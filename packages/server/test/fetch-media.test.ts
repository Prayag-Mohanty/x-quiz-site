/**
 * Fetching media a question sheet named by URL.
 *
 * This endpoint makes the server fetch a URL somebody else chose, which is the
 * shape of every SSRF there has ever been. So most of what is here is refusal.
 *
 * The guard is tested directly rather than over HTTP, and deliberately. A test
 * server can only listen on this machine, and this machine is exactly what the
 * guard refuses — so an HTTP-level test of "a redirect to somewhere private is
 * caught" passes because the FIRST hop was already loopback, and would keep
 * passing if the redirect check were deleted. That is worse than no test.
 * Literal IP hosts skip DNS, so all of this runs with no network at all.
 */

import { after, before, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { UPLOAD_DIR } from '../src/uploads.js';
import { assertReachable, fetchChecked, isPrivateAddress } from '../src/fetchMedia.js';

let app: FastifyInstance;
const createdQuizzes: string[] = [];

before(async () => {
  app = await buildApp({ logger: false });
});

after(async () => {
  for (const id of createdQuizzes) {
    const { rows } = await pool
      .query<{ storage_key: string }>('SELECT storage_key FROM media_asset WHERE quiz_id = $1', [id])
      .catch(() => ({ rows: [] as { storage_key: string }[] }));
    for (const row of rows) {
      await unlink(join(UPLOAD_DIR, row.storage_key)).catch(() => undefined);
      await unlink(join(UPLOAD_DIR, `${row.storage_key}.sealed`)).catch(() => undefined);
    }
    await pool
      .query(
        'DELETE FROM question_media WHERE asset_id IN (SELECT id FROM media_asset WHERE quiz_id = $1)',
        [id],
      )
      .catch(() => undefined);
    await pool.query('DELETE FROM quiz WHERE id = $1', [id]).catch(() => undefined);
  }
  await app.close();
  await pool.end();
});

// ─── The address check, which is the whole guard ────────────────────────────

describe('isPrivateAddress', () => {
  test('refuses this machine and every private block', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '0.0.0.0',
      '10.0.0.5',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      // The address cloud providers put instance credentials behind.
      '169.254.169.254',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      // IPv4 wearing a hat. Missing this is a complete bypass.
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
    ]) {
      assert.equal(isPrivateAddress(address), true, `${address} was allowed`);
    }
  });

  test('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
      assert.equal(isPrivateAddress(address), false, `${address} was refused`);
    }
  });

  test('anything unparseable is refused rather than allowed', () => {
    // Fail closed: a string this cannot read is not a string it should fetch.
    for (const address of ['', 'not-an-address', '1.2.3', '1.2.3.4.5']) {
      assert.equal(isPrivateAddress(address), true, `${address} was allowed`);
    }
  });
});

describe('assertReachable', () => {
  test('http and https only', async () => {
    for (const url of ['file:///etc/passwd', 'data:image/png;base64,AA', 'gopher://8.8.8.8/1']) {
      await assert.rejects(assertReachable(url), /http and https/i, url);
    }
  });

  test('a private address is refused by its literal IP', async () => {
    for (const url of ['http://127.0.0.1:55432/', 'http://169.254.169.254/latest/', 'http://[::1]/']) {
      await assert.rejects(assertReachable(url), /private network/i, url);
    }
  });

  test('a public literal address is allowed', async () => {
    const url = await assertReachable('http://8.8.8.8/image.png');
    assert.equal(url.hostname, '8.8.8.8');
  });

  test('nonsense is not a URL', async () => {
    await assert.rejects(assertReachable('not a url at all'), /Not a URL/);
  });
});

/**
 * The redirect loop.
 *
 * A check at the front door means nothing if the second hop is the one that
 * goes somewhere private. `fetch` is stubbed so both hops are literal IPs and
 * no DNS or network is involved: the first is public and answers 302, the
 * second is loopback and must never be requested.
 */
