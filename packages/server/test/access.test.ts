/**
 * Who may reach the authoring API.
 *
 * This is the test that decides whether the server can be exposed at all. The
 * authoring API reads every canonical answer and hands out join codes and the
 * quizmaster token, and the quiz id is public — it is in the scoreboard URL. So
 * "the answers are behind something" is the property, and it has to hold for
 * the exact paths a curious player would try.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

let app: FastifyInstance;
let quizId = '';

before(async () => {
  app = await buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/api/quizzes',
    payload: { title: 'Access Test' },
  });
  quizId = JSON.parse(res.body).id;
});

after(async () => {
  delete process.env['ADMIN_TOKEN'];
  await pool.query('DELETE FROM quiz WHERE id = $1', [quizId]).catch(() => undefined);
  await app.close();
  await pool.end();
});

/** app.inject() reports 127.0.0.1, so this is the local-machine case. */
const local = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

/** An address that is not loopback — a team on the wifi, or through a tunnel. */
const remote = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers, remoteAddress: '10.0.0.7' });

test('with no ADMIN_TOKEN, authoring answers the local machine and nobody else', async () => {
  delete process.env['ADMIN_TOKEN'];

  assert.equal((await local('/api/quizzes')).statusCode, 200);
  assert.equal((await local(`/api/quizzes/${quizId}/state`)).statusCode, 200);

  // The two that would hand a player the quiz: full state carries the canonical
  // answers, credentials carries the quizmaster token and every join code.
  assert.equal((await remote(`/api/quizzes/${quizId}/state`)).statusCode, 401);
  assert.equal((await remote(`/api/quizzes/${quizId}/credentials`)).statusCode, 401);
  assert.equal((await remote('/api/quizzes')).statusCode, 401);

  // Writes too, not just reads.
  const write = await app.inject({
    method: 'POST',
    url: '/api/quizzes',
    payload: { title: 'Should not exist' },
    remoteAddress: '10.0.0.7',
  });
  assert.equal(write.statusCode, 401);
});

test('the paths players actually use stay open from anywhere', async () => {
  delete process.env['ADMIN_TOKEN'];

  assert.equal((await remote('/api/health')).statusCode, 200);

  // Joining is behind a join code, which is the credential for that door.
  const join = await app.inject({
    method: 'POST',
    url: '/api/join',
    payload: { code: 'NOSUCHCODE', displayName: 'Someone' },
    remoteAddress: '10.0.0.7',
  });
  assert.notEqual(join.statusCode, 401, 'joining must not be behind the admin token');

  // The breakdown is reachable and refuses on its own terms — 403 from its own
  // token check, never 401 from this hook.
  const breakdown = await remote(`/api/quizzes/${quizId}/breakdown`);
  assert.equal(breakdown.statusCode, 403);
});

test('ADMIN_TOKEN replaces the loopback rule in both directions', async () => {
  process.env['ADMIN_TOKEN'] = 'the-secret';

  // Set, the token is what counts — a remote browser with it may author.
  assert.equal((await remote('/api/quizzes', { 'x-admin-token': 'the-secret' })).statusCode, 200);
  assert.equal((await remote('/api/quizzes', { 'x-admin-token': 'wrong' })).statusCode, 401);

  // And being local is no longer enough on its own. That is the point: a
  // quizmaster who sets a token has decided the machine is not the credential.
  assert.equal((await local('/api/quizzes')).statusCode, 401);
  assert.equal((await local('/api/quizzes', { 'x-admin-token': 'the-secret' })).statusCode, 200);

  delete process.env['ADMIN_TOKEN'];
});
