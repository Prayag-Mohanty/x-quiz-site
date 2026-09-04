/**
 * The socket layer, end to end.
 *
 * A real listening server, real WebSocket clients, a real database. The view
 * tests prove the projections are correct in isolation; these prove the right
 * projection reaches the right socket, which is a different mistake to make and
 * the one that would actually leak.
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
  const address = app.server.address() as AddressInfo;
  base = `ws://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const socket of openSockets) socket.close();
  // Removing a played quiz means dismantling its audit trail, which the schema
  // deliberately prevents: quiz_action and score_event hold it with ON DELETE
  // RESTRICT, and a trigger refuses to delete ledger rows at all. Test data is
  // the one legitimate reason to override that, so it is done explicitly and
  // the trigger is put straight back. Without this the deletes fail silently
  // and every run leaves another quiz behind.
  await pool
    .query('ALTER TABLE score_event DISABLE TRIGGER score_event_append_only')
    .catch(() => undefined);
  for (const id of createdQuizzes) {
    for (const sql of [
      'DELETE FROM quiz_action WHERE quiz_id = $1',
      'DELETE FROM score_event WHERE quiz_id = $1',
      'DELETE FROM session WHERE quiz_id = $1',
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

/**
 * A socket that remembers everything it was ever sent.
 *
 * Waiting for "the next message" races: joining, presence changes and other
 * teams' actions all broadcast, so a test can be handed a state that is merely
 * the newest rather than the one it wants. So instead: wait until some received
 * state SATISFIES A PREDICATE — and for leak checks, assert against the whole
 * history, because a secret that arrived once and was superseded still leaked.
 */
class Client {
  private received: ServerMessage[] = [];
  private listeners: (() => void)[] = [];
  readonly socket: WebSocket;

  constructor(url: string) {
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

  private async until<T>(pick: () => T | undefined, what: string, timeoutMs = 5000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = pick();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.listeners.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The most recent state satisfying `pred`, waiting for one if needed. */
  waitForState<V extends TeamView | QmView>(
    pred: (view: V) => boolean,
    what = 'a matching state',
  ): Promise<V> {
    return this.until(() => {
      for (let i = this.received.length - 1; i >= 0; i--) {
        const message = this.received[i];
        if (message?.type === 'STATE' && pred(message.view as V)) return message.view as V;
      }
      return undefined;
    }, what);
  }

  waitForError(): Promise<string> {
    return this.until(() => {
      const found = this.received.find((m) => m.type === 'ERROR');
      return found && found.type === 'ERROR' ? found.message : undefined;
    }, 'an error');
  }

  /** Did this socket EVER receive these bytes? The strongest form of the question. */
  everReceived(needle: string): boolean {
    return this.received.some((m) => JSON.stringify(m).includes(needle));
  }

  /** Let in-flight broadcasts land before asserting a negative. */
  async quiet(ms = 300): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }
}

/** A quiz with four teams, one DIRECT round and one two-part question. */
async function fixture() {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Socket Test' })).body;
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
  await call('PATCH', `/api/questions/${question.id}`, { answer_text: 'Cream / Disraeli Gears' });
  await call('POST', `/api/questions/${question.id}/parts`, { label: 'Album' });

  const creds = (await call('GET', `/api/quizzes/${quiz.id}/credentials`)).body;
  return { quiz, round, question, creds };
}

async function joinTeam(code: string, name: string): Promise<Client> {
  const res = await call('POST', '/api/join', { code, displayName: name });
  assert.equal(res.status, 200);
  const client = new Client(`${base}/ws?token=${res.body.token}`);
  await client.ready();
  return client;
}

async function joinQm(qmToken: string): Promise<Client> {
  const res = await call('POST', '/api/join/qm', { qmToken });
  assert.equal(res.status, 200);
  const client = new Client(`${base}/ws?token=${res.body.token}`);
  await client.ready();
  return client;
}

// ─── Joining ────────────────────────────────────────────────────────────────

test('a team joins with a code and immediately receives the full state', async () => {
  const { creds } = await fixture();
  const alpha = await joinTeam(creds.teams[0].join_code, 'Prayag');

  const view = await alpha.waitForState<TeamView>((v) => v.role === 'TEAM');
  assert.equal(view.you.teamName, 'Alpha');
  assert.equal(view.question, null); // nothing presented yet
  assert.equal(view.standings.length, 4);
});

test('a wrong code is refused without confirming which codes exist', async () => {
  const res = await call('POST', '/api/join', { code: 'NOPE9999', displayName: 'Someone' });
  assert.equal(res.status, 404);
  assert.match(res.body.message, /No team with that code/);
});

test('a socket with no valid session is closed, not served', async () => {
  const client = new Client(`${base}/ws?token=not-a-real-token`);
  await client.ready();
  assert.match(await client.waitForError(), /not valid/);
});

// ─── The role comes from the session, never the client ──────────────────────

test('a team socket cannot drive the quiz, whatever it sends', async () => {
  const { creds, question } = await fixture();
  const alpha = await joinTeam(creds.teams[0].join_code, 'Prayag');
  await alpha.waitForState<TeamView>((v) => v.role === 'TEAM');

  alpha.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });

