/**
 * Row-to-domain mapping. The only place snake_case becomes camelCase.
 *
 * Pure — no I/O, no `pg`, no queries. It takes the flat arrays a handful of
 * SELECTs return and assembles the engine's nested types, so this module can be
 * unit tested with literals and the query layer can live in the server package
 * where it belongs.
 *
 * Two invariants it exists to protect:
 *
 *   1. ORDER. The engine indexes into arrays and rotation.ts does arithmetic on
 *      those indices. SQL rows arrive in whatever order the planner likes, so
 *      every array is sorted by `position` here. Skipping that produces a quiz
 *      that bounces in the wrong direction — with no error anywhere.
 *
 *   2. TEAM SEATING. Team positions must be contiguous from 0, because a team's
 *      index IS its seat. A gap silently shifts every team after it. The
 *      readiness view catches this at authoring time; this catches it at load
 *      time, loudly, rather than mid-quiz.
 */

import type {
  ConnectStage,
  DirectScoring,
  Media,
  Question,
  QuestionPart,
  QuizState,
  Round,
  RuleOptions,
  ScoreEvent,
  Team,
  WrittenScoring,
} from '@quizmaster/engine';

import type {
  ConnectStageRow,
  MediaAssetRow,
  QuestionMediaRow,
  QuestionPartRow,
  QuestionRow,
  QuizRow,
  RoundRow,
  ScoreEventRow,
  TeamMemberRow,
  TeamRow,
} from './rows.js';

/**
 * Turns a stored asset into a URL the client can fetch.
 *
 * Injected rather than assumed because R2 URLs are signed and expire — see the
 * note on media_asset in 001_content.sql. In tests this is
 * `(a) => a.storage_key`.
 */
export type UrlResolver = (asset: MediaAssetRow) => string;

/** Everything one quiz needs, as the flat arrays a few SELECTs return. */
export interface QuizLoad {
  quiz: QuizRow;
  teams: readonly TeamRow[];
  teamMembers: readonly TeamMemberRow[];
  rounds: readonly RoundRow[];
  questions: readonly QuestionRow[];
  parts: readonly QuestionPartRow[];
  questionMedia: readonly QuestionMediaRow[];
  assets: readonly MediaAssetRow[];
  connectStages: readonly ConnectStageRow[];
  ledger: readonly ScoreEventRow[];
}

// ─── Ordering helpers ───────────────────────────────────────────────────────

function byPosition<T extends { position: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.position - b.position);
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * A team's index is its seat at the table. Positions must run 0..n-1 with no
 * gaps or duplicates, or every rotation computed from them is wrong.
 */
function assertContiguousSeats(teams: readonly TeamRow[]): void {
  const seen = new Set<number>();
  for (const team of teams) {
    if (seen.has(team.position)) {
      throw new Error(
        `Two teams share seat ${team.position} in quiz ${team.quiz_id}. ` +
          'Team positions are the rotation order and must be unique.',
      );
    }
    seen.add(team.position);
  }
  for (let i = 0; i < teams.length; i++) {
    if (!seen.has(i)) {
      throw new Error(
        `Team seats are not contiguous: no team at position ${i} of ${teams.length}. ` +
          'Rotation walks these indices, so a gap breaks the bounce order.',
      );
    }
  }
}

// ─── Leaf mappers ───────────────────────────────────────────────────────────

export function toMedia(asset: MediaAssetRow, resolveUrl: UrlResolver): Media {
  const sizeBytes = asset.size_bytes === null ? null : Number(asset.size_bytes);
  return {
    id: asset.id,
    kind: asset.kind,
    url: resolveUrl(asset),
    // exactOptionalPropertyTypes: an absent optional must be absent, not undefined.
    ...(sizeBytes === null ? {} : { sizeBytes }),
  };
}

export function toQuestionPart(row: QuestionPartRow): QuestionPart {
  return {
    id: row.id,
    label: row.label,
    canonicalAnswer: row.canonical_answer,
    // NULL means "fall back to questionValue / parts.length" — which the engine
    // does itself, so the key must be absent rather than undefined.
    ...(row.partial_value === null ? {} : { partialValue: row.partial_value }),
  };
}

export function toTeam(row: TeamRow, members: readonly TeamMemberRow[]): Team {
  return {
    id: row.id,
    name: row.name,
    members: byPosition(members).map((m) => m.display_name),
  };
}

export function toConnectStage(row: ConnectStageRow): ConnectStage {
  return { correct: row.correct, wrong: row.wrong };
}

/**
 * The engine's ScoreEvent has no quizId, and its questionId is a required
 * string. A manual adjustment made between questions has no question, which the
 * reducer represents as '' — see docs/DATA_MODEL.md discrepancy 4.
 */
export function toScoreEvent(row: ScoreEventRow): ScoreEvent {
  return {
    id: row.id,
    teamId: row.team_id,
    roundId: row.round_id,
    questionId: row.question_id ?? '',
    points: row.points,
    reason: row.reason,
    status: row.status,
    ...(row.note === null ? {} : { note: row.note }),
  };
}

/** The other direction: what to INSERT for an event the reducer produced. */
export interface ScoreEventInsert {
  id: string;
  quiz_id: string;
  team_id: string;
  round_id: string;
  question_id: string | null;
  points: number;
  reason: ScoreEvent['reason'];
  status: ScoreEvent['status'];
  note: string | null;
  created_by: string | null;
}

export function toScoreEventInsert(
  event: ScoreEvent,
  ctx: { quizId: string; createdBy?: string },
): ScoreEventInsert {
  return {
    id: event.id,
    quiz_id: ctx.quizId,
    team_id: event.teamId,
    round_id: event.roundId,
    // '' is not a foreign key. The empty string and NULL mean the same thing:
    // no question was in play.
    question_id: event.questionId === '' ? null : event.questionId,
    points: event.points,
    reason: event.reason,
    status: event.status,
    note: event.note ?? null,
    created_by: ctx.createdBy ?? null,
  };
}

