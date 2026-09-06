/**
 * Media upload.
 *
 * Uses real multipart bodies against a real database, because the interesting
 * failures are all at that boundary: a rejected row leaving an orphaned file,
 * a format rule the database enforces rather than the route, and the URL the
 * mapper builds having to match where the file is actually served from.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { UPLOAD_DIR } from '../src/uploads.js';

let app: FastifyInstance;
const createdQuizzes: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  // Delete the files too, not only the rows. Uploads are real bytes on disk and
  // a suite that leaves them behind grows the directory on every run.
  for (const id of createdQuizzes) {
    const { rows } = await pool
      .query<{ storage_key: string }>('SELECT storage_key FROM media_asset WHERE quiz_id = $1', [id])
      .catch(() => ({ rows: [] as { storage_key: string }[] }));
    for (const row of rows) {
      await unlink(join(UPLOAD_DIR, row.storage_key)).catch(() => undefined);
      // Every uploaded asset is also sealed for preloading, which writes a
      // second file beside it. Leaving those behind would slowly fill the
      // uploads directory with ciphertext for quizzes that no longer exist.
      await unlink(join(UPLOAD_DIR, `${row.storage_key}.sealed`)).catch(() => undefined);
    }
  }
  for (const id of createdQuizzes) {
    for (const sql of [
      'DELETE FROM question_media WHERE question_id IN (SELECT q.id FROM question q JOIN round r ON r.id = q.round_id WHERE r.quiz_id = $1)',
      'DELETE FROM media_asset WHERE quiz_id = $1',
      'DELETE FROM session WHERE quiz_id = $1',
      'DELETE FROM quiz WHERE id = $1',
    ]) {
      await pool.query(sql, [id]).catch(() => undefined);
    }
  }
  await app.close();
  await pool.end();
});

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** A real multipart body — a one-pixel PNG is enough to be a genuine image. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(
  questionId: string,
  role: string,
  opts: { filename?: string; contentType?: string; body?: Buffer } = {},
) {
  const boundary = '----quizmastertest';
  const filename = opts.filename ?? 'photo.png';
  const contentType = opts.contentType ?? 'image/png';
  const body = opts.body ?? PNG;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    ),
    body,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await app.inject({
    method: 'POST',
    url: `/api/questions/${questionId}/media?role=${role}`,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

/** The common case: one PNG on a question, as a PROMPT. */
const upload_ = (questionId: string) => upload(questionId, 'PROMPT', { filename: 'secret.png' });

async function fixture(roundType: 'DIRECT' | 'VISUAL_CONNECT' = 'DIRECT') {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Media Test' })).body;
  createdQuizzes.push(quiz.id);
  await call('POST', `/api/quizzes/${quiz.id}/teams`, { name: 'Alpha' });
  await call('POST', `/api/quizzes/${quiz.id}/teams`, { name: 'Beta' });
  const round = (
    await call('POST', `/api/quizzes/${quiz.id}/rounds`, {
      type: roundType,
      title: 'R1',
      ...(roundType === 'DIRECT' ? { direction: 'CW' } : {}),
    })
  ).body;
  const question = (
    await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Which building?' })
  ).body;
  return { quiz, round, question };
}

test('an image can be attached to a question and is served back', async () => {
  const { question } = await fixture();
  const res = await upload(question.id, 'PROMPT');
  assert.equal(res.status, 201);
  assert.equal(res.body.asset.kind, 'IMAGE');
  assert.equal(res.body.asset.original_filename, 'photo.png');

  // The URL the mapper builds must be where the file actually is, or every
  // question with a picture renders a broken image.
  const served = await app.inject({ method: 'GET', url: `/media/${res.body.asset.storage_key}` });
  assert.equal(served.statusCode, 200);
  assert.equal(served.rawPayload.length, PNG.length);
});