describe('fetchChecked follows redirects by hand', () => {
  const withStubbedFetch = async (
    handler: (url: string) => Response,
    run: () => Promise<void>,
  ) => {
    const real = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input.toString();
      seen.push(url);
      return handler(url);
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = real;
    }
    return seen;
  };

  test('a public URL redirecting to a private one is refused at the second hop', async () => {
    const seen = await withStubbedFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:55432/' } }),
      async () => {
        await assert.rejects(fetchChecked('http://8.8.8.8/start'), /private network/i);
      },
    );
    assert.deepEqual(seen, ['http://8.8.8.8/start'], 'the private address must never be requested');
  });

  test('a redirect between public addresses is followed', async () => {
    let hop = 0;
    await withStubbedFetch(
      () =>
        hop++ === 0
          ? new Response(null, { status: 302, headers: { location: 'http://1.1.1.1/final.png' } })
          : new Response('ok', { status: 200, headers: { 'content-type': 'image/png' } }),
      async () => {
        const res = await fetchChecked('http://8.8.8.8/start');
        assert.equal(res.status, 200);
      },
    );
  });

  test('a redirect loop stops rather than spinning', async () => {
    await withStubbedFetch(
      () => new Response(null, { status: 302, headers: { location: 'http://8.8.8.8/again' } }),
      async () => {
        await assert.rejects(fetchChecked('http://8.8.8.8/start'), /Too many redirects/);
      },
    );
  });
});

// ─── The route ──────────────────────────────────────────────────────────────

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const res = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

async function fixture() {
  const quiz = (await call('POST', '/api/quizzes', { title: 'Fetch Media Test' })).body;
  createdQuizzes.push(quiz.id);
  const round = (
    await call('POST', `/api/quizzes/${quiz.id}/rounds`, { type: 'DIRECT', title: 'R1' })
  ).body;
  const question = (await call('POST', `/api/rounds/${round.id}/questions`, { body: 'Q' })).body;
  return { quiz, question };
}

test('the route turns a refused link into a sentence, not a 500', async () => {
  const { question } = await fixture();
  const url = `/api/questions/${question.id}/media/from-url`;

  const local = await call('POST', url, { url: 'http://127.0.0.1:55432/', role: 'PROMPT' });
  assert.equal(local.status, 422);
  assert.match(local.body.message, /private network/i);

  const scheme = await call('POST', url, { url: 'file:///etc/passwd' });
  assert.equal(scheme.status, 422);

  const missing = await call('POST', url, { url: '   ' });
  assert.equal(missing.status, 422);

  const badRole = await call('POST', url, { url: 'http://8.8.8.8/a.png', role: 'NONSENSE' });
  assert.equal(badRole.status, 422);
});

test('a question that does not exist is a 404', async () => {
  const res = await call('POST', '/api/questions/00000000-0000-0000-0000-000000000000/media/from-url', {
    url: 'http://8.8.8.8/a.png',
  });
  assert.equal(res.status, 404);
});

/**
 * The ordinary case, gated on the network being there: a test that fails on a
 * train is a test people learn to ignore.
 */
test('a real image is downloaded, attached and sealed', async () => {
  const reachable = await fetch('https://www.google.com/favicon.ico', {
    method: 'HEAD',
    signal: AbortSignal.timeout(4000),
  })
    .then((r) => r.ok)
    .catch(() => false);
  if (!reachable) {
    console.log('    (skipped: no network)');
    return;
  }

  const { quiz, question } = await fixture();
  const res = await call('POST', `/api/questions/${question.id}/media/from-url`, {
    url: 'https://www.google.com/favicon.ico',
    role: 'PROMPT',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.asset.kind, 'IMAGE');
  // The link is kept as the filename, so a reviewer can see where it came from.
  assert.match(res.body.asset.original_filename, /google\.com/);

  const { rows } = await pool.query<{ preload_key: string | null; size_bytes: string }>(
    'SELECT preload_key, size_bytes FROM media_asset WHERE quiz_id = $1',
    [quiz.id],
  );
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0]!.size_bytes) > 0, 'nothing was written');
  assert.ok(rows[0]!.preload_key, 'a fetched asset must be sealed like an uploaded one');
});
