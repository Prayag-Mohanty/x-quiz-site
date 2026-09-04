/**
 * Authoring API tests.
 *
 * These hit a real Postgres — the schema is doing most of the validation, so a
 * mock would test nothing worth testing. Each test creates its own quiz and
 * deletes it afterwards, so the suite is safe to run against the dev database.
 *
 *   pnpm --filter @quizmaster/server test     (or: npm test)
 *
 * Requires DATABASE_URL. See packages/db/README.md for a disposable cluster.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

let app: FastifyInstance;
const createdQuizzes: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  for (const id of createdQuizzes) {
    await pool.query('DELETE FROM quiz WHERE id = $1', [id]).catch(() => undefined);
  }
  await app.close();
  await pool.end();
});

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  const text = res.body;
  return { status: res.statusCode, body: text ? JSON.parse(text) : null };
}

async function newQuiz(title = 'Test Quiz'): Promise<string> {
  const res = await call('POST', '/api/quizzes', { title });
  assert.equal(res.status, 201);
  createdQuizzes.push(res.body.id);
  return res.body.id;
}

async function addTeams(quizId: string, names: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const name of names) {
    const res = await call('POST', `/api/quizzes/${quizId}/teams`, { name });
    assert.equal(res.status, 201);
    ids.push(res.body.id);
  }
  return ids;
}

// ─── Creation ───────────────────────────────────────────────────────────────

test('a new quiz is seeded with the connect decay curve', async () => {
  const id = await newQuiz('Decay Curve Quiz');
  const { body } = await call('GET', `/api/quizzes/${id}`);
  assert.deepEqual(
    body.connectStages.map((s: any) => [s.correct, s.wrong]),
    [[20, -15], [15, -10], [10, -5], [5, 0]],
  );
});

test('a quiz needs a title', async () => {
  const res = await call('POST', '/api/quizzes', { title: '   ' });
  assert.equal(res.status, 422);
});

// ─── Team seating — the load-bearing one ────────────────────────────────────

test('teams are seated in the order they are added', async () => {
  const id = await newQuiz();
  await addTeams(id, ['Alpha', 'Beta', 'Gamma']);
  const { body } = await call('GET', `/api/quizzes/${id}`);
  assert.deepEqual(
    body.teams.map((t: any) => [t.position, t.name]),
    [[0, 'Alpha'], [1, 'Beta'], [2, 'Gamma']],
  );
});

test('deleting a team renumbers the seats so no gap is left', async () => {
  const id = await newQuiz();
  const [, beta] = await addTeams(id, ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.equal((await call('DELETE', `/api/teams/${beta}`)).status, 204);

  const { body } = await call('GET', `/api/quizzes/${id}`);
  assert.deepEqual(
    body.teams.map((t: any) => [t.position, t.name]),
    [[0, 'Alpha'], [1, 'Gamma'], [2, 'Delta']],
  );
  // A gap here would break rotation silently, so the readiness view watches it.
  assert.equal(
    body.issues.some((i: any) => i.issue.includes('not contiguous')),
    false,
  );
});

test('reordering teams reseats them in one transaction', async () => {
  const id = await newQuiz();
  const [a, b, c] = await addTeams(id, ['Alpha', 'Beta', 'Gamma']);
  // A straight swap of two positions is only legal because the unique is
  // DEFERRABLE and checked at COMMIT.
  const res = await call('POST', `/api/quizzes/${id}/teams/reorder`, { order: [c, a, b] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((t: any) => t.name), ['Gamma', 'Alpha', 'Beta']);
});

test('a partial reorder is refused rather than leaving a gap', async () => {
  const id = await newQuiz();
  const [a] = await addTeams(id, ['Alpha', 'Beta', 'Gamma']);
  const res = await call('POST', `/api/quizzes/${id}/teams/reorder`, { order: [a] });
  assert.equal(res.status, 422);
});

test('two teams in one quiz cannot share a name', async () => {
  const id = await newQuiz();
  await addTeams(id, ['Alpha']);
  const res = await call('POST', `/api/quizzes/${id}/teams`, { name: 'Alpha' });
  // 422, not the generic 409 for a unique violation: describeDbError recognises
  // this constraint by name and turns it into a sentence the UI can show.
  assert.equal(res.status, 422);
  assert.match(res.body.message, /share a name/);
});

// ─── Rounds — FORMAT_SPEC §2.1 ──────────────────────────────────────────────

test('a DIRECT round defaults to clockwise', async () => {
  const id = await newQuiz();
  const res = await call('POST', `/api/quizzes/${id}/rounds`, { type: 'DIRECT', title: 'R1' });
  assert.equal(res.status, 201);
  assert.equal(res.body.direction, 'CW');
});

test('a non-DIRECT round with a direction is refused, not silently corrected', async () => {
  const id = await newQuiz();
  const res = await call('POST', `/api/quizzes/${id}/rounds`, {
    type: 'WRITTEN',
    title: 'Written',
    direction: 'CW',
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /Only a DIRECT round/);
});

test('a written round has no direction', async () => {
  const id = await newQuiz();
  const res = await call('POST', `/api/quizzes/${id}/rounds`, { type: 'WRITTEN', title: 'W' });
  assert.equal(res.status, 201);
  assert.equal(res.body.direction, null);
});

// ─── Questions and parts ────────────────────────────────────────────────────

test('a DIRECT question is created with a part, so it is scorable immediately', async () => {
  const id = await newQuiz();
  const round = (await call('POST', `/api/quizzes/${id}/rounds`, { type: 'DIRECT', title: 'R1' }))
    .body;
  const q = (await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Q?' })).body;

  const { body } = await call('GET', `/api/quizzes/${id}`);
  const parts = body.parts.filter((p: any) => p.question_id === q.id);
  assert.equal(parts.length, 1);
  // The engine divides questionValue by parts.length; zero parts is unscorable.
  assert.equal(
    body.issues.some((i: any) => i.issue.includes('no parts')),
    false,
  );
});

test('deleting a part renumbers the rest', async () => {
  const id = await newQuiz();
  const round = (await call('POST', `/api/quizzes/${id}/rounds`, { type: 'DIRECT', title: 'R1' }))
    .body;
  const q = (await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Q?' })).body;
  const b = (await call('POST', `/api/questions/${q.id}/parts`, { label: 'B' })).body;
  await call('POST', `/api/questions/${q.id}/parts`, { label: 'C' });

  assert.equal((await call('DELETE', `/api/parts/${b.id}`)).status, 204);
  const { body } = await call('GET', `/api/quizzes/${id}`);
  const parts = body.parts
    .filter((p: any) => p.question_id === q.id)
    .sort((x: any, y: any) => x.position - y.position);
  assert.deepEqual(parts.map((p: any) => [p.position, p.label]), [[0, 'Answer'], [1, 'C']]);
});

test('a PATCH cannot write a column outside the allow-list', async () => {
  const id = await newQuiz();
  const before = (await call('GET', `/api/quizzes/${id}`)).body.quiz;
  // `id` is not in the allow-list, so this must be ignored rather than obeyed.
  const res = await call('PATCH', `/api/quizzes/${id}`, {
    id: '00000000-0000-0000-0000-000000000000',
    title: 'Renamed',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.id, before.id);
  assert.equal(res.body.title, 'Renamed');
});

// ─── Scoring configuration ──────────────────────────────────────────────────

test('a correct answer cannot be made to cost points', async () => {
  const id = await newQuiz();
  const res = await call('PATCH', `/api/quizzes/${id}`, { direct_bounce_correct: -5 });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /cannot cost points/);
});

test('scoring values can be changed within the rules', async () => {
  const id = await newQuiz();
  const res = await call('PATCH', `/api/quizzes/${id}`, {
    direct_pounce_correct: 15,
    direct_pounce_wrong: -10,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.direct_pounce_correct, 15);
  assert.equal(res.body.direct_pounce_wrong, -10);
});

// ─── Loading as engine state ────────────────────────────────────────────────

test('an authored quiz loads as engine state through the mappers', async () => {
  const id = await newQuiz('Loadable Quiz');
  await addTeams(id, ['Alpha', 'Beta', 'Gamma', 'Delta']);
  const round = (
    await call('POST', `/api/quizzes/${id}/rounds`, { type: 'DIRECT', title: 'Round 1' })
  ).body;
  const q = (await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Two-part?' })).body;
  await call('PATCH', `/api/questions/${q.id}`, { answer_text: 'A and B' });
  await call('POST', `/api/questions/${q.id}/parts`, { label: 'Part B' });

  const { status, body: state } = await call('GET', `/api/quizzes/${id}/state`);
  assert.equal(status, 200);
  assert.deepEqual(state.teams.map((t: any) => t.name), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.equal(state.rounds[0].direction, 'CW');
  assert.equal(state.rounds[0].questions[0].text, 'Two-part?');
  assert.equal(state.rounds[0].questions[0].parts.length, 2);
  // Nothing has been played yet.
  assert.equal(state.active, null);
  assert.equal(state.ledger.length, 0);
  assert.equal(state.nextDirectTeamIdx, 0);
});

test('a quiz with one team is flagged as not ready to run', async () => {
  const id = await newQuiz();
  await addTeams(id, ['Alpha']);
  const { body: issues } = await call('GET', `/api/quizzes/${id}/issues`);
  assert.equal(
    issues.some((i: any) => i.severity === 'ERROR' && i.issue.includes('teams')),
    true,
  );
});

test('an unknown quiz is a 404, not a crash', async () => {
  const res = await call('GET', '/api/quizzes/00000000-0000-0000-0000-000000000000');
  assert.equal(res.status, 404);
});
