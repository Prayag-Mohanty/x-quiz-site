/**
 * A whole question, with everyone connected at once.
 *
 * The socket tests connect one or two clients in sequence. A real quiz starts
 * with a quizmaster and every team arriving together, and that is precisely the
 * situation that produced the worst bug in this phase — two clients racing
 * getRoom each built their own room, and the loser sat in an orphaned copy of
 * the quiz receiving no broadcasts. It was invisible with one client.
 *
 * So: connect simultaneously, act simultaneously, and assert that every client
 * agrees. Anything that only breaks under concurrency breaks here.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import type { QmView, ServerMessage, TeamView } from '@quizmaster/shared';

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { evictAllRooms } from '../src/rooms.js';

let app: FastifyInstance;
let base: string;
const createdQuizzes: string[] = [];
const openSockets: WebSocket[] = [];

before(async () => {
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  for (const socket of openSockets) socket.close();
  await pool
    .query('ALTER TABLE score_event DISABLE TRIGGER score_event_append_only')
    .catch(() => undefined);
  for (const id of createdQuizzes) {
    for (const sql of [
      'DELETE FROM quiz_action WHERE quiz_id = $1',
      'DELETE FROM score_event WHERE quiz_id = $1',
      'DELETE FROM session WHERE quiz_id = $1',
      // The submission projections hold the question and the team down with
      // ON DELETE RESTRICT, so they go before the quiz does.
      'DELETE FROM pounce_submission WHERE team_id IN (SELECT id FROM team WHERE quiz_id = $1)',
      'DELETE FROM written_answer WHERE team_id IN (SELECT id FROM team WHERE quiz_id = $1)',
      'DELETE FROM quiz WHERE id = $1',
    ]) {
      await pool.query(sql, [id]).catch(() => undefined);
    }
  }
  await pool
    .query('ALTER TABLE score_event ENABLE TRIGGER score_event_append_only')
    .catch(() => undefined);
  evictAllRooms();
  await app.close();
  await pool.end();
});

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** A GET with headers — the breakdown is behind the quizmaster's token. */
async function getWith(url: string, headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

class Client {
  private received: ServerMessage[] = [];
  private listeners: (() => void)[] = [];
  readonly socket: WebSocket;

  constructor(url: string, readonly label: string) {
    this.socket = new WebSocket(url);
    openSockets.push(this.socket);
    this.socket.on('message', (raw) => {
      this.received.push(JSON.parse(raw.toString()) as ServerMessage);
      for (const notify of this.listeners.splice(0)) notify();
    });
  }

  ready(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.once('open', () => resolve());
      this.socket.once('error', reject);
    });
  }

  /**
   * Wait until the CURRENT state satisfies `pred`.
   *
   * Only the latest state is tested, never the history. Scanning backwards for
   * any match will happily return a state from before the thing you are waiting
   * for — especially with predicates built on `every()`, which is vacuously
   * true on an empty array. "The pounces all have text" was satisfied by a
   * state with no pounces at all.
   */
  async waitFor<V extends TeamView | QmView>(pred: (v: V) => boolean, what: string): Promise<V> {
    const deadline = Date.now() + 8000;
    for (;;) {
      const current = this.latest<V>();
      if (current && pred(current)) return current;
      if (Date.now() > deadline) {
        throw new Error(`${this.label}: timed out waiting for ${what}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 40);
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  latest<V extends TeamView | QmView>(): V | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i];
      if (m?.type === 'STATE') return m.view as V;
    }
    return null;
  }

  everReceived(needle: string): boolean {
    return this.received.some((m) => JSON.stringify(m).includes(needle));
  }

  errors(): string[] {
    return this.received.flatMap((m) => (m.type === 'ERROR' ? [m.message] : []));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

const ANSWER = 'Cream and Disraeli Gears';

async function fixture() {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Live Quiz Test' })).body;
  createdQuizzes.push(quiz.id);
  for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
    await call('POST', `/api/quizzes/${quiz.id}/teams`, { name });
  }
  const round = (
    await call('POST', `/api/quizzes/${quiz.id}/rounds`, { type: 'DIRECT', title: 'R1' })
  ).body;
  const question = (
    await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Name the band and album.' })
  ).body;
  await call('PATCH', `/api/questions/${question.id}`, { answer_text: ANSWER });
  await call('POST', `/api/questions/${question.id}/parts`, { label: 'Album' });
  const creds = (await call('GET', `/api/quizzes/${quiz.id}/credentials`)).body;
  return { quiz, question, creds };
}

test('a whole question with five clients connected at once', async () => {
  const { quiz, question, creds } = await fixture();

  // Everyone arrives together, which is how a quiz actually starts.
  const [qmJoin, ...teamJoins] = await Promise.all([
    call('POST', '/api/join/qm', { qmToken: creds.qmToken }),
    ...creds.teams.map((t: { join_code: string; name: string }) =>
      call('POST', '/api/join', { code: t.join_code, displayName: `${t.name} player` }),
    ),
  ]);

  const qm = new Client(`${base}/ws?token=${qmJoin.body.token}`, 'QM');
  const teams = teamJoins.map(
    (j, i) => new Client(`${base}/ws?token=${j.body.token}`, creds.teams[i].name),
  );
  await Promise.all([qm.ready(), ...teams.map((t) => t.ready())]);

  const [alpha, beta, gamma, delta] = teams as [Client, Client, Client, Client];

  // Every client must be in the SAME room. If getRoom raced, some of these
  // never see the question at all.
  await qm.waitFor<QmView>((v) => v.presence.every((p) => p.members.length === 1), 'all four teams present');

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  await Promise.all(
    teams.map((t) => t.waitFor<TeamView>((v) => v.question !== null, 'the question')),
  );

  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  await Promise.all(teams.map((t) => t.waitFor<TeamView>((v) => v.pounce.open, 'pounce open')));

  // Alpha is the direct team and may not pounce. The other three fire at once.
  const secrets = {
    beta: 'Beta says Led Zeppelin',
    gamma: 'Gamma says Cream and Disraeli Gears',
    delta: 'Delta says The Who',
  };
  beta.send({ type: 'POUNCE', text: secrets.beta });
  gamma.send({ type: 'POUNCE', text: secrets.gamma });
  delta.send({ type: 'POUNCE', text: secrets.delta });

  const withPounces = await qm.waitFor<QmView>((v) => v.pounces.length === 3, 'three pounces');
  // Concurrent writes must not lose one, and each must be attributed correctly.
  assert.deepEqual(
    withPounces.pounces.map((p) => p.teamName).sort(),
    ['Beta', 'Delta', 'Gamma'],
  );
  // Still blind, even with three in.
  assert.ok(withPounces.pounces.every((p) => p.text === null));

  // Alpha's own attempt is refused by the format, not by an accident.
  alpha.send({ type: 'POUNCE', text: 'Alpha should not be able to do this' });
  await new Promise((r) => setTimeout(r, 400));
  assert.match(alpha.errors().join(' '), /direct team cannot pounce/);

  qm.send({ type: 'ACTION', action: { type: 'CLOSE_POUNCE' } });
  const closed = await qm.waitFor<QmView>(
    (v) => v.pounces.length === 3 && v.pounces.every((p) => typeof p.text === 'string'),
    'pounce text',
  );
  assert.equal(closed.pounces.find((p) => p.teamName === 'Gamma')?.text, secrets.gamma);

  // Nobody's words reached anybody else, at any point.
  for (const [owner, secret] of [
    [beta, secrets.beta],
    [gamma, secrets.gamma],
    [delta, secrets.delta],
  ] as const) {
    for (const other of teams) {
      if (other === owner) continue;
      assert.equal(
        other.everReceived(secret),
        false,
        `${other.label} received ${owner.label}'s pounce`,
      );
    }
  }

  // Gamma had it; Beta and Delta did not.
  for (const [team, verdict] of [
    ['Gamma', 'CORRECT'],
    ['Beta', 'WRONG'],
    ['Delta', 'WRONG'],
  ] as const) {
    const teamId = closed.pounces.find((p) => p.teamName === team)?.teamId;
    qm.send({ type: 'ACTION', action: { type: 'EVALUATE_POUNCE', teamId: teamId!, verdict, eventId: '' } });
  }

  const judged = await qm.waitFor<QmView>(
    (v) => v.pounces.length === 3 && v.pounces.every((p) => p.verdict !== null),
    'all pounces judged',
  );
  // Judged, but WITHHELD: the bounce is about to run, and a moving scoreboard
  // would tell the room whether the question is already answered.
  for (const name of ['Gamma', 'Beta', 'Delta']) {
    assert.equal(judged.standings.find((s) => s.name === name)?.score, 0, `${name} public`);
  }
  assert.equal(judged.standings.find((s) => s.name === 'Gamma')?.provisionalScore, 10);
  assert.equal(judged.standings.find((s) => s.name === 'Beta')?.provisionalScore, -5);
  assert.equal(judged.standings.find((s) => s.name === 'Delta')?.provisionalScore, -5);

  // And no team's socket has carried any of it.
  for (const team of teams) {
    const view = team.latest<TeamView>();
    assert.ok(
      view?.standings.every((s) => s.score === 0),
      `${team.label} saw a score move before the reveal`,
    );
  }

  // The bounce runs after EVERY pounce window (§2.1). Beta, Gamma and Delta all
  // pounced, so they are spent — the bounce is Alpha, the direct team, alone.
  qm.send({ type: 'ACTION', action: { type: 'FINISH_POUNCE_EVALUATION' } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_BOUNCE' } });

  const bouncing = await qm.waitFor<QmView>((v) => v.bounce.active, 'the bounce');
  assert.equal(bouncing.bounce.onTeamName, 'Alpha');
  await alpha.waitFor<TeamView>((v) => v.bounce.onYou, "Alpha's turn");
  // The three pouncers are told it is not their turn, and never will be.
  for (const spent of [beta, gamma, delta]) {
    const view = spent.latest<TeamView>();
    assert.equal(view?.bounce.onYou, false, `${spent.label} should be out of the bounce`);
  }

  // Alpha cannot answer either, so nobody eligible is left and it dies.
  qm.send({ type: 'ACTION', action: { type: 'BOUNCE_WRONG' } });
  await qm.waitFor<QmView>((v) => v.phase === 'DEAD', 'the question to die');

  qm.send({ type: 'ACTION', action: { type: 'REVEAL_ANSWER' } });

  await Promise.all(
    teams.map((t) => t.waitFor<TeamView>((v) => v.reveal !== null, 'the reveal')),
  );

  // Every client ends up agreeing, which is the whole point of one room.
  const finalScores = teams.map((t) => {
    const view = t.latest<TeamView>();
    return view!.standings.map((s) => `${s.name}:${s.score}`).sort().join(',');
  });
  assert.equal(new Set(finalScores).size, 1, 'clients disagreed about the scores');
  assert.equal(finalScores[0], 'Alpha:0,Beta:-5,Delta:-5,Gamma:10');

  // The action log is a single ordered sequence with no gaps, despite the
  // concurrent sends. A duplicated seq would have failed the insert outright.
  const { rows } = await pool.query(
    'SELECT seq FROM quiz_action WHERE quiz_id = $1 ORDER BY seq',
    [quiz.id],
  );
  const seqs = rows.map((r: { seq: string }) => Number(r.seq));
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1));

  // And nobody saw the answer before it was revealed to everyone.
  assert.ok(teams.every((t) => t.everReceived(ANSWER)), 'reveal reached every team');

  // The pounce text is projected out of the log, because "what did Beta
  // actually write?" is asked after every quiz and the answer should be a
  // SELECT (002_runtime.sql). Withheld on the wire, recorded in the table.
  const submissions = await pool.query(
    `SELECT t.name, p.body, p.verdict, p.stage_idx, p.evaluated_at IS NOT NULL AS judged
       FROM pounce_submission p JOIN team t ON t.id = p.team_id
      WHERE p.question_id = $1 ORDER BY t.name`,
    [question.id],
  );
  assert.deepEqual(
    submissions.rows.map((r: { name: string; body: string; verdict: string }) => [
      r.name,
      r.body,
      r.verdict,
    ]),
    [
      ['Beta', secrets.beta, 'WRONG'],
      ['Delta', secrets.delta, 'WRONG'],
      ['Gamma', secrets.gamma, 'CORRECT'],
    ],
  );
  // evaluated_at is non-null exactly when a verdict is — the table's own check.
  assert.ok(submissions.rows.every((r: { judged: boolean }) => r.judged));
  // A DIRECT pounce has no reveal stage; that column is for connects (§2.3).
  assert.ok(submissions.rows.every((r: { stage_idx: number | null }) => r.stage_idx === null));
});

