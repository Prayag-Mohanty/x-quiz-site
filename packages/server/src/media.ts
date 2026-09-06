/**
 * Media upload — the last Phase 0 item.
 *
 * Files go to local disk for now. Phase 2 moves storage to R2 with signed URLs
 * and a transcode step, and the schema is already shaped for that: media_asset
 * separates `storage_key` (the truth) from `url` (minted at read time), so
 * swapping the backend touches this file and nothing else.
 *
 * ─── What the database enforces, and this does not repeat ───────────────────
 *
 * At most one video per question per role, staged reveals only on a connect
 * question, and reveals being images. Those are unique indexes and CHECK
 * constraints, so a bad upload is refused by Postgres and describeDbError turns
 * it into a sentence. The job here is to store the bytes and write the rows.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { MediaAssetRow, QuestionMediaRow, QuestionRow } from '@quizmaster/db';

import { maybeOne, one, query, transaction } from './db.js';
import { sealAsset } from './sealed.js';
import { UPLOAD_DIR } from './uploads.js';

/** ARCHITECTURE §4: many images are fine, one video, and it bounds preload. */
const LIMITS = {
  IMAGE: 15 * 1024 * 1024,
  AUDIO: 50 * 1024 * 1024,
  VIDEO: 300 * 1024 * 1024,
} as const;

type Kind = keyof typeof LIMITS;

function kindOf(mimetype: string): Kind | null {
  if (mimetype.startsWith('image/')) return 'IMAGE';
  if (mimetype.startsWith('audio/')) return 'AUDIO';
  if (mimetype.startsWith('video/')) return 'VIDEO';
  return null;
}

/**
 * The stored filename.
 *
 * Never the uploaded name: a caller-supplied filename is a path-traversal
 * waiting to happen, and two questions with a photo called `image.jpg` would
 * collide. The original is kept in a column for display only.
 */
