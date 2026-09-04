/**
 * The Fastify app, built but not listening.
 *
 * Separate from index.ts so tests can drive it with `app.inject()` — real
 * routing, real handlers, real database, no port and no race with a background
 * process. Phase 1 registers the WebSocket layer here too.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';

import { describeDbError, pool } from './db.js';
import { registerRoutes } from './routes.js';
import { registerJoinRoutes } from './sessions.js';
import { registerWebSocket } from './ws.js';

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

  await registerRoutes(app);
  await registerJoinRoutes(app);
  await registerWebSocket(app);
  return app;
}
