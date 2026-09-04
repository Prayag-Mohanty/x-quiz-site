/**
 * Rooms.
 *
 * One quiz in flight = one Room, holding one QuizState in memory. Ten teams fit
 * in memory trivially, so there is no Redis and no distributed state
 * (DECISIONS.md). Postgres is durability, not the live store.
 *
 * ─── How a transition happens ───────────────────────────────────────────────
 *
 *   1. A QM intent arrives on a socket.
 *   2. reduce(state, action) — pure, and the only place quiz state changes.
 *   3. The action is appended to quiz_action, and any new or changed ledger
 *      events are written to score_event.
 *   4. Every connected client is sent a fresh view for its role.
 *
 * Persisting the action rather than the state is what makes recovery work: the
 * reducer is pure, so replaying the log from the stored quiz reproduces the
 * exact state, including which teams have pounced and which parts are credited.
 * There is no second representation of the state machine to keep in sync.
 *
 * ─── The rule about ids ─────────────────────────────────────────────────────
 *
 * The reducer takes event ids as input so it can stay pure. Those ids are minted
 * HERE, never accepted from a client — a client that could choose an event id
 * could collide with, or overwrite, someone else's award.
 */

import { randomUUID } from 'node:crypto';
import { reduce, type Action, type QuizState, type ScoreEvent } from '@quizmaster/engine';
import { toQuizState, toScoreEventInsert, type QuizLoad } from '@quizmaster/db';
import type { ServerMessage, TeamDraft, View } from '@quizmaster/shared';

import { pool, query, transaction } from './db.js';
import { buildQmView, buildScoreboardView, buildTeamView, type RoomContext } from './views.js';
import { loadQuiz } from './load.js';

export interface Connection {
  id: string;
  role: 'QM' | 'TEAM' | 'SCOREBOARD';
  teamId: string | null;
  displayName: string;
  send: (message: ServerMessage) => void;
}

export interface Room {
  quizId: string;
  state: QuizState;
  /** Monotonic per quiz. Doubles as the concurrency check in quiz_action. */
  seq: number;
  ctx: RoomContext;
  connections: Map<string, Connection>;
  /**
   * Serialises transitions.
   *
   * Each socket message starts its own async task, so two actions arriving close
   * together — a QM pressing two keys quickly, or a team pouncing as the window
   * closes — would otherwise both read room.state before either committed. Both
   * would then claim the same seq, and the second INSERT would collide on
   * quiz_action's primary key. The reducer is a state machine: its inputs have
   * to be ordered, and this is where that order is imposed.
   */
  queue: Promise<unknown>;
}

const rooms = new Map<string, Room>();

/**
 * Rooms currently being built.
 *
 * getRoom is async: it misses the cache, awaits a database load, then stores the
 * result. Two clients connecting at the same moment — which is exactly what
 * happens when a quiz starts — would both miss and both build a room, and the
 * loser's connections would sit in an orphaned copy of the quiz, receiving no
 * broadcasts and diverging silently. Memoising the in-flight promise, not just
 * the finished room, is what makes concurrent joins land in one place.
 */
const loading = new Map<string, Promise<Room>>();

/**
 * Actions that carry an event id the server must mint.
 *
 * randomUUID rather than nanoid: score_event.id is a uuid column. DECISIONS.md
 * picks nanoid for ids, and it still holds where the id is read aloud or typed —
 * join codes and session tokens. A ledger primary key is neither.
 */
function withServerIds(action: Action): Action {
  switch (action.type) {
    case 'EVALUATE_POUNCE':
    case 'BOUNCE_CORRECT':
    case 'BOUNCE_PARTIAL':
    case 'EVALUATE_WRITTEN':
    case 'MANUAL_ADJUST':
      return { ...action, eventId: randomUUID() };
    default:
      return action;
  }
}

export function getRoom(quizId: string): Promise<Room> {
  const existing = rooms.get(quizId);
  if (existing) return Promise.resolve(existing);

  const inFlight = loading.get(quizId);
  if (inFlight) return inFlight;

  const build = loadRoom(quizId).then(
    (room) => {
      rooms.set(quizId, room);
      loading.delete(quizId);
      return room;
    },
    (err: unknown) => {
      loading.delete(quizId);
      throw err;
    },
  );
  loading.set(quizId, build);
  return build;
}

async function loadRoom(quizId: string): Promise<Room> {
  const load: QuizLoad = await loadQuiz(quizId);
  // Phase 2 swaps this for a signed R2 URL.
  const state = toQuizState(load, (a) => a.url ?? `/media/${a.storage_key}`);

  const room: Room = {
    quizId,
    state,
    seq: 0,
    ctx: {
      quizTitle: load.quiz.title,
      presence: new Map(),
      drafts: new Map(),
    },
    connections: new Map(),
    queue: Promise.resolve(),
  };

  // Recovery: replay whatever has already happened. The reducer is pure, so
  // this lands on exactly the state the room had before it went away.
  const log = await query<{ seq: string; action: Action }>(
    'SELECT seq, action FROM quiz_action WHERE quiz_id = $1 ORDER BY seq',
    [quizId],
  );
  for (const row of log) {
    try {
      room.state = reduce(room.state, row.action);
      room.seq = Number(row.seq);
    } catch (err) {
      // A stored action that no longer applies means the quiz content changed
      // underneath a running quiz. Stop replaying rather than pretending.
      throw new Error(
        `Cannot replay action ${room.seq + 1} for quiz ${quizId}: ${(err as Error).message}. ` +
          'The quiz content may have been edited after the quiz started.',
      );
    }
  }

  return room;
}

/** Drop a room from memory. It rebuilds from the log on next use. */
export function evictRoom(quizId: string): void {
  rooms.delete(quizId);
  loading.delete(quizId);
}

