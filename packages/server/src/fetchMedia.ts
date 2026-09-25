/**
 * Attaching media a question sheet named by URL.
 *
 * An imported question set carries links rather than files — `imageUrl` in a
 * league spreadsheet, a slide host, a shared drive. Downloading those has to
 * happen on the server, because the browser cannot read a cross-origin image
 * as bytes, and that makes this an endpoint that fetches a URL somebody else
 * chose. Which is the whole reason the first half of this file is a guard.
 *
 * ─── The guard ──────────────────────────────────────────────────────────────
 *
 * A server that fetches arbitrary URLs is a server that will happily fetch
 * `http://127.0.0.1:55432`, or a cloud metadata address, on behalf of whoever
 * asked. So:
 *
 *   - http and https only. No file:, no data:, no gopher:.
 *   - the hostname is RESOLVED and every address it resolves to is checked
 *     against the private ranges, because `localtest.me` resolves to 127.0.0.1
 *     and a name tells you nothing on its own.
 *   - redirects are followed by hand, one at a time, re-checking each hop —
 *     otherwise a public URL redirecting to an internal one walks straight
 *     through a check done only at the front door.
 *   - a size cap and a timeout, so a slow or enormous URL cannot hold a
 *     connection or fill the disk.
 *
 * The route itself is behind the admin gate like the rest of the authoring API
 * (see access.ts), so this is not open to the internet. The guard is there
 * because the quizmaster pasting a link is not the same as the quizmaster
 * intending to probe their own network, and a spreadsheet can come from anyone.
 */

import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance } from 'fastify';
import type { MediaAssetRow, QuestionMediaRow, QuestionRow } from '@quizmaster/db';

import { maybeOne, transaction } from './db.js';
import { sealAsset } from './sealed.js';
import { UPLOAD_DIR } from './uploads.js';

const LIMITS = { IMAGE: 15 * 1024 * 1024, AUDIO: 50 * 1024 * 1024, VIDEO: 300 * 1024 * 1024 } as const;
type Kind = keyof typeof LIMITS;

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

function kindOf(contentType: string): Kind | null {
  if (contentType.startsWith('image/')) return 'IMAGE';
  if (contentType.startsWith('audio/')) return 'AUDIO';
  if (contentType.startsWith('video/')) return 'VIDEO';
  return null;
}