  assert.match(await alpha.waitForError(), /Only the quizmaster/);
  // And the quiz did not move: the question was never presented.
  await alpha.quiet();
  assert.equal(alpha.everReceived('Name the band and album.'), false);
});

test('a pounce is attributed from the session, not from the message', async () => {
  const { creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);
  const beta = await joinTeam(creds.teams[1].join_code, 'Beta player');

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  await beta.waitForState<TeamView>((v) => v.pounce.open);

  // Beta claims to be Alpha in the payload. The server never reads that field —
  // it knows which team this socket is, because the token said so.
  beta.send({ type: 'POUNCE', text: 'Led Zeppelin', teamId: creds.teams[0].id });

  const qmView = await qm.waitForState<QmView>((v) => v.pounces.length === 1);
  assert.equal(qmView.pounces[0]?.teamName, 'Beta');
});

// ─── Written-blind pounces, over the real wire ──────────────────────────────

test("a team's pounce text never reaches another team's socket", async () => {
  const { creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);
  const alpha = await joinTeam(creds.teams[0].join_code, 'A');
  const beta = await joinTeam(creds.teams[1].join_code, 'B');

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  await beta.waitForState<TeamView>((v) => v.pounce.open);

  const SECRET = 'Cream, and the album is Disraeli Gears';
  beta.send({ type: 'POUNCE', text: SECRET });
  await qm.waitForState<QmView>((v) => v.pounces.length === 1);

  // Closing lets the QM read it. None of that should reach Alpha.
  qm.send({ type: 'ACTION', action: { type: 'CLOSE_POUNCE' } });
  // `!== null` would also match a state with no pounces at all, since
  // `undefined !== null`. Ask for the text itself.
  const qmView = await qm.waitForState<QmView>(
    (v) => typeof v.pounces[0]?.text === 'string',
  );
  assert.equal(qmView.pounces[0]?.text, SECRET);

  await alpha.quiet();
  // Not "Alpha's current view omits it" — Alpha's socket never carried it once.
  assert.equal(alpha.everReceived(SECRET), false);

  // Beta gets its own words back; it typed them.
  const betaView = await beta.waitForState<TeamView>((v) => v.pounce.yourText !== null);
  assert.equal(betaView.pounce.yourText, SECRET);
});

test('the answer never reaches a team before the reveal', async () => {
  const { creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);
  const alpha = await joinTeam(creds.teams[0].join_code, 'A');

  for (const action of [
    { type: 'PRESENT_QUESTION' as const, questionId: question.id },
    { type: 'OPEN_POUNCE' as const },
    { type: 'CLOSE_POUNCE' as const },
    { type: 'FINISH_POUNCE_EVALUATION' as const },
    { type: 'OPEN_BOUNCE' as const },
  ]) {
    qm.send({ type: 'ACTION', action });
  }
  await alpha.waitForState<TeamView>((v) => v.bounce.active);

  await alpha.quiet();
  assert.equal(alpha.everReceived('Disraeli Gears'), false);

  qm.send({ type: 'ACTION', action: { type: 'BOUNCE_CORRECT', eventId: 'server-mints-this' } });
  qm.send({ type: 'ACTION', action: { type: 'REVEAL_ANSWER' } });

  const revealed = await alpha.waitForState<TeamView>((v) => v.reveal !== null);
  assert.equal(revealed.reveal?.text, 'Cream / Disraeli Gears');
});

