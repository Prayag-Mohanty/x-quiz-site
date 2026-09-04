/**
 * The socket layer.
 *
 * A normal HTTP request closes as soon as it is answered, which is useless for
 * "tell all ten teams the pounce window just shut". A WebSocket stays open so
 * the server can push.
 *
 * ─── What this layer refuses to trust ───────────────────────────────────────
 *
 * The role comes from the session row, never from the client. A message saying
 * "I am the QM" is ignored; a message saying "this pounce is from team 3" is
 * ignored. The socket already knows which team it belongs to, because the token
 * it presented is tied to one. A client that could name its own role or its own
 * team could award itself points.
 *
 * ─── Reconnection ───────────────────────────────────────────────────────────
 *
 * A laptop's wifi drops for four seconds mid-pounce. That client reconnects with
 * the same token and is sent the whole current view immediately. There is no
 * replay to catch up on and no delta to miss, which is the entire reason the
 * server sends complete views: rejoining is the same code path as joining.
 */

import { nanoid } from 'nanoid';
import type { FastifyInstance } from 'fastify';
import type { Action } from '@quizmaster/engine';
import type { ClientMessage, ServerMessage } from '@quizmaster/shared';

import { findSession } from './sessions.js';
import {
  addConnection,
  applyAction,
  getRoom,
  markTyping,
  removeConnection,
  sendState,
  setDraft,
  type Connection,
} from './rooms.js';

/** Actions a team socket may cause. Everything else is the QM's alone. */
function isQmOnly(action: Action): boolean {
  return action.type !== 'SUBMIT_POUNCE' && action.type !== 'SUBMIT_WRITTEN';
}

function parse(raw: string): ClientMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
      return parsed as ClientMessage;
    }
  } catch {
    // Malformed input from a browser is not an exceptional condition.
  }
  return null;
}

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { token?: string; scoreboard?: string } }>(
    '/ws',
    { websocket: true },
    async (socket, req) => {
      const send = (message: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      };

      /**
       * Attach the listener BEFORE any await.
       *
       * Session lookup and room loading are both async, and a browser sends as
       * soon as the socket opens — anything arriving during that gap would be
       * dropped on the floor with no error anywhere. Buffer until setup is done,
       * then drain in order.
       */
      const pending: string[] = [];
      let handle: ((raw: string) => void) | null = null;
      socket.on('message', (raw: Buffer) => {
        const text = raw.toString();
        if (handle) handle(text);
        else pending.push(text);
      });

      const token = req.query.token ?? '';
      const scoreboardQuizId = req.query.scoreboard ?? '';

      let conn: Connection;
      let quizId: string;

      if (scoreboardQuizId) {
        // The scoreboard shows only what is already public, so it needs no
        // credential — a projector in the room is not a participant.
        quizId = scoreboardQuizId;
        conn = {
          id: nanoid(),
          role: 'SCOREBOARD',
          teamId: null,
          displayName: 'Scoreboard',
          send,
        };
      } else {
        const session = await findSession(token);
        if (!session) {
          send({ type: 'ERROR', message: 'That session is not valid. Join again.' });
          socket.close();
          return;
        }
        quizId = session.quiz_id;
        conn = {
          id: nanoid(),
          // The session decides. The client is never asked.
          role: session.team_id ? 'TEAM' : 'QM',
          teamId: session.team_id,
          displayName: session.display_name,
          send,
        };
      }

      let room;
      try {
        room = await getRoom(quizId);
      } catch (err) {
        send({ type: 'ERROR', message: (err as Error).message });
        socket.close();
        return;
      }

      addConnection(room, conn);
      // The full current state, immediately. This is also what a reconnecting
      // client gets, by the same path.
      sendState(room, conn);

      handle = (raw: string) => {
        void (async () => {
          const message = parse(raw);
          if (!message) return;

          try {
            switch (message.type) {
              case 'PING':
                send({ type: 'PONG' });
                return;

              case 'ACTION': {
                if (conn.role !== 'QM') {
                  send({ type: 'ERROR', message: 'Only the quizmaster can do that.' });
                  return;
                }
                await applyAction(room, message.action, conn.displayName);
                return;
              }

              case 'POUNCE': {
                if (conn.role !== 'TEAM' || !conn.teamId) {
                  send({ type: 'ERROR', message: 'Only a team can pounce.' });
                  return;
                }
                // teamId comes from the session, never from the message.
                await applyAction(
                  room,
                  { type: 'SUBMIT_POUNCE', teamId: conn.teamId, text: message.text },
                  conn.displayName,
                );
                return;
              }

              case 'DRAFT': {
                if (conn.role !== 'TEAM' || !conn.teamId) return;
                setDraft(room, conn.teamId, message.text, conn.displayName);
                return;
              }

              case 'TYPING': {
                if (conn.role !== 'TEAM' || !conn.teamId) return;
                markTyping(room, conn.teamId, conn.displayName);
                return;
              }

              default:
                return;
            }
          } catch (err) {
            // An illegal transition is a stale button or a race, not a crash.
            // Tell the client and resend the truth so its screen stops lying.
            send({ type: 'ERROR', message: (err as Error).message });
            sendState(room, conn);
          }
        })();
      };

      // Anything that arrived while we were looking up the session.
      for (const buffered of pending.splice(0)) handle(buffered);

      socket.on('close', () => removeConnection(room, conn.id));
      socket.on('error', () => removeConnection(room, conn.id));
    },
  );

  // Guard against the one thing that would break a live quiz silently: an
  // unhandled rejection taking the process down mid-round.
  app.log.debug('websocket route registered');
}

/** Exposed for tests. */
export const _internal = { isQmOnly };