function storageKeyFor(originalName: string): string {
  const ext = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
  return `${randomUUID()}${ext.slice(0, 10)}`;
}

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(UPLOAD_DIR, { recursive: true });

  /**
   * Attach a file to a question.
   *
   * role=PROMPT  what the teams see with the question
   * role=ANSWER  the answer slide
   * role=REVEAL  a staged image for a long visual connect
   */
  app.post<{ Params: { id: string }; Querystring: { role?: string } }>(
    '/api/questions/:id/media',
    async (req, reply) => {
      const role = (req.query.role ?? 'PROMPT').toUpperCase();
      if (!['PROMPT', 'ANSWER', 'REVEAL'].includes(role)) {
        return reply.code(422).send({ message: 'Media role must be PROMPT, ANSWER or REVEAL.' });
      }

      const question = await maybeOne<QuestionRow & { quiz_id: string }>(
        `SELECT q.*, r.quiz_id FROM question q JOIN round r ON r.id = q.round_id WHERE q.id = $1`,
        [req.params.id],
      );
      if (!question) return reply.code(404).send({ message: 'No such question.' });

      const file = await req.file();
      if (!file) return reply.code(422).send({ message: 'No file was sent.' });

      const kind = kindOf(file.mimetype);
      if (!kind) {
        return reply
          .code(422)
          .send({ message: `${file.mimetype} is not an image, audio or video file.` });
      }

      const storageKey = storageKeyFor(file.filename ?? '');
      const path = join(UPLOAD_DIR, storageKey);

      // Stream to disk rather than buffering: a 300MB video should not sit in
      // the process's memory on its way through.
      try {
        await pipeline(file.file, createWriteStream(path));
      } catch {
        await unlink(path).catch(() => undefined);
        return reply.code(500).send({ message: 'Could not save that file.' });
      }

      if (file.file.truncated) {
        // @fastify/multipart stops at the limit rather than erroring, so a
        // silently half-written file is the failure mode to guard against.
        await unlink(path).catch(() => undefined);
        const mb = Math.round(LIMITS[kind] / (1024 * 1024));
        return reply.code(413).send({ message: `That ${kind.toLowerCase()} is over ${mb}MB.` });
      }

      try {
        const media = await transaction(async (client) => {
          const { rows: assetRows } = await client.query<MediaAssetRow>(
            `INSERT INTO media_asset
               (quiz_id, kind, storage_key, size_bytes, original_filename, content_type,
                transcode_status)
             VALUES ($1,$2,$3,$4,$5,$6,'NOT_REQUIRED')
             RETURNING *`,
            [
              question.quiz_id,
              kind,
              storageKey,
              file.file.bytesRead,
              file.filename ?? null,
              file.mimetype,
            ],
          );
          const asset = assetRows[0];
          if (!asset) throw new Error('INSERT returned no row');

          const { rows: posRows } = await client.query<{ next: number }>(
            `SELECT coalesce(max(position) + 1, 0)::int AS next
               FROM question_media WHERE question_id = $1 AND role = $2`,
            [question.id, role],
          );
          const { rows } = await client.query<QuestionMediaRow>(
            `INSERT INTO question_media
               (question_id, round_type, role, position, asset_id, kind)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [question.id, question.round_type, role, posRows[0]?.next ?? 0, asset.id, kind],
          );
          return { asset, link: rows[0] };
        });

        // Seal it now, while the quiz is being written, so that by the time it
        // is run every asset already has a key and the views can hand one out
        // synchronously. A failure here costs the preload for this asset and
        // nothing else — the client falls back to fetching it when the question
        // appears, which is what it did before sealing existed.
        await sealAsset(media.asset.id).catch(() => undefined);

        return reply.code(201).send(media);
      } catch (err) {
        // The row was refused — one video per question, a reveal on a
        // non-connect question — so the file on disk is now an orphan.
        await unlink(path).catch(() => undefined);
        throw err;
      }
    },
  );

  /** Everything attached to a question, in order, per role. */
  app.get<{ Params: { id: string } }>('/api/questions/:id/media', async (req) =>
    query(
      `SELECT m.id, m.role, m.position, m.kind, a.id AS asset_id, a.storage_key,
              a.original_filename, a.size_bytes
         FROM question_media m
         JOIN media_asset a ON a.id = m.asset_id
        WHERE m.question_id = $1
        ORDER BY m.role, m.position`,
      [req.params.id],
    ),
  );

  /**
   * Detach a file, and delete it if nothing else uses it.
   *
   * An asset can be attached to several questions, so the row goes first and
   * the bytes only follow when the last reference is gone.
   */
  app.delete<{ Params: { id: string } }>('/api/question-media/:id', async (req, reply) => {
    const removed = await transaction(async (client) => {
      const { rows } = await client.query<QuestionMediaRow>(
        'DELETE FROM question_media WHERE id = $1 RETURNING *',
        [req.params.id],
      );
      const link = rows[0];
      if (!link) return null;

      await client.query(
        `UPDATE question_media SET position = position - 1
          WHERE question_id = $1 AND role = $2 AND position > $3`,
        [link.question_id, link.role, link.position],
      );

      const { rows: stillUsed } = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM question_media WHERE asset_id = $1',
        [link.asset_id],
      );
      if (stillUsed[0]?.count === '0') {
        const { rows: assetRows } = await client.query<{ storage_key: string }>(
          'DELETE FROM media_asset WHERE id = $1 RETURNING storage_key',
          [link.asset_id],
        );
        return { storageKey: assetRows[0]?.storage_key ?? null };
      }
      return { storageKey: null };
    });

    if (!removed) return reply.code(404).send({ message: 'No such attachment.' });
    // After the transaction commits: a file deleted before a rollback would be
    // gone while its row survived.
    if (removed.storageKey) {
      await unlink(join(UPLOAD_DIR, removed.storageKey)).catch(() => undefined);
    }
    return reply.code(204).send();
  });
}

export const _internal = { kindOf, storageKeyFor, LIMITS };
