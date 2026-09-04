/**
 * Core domain types for the quiz engine.
 *
 * See docs/FORMAT_SPEC.md — that document is normative. Every type here should be
 * traceable to a rule in it.
 */

// ─── Identifiers ────────────────────────────────────────────────────────────

export type TeamId = string;
export type QuestionId = string;
export type RoundId = string;
export type EventId = string;

// ─── Configuration ──────────────────────────────────────────────────────────

export type Direction = 'CW' | 'ACW';

export type RoundType = 'DIRECT' | 'WRITTEN' | 'VISUAL_CONNECT';

/** Scoring values for a DIRECT round. Defaults match FORMAT_SPEC §2.1. */
export interface DirectScoring {
  pounceCorrect: number; // +10
  pounceWrong: number; // -5
  bounceCorrect: number; // +10
  bounceWrong: number; // 0
  questionValue: number; // 10 — used to derive default partial value
}

export const DEFAULT_DIRECT_SCORING: DirectScoring = {
  pounceCorrect: 10,
  pounceWrong: -5,
  bounceCorrect: 10,
  bounceWrong: 0,
  questionValue: 10,
};

export interface WrittenScoring {
  correct: number; // +10
  wrong: number; // 0
  stakeCorrect: number; // +15
  stakeWrong: number; // -5
}

export const DEFAULT_WRITTEN_SCORING: WrittenScoring = {
  correct: 10,
  wrong: 0,
  stakeCorrect: 15,
  stakeWrong: -5,
};

/** Per-reveal-stage values for VISUAL_CONNECT. Index 0 = first reveal. */
export interface ConnectStage {
  correct: number;
  wrong: number;
}

export const DEFAULT_CONNECT_STAGES: readonly ConnectStage[] = [
  { correct: 20, wrong: -15 },
  { correct: 15, wrong: -10 },
  { correct: 10, wrong: -5 },
  { correct: 5, wrong: 0 },
];

/**
 * Rule toggles for behaviours that are genuinely open (FORMAT_SPEC §5).
 * Defaults encode the current assumption; flipping one must not require code changes.
 */
export interface RuleOptions {
  /** §5.1 — may a team that pounced wrong still answer on bounce? */
  wrongPouncerMayBounce: boolean;
  /** §5.2 — may a team stake more than one written-round answer? */
  multipleStakesAllowed: boolean;
  /** §5.4 — does a visual connect bounce after the final reveal, or die? */
  connectBouncesAfterFinalReveal: boolean;
}

export const DEFAULT_RULES: RuleOptions = {
  wrongPouncerMayBounce: true,
  multipleStakesAllowed: true,
  connectBouncesAfterFinalReveal: false,
};

// ─── Content ────────────────────────────────────────────────────────────────

export type MediaKind = 'IMAGE' | 'AUDIO' | 'VIDEO';

export interface Media {
  id: string;
  kind: MediaKind;
  url: string;
  /** Bytes; used to drive the preload readiness grid. */
  sizeBytes?: number;
}

export interface QuestionPart {
  id: string;
  label: string;
  canonicalAnswer: string;
  /** Default partial value if this part alone is answered. Falls back to value/parts. */
  partialValue?: number;
}

export interface Question {
  id: QuestionId;
  /** Always required — FORMAT_SPEC §4. */
  text: string;
  media: Media[];
  /** One entry for a simple question; 2+ for a multi-part question. */
  parts: QuestionPart[];
  answerText: string;
  answerMedia: Media[];
  /** VISUAL_CONNECT only: images revealed one at a time, in order. */
  revealSequence?: Media[];
}

export interface Round {
  id: RoundId;
  type: RoundType;
  title: string;
  /** DIRECT only. */
  direction?: Direction;
  questions: Question[];
}

export interface Team {
  id: TeamId;
  name: string;
  members: string[];
}

// ─── Score ledger ───────────────────────────────────────────────────────────

export type ScoreReason =
  | 'POUNCE_CORRECT'
  | 'POUNCE_WRONG'
  | 'BOUNCE_CORRECT'
  | 'PARTIAL'
  | 'WRITTEN_CORRECT'
  | 'STAKE_CORRECT'
  | 'STAKE_WRONG'
  | 'CONNECT_CORRECT'
  | 'CONNECT_WRONG'
  | 'TIEBREAK'
  | 'MANUAL_ADJUST';