/**
 * Addresses no quiz asset lives at.
 *
 * Loopback, the link-local range that carries cloud metadata, and the three
 * private blocks. Checked against RESOLVED addresses, never against the name.
 */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const v6 = address.toLowerCase();
    if (v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd')) return true;
    if (v6.startsWith('fe80')) return true;
    // ::ffff:127.0.0.1 and friends are IPv4 wearing a hat.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 127) return true; // this host, loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** Throws with a sentence the UI can show. Never returns a URL it has not checked. */
export async function assertReachable(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Only http and https links can be fetched, not ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error(`Could not find ${url.hostname}`);
      });

  if (addresses.length === 0) throw new Error(`Could not find ${url.hostname}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(`${url.hostname} is on this machine or its private network, so it is not fetched.`);
    }
  }
  return url;
}

/**
 * Fetch, re-checking every redirect.
 *
 * `redirect: 'manual'` rather than letting fetch follow: a check at the front
 * door means nothing if the second hop is the one that goes somewhere private.
 */
export async function fetchChecked(raw: string): Promise<Response> {
  let target = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertReachable(target);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'image/*,audio/*,video/*,*/*;q=0.5' },
    });

    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error(`${url.hostname} redirected without saying where.`);
      target = new URL(next, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`${url.hostname} answered ${res.status}.`);
    return res;
  }
  throw new Error('Too many redirects.');
}

/** The extension to store under, from the content type rather than the URL. */
function extensionFor(contentType: string, url: string): string {
  const fromUrl = extname(new URL(url).pathname).toLowerCase().replace(/[^.a-z0-9]/g, '');
  if (fromUrl.length > 1 && fromUrl.length <= 6) return fromUrl;
  const subtype = contentType.split('/')[1]?.split(';')[0] ?? '';
  return subtype ? `.${subtype.replace(/[^a-z0-9]/g, '').slice(0, 5)}` : '';
}

export async function registerFetchMediaRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Attach a file named by URL.
   *
   * Used by the importer, one question at a time, so a sheet with forty images
   * reports forty outcomes rather than failing as a single opaque lump.
   */
  app.post<{ Params: { id: string }; Body: { url?: string; role?: string } }>(
    '/api/questions/:id/media/from-url',
    async (req, reply) => {
      const role = (req.body?.role ?? 'PROMPT').toUpperCase();
      if (!['PROMPT', 'ANSWER', 'REVEAL'].includes(role)) {
        return reply.code(422).send({ message: 'Media role must be PROMPT, ANSWER or REVEAL.' });
      }
      const raw = (req.body?.url ?? '').trim();
      if (!raw) return reply.code(422).send({ message: 'No URL was given.' });

      const question = await maybeOne<QuestionRow & { quiz_id: string }>(
        'SELECT q.*, r.quiz_id FROM question q JOIN round r ON r.id = q.round_id WHERE q.id = $1',
        [req.params.id],
      );
      if (!question) return reply.code(404).send({ message: 'No such question.' });

      let res: Response;
      try {
        res = await fetchChecked(raw);
      } catch (err) {
        // A bad link in a spreadsheet is a normal event during an import, not a
        // server fault — say which link and why, and let the import continue.
        return reply.code(422).send({ message: (err as Error).message });
      }

      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      const kind = kindOf(contentType);
      if (!kind || !res.body) {
        return reply
          .code(422)
          .send({ message: `That link is ${contentType || 'not a media file'}, not an image, audio or video.` });
      }

      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > LIMITS[kind]) {
        const mb = Math.round(LIMITS[kind] / (1024 * 1024));
        return reply.code(413).send({ message: `That ${kind.toLowerCase()} is over ${mb}MB.` });
      }

      const storageKey = `${randomUUID()}${extensionFor(contentType, raw)}`;
      const path = join(UPLOAD_DIR, storageKey);

      // Counted while streaming, because content-length is a claim rather than
      // a fact and a server that lies about it should not fill the disk.
      let written = 0;
      try {
        const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
        body.on('data', (chunk: Buffer) => {
          written += chunk.length;
          if (written > LIMITS[kind]) body.destroy(new Error('over the size limit'));
        });
        await pipeline(body, createWriteStream(path));
      } catch (err) {
        await unlink(path).catch(() => undefined);
        const mb = Math.round(LIMITS[kind] / (1024 * 1024));
        const message = (err as Error).message.includes('size limit')
          ? `That ${kind.toLowerCase()} is over ${mb}MB.`
          : `Could not download ${raw}.`;
        return reply.code(422).send({ message });
      }

      try {
        const media = await transaction(async (client) => {
          const { rows: assetRows } = await client.query<MediaAssetRow>(
            `INSERT INTO media_asset
               (quiz_id, kind, storage_key, size_bytes, original_filename, content_type, transcode_status)
             VALUES ($1,$2,$3,$4,$5,$6,'NOT_REQUIRED') RETURNING *`,
            [question.quiz_id, kind, storageKey, written, raw.slice(0, 500), contentType],
          );
          const asset = assetRows[0];
          if (!asset) throw new Error('INSERT returned no row');

          const { rows: posRows } = await client.query<{ next: number }>(
            `SELECT coalesce(max(position) + 1, 0)::int AS next
               FROM question_media WHERE question_id = $1 AND role = $2`,
            [question.id, role],
          );
          const { rows } = await client.query<QuestionMediaRow>(
            `INSERT INTO question_media (question_id, round_type, role, position, asset_id, kind)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [question.id, question.round_type, role, posRows[0]?.next ?? 0, asset.id, kind],
          );
          return { asset, link: rows[0] };
        });

        await sealAsset(media.asset.id).catch(() => undefined);
        return reply.code(201).send(media);
      } catch (err) {
        await unlink(path).catch(() => undefined);
        throw err;
      }
    },
  );
}