/**
 * The written round, projected.
 *
 * Teams write on one sheet and it is submitted against every question, so the
 * table should end up with the sheet under each one, the stake recorded per
 * question, and locked_at set once collection closes (FORMAT_SPEC §2.2).
 */
test('a written round leaves its sheets, stakes and verdicts in the table', async () => {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Written Projection Test' })).body;
  createdQuizzes.push(quiz.id);
  for (const name of ['Alpha', 'Beta']) {
    await call('POST', `/api/quizzes/${quiz.id}/teams`, { name });
  }
  const round = (
    await call('POST', `/api/quizzes/${quiz.id}/rounds`, { type: 'WRITTEN', title: 'W1' })
  ).body;
  const questions = [];
  for (const body of ['Written one?', 'Written two?']) {
    const q = (await call('POST', `/api/rounds/${round.id}/questions`, { body })).body;
    await call('PATCH', `/api/questions/${q.id}`, { answer_text: `Answer to ${body}` });
    questions.push(q);
  }
  const creds = (await call('GET', `/api/quizzes/${quiz.id}/credentials`)).body;

  const qmJoin = await call('POST', '/api/join/qm', { qmToken: creds.qmToken });
  const alphaJoin = await call('POST', '/api/join', {
    code: creds.teams[0].join_code,
    displayName: 'Alpha player',
  });
  const qm = new Client(`${base}/ws?token=${qmJoin.body.token}`, 'QM');
  const alpha = new Client(`${base}/ws?token=${alphaJoin.body.token}`, 'Alpha');
  await Promise.all([qm.ready(), alpha.ready()]);

  qm.send({ type: 'ACTION', action: { type: 'SHOW_WRITTEN_QUESTION', index: 0 } });
  await alpha.waitFor<TeamView>((v) => v.written !== null, 'the written round');

  const SHEET = ['1. Bombay', '2. Cream'].join('\n');
  // One sheet, sent against every question the QM has reached — which is what
  // the team client does with a single box.
  alpha.send({
    type: 'WRITTEN_ANSWER',
    questionId: questions[0].id,
    text: SHEET,
    staked: false,
  });
  qm.send({ type: 'ACTION', action: { type: 'SHOW_WRITTEN_QUESTION', index: 1 } });
  alpha.send({
    type: 'WRITTEN_ANSWER',
    questionId: questions[1].id,
    text: SHEET,
    staked: true,
  });

  await qm.waitFor<QmView>(
    (v) => (v.written?.answers.filter((a) => a.text !== null).length ?? 0) === 2,
    'both sheets',
  );

  // Still collecting: nothing is locked, so a stake can still be changed.
  const open = await pool.query(
    'SELECT locked_at FROM written_answer WHERE question_id = ANY($1)',
    [questions.map((q: { id: string }) => q.id)],
  );
  assert.equal(open.rows.length, 2);
  assert.ok(open.rows.every((r: { locked_at: Date | null }) => r.locked_at === null));

  qm.send({ type: 'ACTION', action: { type: 'CLOSE_COLLECTION' } });
  await qm.waitFor<QmView>((v) => v.written?.phase === 'EVALUATING', 'grading');

  qm.send({
    type: 'ACTION',
    action: {
      type: 'EVALUATE_WRITTEN',
      teamId: creds.teams[0].id,
      questionId: questions[1].id,
      verdict: 'CORRECT',
      eventId: '',
    },
  });
  // +15, not +10: the stake was declared at submission and is now binding.
  await qm.waitFor<QmView>(
    (v) => v.standings.find((s) => s.name === 'Alpha')?.provisionalScore === 15,
    'the staked award',
  );

  const { rows } = await pool.query(
    `SELECT q.position, w.body, w.staked, w.verdict,
            w.locked_at IS NOT NULL AS locked,
            w.evaluated_at IS NOT NULL AS judged
       FROM written_answer w JOIN question q ON q.id = w.question_id
      WHERE q.round_id = $1 ORDER BY q.position`,
    [round.id],
  );
  assert.deepEqual(
    rows.map((r: { body: string; staked: boolean; verdict: string | null }) => [
      r.body,
      r.staked,
      r.verdict,
    ]),
    [
      [SHEET, false, null],
      [SHEET, true, 'CORRECT'],
    ],
  );
  assert.ok(rows.every((r: { locked: boolean }) => r.locked), 'closing the round locks the sheet');
  assert.deepEqual(rows.map((r: { judged: boolean }) => r.judged), [false, true]);
});

