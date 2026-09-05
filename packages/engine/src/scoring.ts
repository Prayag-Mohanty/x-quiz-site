/**
 * Derived views over the score ledger.
 *
 * The ledger is append-only; scores are always computed, never stored.
 * See CLAUDE.md invariant 2 — do not add a `score` field to Team.
 */

import type { QuizState, ScoreEvent, TeamId } from './types.js';

/** Public score: APPLIED events only. PENDING partials are deliberately excluded. */
export function publicScore(ledger: readonly ScoreEvent[], teamId: TeamId): number {
  return ledger
    .filter((e) => e.teamId === teamId && e.status === 'APPLIED')
    .reduce((sum, e) => sum + e.points, 0);
}

/**
 * What the QM sees: APPLIED plus PENDING. Lets the QM know a partial is banked
 * without it appearing on the teams' scoreboard.
 */
export function provisionalScore(ledger: readonly ScoreEvent[], teamId: TeamId): number {
  return ledger
    .filter((e) => e.teamId === teamId && e.status !== 'VOIDED')
    .reduce((sum, e) => sum + e.points, 0);
}

export interface Standing {
  teamId: TeamId;
  name: string;
  score: number;
  pouncesAttempted: number;
  pouncesCorrect: number;
  pouncesWrong: number;
}

/**
 * Standings with tiebreak signals attached.
 *
 * Sorted by score descending. Ties are NOT resolved — the QM decides
 * (FORMAT_SPEC §3). The pounce stats are provided so the QM can decide informedly.
 */
export function standings(state: QuizState): Standing[] {
  const rows = state.teams.map((team) => {
    const own = state.ledger.filter(
      (e) => e.teamId === team.id && e.status !== 'VOIDED',
    );
    const correct = own.filter(
      (e) => e.reason === 'POUNCE_CORRECT' || e.reason === 'CONNECT_CORRECT',
    ).length;
    const wrong = own.filter(
      (e) => e.reason === 'POUNCE_WRONG' || e.reason === 'CONNECT_WRONG',
    ).length;
    return {
      teamId: team.id,
      name: team.name,
      score: publicScore(state.ledger, team.id),
      pouncesAttempted: correct + wrong,
      pouncesCorrect: correct,
      pouncesWrong: wrong,
    };
  });
  return rows.sort((a, b) => b.score - a.score);
}

/** Per-team breakdown for the post-quiz summary. Excludes voided events. */
export function breakdown(state: QuizState, teamId: TeamId): ScoreEvent[] {
  return state.ledger.filter((e) => e.teamId === teamId && e.status !== 'VOIDED');
}

/**
 * How a question's value splits across its parts, when the QM has not said.
 *
 * Points in this format are whole numbers, and `score_event.points` is an
 * integer column — so the obvious `value / parts.length` is a live failure
 * waiting for the first question whose parts do not divide evenly. Three parts
 * of a ten-point question gave 3.3333333333333335, and the insert was rejected
 * mid-bounce with a Postgres type error on the quizmaster's screen.
 *
 * So: floor, and hand the remainder to the earliest parts. 10 across 3 is
 * 4/3/3, which sums to exactly the question value — no fractions, and nothing
 * quietly lost to rounding. An explicit `partialValue` on a part always wins;
 * this is only the default.
 */
export function defaultPartValues(questionValue: number, partCount: number): number[] {
  if (partCount <= 0) return [];
  const base = Math.floor(questionValue / partCount);
  const remainder = questionValue - base * partCount;
  return Array.from({ length: partCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** What one part is worth: what was authored, or its share of the default split. */
export function partValue(
  questionValue: number,
  parts: readonly { partialValue?: number }[],
  index: number,
): number {
  const part = parts[index];
  if (part?.partialValue !== undefined) return part.partialValue;
  return defaultPartValues(questionValue, parts.length)[index] ?? 0;
}