test('the stored filename is not the uploaded one', async () => {
  const { question } = await fixture();
  const res = await upload(question.id, 'PROMPT', { filename: '../../etc/passwd.png' });
  assert.equal(res.status, 201);
  // A caller-supplied name is a path traversal waiting to happen.
  assert.equal(res.body.asset.storage_key.includes('..'), false);
  assert.equal(res.body.asset.storage_key.includes('/'), false);
  assert.match(res.body.asset.storage_key, /^[0-9a-f-]{36}\.png$/);
  // Two layers agree here: busboy strips the directory part before the route
  // ever sees the name, AND the stored key is generated rather than derived
  // from it. Either alone would be enough; both is the point.
  assert.equal(res.body.asset.original_filename, 'passwd.png');
});

test('a non-media file is refused', async () => {
  const { question } = await fixture();
  const res = await upload(question.id, 'PROMPT', {
    filename: 'notes.txt',
    contentType: 'text/plain',
    body: Buffer.from('hello'),
  });
  assert.equal(res.status, 422);
  assert.match(res.body.message, /not an image, audio or video/);
});

test('several images on one question, in order', async () => {
  const { question } = await fixture();
  await upload(question.id, 'PROMPT', { filename: 'one.png' });
  await upload(question.id, 'PROMPT', { filename: 'two.png' });
  const listed = (await call('GET', `/api/questions/${question.id}/media`)).body;
  assert.deepEqual(
    listed.map((m: { position: number; original_filename: string }) => [
      m.position,
      m.original_filename,
    ]),
    [[0, 'one.png'], [1, 'two.png']],
  );
});

// ─── The rules the database enforces — FORMAT_SPEC §4 and §2.3 ──────────────

test('a second video on the same question is refused, and leaves no orphan file', async () => {
  const { question } = await fixture();
  const first = await upload(question.id, 'PROMPT', {
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    body: Buffer.from('fake video bytes'),
  });
  assert.equal(first.status, 201);

  const before = (await readdir(UPLOAD_DIR)).length;
  const second = await upload(question.id, 'PROMPT', {
    filename: 'another.mp4',
    contentType: 'video/mp4',
    body: Buffer.from('more fake video'),
  });
  assert.equal(second.status, 422);
  assert.match(second.body.message, /at most one video/i);

  // The row was refused after the bytes were written; the file must not survive.
  assert.equal((await readdir(UPLOAD_DIR)).length, before);
});

test('the answer slide may have its own video even when the prompt has one', async () => {
  const { question } = await fixture();
  const prompt = await upload(question.id, 'PROMPT', {
    filename: 'q.mp4',
    contentType: 'video/mp4',
    body: Buffer.from('prompt video'),
  });
  assert.equal(prompt.status, 201);
  const answer = await upload(question.id, 'ANSWER', {
    filename: 'a.mp4',
    contentType: 'video/mp4',
    body: Buffer.from('answer video'),
  });
  assert.equal(answer.status, 201);
});

test('a staged reveal is refused on a question that is not a visual connect', async () => {
  const { question } = await fixture('DIRECT');
  const res = await upload(question.id, 'REVEAL');
  assert.equal(res.status, 422);
  assert.match(res.body.message, /long visual connect/i);
});

test('a staged reveal is accepted on a visual connect question', async () => {
  const { question } = await fixture('VISUAL_CONNECT');
  const res = await upload(question.id, 'REVEAL');
  assert.equal(res.status, 201);
});

// ─── Removing ───────────────────────────────────────────────────────────────

test('detaching media deletes the file and renumbers what is left', async () => {
  const { question } = await fixture();
  await upload(question.id, 'PROMPT', { filename: 'one.png' });
  const middle = await upload(question.id, 'PROMPT', { filename: 'two.png' });
  await upload(question.id, 'PROMPT', { filename: 'three.png' });

  const key = middle.body.asset.storage_key;
  assert.equal((await app.inject({ method: 'GET', url: `/media/${key}` })).statusCode, 200);

  const removed = await call('DELETE', `/api/question-media/${middle.body.link.id}`);
  assert.equal(removed.status, 204);

  assert.equal((await app.inject({ method: 'GET', url: `/media/${key}` })).statusCode, 404);
  const listed = (await call('GET', `/api/questions/${question.id}/media`)).body;
  assert.deepEqual(
    listed.map((m: { position: number; original_filename: string }) => [
      m.position,
      m.original_filename,
    ]),
    [[0, 'one.png'], [1, 'three.png']],
  );
});