test('a team that reconnects mid-question rejoins the same room as everyone else', async () => {
  const { question, creds } = await fixture();

  const qmJoin = await call('POST', '/api/join/qm', { qmToken: creds.qmToken });
  const betaJoin = await call('POST', '/api/join', {
    code: creds.teams[1].join_code,
    displayName: 'Beta player',
  });
  const qm = new Client(`${base}/ws?token=${qmJoin.body.token}`, 'QM');
  const beta = new Client(`${base}/ws?token=${betaJoin.body.token}`, 'Beta');
  await Promise.all([qm.ready(), beta.ready()]);

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  await beta.waitFor<TeamView>((v) => v.pounce.open, 'pounce open');

  beta.send({ type: 'POUNCE', text: 'submitted before the drop' });
  await qm.waitFor<QmView>((v) => v.pounces.length === 1, 'the pounce');

  // Wifi dies.
  beta.socket.close();
  const again = new Client(`${base}/ws?token=${betaJoin.body.token}`, 'Beta again');
  await again.ready();

  // Back into the same question, with its own pounce still showing as submitted.
  const view = await again.waitFor<TeamView>((v) => v.question !== null, 'the question');
  assert.equal(view.pounce.submitted, true);
  assert.equal(view.pounce.yourText, 'submitted before the drop');

  // And the QM still sees exactly one pounce, not two.
  const qmView = await qm.waitFor<QmView>((v) => v.pounces.length === 1, 'still one pounce');
  assert.equal(qmView.pounces.length, 1);
});

