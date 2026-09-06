/**
 * Sealed media, for preloading.
 *
 * The problem this solves is not speed, it is simultaneity. A question image
 * fetched when the question appears takes about a second to arrive through a
 * tunnel, and a different second for each team — which is a fairness problem
 * rather than a comfort one while a pounce window is open, because on a visual
 * connect the picture IS the question.
 *
 * Plain preloading would fix the timing and break the round: anything a browser
 * has fetched is one click away in its network tab, so a team holding the
 * images of an unasked question is a team holding the question.
 *
 * So the bytes go early and the key goes late:
 *
 *   1. A client is told `{ id, sealedUrl }` for every asset in the round.
 *   2. It fetches the ciphertext and keeps it in memory. It cannot read it.
 *   3. The QM presents the question. The key travels in that same view update —
 *      at exactly the moment the plaintext URL would have been sent anyway.
 *   4. The client decrypts what it already has and renders it instantly.
 *
 * AES-256-GCM, one key per asset, generated the first time an asset is sealed.
 * The sealed file is written next to the original and reused, so this is one
 * encryption per asset for the life of the quiz rather than one per request.
 *
 * ─── What this is and is not ────────────────────────────────────────────────
 *
 * The key sits in the same database as the ciphertext. That is not an oversight
 * and this is not protection against anyone who can read the database — the
 * quizmaster already can. The threat model is exactly one thing: a player, in a
 * browser, with dev tools open, holding bytes they are not yet allowed to see.
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';

import { maybeOne, one } from './db.js';
import { UPLOAD_DIR } from './uploads.js';

/** 12 bytes is the GCM standard, and WebCrypto on the client assumes it. */
const IV_BYTES = 12;

interface SealableRow {
  id: string;
  storage_key: string;
  content_type: string | null;
  preload_key: string | null;
}

const sealedPath = (storageKey: string) => join(UPLOAD_DIR, `${storageKey}.sealed`);

/**
 * Encrypt an asset once, and remember the key.
 *
 * The layout is `iv || ciphertext || tag`, which is what WebCrypto's
 * `decrypt` expects when handed the tag appended to the ciphertext — so the
 * client needs no framing logic of its own beyond splitting off the first 12
 * bytes.
 */
async function seal(asset: SealableRow): Promise<string | null> {
  const source = join(UPLOAD_DIR, asset.storage_key);
  if (!existsSync(source)) return null;

  // Already sealed, and the file is still there: nothing to do.
  if (asset.preload_key && existsSync(sealedPath(asset.storage_key))) {
    return asset.preload_key;
  }

  const key = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(sealedPath(asset.storage_key));
  out.write(iv);

  await pipeline(createReadStream(source), cipher, out, { end: false });
  // The tag is only available once the cipher has flushed, and it has to be on
  // the end of the file: WebCrypto expects it appended to the ciphertext.
  out.end(cipher.getAuthTag());
  await new Promise<void>((resolve, reject) => {
    out.on('close', resolve);
    out.on('error', reject);
  });

  const encoded = key.toString('base64');
  await one('UPDATE media_asset SET preload_key = $2 WHERE id = $1 RETURNING id', [
    asset.id,
    encoded,
  ]);
  return encoded;
}

/**
 * The key for an asset, sealing it if this is the first time it has been asked
 * for. Null when the file is missing, which the caller turns into "no preload"
 * rather than an error — a question with no preload still works, it is just a
 * second slower.
 */
export async function sealAsset(assetId: string): Promise<string | null> {
  const asset = await maybeOne<SealableRow>(
    'SELECT id, storage_key, content_type, preload_key FROM media_asset WHERE id = $1',
    [assetId],
  );
  if (!asset) return null;
  return seal(asset).catch(() => null);
}

export async function registerSealedRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The ciphertext.
   *
   * Public, like the plain media route, and safe to be: without the key this is
   * noise. It is addressed by `preload_id` rather than `storage_key` so that
   * holding a preload URL tells you nothing about the plaintext one, which is
   * an unguessable uuid and is never sent before the question is presented.
   */
  app.get<{ Params: { preloadId: string } }>(
    '/media/sealed/:preloadId',
    async (req, reply) => {
      const asset = await maybeOne<SealableRow>(
        'SELECT id, storage_key, content_type, preload_key FROM media_asset WHERE preload_id = $1',
        [req.params.preloadId],
      );
      if (!asset) return reply.code(404).send({ message: 'No such media.' });

      const key = await seal(asset).catch(() => null);
      if (!key) return reply.code(404).send({ message: 'No such media.' });

      const path = sealedPath(asset.storage_key);
      const { size } = await stat(path);
      return reply
        // Opaque bytes on purpose: nothing here should tell a browser, or a
        // person reading headers, what kind of file this will turn out to be.
        .type('application/octet-stream')
        .header('content-length', String(size))
        // Immutable: an asset's ciphertext never changes, and a team that
        // reconnects should not fetch it twice.
        .header('cache-control', 'public, max-age=86400, immutable')
        .send(createReadStream(path));
    },
  );
}
