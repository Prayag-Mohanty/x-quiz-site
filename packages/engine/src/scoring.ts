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