// ─── The post-quiz breakdown ────────────────────────────────────────────────

/**
 * The report carries canonical answers and every team's private text, and the
 * quiz id is not a secret — it is in the public scoreboard URL. So the token is
 * the whole of the protection, and this is the test that says so.
 */
test('the breakdown refuses everyone but the quizmaster', async () => {
  const { quiz, creds } = await fixture();
  const url = `/api/quizzes/${quiz.id}/breakdown`;

  assert.equal((await getWith(url, {})).status, 403, 'no token');
  assert.equal((await getWith(url, { 'x-qm-token': 'not-the-token' })).status, 403);

  // A team session is a valid session for this quiz and must still be refused —
  // it is the case that would hand the answers to a player.
  const teamJoin = await call('POST', '/api/join', {
    code: creds.teams[0].join_code,
    displayName: 'A player',
  });
  assert.equal((await getWith(url, { 'x-qm-token': teamJoin.body.token })).status, 403);

  // A missing quiz answers exactly like a wrong token, so the response cannot
  // be used to confirm which quiz ids exist.
  const missing = await getWith('/api/quizzes/00000000-0000-0000-0000-000000000000/breakdown', {
    'x-qm-token': creds.qmToken,
  });
  assert.equal(missing.status, 403);

  // The quiz token opens it, and so does a live console session.
  assert.equal((await getWith(url, { 'x-qm-token': creds.qmToken })).status, 200);
  const qmJoin = await call('POST', '/api/join/qm', { qmToken: creds.qmToken });
  assert.equal((await getWith(url, { 'x-qm-token': qmJoin.body.token })).status, 200);
});

