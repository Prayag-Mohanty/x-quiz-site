/**
 * Every action is a QM intent.
 *
 * CLAUDE.md invariant: timers never dispatch these. If you are writing
 * `setTimeout(() => dispatch(...))` against quiz state, stop — it is wrong.
 *
 * `eventId` is passed in rather than generated, to keep the reducer pure.
 */

import type { QuestionId, TeamId } from './types.js';

export type Action =
  // ── DIRECT round ──────────────────────────────────────────────────────────
  | { type: 'PRESENT_QUESTION'; questionId: QuestionId }
  | { type: 'OPEN_POUNCE' }
  | { type: 'FINAL_CALL' }
  | { type: 'SUBMIT_POUNCE'; teamId: TeamId; text: string }
  | { type: 'CLOSE_POUNCE' }
  | { type: 'EVALUATE_POUNCE'; teamId: TeamId; verdict: 'CORRECT' | 'WRONG'; eventId: string }
  | { type: 'FINISH_POUNCE_EVALUATION' }
  | { type: 'OPEN_BOUNCE' }
  | { type: 'BOUNCE_CORRECT'; eventId: string }
  | {
      type: 'BOUNCE_PARTIAL';
      partIds: string[];
      /** Override the default partial value. Omit for value/parts. */
      points?: number;
      eventId: string;
    }
  | { type: 'BOUNCE_WRONG' }
  | { type: 'REVEAL_ANSWER' }
  | { type: 'NEXT_QUESTION' }

  // ── VISUAL_CONNECT round ──────────────────────────────────────────────────
  | { type: 'SHOW_REVEAL' }
  | { type: 'ADVANCE_REVEAL' }

  // ── WRITTEN round ─────────────────────────────────────────────────────────
  | { type: 'SHOW_WRITTEN_QUESTION'; index: number }
  | { type: 'OPEN_COLLECTION' }
  | {
      type: 'SUBMIT_WRITTEN';
      teamId: TeamId;
      questionId: QuestionId;
      text: string;
      staked: boolean;
    }
  | { type: 'CLOSE_COLLECTION' }
  | {
      type: 'EVALUATE_WRITTEN';
      teamId: TeamId;
      questionId: QuestionId;
      verdict: 'CORRECT' | 'WRONG';
      eventId: string;
    }
  | { type: 'FINISH_WRITTEN_EVALUATION' }

  // ── Cross-cutting ─────────────────────────────────────────────────────────
  | { type: 'MANUAL_ADJUST'; teamId: TeamId; points: number; note: string; eventId: string }
  | { type: 'VOID_EVENT'; eventId: string }
  | { type: 'START_ROUND'; roundIdx: number };

/** Thrown when an action is dispatched in a phase that does not permit it. */
export class IllegalTransition extends Error {
  constructor(action: Action['type'], phase: string) {
    super(`Action ${action} is not legal in phase ${phase}`);
    this.name = 'IllegalTransition';
  }
}
