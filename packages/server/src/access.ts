/**
 * Who may reach the authoring API.
 *
 * Everything under /api is the authoring tool apart from a short public list,
 * and the authoring tool can read every canonical answer in the database, mint
 * join codes, and hand out the quizmaster token. On the quizmaster's own laptop
 * that is fine. The moment the process is reachable from anywhere else — a LAN
 * address so teams can join, a tunnel so they can join from other cities — it
 * is the opposite of fine: the quiz id is in the public scoreboard URL, so
 * `/api/quizzes/<id>/state` would hand a player the answers.
 *
 * The rule:
 *
 *   ADMIN_TOKEN set    → authoring requires it in the x-admin-token header
 *   ADMIN_TOKEN unset  → authoring answers loopback requests only
 *
 * Unset is the default, so the local workflow stays zero-config, and exposing
 * the process without thinking about it fails closed rather than quietly
 * serving the answer sheet to the room.
 *
 * This is not user accounts. DECISIONS.md is explicit that this product has one
 * quizmaster and no account infrastructure; this is a door, not a directory.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Paths that must stay open, because the people using them are the players.
 *
 * Each is either already behind its own credential (a join code, a session
 * token, the quizmaster token) or carries nothing secret.
 */
function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  if (!path.startsWith('/api/')) return true; // /ws, /media, the client bundle
  return (
    path === '/api/health' ||
    path === '/api/join' ||
    path === '/api/join/qm' ||
    // Its own token check, and a stricter one — see breakdown.ts.
    /^\/api\/quizzes\/[^/]+\/breakdown$/.test(path)
  );
}

/** 127.0.0.1, ::1, and the IPv4-mapped form Node reports on dual-stack sockets. */
function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function adminTokenConfigured(): boolean {
  return Boolean((process.env['ADMIN_TOKEN'] ?? '').trim());
}

export function mayAuthor(req: FastifyRequest): boolean {
  const configured = (process.env['ADMIN_TOKEN'] ?? '').trim();
  if (configured) {
    return (req.headers['x-admin-token'] ?? '').toString().trim() === configured;
  }
  return isLoopback(req.ip);
}

export async function registerAccessControl(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, reply) => {
    if (isPublicPath(req.url)) return;
    if (mayAuthor(req)) return;

    // 401 rather than 404: the authoring UI turns this into a token prompt, and
    // a quizmaster who has just exposed the server needs to be told why their
    // own editor stopped working rather than left guessing.
    return reply.code(401).send({
      message: adminTokenConfigured()
        ? 'This server needs the admin token to edit quizzes.'
        : 'Editing is only allowed from the machine running the server. Set ADMIN_TOKEN to edit from elsewhere.',
      needsAdminToken: true,
    });
  });
}
