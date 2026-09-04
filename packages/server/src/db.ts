/**
 * Postgres access.
 *
 * Raw `pg` with parameterised queries rather than Drizzle. DECISIONS.md picks
 * Drizzle, and for new schema work it should be used — but the schema and its
 * mappers were built before that document existed and were kept as-is by
 * explicit decision, so the query layer matches them. Every SQL string lives in
 * queries.ts, not scattered through the routes.
 *
 * Never build SQL by concatenating input. Every value goes through $1, $2, …
 */

import pg from 'pg';

const { Pool } = pg;

// `bigint` (int8) would otherwise arrive as a string. The row types in
// @quizmaster/db already say string, which is correct — a bigint does not fit in
// a JS number — so this is left alone deliberately. Documented here so nobody
// "fixes" it later and quietly breaks size_bytes on a large upload.

export const pool = new Pool({
  connectionString: process.env['DATABASE_URL'],
});

export async function query<T>(text: string, params: readonly unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params as unknown[]);
  return result.rows as T[];
}

/** A query expected to return exactly one row. Throws if it does not. */
export async function one<T>(text: string, params: readonly unknown[] = []): Promise<T> {
  const rows = await query<T>(text, params);
  const row = rows[0];
  if (!row) throw new NotFound('No row returned');
  return row;
}

/** A query expected to return at most one row. */
export async function maybeOne<T>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run a set of statements atomically.
 *
 * Needed for more than tidiness here: reordering positions relies on the
 * DEFERRABLE uniques, which are only checked at COMMIT. Two UPDATEs that swap
 * positions are legal inside one transaction and illegal outside it.
 */
export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export class NotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFound';
  }
}

/**
 * Postgres error codes worth translating into something a UI can show.
 * The schema does a lot of the validation, so these are the normal path for
 * "the QM tried something the format forbids", not exceptional failures.
 */
export function describeDbError(err: unknown): { status: number; message: string } | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as { code?: string; constraint?: string; message?: string };

  const byConstraint: Record<string, string> = {
    spec_2_1_direction_iff_direct:
      'A DIRECT round needs a direction, and only a DIRECT round may have one.',
    spec_2_1_starting_team_only_direct:
      'Only a DIRECT round can have a starting team.',
    spec_4_one_video_per_question_role:
      'A question may carry at most one video (the answer slide may have its own).',
    spec_2_3_reveal_only_in_connect:
      'Staged reveal images belong only to a long visual connect question.',
    spec_2_3_reveals_are_images:
      'A long visual connect is revealed through images.',
    team_name_unique: 'Two teams in the same quiz cannot share a name.',
    spec_2_penalties_are_not_rewards: 'A wrong answer cannot award points.',
    spec_2_rewards_are_not_penalties: 'A correct answer cannot cost points.',
  };

  if (e.constraint && byConstraint[e.constraint]) {
    return { status: 422, message: byConstraint[e.constraint] as string };
  }

  switch (e.code) {
    case '23505':
      return { status: 409, message: 'That already exists.' };
    case '23503':
      return { status: 422, message: 'That refers to something which does not exist.' };
    case '23514':
      return { status: 422, message: e.message ?? 'That value is not allowed.' };
    case '23502':
      return { status: 422, message: 'A required field was missing.' };
    default:
      return null;
  }
}
