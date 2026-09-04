/**
 * Joining.
 *
 * DECISIONS.md: join codes, not accounts. No passwords, no email, no OAuth.
 * This is a quiz for people the QM already knows, and account infrastructure is
 * pure cost.
 *
 * Two ways in:
 *   - a team member types a short code and their own name
 *   - the QM opens a long link nobody else has
 *
 * Both mint a session row; its token is what the WebSocket presents. The token
 * carries the role, so the socket never has to ask a client who it is — a client
 * that could name its own role could name itself QM.
 */

import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';

import { maybeOne, one, query } from './db.js';

export interface SessionRow {
  id: string;
  token: string;
  quiz_id: string;
  team_id: string | null;
  display_name: string;
}

export async function findSession(token: string): Promise<SessionRow | null> {
  if (!token) return null;
  const session = await maybeOne<SessionRow>(
    'SELECT id, token, quiz_id, team_id, display_name FROM session WHERE token = $1',
    [token],
  );
  if (session) {
    // Fire and forget — a failed heartbeat must not block a reconnect.
    void one('UPDATE session SET last_seen_at = now() WHERE id = $1 RETURNING id', [
      session.id,
    ]).catch(() => undefined);
  }
  return session;
}

export async function registerJoinRoutes(app: FastifyInstance): Promise<void> {
  /**
   * A team member joining.
   *
   * The code identifies the team AND the quiz, so nobody has to be told which
   * quiz they are joining. Codes are stored upper-case and compared upper-case,
   * because this gets typed off a phone screen in a hurry.
   */
  app.post<{ Body: { code?: string; displayName?: string } }>(
    '/api/join',
    async (req, reply) => {
      const code = (req.body?.code ?? '').trim().toUpperCase();
      const displayName = (req.body?.displayName ?? '').trim();

      if (!code) return reply.code(422).send({ message: 'Enter your team code.' });
      if (!displayName) return reply.code(422).send({ message: 'Enter your name.' });

      const team = await maybeOne<{ id: string; quiz_id: string; name: string }>(
        'SELECT id, quiz_id, name FROM team WHERE join_code = $1',
        [code],
      );
      // Deliberately vague: a wrong code should not confirm which codes exist.
      if (!team) return reply.code(404).send({ message: 'No team with that code.' });

      const token = nanoid(32);
      await one(
        `INSERT INTO session (token, quiz_id, team_id, display_name)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [token, team.quiz_id, team.id, displayName],
      );

      return {
        token,
        role: 'TEAM' as const,
        quizId: team.quiz_id,
        teamId: team.id,
        teamName: team.name,
        displayName,
      };
    },
  );

  /** The QM opening their own link. Possession of the token is the credential. */
  app.post<{ Body: { qmToken?: string; displayName?: string } }>(
    '/api/join/qm',
    async (req, reply) => {
      const qmToken = (req.body?.qmToken ?? '').trim();
      if (!qmToken) return reply.code(422).send({ message: 'Missing quizmaster token.' });

      const quiz = await maybeOne<{ id: string; title: string }>(
        'SELECT id, title FROM quiz WHERE qm_token = $1',
        [qmToken],
      );
      if (!quiz) return reply.code(404).send({ message: 'That quizmaster link is not valid.' });

      const token = nanoid(32);
      await one(
        `INSERT INTO session (token, quiz_id, team_id, display_name)
         VALUES ($1, $2, NULL, $3) RETURNING id`,
        [token, quiz.id, (req.body?.displayName ?? 'Quizmaster').trim() || 'Quizmaster'],
      );

      return { token, role: 'QM' as const, quizId: quiz.id, quizTitle: quiz.title };
    },
  );

  /**
   * The QM's own link and the team codes, for handing out before a quiz.
   *
   * Authoring-side only. It exposes every code for the quiz, so it lives beside
   * the authoring API rather than anywhere a participant reaches.
   */
  app.get<{ Params: { id: string } }>('/api/quizzes/:id/credentials', async (req, reply) => {
    const quiz = await maybeOne<{ id: string; qm_token: string }>(
      'SELECT id, qm_token FROM quiz WHERE id = $1',
      [req.params.id],
    );
    if (!quiz) return reply.code(404).send({ message: 'No such quiz.' });

    const teams = await query<{
      id: string;
      name: string;
      join_code: string;
      position: number;
    }>('SELECT id, name, join_code, position FROM team WHERE quiz_id = $1 ORDER BY position', [
      req.params.id,
    ]);

    return { qmToken: quiz.qm_token, teams };
  });
}