test('the breakdown reports where every point came from, and what was written', async () => {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Breakdown Test' })).body;
  createdQuizzes.push(quiz.id);
  for (const name of ['Alpha', 'Beta']) {
    await call('POST', `/api/quizzes/${quiz.id}/teams`, { name });
  }
  const round = (
    await call('POST', `/api/quizzes/${quiz.id}/rounds`, { type: 'WRITTEN', title: 'W1' })
  ).body;
  const question = (
    await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Written one?' })
  ).body;
  await call('PATCH', `/api/questions/${question.id}`, { answer_text: 'The right answer' });
  const creds = (await call('GET', `/api/quizzes/${quiz.id}/credentials`)).body;

  const qmJoin = await call('POST', '/api/join/qm', { qmToken: creds.qmToken });
  const alphaJoin = await call('POST', '/api/join', {
    code: creds.teams[0].join_code,
    displayName: 'Alpha player',
  });
  const qm = new Client(`${base}/ws?token=${qmJoin.body.token}`, 'QM');
  const alpha = new Client(`${base}/ws?token=${alphaJoin.body.token}`, 'Alpha');
  await Promise.all([qm.ready(), alpha.ready()]);

  qm.send({ type: 'ACTION', action: { type: 'SHOW_WRITTEN_QUESTION', index: 0 } });
  await alpha.waitFor<TeamView>((v) => v.written !== null, 'the written round');

  alpha.send({
    type: 'WRITTEN_ANSWER',
    questionId: question.id,
    text: 'Alpha wrote this, and staked it',
    staked: true,
  });
  await qm.waitFor<QmView>(
    (v) => (v.written?.answers.filter((a) => a.text !== null).length ?? 0) === 1,
    'the sheet',
  );

  qm.send({ type: 'ACTION', action: { type: 'CLOSE_COLLECTION' } });
  await qm.waitFor<QmView>((v) => v.written?.phase === 'EVALUATING', 'grading');
  qm.send({
    type: 'ACTION',
    action: {
      type: 'EVALUATE_WRITTEN',
      teamId: creds.teams[0].id,
      questionId: question.id,
      verdict: 'CORRECT',
      eventId: '',
    },
  });
  await qm.waitFor<QmView>(
    (v) => v.standings.find((s) => s.name === 'Alpha')?.provisionalScore === 15,
    'the staked award',
  );

  const report = (
    await getWith(`/api/quizzes/${quiz.id}/breakdown`, { 'x-qm-token': creds.qmToken })
  ).body;

  // Seat order, never score order: FORMAT_SPEC §3 leaves ranking to the QM, and
  // a report that sorted by score would be making that call for them.
  assert.deepEqual(report.standings.map((s: { name: string }) => s.name), ['Alpha', 'Beta']);

  // A written award is APPLIED the moment it is judged, unlike a pounce: there
  // is no bounce still running for a visible score to leak into (§2.2), so
  // nothing is withheld and the report has nothing to warn about.
  const alphaStanding = report.standings.find((s: { name: string }) => s.name === 'Alpha');
  assert.equal(alphaStanding.score, 15);
  assert.equal(alphaStanding.withheldPoints, 0);

  assert.equal(report.events.length, 1);
  assert.equal(report.events[0].points, 15);
  assert.equal(report.events[0].reason, 'STAKE_CORRECT');
  assert.equal(report.events[0].status, 'APPLIED');
  assert.equal(report.events[0].roundTitle, 'W1');
  assert.equal(report.events[0].questionIndex, 0);

  // And what they actually wrote, with the canonical answer beside it.
  assert.equal(report.submissions.length, 1);
  assert.deepEqual(
    {
      team: report.submissions[0].teamName,
      kind: report.submissions[0].kind,
      staked: report.submissions[0].staked,
      body: report.submissions[0].body,
      verdict: report.submissions[0].verdict,
      answer: report.submissions[0].answerText,
    },
    {
      team: 'Alpha',
      kind: 'WRITTEN',
      staked: true,
      body: 'Alpha wrote this, and staked it',
      verdict: 'CORRECT',
      answer: 'The right answer',
    },
  );
});

