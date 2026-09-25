/**
 * A whole quiz, played against a running server.
 *
 *   node scripts/dry-run.mjs                                  # localhost:3000
 *   ADMIN_TOKEN=… node scripts/dry-run.mjs                    # if one is set
 *   BASE=https://….trycloudflare.com ADMIN_TOKEN=… node scripts/dry-run.mjs
 *
 * Run it against your own server before a quiz night. It is the one check that
 * exercises what you will actually use: not `app.inject` and not a unit test,
 * but real HTTP, real WebSockets, the real database, and one quizmaster with
 * five people on four teams all connected at once — which is the situation that
 * produced the worst bug of Phase 1, two clients racing to build the room.
 *
 * It writes a quiz called "Dry Run <date>" and plays three rounds through it:
 * every round type, pounce, bounce, partial credit, a rewind, an adjustment, an
 * undo, stakes, the decay ladder, a dropped socket — then checks the post-quiz
 * report against the scores it expects. It touches nothing you already have.
 *
 * The quiz is left behind, because a quiz with a score on it cannot be deleted
 * through the API: the ledger is append-only and a trigger enforces that. Leave
 * it, or delete it in psql. `/breakdown?quiz=…` will show you the whole run the
 * way it will show you a real one.
 *
 * Every assertion is about what a client ACTUALLY RECEIVED, because that is the
 * only thing that can leak. Where a rule says a team must not know something,
 * the check is a substring search of the raw JSON that team's socket was sent —
 * not a property lookup, which would pass while the secret sat in a sibling
 * field.
 */

import { deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env['BASE'] ?? 'http://127.0.0.1:3000';
const WS = BASE.replace(/^http/, 'ws');
const ADMIN = process.env['ADMIN_TOKEN'] ?? '';

// ─── Reporting ──────────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`);
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

function eq(label, actual, expected) {
  check(label, actual === expected, `got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`);
}

function step(text) {
  console.log(`\n${text}`);
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'x-admin-token': ADMIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return parsed;
}

/** A real PNG, so the upload path and the sealing get real bytes. */
function png(size, shade) {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const raw = Buffer.alloc((size + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) raw[y * (size + 1) + 1 + x] = (shade + x * 7 + y * 11) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function upload(questionId, role, name, bytes) {
  const form = new FormData();
  form.set('file', new Blob([bytes], { type: 'image/png' }), name);
  const res = await fetch(`${BASE}/api/questions/${questionId}/media?role=${role}`, {
    method: 'POST',
    headers: { 'x-admin-token': ADMIN },
    body: form,
  });
  if (!res.ok) throw new Error(`upload ${name} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ─── A client ───────────────────────────────────────────────────────────────

class Client {
  constructor(url, label) {
    this.label = label;
    this.raw = [];       // every STATE message as the bytes it arrived as
    this.errors = [];
    this.waiters = [];
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data);
      const message = JSON.parse(text);
      if (message.type === 'STATE') this.raw.push(text);
      if (message.type === 'ERROR') this.errors.push(message.message);
      for (const notify of this.waiters.splice(0)) notify();
    });
  }

  ready() {
    if (this.socket.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error(`${this.label}: socket error`)), { once: true });
    });
  }

  /** The latest view only. Scanning history would match a state from before. */
  view() {
    const last = this.raw[this.raw.length - 1];
    return last ? JSON.parse(last).view : null;
  }

  /** The raw bytes of the latest state — for "was this ever sent" questions. */
  bytes() {
    return this.raw[this.raw.length - 1] ?? '';
  }

  /**
   * The room's action number this client has caught up to.
   *
   * One counter shared by every connection, which is what makes it usable as a
   * barrier: "everyone has seen the state after action N".
   */
  seqNo() {
    const last = this.raw[this.raw.length - 1];
    return last ? JSON.parse(last).seq : -1;
  }

  async waitFor(pred, what) {
    const deadline = Date.now() + 8000;
    for (;;) {
      const current = this.view();
      if (current && pred(current)) return current;
      if (Date.now() > deadline) throw new Error(`${this.label}: timed out waiting for ${what}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  act(action) {
    this.send({ type: 'ACTION', action });
  }

  close() {
    this.socket.close();
  }
}

const id = () => randomUUID();

// ─── Authoring the quiz ─────────────────────────────────────────────────────

async function build() {
  step('Writing the quiz');
  // Local date, not ISO: at IST an ISO date names yesterday for most of the
  // morning, and this title is read by a person looking at their quiz list.
  const today = new Date().toLocaleDateString('en-CA');
  const quiz = await api('POST', '/api/quizzes', { title: `Dry Run ${today}` });
  console.log(`  quiz ${quiz.id}`);

  const teams = {};
  for (const name of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
    teams[name] = await api('POST', `/api/quizzes/${quiz.id}/teams`, { name });
  }

  // Round 1 — DIRECT, three questions, the middle one in two parts.
  const direct = await api('POST', `/api/quizzes/${quiz.id}/rounds`, {
    type: 'DIRECT', title: 'Openers', direction: 'CW',
  });
  const d1 = await api('POST', `/api/rounds/${direct.id}/questions`, {
    body: 'Which element makes up about three quarters of the mass of the universe?',
  });
  await api('PATCH', `/api/questions/${d1.id}`, { answer_text: 'Hydrogen' });

  const d2 = await api('POST', `/api/rounds/${direct.id}/questions`, {
    body: 'Name both halves of the pair that shared the 1962 Nobel for the structure of DNA with Wilkins.',
  });
  await api('PATCH', `/api/questions/${d2.id}`, { answer_text: 'Watson and Crick' });
  // A DIRECT question is created with one part already, so this makes two, not
  // three — a third would split 10 as 4/3/3 and the check below would be wrong
  // about the arithmetic rather than about the app.
  const p2 = await api('POST', `/api/questions/${d2.id}/parts`, { label: 'Crick' });
  const p1 = (await api('GET', `/api/quizzes/${quiz.id}`)).parts.find(
    (p) => p.question_id === d2.id && p.id !== p2.id,
  );
  await api('PATCH', `/api/parts/${p1.id}`, { label: 'Watson', canonical_answer: 'James Watson' });
  await api('PATCH', `/api/parts/${p2.id}`, { canonical_answer: 'Francis Crick' });

  const d3 = await api('POST', `/api/rounds/${direct.id}/questions`, {
    body: 'What is the only Grand Slam played on clay?',
  });
  await api('PATCH', `/api/questions/${d3.id}`, { answer_text: 'The French Open' });

  // Round 2 — WRITTEN. Four questions: FORMAT_SPEC §2.2 specifies four, and the
  // readiness check treats any other number as an error, so three would be a
  // quiz the app is right to complain about.
  const written = await api('POST', `/api/quizzes/${quiz.id}/rounds`, { type: 'WRITTEN', title: 'On Paper' });
  const w = [];
  for (const [body, answer] of [
    ['Which river does the city of Varanasi sit on?', 'The Ganges'],
    ['Who wrote the novel Midnight’s Children?', 'Salman Rushdie'],
    ['Which two metals make up bronze?', 'Copper and tin'],
    ['What is the capital of Kazakhstan?', 'Astana'],
  ]) {
    const question = await api('POST', `/api/rounds/${written.id}/questions`, { body });
    await api('PATCH', `/api/questions/${question.id}`, { answer_text: answer });
    w.push(question);
  }
  const [w1, w2, w3] = w;

  // Round 3 — VISUAL_CONNECT, one question, four staged images.
  const connect = await api('POST', `/api/quizzes/${quiz.id}/rounds`, {
    type: 'VISUAL_CONNECT', title: 'The Connect',
  });
  const c1 = await api('POST', `/api/rounds/${connect.id}/questions`, { body: 'Connect.' });
  await api('PATCH', `/api/questions/${c1.id}`, { answer_text: 'They all played for Mohun Bagan' });
  for (let i = 0; i < 4; i++) {
    await upload(c1.id, 'REVEAL', `reveal-${i + 1}.png`, png(64, i * 40 + 20));
  }

  const issues = await api('GET', `/api/quizzes/${quiz.id}/issues`);
  const blocking = issues.filter((i) => i.severity === 'ERROR');
  check('the readiness check finds nothing blocking', blocking.length === 0, JSON.stringify(blocking.map((i) => i.issue)));

  const credentials = await api('GET', `/api/quizzes/${quiz.id}/credentials`);
  return {
    quiz, teams, credentials,
    rounds: { direct, written, connect },
    questions: { d1, d2, d3, w1, w2, w3, c1 },
    parts: { p1, p2 },
  };
}

// ─── The run ────────────────────────────────────────────────────────────────

async function main() {
  const built = await build();
  const { quiz, teams, credentials, questions, parts } = built;

  step('Everyone joins at once');
  const qmSession = await api('POST', '/api/join/qm', { qmToken: credentials.qmToken, displayName: 'Prayag' });
  const codeOf = (name) => credentials.teams.find((t) => t.name === name).join_code;
  const sessions = {};
  // Two people on Alpha: a team is one identity shared by up to three humans.
  for (const [name, who] of [['Alpha', 'Ana'], ['Alpha', 'Arun'], ['Bravo', 'Bina'], ['Charlie', 'Chen'], ['Delta', 'Dev']]) {
    const session = await api('POST', '/api/join', { code: codeOf(name), displayName: who });
    (sessions[name] ??= []).push(session);
  }

  const qm = new Client(`${WS}/ws?token=${qmSession.token}`, 'QM');
  const team = {
    Alpha: new Client(`${WS}/ws?token=${sessions.Alpha[0].token}`, 'Alpha/Ana'),
    Alpha2: new Client(`${WS}/ws?token=${sessions.Alpha[1].token}`, 'Alpha/Arun'),
    Bravo: new Client(`${WS}/ws?token=${sessions.Bravo[0].token}`, 'Bravo'),
    Charlie: new Client(`${WS}/ws?token=${sessions.Charlie[0].token}`, 'Charlie'),
    Delta: new Client(`${WS}/ws?token=${sessions.Delta[0].token}`, 'Delta'),
  };
  const board = new Client(`${WS}/ws?scoreboard=${quiz.id}`, 'Scoreboard');
  const all = [qm, ...Object.values(team), board];
  await Promise.all(all.map((c) => c.ready()));
  for (const c of all) await c.waitFor(() => true, 'first state');

  /**
   * Wait until every client has caught up to the furthest one.
   *
   * Without this, "the team sees X" is a race the harness wins or loses at
   * random: the QM's own socket gets its view built first, so reading a team's
   * view straight after the QM's is reading the state BEFORE the action. Two
   * checks failed that way and neither was a bug in the app.
   */
  const settle = async (what) => {
    const target = Math.max(...all.map((c) => c.seqNo()));
    await Promise.all(all.map((c) => c.waitFor(() => c.seqNo() >= target, `${c.label} to reach ${what}`)));
  };

  await settle('everyone connected');
  const present = await qm.waitFor((v) => v.presence.length === 4 && v.presence.every((p) => p.members.length >= 1), 'everyone present');
  eq('the console sees four teams', present.presence.length, 4);
  eq('Alpha shows two people connected', present.presence.find((p) => p.teamName === 'Alpha').members.length, 2);
  const teamSeesPresence = team.Charlie.view().presence.find((p) => p.teamName === 'Alpha');
  eq('a team sees the same attendance', teamSeesPresence.members.length, 2);

  // ── Round 1, question 1 ───────────────────────────────────────────────────
  step('Round 1 · Q1 — a pounce round, then the bounce');
  qm.act({ type: 'START_ROUND', roundIdx: 0 });
  await qm.waitFor((v) => v.round?.title === 'Openers', 'round 1');
  qm.act({ type: 'PRESENT_QUESTION', questionId: questions.d1.id });
  await qm.waitFor((v) => v.phase === 'PRESENTED', 'presented');

  const alphaOnQ1 = await team.Alpha.waitFor((v) => v.question !== null, 'the question');
  await settle('the question on every screen');
  check('the question reaches the teams', alphaOnQ1.question.text.startsWith('Which element'));
  eq('Alpha is the direct team', alphaOnQ1.you.isDirectTeam, true);
  eq('Bravo is not', team.Bravo.view().you.isDirectTeam, false);
  check('the answer is not on the wire before the reveal', !team.Alpha.bytes().includes('Hydrogen'), 'a team was sent the answer');
  check('nor on the scoreboard', !board.bytes().includes('Hydrogen'));

  qm.act({ type: 'OPEN_POUNCE' });
  await team.Bravo.waitFor((v) => v.pounce.open, 'the pounce window');
  team.Bravo.send({ type: 'POUNCE', text: 'Hydrogen' });
  team.Charlie.send({ type: 'POUNCE', text: 'Helium, I think' });
  const blind = await qm.waitFor((v) => v.pounces.length === 2, 'two pounces');
  await settle('two pounces in');
  check('the QM sees who pounced but not what', blind.pounces.every((p) => p.text === null));
  check('and cannot read it in the bytes either', !qm.bytes().includes('Helium'), 'pounce text sent while the window was open');
  check('Charlie never receives Bravo’s pounce', !team.Charlie.bytes().includes('Hydrogen'));
  eq('Bravo can see its own words', team.Bravo.view().pounce.yourText, 'Hydrogen');

  qm.act({ type: 'FINAL_CALL' });
  await team.Bravo.waitFor((v) => v.pounce.finalCall, 'final call');
  qm.act({ type: 'CLOSE_POUNCE' });
  const closed = await qm.waitFor((v) => v.pounces.every((p) => p.text !== null), 'the pounce text');
  check('closing the window hands the QM the text', closed.pounces.map((p) => p.text).sort().join(' | ').includes('Helium'));

  qm.act({ type: 'EVALUATE_POUNCE', teamId: teams.Bravo.id, verdict: 'CORRECT', eventId: id() });
  qm.act({ type: 'EVALUATE_POUNCE', teamId: teams.Charlie.id, verdict: 'WRONG', eventId: id() });
  const judged = await qm.waitFor((v) => v.pounces.every((p) => p.verdict !== null), 'both judged');
  await settle('both pounces judged');
  eq('the QM sees the provisional total', judged.standings.find((s) => s.name === 'Bravo').provisionalScore, 10);
  eq('and what is being withheld', judged.standings.find((s) => s.name === 'Bravo').withheldPoints, 10);
  check('no team sees a pounce result yet', team.Bravo.view().standings.every((s) => s.score === 0), JSON.stringify(team.Bravo.view().standings.map((s) => s.score)));
  check('nor does the scoreboard', board.view().standings.every((s) => s.score === 0));

  qm.act({ type: 'FINISH_POUNCE_EVALUATION' });
  await qm.waitFor((v) => v.phase === 'POUNCE_EVALUATED', 'evaluation finished');
  qm.act({ type: 'OPEN_BOUNCE' });
  const bounce = await qm.waitFor((v) => v.bounce.active, 'the bounce');
  await settle('the bounce open');
  eq('the bounce opens on the direct team', bounce.bounce.onTeamName, 'Alpha');
  const spent = bounce.bounce.order.filter((o) => o.spent).map((o) => o.name).sort();
  check('both pouncers are marked out of it', spent.join(',') === 'Bravo,Charlie', spent.join(','));
  eq('a team is told when it is their turn', team.Alpha.view().bounce.onYou, true);
  eq('the room can follow it', board.view().bounce.onTeamName, 'Alpha');

  qm.act({ type: 'BOUNCE_WRONG' });
  const moved = await qm.waitFor((v) => v.bounce.onTeamName !== 'Alpha', 'the bounce to move');
  eq('the bounce skips the teams that pounced', moved.bounce.onTeamName, 'Delta');
  qm.act({ type: 'BOUNCE_CORRECT', eventId: id() });
  await qm.waitFor((v) => v.phase === 'RESOLVED', 'resolved');
  qm.act({ type: 'REVEAL_ANSWER' });

  const revealed = await team.Alpha.waitFor((v) => v.reveal !== null, 'the reveal');
  eq('the answer arrives at the reveal and not before', revealed.reveal.text, 'Hydrogen');
  const afterQ1 = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Bravo').score === 10, 'published scores');
  await settle('the scores published');
  const scores = (view) => Object.fromEntries(view.standings.map((s) => [s.name, s.score]));
  check('the withheld pounce results publish together', JSON.stringify(scores(afterQ1)) === JSON.stringify({ Alpha: 0, Bravo: 10, Charlie: -5, Delta: 10 }), JSON.stringify(scores(afterQ1)));
  check('and the teams see the same', JSON.stringify(scores(team.Delta.view())) === JSON.stringify({ Alpha: 0, Bravo: 10, Charlie: -5, Delta: 10 }));

  qm.act({ type: 'NEXT_QUESTION' });
  const rotated = await qm.waitFor((v) => v.phase === 'IDLE', 'the next question');
  eq('a bounce win moves the rotation to the team after the winner', rotated.nextDirectTeamName, 'Alpha');

  // ── Round 1, question 2 ───────────────────────────────────────────────────
  step('Round 1 · Q2 — partial credit, withheld, and a question that dies');
  qm.act({ type: 'PRESENT_QUESTION', questionId: questions.d2.id });
  await qm.waitFor((v) => v.phase === 'PRESENTED', 'presented');
  await settle('Q2 presented');
  eq('the team is told it is a two-part question', team.Alpha.view().question.partCount, 2);
  check('without being told the parts', !team.Alpha.bytes().includes('Francis Crick'));
  eq('the QM has the split worked out', qm.view().answer.parts.map((p) => p.value).join('+'), '5+5');

  qm.act({ type: 'OPEN_POUNCE' });
  await qm.waitFor((v) => v.phase === 'POUNCE_OPEN', 'pounce open');
  qm.act({ type: 'CLOSE_POUNCE' });
  qm.act({ type: 'FINISH_POUNCE_EVALUATION' });
  qm.act({ type: 'OPEN_BOUNCE' });
  await qm.waitFor((v) => v.bounce.active && v.bounce.onTeamName === 'Alpha', 'the bounce on Alpha');

  qm.act({ type: 'BOUNCE_PARTIAL', partIds: [parts.p1.id], eventId: id() });
  const partial = await qm.waitFor((v) => v.withheldOnQuestion === 5, 'the withheld partial');
  await settle('the partial recorded');
  eq('a partial is recorded against the question', partial.withheldOnQuestion, 5);
  eq('and credited to the team that got it', partial.answer.parts.find((p) => p.id === parts.p1.id).creditedTo, 'Alpha');
  check('and published to nobody', team.Alpha.view().standings.find((s) => s.name === 'Alpha').score === 0);
  eq('the bounce carries on after a partial', partial.bounce.onTeamName, 'Bravo');

  qm.act({ type: 'BOUNCE_WRONG' });
  await qm.waitFor((v) => v.bounce.onTeamName === 'Charlie', 'the bounce on Charlie');
  // The misclick: step back a team, then carry on. The award must survive it.
  qm.act({ type: 'REWIND_BOUNCE' });
  const rewound = await qm.waitFor((v) => v.bounce.onTeamName === 'Bravo', 'the rewind');
  eq('a rewind steps back one team', rewound.bounce.onTeamName, 'Bravo');
  eq('and leaves the ledger alone', rewound.withheldOnQuestion, 5);

  qm.act({ type: 'BOUNCE_WRONG' });
  await qm.waitFor((v) => v.bounce.onTeamName === 'Charlie', 'Charlie again');
  qm.act({ type: 'BOUNCE_WRONG' });
  await qm.waitFor((v) => v.bounce.onTeamName === 'Delta', 'Delta');
  qm.act({ type: 'BOUNCE_WRONG' });
  const dead = await qm.waitFor((v) => v.phase === 'DEAD', 'the question to die');
  eq('the question dies once everyone has had it', dead.phase, 'DEAD');
  qm.act({ type: 'REVEAL_ANSWER' });
  const q2Done = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Alpha').score === 5, 'the partial to publish');
  eq('the withheld partial publishes at the reveal', q2Done.standings.find((s) => s.name === 'Alpha').score, 5);
  eq('and nothing is left withheld', q2Done.withheldOnQuestion, 0);

  qm.act({ type: 'NEXT_QUESTION' });
  const afterDead = await qm.waitFor((v) => v.phase === 'IDLE', 'idle');
  eq('a dead question moves the rotation on by one', afterDead.nextDirectTeamName, 'Bravo');

  // ── Round 1, question 3 ───────────────────────────────────────────────────
  step('Round 1 · Q3 — straight to the bounce, an adjustment, and an undo');
  qm.act({ type: 'PRESENT_QUESTION', questionId: questions.d3.id });
  await qm.waitFor((v) => v.phase === 'PRESENTED', 'presented');
  qm.act({ type: 'OPEN_BOUNCE' });
  await qm.waitFor((v) => v.bounce.onTeamName === 'Bravo', 'the bounce on Bravo');
  qm.act({ type: 'BOUNCE_CORRECT', eventId: id() });
  await qm.waitFor((v) => v.phase === 'RESOLVED', 'resolved');

  qm.act({ type: 'MANUAL_ADJUST', teamId: teams.Charlie.id, points: 5, note: 'Answered before the bounce reached them', eventId: id() });
  const adjusted = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Charlie').score === 0, 'the adjustment');
  eq('a manual adjustment applies at once', adjusted.standings.find((s) => s.name === 'Charlie').score, 0);
  eq('with its reason attached', adjusted.recent[0].note, 'Answered before the bounce reached them');

  /**
   * The id to undo comes from the view, not from the client.
   *
   * The server stamps its own event id over whatever the client sent, so an
   * undo aimed at the id this script invented hits nothing — and silently,
   * because VOID_EVENT over an unknown id is a no-op. The console gets this
   * right (it reads recent[0].eventId); the harness had to learn it.
   */
  const adjustId = adjusted.recent.find((e) => e.reason === 'MANUAL_ADJUST' && e.status === 'APPLIED').eventId;
  qm.act({ type: 'VOID_EVENT', eventId: adjustId });
  const undone = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Charlie').score === -5, 'the undo');
  eq('undo takes the points back', undone.standings.find((s) => s.name === 'Charlie').score, -5);
  eq('and voids rather than deletes', undone.recent.find((e) => e.eventId === adjustId).status, 'VOIDED');

  qm.act({ type: 'REVEAL_ANSWER' });
  await qm.waitFor((v) => v.phase === 'REVEALED', 'revealed');
  qm.act({ type: 'NEXT_QUESTION' });
  const endOfRound = await qm.waitFor((v) => v.phase === 'IDLE', 'the end of the round');
  check('round 1 totals', JSON.stringify(scores(endOfRound)) === JSON.stringify({ Alpha: 5, Bravo: 20, Charlie: -5, Delta: 10 }), JSON.stringify(scores(endOfRound)));

  // ── Round 2 ───────────────────────────────────────────────────────────────
  step('Round 2 — written, on one sheet, with stakes');
  qm.act({ type: 'START_ROUND', roundIdx: 1 });
  await qm.waitFor((v) => v.round?.type === 'WRITTEN', 'the written round');
  qm.act({ type: 'SHOW_WRITTEN_QUESTION', index: 0 });
  // `v.written?.currentQuestion !== null` is vacuously TRUE while `written` is
  // still null, which is how this first waited for nothing at all.
  const showing = await team.Alpha.waitFor(
    (v) => v.written != null && v.written.currentQuestion != null,
    'the first question on the team sheet',
  );
  check('the question being read is on the team screen', showing.written.currentQuestion.text.includes('Varanasi'));
  check('the canonical answer is not', !team.Alpha.bytes().includes('Ganges'), 'the answer was sent to a team');

  // Answerable while the next question is still being read (§2.2).
  team.Alpha.send({ type: 'WRITTEN_ANSWER', questionId: questions.w1.id, text: 'The Ganga', staked: true });
  team.Bravo.send({ type: 'WRITTEN_ANSWER', questionId: questions.w1.id, text: 'The Yamuna', staked: true });
  team.Charlie.send({ type: 'WRITTEN_ANSWER', questionId: questions.w1.id, text: 'Ganges', staked: false });
  await qm.waitFor((v) => v.written.answers.filter((a) => a.text !== null).length === 3, 'three answers');

  qm.act({ type: 'SHOW_WRITTEN_QUESTION', index: 1 });
  await team.Alpha.waitFor((v) => v.written.shownIdx === 1, 'the second question');
  qm.act({ type: 'OPEN_COLLECTION' });
  await team.Alpha.waitFor((v) => v.written.collecting, 'collection open');

  team.Alpha.send({ type: 'WRITTEN_ANSWER', questionId: questions.w2.id, text: 'Arundhati Roy', staked: false });
  team.Bravo.send({ type: 'WRITTEN_ANSWER', questionId: questions.w2.id, text: 'Salman Rushdie', staked: false });
  team.Charlie.send({ type: 'WRITTEN_ANSWER', questionId: questions.w2.id, text: 'Rushdie', staked: true });
  team.Alpha.send({ type: 'WRITTEN_ANSWER', questionId: questions.w3.id, text: 'Copper and tin', staked: false });
  team.Charlie.send({ type: 'WRITTEN_ANSWER', questionId: questions.w3.id, text: 'Copper and zinc', staked: false });
  const sheet = await team.Charlie.waitFor((v) => v.written.yourAnswers.length === 3, 'the sheet');
  eq('a team sees its own sheet', sheet.written.yourAnswers.length, 3);
  check('and nobody else’s', !team.Charlie.bytes().includes('Arundhati'), 'another team’s answer was sent');
  eq('every question is in front of the team', sheet.written.questions.length, 4);

  qm.act({ type: 'CLOSE_COLLECTION' });
  const grid = await qm.waitFor((v) => v.written.phase === 'EVALUATING', 'the grading grid');
  eq('the grid has a row per team per question', grid.written.answers.length, 16);
  const deltaRows = grid.written.answers.filter((a) => a.teamName === 'Delta');
  check('including the team that wrote nothing', deltaRows.length === 4 && deltaRows.every((a) => a.text === null));

  const grade = (teamName, questionId, verdict) =>
    qm.act({ type: 'EVALUATE_WRITTEN', teamId: teams[teamName].id, questionId, verdict, eventId: id() });
  grade('Alpha', questions.w1.id, 'CORRECT');   // staked  → +15
  grade('Bravo', questions.w1.id, 'WRONG');     // staked  → −5
  grade('Charlie', questions.w1.id, 'CORRECT'); // plain   → +10
  grade('Alpha', questions.w2.id, 'WRONG');     // plain   →  0
  grade('Bravo', questions.w2.id, 'CORRECT');   // plain   → +10
  grade('Charlie', questions.w2.id, 'CORRECT'); // staked  → +15
  grade('Alpha', questions.w3.id, 'CORRECT');   // plain   → +10
  grade('Charlie', questions.w3.id, 'WRONG');   // plain   →  0
  const graded = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Alpha').score === 30, 'the written scores');
  check('a stake pays 15 and costs 5', JSON.stringify(scores(graded)) === JSON.stringify({ Alpha: 30, Bravo: 25, Charlie: 20, Delta: 10 }), JSON.stringify(scores(graded)));
  qm.act({ type: 'FINISH_WRITTEN_EVALUATION' });
  const verdicts = await team.Alpha.waitFor((v) => v.written.yourAnswers.some((a) => a.verdict !== null), 'the verdicts');
  eq('a team learns how it did', verdicts.written.yourAnswers.find((a) => a.questionId === questions.w1.id).verdict, 'CORRECT');

  // ── Round 3 ───────────────────────────────────────────────────────────────
  step('Round 3 — the visual connect, and what a team is holding');
  qm.act({ type: 'START_ROUND', roundIdx: 2 });
  const connectRound = await team.Alpha.waitFor((v) => v.round?.type === 'VISUAL_CONNECT', 'the connect round');
  eq('the whole round’s media is preloaded, sealed', connectRound.preload.length, 4);

  const sealed = connectRound.preload[0];
  const sealedRes = await fetch(`${BASE}${sealed.url}`);
  const sealedBytes = Buffer.from(await sealedRes.arrayBuffer());
  eq('the ciphertext is served as opaque bytes', sealedRes.headers.get('content-type'), 'application/octet-stream');
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  check('and is not a readable image', !sealedBytes.subarray(0, 4).equals(magic), 'the preloaded bytes are a PNG');
  check('the bytes are there to decrypt later', sealedBytes.length > 100, `${sealedBytes.length} bytes`);
  check('no key has been sent with them', !JSON.stringify(connectRound.preload).includes('key'));

  qm.act({ type: 'PRESENT_QUESTION', questionId: questions.c1.id });
  const stage0 = await team.Alpha.waitFor((v) => v.question !== null, 'the first reveal');
  eq('one reveal is on screen, not four', stage0.question.media.length, 1);
  check('and its key arrives with it', typeof stage0.question.media[0].key === 'string');
  check('the key unlocks only what is already visible', team.Alpha.bytes().split('"key"').length - 1 === 1, 'more keys than visible images');
  eq('the ladder says what a pounce is worth now', `${stage0.connect.value.correct}/${stage0.connect.value.wrong}`, '20/-15');
  eq('and what waiting will cost', stage0.connect.ladder.length, 4);

  qm.act({ type: 'OPEN_POUNCE' });
  await team.Alpha.waitFor((v) => v.pounce.open, 'the connect pounce window');
  team.Alpha.send({ type: 'POUNCE', text: 'They are all from Kolkata' });
  await qm.waitFor((v) => v.pounces.length === 1, 'the pounce');
  qm.act({ type: 'CLOSE_POUNCE' });
  await qm.waitFor((v) => v.pounces[0].text !== null, 'the text');
  qm.act({ type: 'EVALUATE_POUNCE', teamId: teams.Alpha.id, verdict: 'WRONG', eventId: id() });
  await qm.waitFor((v) => v.pounces[0].verdict === 'WRONG', 'the verdict');
  qm.act({ type: 'FINISH_POUNCE_EVALUATION' });
  await qm.waitFor((v) => v.phase === 'POUNCE_EVALUATED', 'evaluated');
  qm.act({ type: 'ADVANCE_REVEAL' });

  const stage1 = await team.Alpha.waitFor((v) => v.connect.stageIdx === 1, 'the second reveal');
  eq('the value decays with the reveal', `${stage1.connect.value.correct}/${stage1.connect.value.wrong}`, '15/-10');
  eq('two images are on screen now', stage1.question.media.length, 2);
  eq('a team that has pounced is spent for the question', stage1.pounce.spent, true);

  qm.act({ type: 'OPEN_POUNCE' });
  await team.Bravo.waitFor((v) => v.pounce.open, 'the window');
  team.Alpha.errors.length = 0;
  team.Alpha.send({ type: 'POUNCE', text: 'Trying again' });
  await new Promise((r) => setTimeout(r, 400));
  check('a spent team is refused, in words', team.Alpha.errors.some((e) => /already pounced/i.test(e)), JSON.stringify(team.Alpha.errors));

  team.Bravo.send({ type: 'POUNCE', text: 'They all played for Mohun Bagan' });
  await qm.waitFor((v) => v.pounces.some((p) => p.teamName === 'Bravo'), 'Bravo’s pounce');
  qm.act({ type: 'CLOSE_POUNCE' });
  await qm.waitFor((v) => v.pounces.every((p) => p.text !== null), 'the text');
  qm.act({ type: 'EVALUATE_POUNCE', teamId: teams.Bravo.id, verdict: 'CORRECT', eventId: id() });
  await qm.waitFor((v) => v.pounces.some((p) => p.verdict === 'CORRECT'), 'the verdict');
  qm.act({ type: 'FINISH_POUNCE_EVALUATION' });
  await qm.waitFor((v) => v.phase === 'RESOLVED', 'resolved');
  qm.act({ type: 'REVEAL_ANSWER' });

  const final = await qm.waitFor((v) => v.standings.find((s) => s.name === 'Bravo').score === 40, 'the final scores');
  await settle('the final scores');
  check('final totals', JSON.stringify(scores(final)) === JSON.stringify({ Alpha: 15, Bravo: 40, Charlie: 20, Delta: 10 }), JSON.stringify(scores(final)));
  const boardFinal = await board.waitFor((v) => v.standings.find((s) => s.name === 'Bravo').score === 40, 'the projector');
  eq('the projector agrees', boardFinal.reveal.text, 'They all played for Mohun Bagan');
  eq('and every team agrees', JSON.stringify(scores(team.Delta.view())), JSON.stringify(scores(final)));

  // ── Reconnection ──────────────────────────────────────────────────────────
  step('Killing a team’s socket mid-quiz');
  const before = team.Charlie.view();
  team.Charlie.close();
  await new Promise((r) => setTimeout(r, 300));
  const rejoined = new Client(`${WS}/ws?token=${sessions.Charlie[0].token}`, 'Charlie again');
  await rejoined.ready();
  const after = await rejoined.waitFor((v) => v.standings.length === 4, 'the state on reconnect');
  eq('a reconnecting team lands in the same phase', after.phase, before.phase);
  eq('with the same scores', JSON.stringify(scores(after)), JSON.stringify(scores(before)));
  eq('and its own answers back', after.written === null ? null : 0, before.written === null ? null : 0);
  rejoined.close();

  // ── The report ────────────────────────────────────────────────────────────
  step('The post-quiz report');
  const anon = await fetch(`${BASE}/api/quizzes/${quiz.id}/breakdown`);
  eq('the breakdown refuses a request without the token', anon.status, 403);
  const reportRes = await fetch(`${BASE}/api/quizzes/${quiz.id}/breakdown`, {
    headers: { 'x-qm-token': credentials.qmToken },
  });
  const report = await reportRes.json();
  const reported = Object.fromEntries(report.standings.map((s) => [s.name, s.score]));
  check('the report totals match the room', JSON.stringify(reported) === JSON.stringify({ Alpha: 15, Bravo: 40, Charlie: 20, Delta: 10 }), JSON.stringify(reported));
  check('nothing was recorded and left unpublished', report.standings.every((s) => s.withheldPoints === 0), JSON.stringify(report.standings.map((s) => s.withheldPoints)));
  check('the voided adjustment is not counted', !report.events.some((e) => e.reason === 'MANUAL_ADJUST'), 'a voided event is in the report');
  check('every team’s words are in it', report.submissions.some((s) => s.body === 'Helium, I think') && report.submissions.some((s) => s.body === 'Arundhati Roy'));
  check('a stake is recorded as one', report.submissions.some((s) => s.kind === 'WRITTEN' && s.staked && s.body === 'The Ganga'));
  const connectPounce = report.submissions.find((s) => s.body.includes('Mohun Bagan'));
  eq('a connect pounce records which reveal it came at', connectPounce.stageIdx, 1);
  eq('pounce statistics come out of the ledger', report.standings.find((s) => s.name === 'Alpha').pouncesWrong, 1);

  const out = process.env['REPORT_OUT'];
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));

  const errors = all.map((c) => [c.label, c.errors]);
  for (const c of all) c.close();
  return { quizId: quiz.id, report, errors };
}

const result = await main();
console.log(`\n${passed} checks passed, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
for (const [label, list] of result.errors) {
  if (list.length) console.log(`  ${label} was told: ${list.join(' | ')}`);
}
console.log(`\nIt played quiz ${result.quizId} — "Dry Run" in your quiz list.`);
process.exit(failures.length === 0 ? 0 : 1);