test('a question with media loads as engine state with a playable URL', async () => {
  const { quiz, question } = await fixture();
  const uploaded = await upload(question.id, 'PROMPT', { filename: 'scene.png' });

  const state = (await call('GET', `/api/quizzes/${quiz.id}/state`)).body;
  const media = state.rounds[0].questions[0].media;
  assert.equal(media.length, 1);
  assert.equal(media[0].kind, 'IMAGE');
  assert.equal(media[0].url, `/media/${uploaded.body.asset.storage_key}`);
});

// ─── Sealed preload ─────────────────────────────────────────────────────────

/**
 * The bytes travel early, the key travels late.
 *
 * This is the property the whole feature rests on: a client may hold every
 * image in the round before any of it is asked, and be unable to read a single
 * one. If the sealed endpoint ever returned plaintext, preloading would hand a
 * team the visual connect.
 */
test('the sealed copy is not the file, and the plain URL is not derivable from it', async () => {
  const { question } = await fixture();
  const upload = await upload_(question.id);
  assert.equal(upload.status, 201);

  const { rows } = await pool.query(
    'SELECT id, storage_key, preload_id, preload_key FROM media_asset WHERE id = $1',
    [upload.body.asset.id],
  );
  const asset = rows[0];

  // Sealed on upload, so the views can hand a key out synchronously later.
  assert.ok(asset.preload_key, 'the asset was not sealed on upload');
  // The two identifiers are unrelated: holding one tells you nothing about the
  // other, and the plaintext URL is an unguessable uuid.
  assert.notEqual(asset.preload_id, asset.storage_key);
  assert.equal(asset.storage_key.includes(asset.preload_id), false);

  const sealed = await app.inject({ method: 'GET', url: `/media/sealed/${asset.preload_id}` });
  assert.equal(sealed.statusCode, 200);
  assert.equal(sealed.headers['content-type'], 'application/octet-stream');

  const ciphertext = sealed.rawPayload;
  // Longer than the original by the nonce and the tag, and nothing like it.
  assert.equal(ciphertext.length, PNG.length + 12 + 16);
  assert.equal(ciphertext.includes(PNG), false, 'the plaintext is inside the sealed file');
  // Not even the PNG signature survives, which is the cheapest possible tell.
  assert.equal(ciphertext.subarray(12, 20).equals(PNG.subarray(0, 8)), false);
});

test('the sealed bytes decrypt back to the original with the key, and not without it', async () => {
  const { question } = await fixture();
  const upload = await upload_(question.id);
  const { rows } = await pool.query(
    'SELECT preload_id, preload_key FROM media_asset WHERE id = $1',
    [upload.body.asset.id],
  );
  const asset = rows[0];

  const sealed = (
    await app.inject({ method: 'GET', url: `/media/sealed/${asset.preload_id}` })
  ).rawPayload;

  // Exactly what the browser does: iv is the first 12 bytes, the tag is the
  // last 16, and WebCrypto wants the tag left on the end of the ciphertext.
  const key = Buffer.from(asset.preload_key, 'base64');
  const iv = sealed.subarray(0, 12);
  const body = sealed.subarray(12, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  assert.deepEqual(plain, PNG, 'the sealed copy did not round trip');

  // A different key must not open it. GCM authenticates, so this throws rather
  // than quietly producing garbage — which is what makes the client's failure
  // path a clean fallback instead of a broken image.
  const wrong = createDecipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  wrong.setAuthTag(tag);
  assert.throws(() => Buffer.concat([wrong.update(body), wrong.final()]));
});

test('a sealed id that does not exist is a 404, not a hint', async () => {
  const res = await app.inject({
    method: 'GET',
    url: '/media/sealed/00000000-0000-0000-0000-000000000000',
  });
  assert.equal(res.statusCode, 404);
});
