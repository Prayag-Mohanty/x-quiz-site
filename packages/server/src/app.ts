/**
 * The Fastify app, built but not listening.
 *
 * Separate from index.ts so tests can drive it with `app.inject()` — real
 * routing, real handlers, real database, no port and no race with a background
 * process. Phase 1 registers the WebSocket layer here too.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { describeDbError, pool } from './db.js';
import { registerRoutes } from './routes.js';
import { registerJoinRoutes } from './sessions.js';
import { registerMediaRoutes } from './media.js';
import { UPLOAD_DIR } from './uploads.js';
import { registerBreakdownRoutes } from './breakdown.js';
import { registerSealedRoutes } from './sealed.js';
import { registerWebSocket } from './ws.js';
import { registerAccessControl } from './access.js';

export async function buildApp(
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: 'info' },
  });

  // The client dev server runs on another port, which the browser treats as a
  // different origin and blocks by default. Wide open is fine while this is
  // localhost-only; Phase 1 narrows it.
  await app.register(cors, { origin: true });

  // Before any route: the authoring API can read every answer in the database.
  // See access.ts for why this is loopback-only until ADMIN_TOKEN is set.
  await registerAccessControl(app);

  /**
   * Most rejected writes are the schema enforcing FORMAT_SPEC, not bugs — turn
   * them into something the UI can show rather than a 500.
   */
  app.setErrorHandler((error, _req, reply) => {
    const described = describeDbError(error);
    if (described) return reply.code(described.status).send({ message: described.message });
    app.log.error(error);
    return reply.code(500).send({ message: 'Something went wrong.' });
  });

  app.get('/api/health', async () => {
    const { rows } = await pool.query('SELECT 1 AS ok');
    return { ok: rows[0]?.ok === 1 };
  });

  await app.register(websocket);

  // 300MB covers one 1080p video, which ARCHITECTURE §4 caps a question at.
  await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 1 } });

  // Uploaded files are served from /media/<storage_key>, which is exactly the
  // URL the row-to-domain mapper builds. Phase 2 swaps this for signed R2 URLs.
  await app.register(fastifyStatic, { root: UPLOAD_DIR, prefix: '/media/' });

  await registerRoutes(app);
  await registerJoinRoutes(app);
  await registerMediaRoutes(app);
  await registerBreakdownRoutes(app);
  await registerSealedRoutes(app);
  await registerWebSocket(app);
  await registerClient(app);
  return app;
}

/**
 * Serve the built client, so the whole app is one origin on one port.
 *
 * Two ports work on a laptop, where the dev server proxies /api and /ws to the
 * other one. They stop working the moment anyone else needs a URL: a tunnel
 * exposes one port, and "open :5173 but the API is on :3000" is not a thing you
 * can tell four teams over a video call.
 *
 * Skipped when there is no build, so `npm run dev` against the Vite server is
 * unaffected and the tests do not need a client build to run.
 */
async function registerClient(app: FastifyInstance): Promise<void> {
  const clientDir =
    process.env['CLIENT_DIR'] ?? join(process.cwd(), '..', 'client', 'dist');
  if (!existsSync(join(clientDir, 'index.html'))) return;

  // decorateReply: false — the media registration above already added
  // reply.sendFile, and Fastify refuses to decorate twice.
  await app.register(fastifyStatic, { root: clientDir, decorateReply: false });

  /**
   * Client-side routing: /play, /qm, /scoreboard and /breakdown are React
   * routes, not files, so anything that is not an API call, a socket or an
   * upload falls through to index.html. An unknown /api path must still 404 as
   * an API — answering it with a page turns a typo into a parse error.
   */
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api') || req.url.startsWith('/media')) {
      return reply.code(404).send({ message: 'Not found.' });
    }
    return reply.sendFile('index.html', clientDir);
  });
}