/**
 * PENDING — recorded but withheld from the public scoreboard. Used for partial credit,
 *           which must not be published before the answer reveal (FORMAT_SPEC §2.1).
 * APPLIED  — counts toward the score.
 * VOIDED   — undone by the QM; retained for audit.
 */
export type ScoreStatus = 'PENDING' | 'APPLIED' | 'VOIDED';

export interface ScoreEvent {
  id: EventId;
  teamId: TeamId;
  roundId: RoundId;
  questionId: QuestionId;
  points: number;
  reason: ScoreReason;
  status: ScoreStatus;
  /** QM's free-text justification. Surfaces in the post-quiz breakdown. */
  note?: string;
}

// ─── Question phase (the DIRECT state machine) ──────────────────────────────

export type DirectPhase =
  | 'IDLE'
  | 'PRESENTED'
  | 'POUNCE_OPEN'
  | 'POUNCE_FINAL_CALL'
  | 'POUNCE_CLOSED'
  | 'POUNCE_EVALUATED'
  | 'BOUNCE'
  | 'RESOLVED'
  | 'DEAD'
  | 'REVEALED';

export interface PounceSubmission {
  teamId: TeamId;
  text: string;
  /** Set once the QM has judged it. Undefined = not yet evaluated. */
  verdict?: 'CORRECT' | 'WRONG';
}

export interface DirectQuestionState {
  kind: 'DIRECT';
  phase: DirectPhase;
  questionId: QuestionId;
  /** Index into quiz.teams of the team this question was posed to. */
  directTeamIdx: number;
  /** Current bounce position; null before bounce opens. */
  bounceTeamIdx: number | null;
  /** Teams already offered the question on bounce, in order. */
  bounceOffered: TeamId[];
  pounces: PounceSubmission[];
  /** Parts credited so far, by part id → team that got it. */
  partsCredited: Record<string, TeamId>;
}

// ─── Visual connect state ───────────────────────────────────────────────────

export type ConnectPhase =
  | 'IDLE'
  | 'REVEAL_SHOWN'
  | 'POUNCE_OPEN'
  | 'POUNCE_CLOSED'
  | 'POUNCE_EVALUATED'
  | 'RESOLVED'
  | 'DEAD'
  | 'REVEALED';

export interface ConnectQuestionState {
  kind: 'VISUAL_CONNECT';
  phase: ConnectPhase;
  questionId: QuestionId;
  /** 0-based index of the currently shown reveal. */
  stageIdx: number;
  /** Pounces for the CURRENT stage only. */
  pounces: PounceSubmission[];
  /**
   * One pounce per team per QUESTION, not per stage (FORMAT_SPEC §2.3).
   * Once a team appears here they are out for the rest of this connect.
   */
  spentTeams: TeamId[];
}

// ─── Written round state ────────────────────────────────────────────────────

export type WrittenPhase =
  | 'IDLE'
  | 'SHOWING'
  | 'COLLECTING'
  | 'SUBMITTED'
  | 'EVALUATING'
  | 'REVEALED';

export interface WrittenAnswer {
  teamId: TeamId;
  questionId: QuestionId;
  text: string;
  staked: boolean;
  verdict?: 'CORRECT' | 'WRONG';
}

export interface WrittenRoundState {
  kind: 'WRITTEN';
  phase: WrittenPhase;
  /** Index of the question currently displayed during SHOWING. */
  shownIdx: number;
  answers: WrittenAnswer[];
}

export type QuestionState =
  | DirectQuestionState
  | ConnectQuestionState
  | WrittenRoundState;

// ─── Quiz state ─────────────────────────────────────────────────────────────

export interface QuizState {
  teams: Team[];
  rounds: Round[];
  roundIdx: number;
  questionIdx: number;
  /** Null between questions. */
  active: QuestionState | null;
  ledger: ScoreEvent[];
  rules: RuleOptions;
  directScoring: DirectScoring;
  writtenScoring: WrittenScoring;
  connectStages: readonly ConnectStage[];
  /**
   * Direct team for the NEXT direct question, as an index into teams.
   * Maintained across questions per FORMAT_SPEC §2.1 advancement rule.
   */
  nextDirectTeamIdx: number;
}