// ─── Reconnection ───────────────────────────────────────────────────────────

test('a team that drops mid-pounce reconnects into the exact current state', async () => {
  const { creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);
  const alpha = await joinTeam(creds.teams[0].join_code, 'A');

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  await alpha.waitForState<TeamView>((v) => v.pounce.open);

  // Wifi drops. Same person, new socket.
  alpha.socket.close();
  const res = await call('POST', '/api/join', {
    code: creds.teams[0].join_code,
    displayName: 'A',
  });
  const reconnected = new Client(`${base}/ws?token=${res.body.token}`);
  await reconnected.ready();

  // Straight back into the open pounce window, question and all. No replay on
  // the client, no delta to have missed.
  const view = await reconnected.waitForState<TeamView>((v) => v.role === 'TEAM');
  assert.equal(view.phase, 'POUNCE_OPEN');
  assert.equal(view.pounce.open, true);
  assert.equal(view.question?.text, 'Name the band and album.');
  assert.equal(view.you.teamName, 'Alpha');
});

// ─── Persistence and recovery ───────────────────────────────────────────────

test('actions are persisted, and a dropped room rebuilds from the log', async () => {
  const { quiz, creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);

  qm.send({ type: 'ACTION', action: { type: 'PRESENT_QUESTION', questionId: question.id } });
  qm.send({ type: 'ACTION', action: { type: 'OPEN_POUNCE' } });
  qm.send({ type: 'ACTION', action: { type: 'CLOSE_POUNCE' } });
  await qm.waitForState<QmView>((v) => v.phase === 'POUNCE_CLOSED');

  const { rows } = await pool.query(
    'SELECT type FROM quiz_action WHERE quiz_id = $1 ORDER BY seq',
    [quiz.id],
  );
  assert.deepEqual(
    rows.map((r: { type: string }) => r.type),
    ['PRESENT_QUESTION', 'OPEN_POUNCE', 'CLOSE_POUNCE'],
  );

  // The server restarts: everything held in memory is gone.
  evictAllRooms();

  const rejoined = await joinQm(creds.qmToken);
  // Rebuilt purely by replaying the log through the pure reducer.
  const view = await rejoined.waitForState<QmView>((v) => v.role === 'QM');
  assert.equal(view.phase, 'POUNCE_CLOSED');
});

// ─── The ledger reaches Postgres ────────────────────────────────────────────

test('a withheld partial is stored as PENDING and stays off a team scoreboard', async () => {
  const { quiz, creds, question } = await fixture();
  const qm = await joinQm(creds.qmToken);
  const beta = await joinTeam(creds.teams[1].join_code, 'B');

  for (const action of [
    { type: 'PRESENT_QUESTION' as const, questionId: question.id },
    { type: 'OPEN_POUNCE' as const },
    { type: 'CLOSE_POUNCE' as const },
    { type: 'FINISH_POUNCE_EVALUATION' as const },
    { type: 'OPEN_BOUNCE' as const },
  ]) {
    qm.send({ type: 'ACTION', action });
  }

  const bouncing = await qm.waitForState<QmView>((v) => v.bounce.active);
  const firstPart = bouncing.answer?.parts[0];
  assert.ok(firstPart);

  // Alpha, the direct team, gets one part of two. The eventId here is junk on
  // purpose: the server mints its own and must not honour a client's.
  qm.send({
    type: 'ACTION',
    action: { type: 'BOUNCE_PARTIAL', partIds: [firstPart.id], eventId: 'client-supplied' },
  });
  await qm.waitForState<QmView>((v) => v.standings.some((s) => s.withheldPoints > 0));

  const stored = await pool.query(
    "SELECT id, points, reason, status FROM score_event WHERE quiz_id = $1 AND reason = 'PARTIAL'",
    [quiz.id],
  );
  assert.equal(stored.rows.length, 1);
  assert.equal(stored.rows[0].status, 'PENDING');
  assert.equal(stored.rows[0].points, 5);
  assert.notEqual(stored.rows[0].id, 'client-supplied');

  // And Beta cannot see Alpha's score move, which is the entire point.
  await beta.quiet();
  const betaView = await beta.waitForState<TeamView>((v) => v.bounce.active);
  assert.equal(betaView.standings.find((s) => s.name === 'Alpha')?.score, 0);
});
