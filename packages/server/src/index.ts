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
await app.listen({ port, host: '127.0.0.1' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => pool.end())
      .then(() => process.exit(0));
  });
}
