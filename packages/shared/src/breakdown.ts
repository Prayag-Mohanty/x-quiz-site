/**
 * The post-quiz breakdown.
 *
 * Not the wire protocol — this is a document, fetched once over HTTP after the
 * quiz is over, not a view that streams. It exists because three questions get
 * asked after every quiz and none of them are answerable from a scoreboard:
 *
 *   "how did we get 45?"          → every award, in the order it happened
 *   "what did we actually write?" → the pounce text and the written sheets
 *   "who was second?"             → the tiebreak signals, shown not resolved
 *
 * The last one is deliberate. FORMAT_SPEC §3 says the system displays the
 * signals and the QM decides; a breakdown that printed a ranking would be
 * making a ruling it has no authority to make.
 *
 * It carries canonical answers and every team's private text, so it is the
 * QM's document and the endpoint requires the quizmaster's token.
 */

export interface BreakdownStanding {
  teamId: string;
  name: string;
  /** Seat index, 0-based. The order everything else is listed in. */
  seat: number;
  /** APPLIED events only — the published score. */
  score: number;
  pouncesAttempted: number;
  pouncesCorrect: number;
  pouncesWrong: number;
  /**
   * Points recorded but never published, because the QM never revealed that
   * question. Almost always a mistake in how the quiz was run, and this is the
   * one place it becomes visible.
   */
  withheldPoints: number;
}

export interface BreakdownEvent {
  teamId: string;
  teamName: string;
  roundIndex: number;
  roundTitle: string;
  /** Null for a round-level award — a tiebreak or a manual adjustment. */
  questionIndex: number | null;
  questionText: string | null;
  points: number;
  reason: string;
  status: 'PENDING' | 'APPLIED' | 'VOIDED';
  note: string | null;
}

export interface BreakdownSubmission {
  teamId: string;
  teamName: string;
  roundIndex: number;
  roundTitle: string;
  questionIndex: number;
  questionText: string;
  /** The canonical answer, for reading a team's words against. */
  answerText: string;
  kind: 'POUNCE' | 'WRITTEN';
  /** Which reveal a connect pounce came in at. Null everywhere else (§2.3). */
  stageIdx: number | null;
  /** Written rounds only (§2.2). */
  staked: boolean;
  body: string;
  verdict: 'CORRECT' | 'WRONG' | null;
}

export interface BreakdownReport {
  quiz: { id: string; title: string; status: string };
  generatedAt: string;
  /** Seat order, never score order — see the note above about rulings. */
  standings: BreakdownStanding[];
  rounds: { id: string; title: string; type: string; index: number }[];
  /** Every award that still counts, oldest first. VOIDED ones are excluded. */
  events: BreakdownEvent[];
  /** What each team wrote, from the projections the action log feeds. */
  submissions: BreakdownSubmission[];
}
