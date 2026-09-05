/**
 * Authoring server — Phase 0.
 *
 * Phase 1 adds the WebSocket layer and the engine on top of this process. For
 * now it is HTTP CRUD over the schema, so a quiz can be written down somewhere
 * other than a text file at 2am.
 */

import { buildApp } from './app.js';
import { pool } from './db.js';

const app = await buildApp();

const port = Number(process.env['PORT'] ?? 3000);

/**
 * Loopback by default, because a quiz database with every answer in it should
 * not be reachable from the coffee shop wifi by accident. Set HOST=0.0.0.0 to
 * let teams on the network in — and read access.ts first, because that also
 * exposes the authoring API unless ADMIN_TOKEN is set.
 */
const host = process.env['HOST'] ?? '127.0.0.1';
await app.listen({ port, host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