export function evictAllRooms(): void {
  rooms.clear();
  loading.clear();
}

/**
 * Write the ledger changes this action produced.
 *
 * The reducer either appends an event or flips a status; score_event's trigger
 * permits exactly those, so a diff is enough. Anything else would be rejected by
 * the database, which is the point of the trigger.
 */
async function persistLedger(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  quizId: string,
  before: readonly ScoreEvent[],
  after: readonly ScoreEvent[],
): Promise<void> {
  const previous = new Map(before.map((e) => [e.id, e]));

  for (const event of after) {
    const prior = previous.get(event.id);
    if (!prior) {
      const row = toScoreEventInsert(event, { quizId });
      await client.query(
        `INSERT INTO score_event
           (id, quiz_id, team_id, round_id, question_id, points, reason, status, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          row.id, row.quiz_id, row.team_id, row.round_id, row.question_id,
          row.points, row.reason, row.status, row.note, row.created_by,
        ],
      );
    } else if (prior.status !== event.status) {
      // PENDING -> APPLIED at the reveal, or -> VOIDED on undo. The trigger
      // rejects anything else, including a status going backwards.
      await client.query('UPDATE score_event SET status = $2 WHERE id = $1', [
        event.id,
        event.status,
      ]);
    }
  }
}

/**
 * Apply a QM intent.
 *
 * Throws if the reducer refuses — an illegal transition is a bug in the console
 * or a stale button, and the caller turns it into a message rather than a crash.
 */
export async function applyAction(room: Room, action: Action, actor: string): Promise<void> {
  // Queue first: read-reduce-write must not interleave with another action.
  const run = room.queue.then(
    () => applyNow(room, action, actor),
    () => applyNow(room, action, actor),
  );
  // The queue itself must never reject, or one bad action would poison every
  // action after it. The caller still sees the rejection through `run`.
  room.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applyNow(room: Room, action: Action, actor: string): Promise<void> {
  const stamped = withServerIds(action);
  const before = room.state;
  // Pure, and first: if this throws, nothing has been written or broadcast.
  const after = reduce(before, stamped);
  const seq = room.seq + 1;

  await transaction(async (client) => {
    await client.query(
      'INSERT INTO quiz_action (quiz_id, seq, action, type, actor) VALUES ($1,$2,$3,$4,$5)',
      [room.quizId, seq, JSON.stringify(stamped), stamped.type, actor],
    );
    await persistLedger(client, room.quizId, before.ledger, after.ledger);
  });

  room.state = after;
  room.seq = seq;
  broadcast(room);
}

// ─── Ephemeral room state — never the reducer's business ────────────────────

export function setDraft(room: Room, teamId: string, text: string, author: string): void {
  const current = room.ctx.drafts.get(teamId) ?? { text: '', updatedBy: null, typing: [] };
  // Last-write-wins with attribution (ARCHITECTURE §5). Three people editing one
  // box is coordination, not a quiz transition, so it stays out of the engine.
  room.ctx.drafts.set(teamId, { ...current, text, updatedBy: author });
  broadcast(room);
}

export function markTyping(room: Room, teamId: string, author: string): void {
  const current: TeamDraft = room.ctx.drafts.get(teamId) ?? {
    text: '',
    updatedBy: null,
    typing: [],
  };
  if (!current.typing.includes(author)) {
    room.ctx.drafts.set(teamId, { ...current, typing: [...current.typing, author] });
    broadcast(room);
  }
  // The indicator clears itself. This is a display timer and touches no quiz
  // state, which is the only kind of timer allowed to exist (CLAUDE.md).
  setTimeout(() => {
    const now = room.ctx.drafts.get(teamId);
    if (!now) return;
    room.ctx.drafts.set(teamId, { ...now, typing: now.typing.filter((n) => n !== author) });
    broadcast(room);
  }, 3000);
}

function recomputePresence(room: Room): void {
  // Deduplicated by name: one person with the quiz open on a laptop and a phone,
  // or mid-reconnect with the old socket not yet reaped, is still one person.
  // Listing them twice makes the team look bigger than it is and reads as a bug.
  const byTeam = new Map<string, Set<string>>();
  for (const conn of room.connections.values()) {
    if (conn.role !== 'TEAM' || !conn.teamId) continue;
    const names = byTeam.get(conn.teamId) ?? new Set<string>();
    names.add(conn.displayName);
    byTeam.set(conn.teamId, names);
  }
  const presence = new Map<string, string[]>();
  for (const [teamId, names] of byTeam) presence.set(teamId, [...names]);
  room.ctx.presence = presence;
}

export function addConnection(room: Room, conn: Connection): void {
  room.connections.set(conn.id, conn);
  recomputePresence(room);
  broadcast(room);
}

export function removeConnection(room: Room, connId: string): void {
  room.connections.delete(connId);
  recomputePresence(room);
  broadcast(room);
}

/** The view this connection is allowed to see. Built per role, never filtered later. */
export function viewFor(room: Room, conn: Connection): View {
  if (conn.role === 'QM') return buildQmView(room.state, room.ctx);
  if (conn.role === 'TEAM' && conn.teamId) {
    return buildTeamView(room.state, room.ctx, {
      teamId: conn.teamId,
      displayName: conn.displayName,
    });
  }
  return buildScoreboardView(room.state, room.ctx);
}

export function sendState(room: Room, conn: Connection): void {
  conn.send({ type: 'STATE', seq: room.seq, view: viewFor(room, conn) });
}

export function broadcast(room: Room): void {
  for (const conn of room.connections.values()) sendState(room, conn);
}

export async function shutdownRooms(): Promise<void> {
  rooms.clear();
  await pool.end().catch(() => undefined);
}
