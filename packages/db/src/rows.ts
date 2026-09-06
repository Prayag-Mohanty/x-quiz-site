/**
 * Row types — one interface per table, mirroring the SQL exactly.
 *
 * These are the shapes `pg` hands back, not the engine's domain types. Names stay
 * snake_case so a query result can be assigned to one of these without a rename
 * step, and so a mismatch with the migration is visible by reading the two side
 * by side. Translation into the engine's types happens in map.ts and nowhere else.
 *
 * Two `pg` behaviours are baked in here:
 *   - `bigint` columns arrive as STRINGS, not numbers, because a bigint does not
 *     fit in a JS number. Anything typed `string` below and named like a number
 *     is a bigint.
 *   - `timestamptz` columns arrive as `Date`.
 */

// ─── Enumerations (mirroring the CHECK constraints) ─────────────────────────

export type QuizStatus = 'DRAFT' | 'READY' | 'LIVE' | 'COMPLETE' | 'ARCHIVED';
export type RoundTypeRow = 'DIRECT' | 'WRITTEN' | 'VISUAL_CONNECT';
export type DirectionRow = 'CW' | 'ACW';
export type MediaKindRow = 'IMAGE' | 'AUDIO' | 'VIDEO';
export type MediaRole = 'PROMPT' | 'ANSWER' | 'REVEAL';
export type TranscodeStatus = 'PENDING' | 'READY' | 'FAILED' | 'NOT_REQUIRED';
export type ScoreStatusRow = 'PENDING' | 'APPLIED' | 'VOIDED';
export type VerdictRow = 'CORRECT' | 'WRONG';

export type ScoreReasonRow =
  | 'POUNCE_CORRECT'
  | 'POUNCE_WRONG'
  | 'BOUNCE_CORRECT'
  | 'PARTIAL'
  | 'WRITTEN_CORRECT'
  | 'WRITTEN_WRONG'
  | 'STAKE_CORRECT'
  | 'STAKE_WRONG'
  | 'CONNECT_CORRECT'
  | 'CONNECT_WRONG'
  | 'TIEBREAK'
  | 'MANUAL_ADJUST';

// ─── Content tables (001_content.sql) ───────────────────────────────────────

export interface QuizRow {
  id: string;
  title: string;
  status: QuizStatus;

  direct_pounce_correct: number;
  direct_pounce_wrong: number;
  direct_bounce_correct: number;
  direct_bounce_wrong: number;
  direct_question_value: number;

  written_correct: number;
  written_wrong: number;
  written_stake_correct: number;
  written_stake_wrong: number;

  rule_pouncers_may_bounce: boolean;
  rule_multiple_stakes_allowed: boolean;
  rule_connect_bounces_after_final_reveal: boolean;

  created_at: Date;
  updated_at: Date;
}

export interface ConnectStageRow {
  id: string;
  quiz_id: string;
  position: number;
  correct: number;
  wrong: number;
}

export interface TeamRow {
  id: string;
  quiz_id: string;
  /** Seat order around the circle. Load-bearing: rotation is defined on it. */
  position: number;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface TeamMemberRow {
  id: string;
  team_id: string;
  position: number;
  display_name: string;
}

export interface RoundRow {
  id: string;
  quiz_id: string;
  position: number;
  type: RoundTypeRow;
  title: string;
  /** Non-null exactly when type is DIRECT. */
  direction: DirectionRow | null;
  /** Not yet consumed by the engine — docs/DATA_MODEL.md discrepancy 2. */
  starting_team_position: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionRow {
  id: string;
  round_id: string;
  /** Denormalised copy of round.type, kept honest by a composite FK. */
  round_type: RoundTypeRow;
  position: number;
  /** Maps to Question.text. */
  body: string;
  answer_text: string;
  /** QM-only. Not part of the engine's Question. */
  qm_notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionPartRow {
  id: string;
  question_id: string;
  position: number;
  label: string;
  canonical_answer: string;
  /** NULL means "use questionValue / parts.length". */
  partial_value: number | null;
  /** Authoring aid only; the engine has no such field. */
  accepted_variants: string[];
}

export interface MediaAssetRow {
  id: string;
  quiz_id: string;
  kind: MediaKindRow;
  storage_key: string;
  /** Usually NULL — the server mints a signed URL at read time. */
  url: string | null;
  /** bigint: arrives as a string. */
  size_bytes: string | null;
  duration_ms: number | null;
  original_filename: string | null;
  content_type: string | null;
  checksum_sha256: string | null;
  /** Public id for the SEALED copy — see migrations/008. */
  preload_id: string;
  /** Base64 AES-256-GCM key, or null until the asset has been sealed. */
  preload_key: string | null;
  transcode_status: TranscodeStatus;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionMediaRow {
  id: string;
  question_id: string;
  round_type: RoundTypeRow;
  role: MediaRole;
  position: number;
  asset_id: string;
  kind: MediaKindRow;
}

/** A row of the quiz_authoring_issue view. */
export interface AuthoringIssueRow {
  quiz_id: string;
  severity: 'ERROR' | 'WARN';
  entity: string;
  entity_id: string;
  issue: string;
}

// ─── Runtime tables (002_runtime.sql) ───────────────────────────────────────

export interface ScoreEventRow {
  id: string;
  /** bigint: arrives as a string. Append order. */
  seq: string;
  quiz_id: string;
  team_id: string;
  round_id: string;
  /** NULL for a manual adjustment made between questions. */
  question_id: string | null;
  points: number;
  reason: ScoreReasonRow;
  status: ScoreStatusRow;
  note: string | null;
  created_at: Date;
  applied_at: Date | null;
  voided_at: Date | null;
  created_by: string | null;
}

export interface QuizActionRow {
  quiz_id: string;
  /** bigint: arrives as a string. */
  seq: string;
  /** The serialised engine Action. */
  action: unknown;
  type: string;
  actor: string | null;
  created_at: Date;
}

export interface QuizSnapshotRow {
  quiz_id: string;
  seq: string;
  /** A serialised QuizState. */
  state: unknown;
  created_at: Date;
}

export interface PounceSubmissionRow {
  id: string;
  question_id: string;
  team_id: string;
  /** VISUAL_CONNECT stage; NULL for DIRECT. */
  stage_idx: number | null;
  body: string;
  verdict: VerdictRow | null;
  submitted_at: Date;
  evaluated_at: Date | null;
}

export interface WrittenAnswerRow {
  id: string;
  question_id: string;
  team_id: string;
  body: string;
  staked: boolean;
  verdict: VerdictRow | null;
  submitted_at: Date;
  locked_at: Date | null;
  evaluated_at: Date | null;
}

// ─── View rows ──────────────────────────────────────────────────────────────

export interface TeamScoreRow {
  quiz_id: string;
  team_id: string;
  name: string;
  position: number;
  /** bigint (sum): arrives as a string. */
  public_score: string;
  provisional_score: string;
  withheld_events: string;
}

export interface TeamStandingRow {
  quiz_id: string;
  team_id: string;
  name: string;
  score: string;
  pounces_correct: string;
  pounces_wrong: string;
  pounces_attempted: string;
}