/**
 * Undoing a move on the bounce, live.
 *
 * The engine test proves the state goes back. This one proves the room does:
 * the team that was wrongly passed over has to be told it is their turn again,
 * because in the room they have already stopped talking.
 */
test('a misclicked bounce can be stepped back, on every screen', async () => {
  const { question, creds } = await fixture();

  const [qmJoin, ...teamJoins] = await Promise.all([
    call('POST', '/api/join/qm', { qmToken: creds.qmToken }),
    ...creds.teams.map((t: { join_code: string; name: string }) =>
      call('POST', '/api/join', { code: t.join_code, displayName: `${t.name} player` }),
    ),
  ]);
  const qm = new Client(`${base}/ws?token=${qmJoin.body.token}`, 'QM');
  const teams = teamJoins.map(
    (j, i) => new Client(`${base}/ws?token=${j.body.token}`, creds.teams[i].name),
  );
  await Promise.all([qm.ready(), ...teams.map((t) => t.ready())]);
  const [alpha, beta] = teams as [Client, Client];

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_BOUNCE' } });
  await alpha.waitFor<TeamView>((v) => v.bounce.onYou, "Alpha's turn");

  // The misclick.
  qm.send({ type: 'ACTION', action: { type: 'BOUNCE_WRONG' } });
  await beta.waitFor<TeamView>((v) => v.bounce.onYou, "Beta's turn");

  qm.send({ type: 'ACTION', action: { type: 'REWIND_BOUNCE' } });

  const back = await qm.waitFor<QmView>((v) => v.bounce.onTeamName === 'Alpha', 'the rewind');
  assert.equal(back.phase, 'BOUNCE');
  await alpha.waitFor<TeamView>((v) => v.bounce.onYou, "Alpha's turn again");
  await beta.waitFor<TeamView>((v) => !v.bounce.onYou, 'Beta stood down');

  // Beta is offerable again rather than struck off, so the next wrong answer
  // walks to them exactly as it would have.
  assert.equal(back.bounce.order.find((t) => t.name === 'Beta')?.offered, false);
  qm.send({ type: 'ACTION', action: { type: 'BOUNCE_WRONG' } });
  await beta.waitFor<TeamView>((v) => v.bounce.onYou, 'Beta again');
});