// ─── Question assembly ──────────────────────────────────────────────────────

interface MediaIndex {
  byQuestion: Map<string, QuestionMediaRow[]>;
  assets: Map<string, MediaAssetRow>;
}

function mediaForRole(
  questionId: string,
  role: QuestionMediaRow['role'],
  index: MediaIndex,
  resolveUrl: UrlResolver,
): Media[] {
  const rows = index.byQuestion.get(questionId) ?? [];
  return byPosition(rows.filter((m) => m.role === role)).map((m) => {
    const asset = index.assets.get(m.asset_id);
    if (!asset) {
      throw new Error(
        `Question ${questionId} references media asset ${m.asset_id}, which was not loaded. ` +
          'Load every asset the questions reference, or the client will preload nothing.',
      );
    }
    return toMedia(asset, resolveUrl);
  });
}

export function toQuestion(
  row: QuestionRow,
  parts: readonly QuestionPartRow[],
  index: MediaIndex,
  resolveUrl: UrlResolver,
): Question {
  const revealSequence = mediaForRole(row.id, 'REVEAL', index, resolveUrl);
  return {
    id: row.id,
    // The one rename: question.body -> Question.text.
    text: row.body,
    media: mediaForRole(row.id, 'PROMPT', index, resolveUrl),
    parts: byPosition(parts).map(toQuestionPart),
    answerText: row.answer_text,
    answerMedia: mediaForRole(row.id, 'ANSWER', index, resolveUrl),
    // Only VISUAL_CONNECT questions have one, and the schema enforces that.
    ...(revealSequence.length === 0 ? {} : { revealSequence }),
  };
}

export function toRound(
  row: RoundRow,
  questions: readonly QuestionRow[],
  partsByQuestion: Map<string, QuestionPartRow[]>,
  index: MediaIndex,
  resolveUrl: UrlResolver,
): Round {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    // Non-null exactly when type is DIRECT — spec_2_1_direction_iff_direct.
    ...(row.direction === null ? {} : { direction: row.direction }),
    questions: byPosition(questions).map((q) =>
      toQuestion(q, partsByQuestion.get(q.id) ?? [], index, resolveUrl),
    ),
  };
}

// ─── Whole-quiz assembly ────────────────────────────────────────────────────

export function toDirectScoring(quiz: QuizRow): DirectScoring {
  return {
    pounceCorrect: quiz.direct_pounce_correct,
    pounceWrong: quiz.direct_pounce_wrong,
    bounceCorrect: quiz.direct_bounce_correct,
    bounceWrong: quiz.direct_bounce_wrong,
    questionValue: quiz.direct_question_value,
  };
}

export function toWrittenScoring(quiz: QuizRow): WrittenScoring {
  return {
    correct: quiz.written_correct,
    wrong: quiz.written_wrong,
    stakeCorrect: quiz.written_stake_correct,
    stakeWrong: quiz.written_stake_wrong,
  };
}

export function toRuleOptions(quiz: QuizRow): RuleOptions {
  return {
    pouncersMayBounce: quiz.rule_pouncers_may_bounce,
    multipleStakesAllowed: quiz.rule_multiple_stakes_allowed,
    connectBouncesAfterFinalReveal: quiz.rule_connect_bounces_after_final_reveal,
  };
}

/**
 * Build the engine's starting state from stored rows.
 *
 * This is the state BEFORE any action has been replayed: round 0, question 0,
 * nothing active. To recover a quiz already in progress, take this as the base
 * and replay quiz_action through reduce() — see docs/DATA_MODEL.md §5.
 */
export function toQuizState(load: QuizLoad, resolveUrl: UrlResolver): QuizState {
  const teams = byPosition(load.teams);
  assertContiguousSeats(teams);

  const membersByTeam = groupBy(load.teamMembers, (m) => m.team_id);
  const questionsByRound = groupBy(load.questions, (q) => q.round_id);
  const partsByQuestion = groupBy(load.parts, (p) => p.question_id);

  const index: MediaIndex = {
    byQuestion: groupBy(load.questionMedia, (m) => m.question_id),
    assets: new Map(load.assets.map((a) => [a.id, a])),
  };

  const rounds = byPosition(load.rounds).map((r) =>
    toRound(r, questionsByRound.get(r.id) ?? [], partsByQuestion, index, resolveUrl),
  );

  return {
    teams: teams.map((t) => toTeam(t, membersByTeam.get(t.id) ?? [])),
    rounds,
    roundIdx: 0,
    questionIdx: 0,
    active: null,
    ledger: load.ledger.map(toScoreEvent),
    rules: toRuleOptions(load.quiz),
    directScoring: toDirectScoring(load.quiz),
    writtenScoring: toWrittenScoring(load.quiz),
    connectStages: byPosition(load.connectStages).map(toConnectStage),
    nextDirectTeamIdx: firstDirectSeat(load.rounds),
  };
}

/**
 * Which team gets the very first direct question.
 *
 * Honours round.starting_team_position for the opening round. The engine has no
 * per-round equivalent, so this is as far as the stored intent currently
 * reaches — every later round carries on from wherever the previous one ended.
 * See docs/DATA_MODEL.md discrepancy 2; resolving it is a Phase 1 change to
 * START_ROUND, not a mapping problem.
 */
function firstDirectSeat(rounds: readonly RoundRow[]): number {
  const first = byPosition(rounds)[0];
  if (!first || first.starting_team_position === null) return 0;
  return first.starting_team_position;
}
