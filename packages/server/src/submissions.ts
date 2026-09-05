/**
 * Submission projections.
 *
 * `pounce_submission` and `written_answer` are not state. The action log is the
 * source of truth and the reducer is what reconstructs a quiz; these two tables
 * exist so that "what did Team 6 actually write?" — asked after every quiz — is
 * a SELECT rather than an exercise in unpacking JSONB (002_runtime.sql).
 *
 * They can be rebuilt from `quiz_action` at any time. Nothing reads them back
 * into the engine, and nothing should: if one of these rows ever disagrees with
 * a replay, the replay wins and this file is the bug.
 *
 * ─── Why this runs after every action ───────────────────────────────────────
 *
 * A visual connect keeps `pounces` for the CURRENT stage only (FORMAT_SPEC
 * §2.3) — advance the stage and the text is gone from live state. So the
 * projection cannot be written at the end of a question; it has to be written
 * while the submission is still in front of us. Same diff-the-two-states shape
 * as persistLedger, for the same reason.
 */

import type { QuizState } from '@quizmaster/engine';

type Verdict = 'CORRECT' | 'WRONG' | null;

interface PounceRow {
  questionId: string;
  teamId: string;
  /** Which reveal the pounce came in at, for a connect. NULL for DIRECT. */
  stageIdx: number | null;
  body: string;
  verdict: Verdict;
}

interface WrittenRow {
  questionId: string;
  teamId: string;
  body: string;
  staked: boolean;
  verdict: Verdict;
  /** The round has stopped collecting, so the stake is now binding (§2.2). */
  locked: boolean;
}

type Client = { query: (text: string, params?: unknown[]) => Promise<unknown> };

function pounceRows(state: QuizState): PounceRow[] {
  // Bound to a local so the union stays narrowed inside the closure.
  const active = state.active;
  if (!active || active.kind === 'WRITTEN') return [];
  return active.pounces.map((p) => ({
    questionId: active.questionId,
    teamId: p.teamId,
    stageIdx: active.kind === 'VISUAL_CONNECT' ? active.stageIdx : null,
    body: p.text,
    verdict: p.verdict ?? null,
  }));
}

function writtenRows(state: QuizState): WrittenRow[] {
  const active = state.active;
  if (!active || active.kind !== 'WRITTEN') return [];
  const locked = active.phase !== 'SHOWING' && active.phase !== 'COLLECTING';
  return active.answers.map((a) => ({
    questionId: a.questionId,
    teamId: a.teamId,
    body: a.text,
    staked: a.staked,
    verdict: a.verdict ?? null,
    locked,
  }));
}

const key = (r: { questionId: string; teamId: string }) => `${r.questionId}|${r.teamId}`;

/** Rows in `after` that are new, or changed since `before`. */
function changed<T extends { questionId: string; teamId: string }>(
  before: T[],
  after: T[],
): T[] {
  const previous = new Map(before.map((r) => [key(r), JSON.stringify(r)]));
  return after.filter((r) => previous.get(key(r)) !== JSON.stringify(r));
}

/**
 * Write the submissions this action produced or changed.
 *
 * Upsert rather than insert: a team may edit its written sheet repeatedly
 * before the round closes, and the QM's verdict lands on a row that already
 * exists. `evaluated_at` is set with the first verdict and kept thereafter,
 * because both tables check that it is non-null exactly when a verdict is.
 */
export async function persistSubmissions(
  client: Client,
  before: QuizState,
  after: QuizState,
): Promise<void> {
  for (const row of changed(pounceRows(before), pounceRows(after))) {
    await client.query(
      `INSERT INTO pounce_submission
         (question_id, team_id, stage_idx, body, verdict, evaluated_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (question_id, team_id) DO UPDATE SET
         stage_idx    = EXCLUDED.stage_idx,
         body         = EXCLUDED.body,
         verdict      = EXCLUDED.verdict,
         evaluated_at = CASE
                          WHEN EXCLUDED.verdict IS NULL THEN NULL
                          ELSE COALESCE(pounce_submission.evaluated_at, now())
                        END`,
      [row.questionId, row.teamId, row.stageIdx, row.body, row.verdict],
    );
  }

  for (const row of changed(writtenRows(before), writtenRows(after))) {
    await client.query(
      `INSERT INTO written_answer
         (question_id, team_id, body, staked, verdict, locked_at, evaluated_at)
       VALUES ($1, $2, $3, $4, $5,
               CASE WHEN $6 THEN now() ELSE NULL END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (question_id, team_id) DO UPDATE SET
         body         = EXCLUDED.body,
         staked       = EXCLUDED.staked,
         verdict      = EXCLUDED.verdict,
         locked_at    = CASE
                          WHEN $6 THEN COALESCE(written_answer.locked_at, now())
                          ELSE NULL
                        END,
         evaluated_at = CASE
                          WHEN EXCLUDED.verdict IS NULL THEN NULL
                          ELSE COALESCE(written_answer.evaluated_at, now())
                        END`,
      [row.questionId, row.teamId, row.body, row.staked, row.verdict, row.locked],
    );
  }
}
