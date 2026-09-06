/**
 * Mapping tests.
 *
 * The mappers are pure functions over row literals, so these need no database.
 * The schema's own rules are tested in test/smoke.sql against a real Postgres;
 * this file tests the translation, which is where ordering and optionality get
 * quietly wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toQuizState,
  toScoreEvent,
  toScoreEventInsert,
  type QuizLoad,
  type UrlResolver,
} from '../src/map.js';
import type {
  MediaAssetRow,
  QuestionMediaRow,
  QuestionPartRow,
  QuestionRow,
  QuizRow,
  RoundRow,
  ScoreEventRow,
  TeamRow,
} from '../src/rows.js';

// ─── Row factories ──────────────────────────────────────────────────────────

const NOW = new Date('2026-09-05T00:00:00Z');
const resolve: UrlResolver = (a) => `https://cdn.test/${a.storage_key}`;

function quizRow(over: Partial<QuizRow> = {}): QuizRow {
  return {
    id: 'q1',
    title: 'Test Quiz',
    status: 'DRAFT',
    direct_pounce_correct: 10,
    direct_pounce_wrong: -5,
    direct_bounce_correct: 10,
    direct_bounce_wrong: 0,
    direct_question_value: 10,
    written_correct: 10,
    written_wrong: 0,
    written_stake_correct: 15,
    written_stake_wrong: -5,
    rule_pouncers_may_bounce: false,
    rule_multiple_stakes_allowed: true,
    rule_connect_bounces_after_final_reveal: false,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function teamRow(position: number, over: Partial<TeamRow> = {}): TeamRow {
  return {
    id: `t${position}`,
    quiz_id: 'q1',
    position,
    name: `Team ${position}`,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function roundRow(over: Partial<RoundRow> = {}): RoundRow {
  return {
    id: 'r1',
    quiz_id: 'q1',
    position: 0,
    type: 'DIRECT',
    title: 'Round 1',
    direction: 'CW',
    starting_team_position: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function questionRow(over: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: 'qn1',
    round_id: 'r1',
    round_type: 'DIRECT',
    position: 0,
    body: 'The question text',
    answer_text: 'The answer',
    qm_notes: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function partRow(position: number, over: Partial<QuestionPartRow> = {}): QuestionPartRow {
  return {
    id: `p${position}`,
    question_id: 'qn1',
    position,
    label: `Part ${position}`,
    canonical_answer: 'x',
    partial_value: null,
    accepted_variants: [],
    ...over,
  };
}

function assetRow(id: string, over: Partial<MediaAssetRow> = {}): MediaAssetRow {
  return {
    id,
    quiz_id: 'q1',
    kind: 'IMAGE',
    storage_key: `${id}.jpg`,
    url: null,
    size_bytes: null,
    duration_ms: null,
    original_filename: null,
    content_type: null,
    checksum_sha256: null,
    // Sealed preload (migrations/008). The mapper does not read these — the
    // key never travels through the engine's domain types — but the row shape
    // has to be honest about what the table holds.
    preload_id: `${id}-preload`,
    preload_key: null,
    transcode_status: 'READY',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function mediaRow(over: Partial<QuestionMediaRow> = {}): QuestionMediaRow {
  return {
    id: `qm-${Math.random()}`,
    question_id: 'qn1',
    round_type: 'DIRECT',
    role: 'PROMPT',
    position: 0,
    asset_id: 'a1',
    kind: 'IMAGE',
    ...over,
  };
}

function scoreEventRow(over: Partial<ScoreEventRow> = {}): ScoreEventRow {
  return {
    id: 'e1',
    seq: '1',
    quiz_id: 'q1',
    team_id: 't0',
    round_id: 'r1',
    question_id: 'qn1',
    points: 10,
    reason: 'BOUNCE_CORRECT',
    status: 'APPLIED',
    note: null,
    created_at: NOW,
    applied_at: NOW,
    voided_at: null,
    created_by: null,
    ...over,
  };
}

function load(over: Partial<QuizLoad> = {}): QuizLoad {
  return {
    quiz: quizRow(),
    teams: [teamRow(0), teamRow(1)],
    teamMembers: [],
    rounds: [roundRow()],
    questions: [questionRow()],
    parts: [partRow(0)],
    questionMedia: [],
    assets: [],
    connectStages: [],
    ledger: [],
    ...over,
  };
}

// ─── Ordering ───────────────────────────────────────────────────────────────
// SQL returns rows in whatever order the planner likes. The engine indexes into
// these arrays and rotation.ts does arithmetic on the indices.

test('teams are ordered by seat, whatever order the rows arrive in', () => {
  const state = toQuizState(
    load({ teams: [teamRow(2), teamRow(0), teamRow(3), teamRow(1)] }),
    resolve,
  );
  assert.deepEqual(
    state.teams.map((t) => t.name),
    ['Team 0', 'Team 1', 'Team 2', 'Team 3'],
  );
});

test('rounds, questions and parts are ordered by position', () => {
  const state = toQuizState(
    load({
      rounds: [roundRow({ id: 'r2', position: 1, title: 'Second' }), roundRow()],
      questions: [
        questionRow({ id: 'qn2', position: 1, body: 'second' }),
        questionRow({ id: 'qn1', position: 0, body: 'first' }),
      ],
      parts: [
        partRow(1, { id: 'pB', question_id: 'qn1' }),
        partRow(0, { id: 'pA', question_id: 'qn1' }),
      ],
    }),
    resolve,
  );
  assert.deepEqual(state.rounds.map((r) => r.title), ['Round 1', 'Second']);
  const first = state.rounds[0];
  assert.ok(first);
  assert.deepEqual(first.questions.map((q) => q.text), ['first', 'second']);
  assert.deepEqual(first.questions[0]?.parts.map((p) => p.id), ['pA', 'pB']);
});

test('media is ordered within each role', () => {
  const state = toQuizState(
    load({
      assets: [assetRow('a1'), assetRow('a2'), assetRow('a3')],
      questionMedia: [
        mediaRow({ role: 'PROMPT', position: 1, asset_id: 'a2' }),
        mediaRow({ role: 'PROMPT', position: 0, asset_id: 'a1' }),
        mediaRow({ role: 'ANSWER', position: 0, asset_id: 'a3' }),
      ],
    }),
    resolve,
  );
  const q = state.rounds[0]?.questions[0];
  assert.ok(q);
  assert.deepEqual(q.media.map((m) => m.id), ['a1', 'a2']);
  assert.deepEqual(q.answerMedia.map((m) => m.id), ['a3']);
});

// ─── Team seating — FORMAT_SPEC §2.1 ────────────────────────────────────────
// A team's index IS its seat. A gap shifts every team after it, silently.

test('a gap in team seats is rejected at load time', () => {
  assert.throws(
    () => toQuizState(load({ teams: [teamRow(0), teamRow(2)] }), resolve),
    /not contiguous/,
  );
});

test('two teams in one seat is rejected at load time', () => {
  assert.throws(
    () => toQuizState(load({ teams: [teamRow(0), teamRow(0, { id: 'other' })] }), resolve),
    /share seat/,
  );
});

// ─── Optionality ────────────────────────────────────────────────────────────
// The engine sets exactOptionalPropertyTypes, and its fallbacks key off a
// MISSING property, not an undefined one. `{ partialValue: undefined }` would
// defeat the "value / parts.length" default.

test('a NULL partial_value leaves the key absent, not undefined', () => {
  const state = toQuizState(load({ parts: [partRow(0, { partial_value: null })] }), resolve);
  const part = state.rounds[0]?.questions[0]?.parts[0];
  assert.ok(part);
  assert.equal('partialValue' in part, false);
});

test('a set partial_value is carried through', () => {
  const state = toQuizState(load({ parts: [partRow(0, { partial_value: 7 })] }), resolve);
  assert.equal(state.rounds[0]?.questions[0]?.parts[0]?.partialValue, 7);
});

test('a non-DIRECT round has no direction property at all', () => {
  const state = toQuizState(
    load({
      rounds: [roundRow({ type: 'WRITTEN', direction: null })],
      questions: [questionRow({ round_type: 'WRITTEN' })],
    }),
    resolve,
  );
  const round = state.rounds[0];
  assert.ok(round);
  assert.equal('direction' in round, false);
});

test('revealSequence is absent unless the question has reveal media', () => {
  const plain = toQuizState(load(), resolve).rounds[0]?.questions[0];
  assert.ok(plain);
  assert.equal('revealSequence' in plain, false);

  const connect = toQuizState(
    load({
      rounds: [roundRow({ type: 'VISUAL_CONNECT', direction: null })],
      questions: [questionRow({ round_type: 'VISUAL_CONNECT' })],
      assets: [assetRow('a1')],
      questionMedia: [mediaRow({ role: 'REVEAL', round_type: 'VISUAL_CONNECT' })],
    }),
    resolve,
  ).rounds[0]?.questions[0];
  assert.ok(connect);
  assert.deepEqual(connect.revealSequence?.map((m) => m.id), ['a1']);
});

// ─── Media ──────────────────────────────────────────────────────────────────

test('the URL is minted by the resolver, not read from the row', () => {
  const state = toQuizState(
    load({
      assets: [assetRow('a1', { storage_key: 'signed-me.jpg', url: 'https://stale/url' })],
      questionMedia: [mediaRow()],
    }),
    resolve,
  );
  assert.equal(state.rounds[0]?.questions[0]?.media[0]?.url, 'https://cdn.test/signed-me.jpg');
});

test('size_bytes arrives from pg as a bigint string and becomes a number', () => {
  const state = toQuizState(
    load({
      assets: [assetRow('a1', { size_bytes: '15728640' })],
      questionMedia: [mediaRow()],
    }),
    resolve,
  );
  assert.equal(state.rounds[0]?.questions[0]?.media[0]?.sizeBytes, 15728640);
});

test('a question referencing an asset that was not loaded fails loudly', () => {
  assert.throws(
    () => toQuizState(load({ assets: [], questionMedia: [mediaRow({ asset_id: 'missing' })] }), resolve),
    /was not loaded/,
  );
});

// ─── Score events ───────────────────────────────────────────────────────────

test('a NULL question_id becomes the empty string the reducer expects', () => {
  const event = toScoreEvent(scoreEventRow({ question_id: null, reason: 'MANUAL_ADJUST', note: 'penalty' }));
  assert.equal(event.questionId, '');
});

test('an empty questionId becomes NULL on the way back to SQL', () => {
  const insert = toScoreEventInsert(
    { id: 'e9', teamId: 't0', roundId: 'r1', questionId: '', points: -10, reason: 'MANUAL_ADJUST', status: 'APPLIED', note: 'penalty' },
    { quizId: 'q1' },
  );
  assert.equal(insert.question_id, null);
});

test('a score event round-trips through both mappers', () => {
  const row = scoreEventRow({ note: 'close enough' });
  const insert = toScoreEventInsert(toScoreEvent(row), { quizId: 'q1' });
  assert.equal(insert.id, row.id);
  assert.equal(insert.team_id, row.team_id);
  assert.equal(insert.question_id, row.question_id);
  assert.equal(insert.points, row.points);
  assert.equal(insert.reason, row.reason);
  assert.equal(insert.status, row.status);
  assert.equal(insert.note, row.note);
});

test('a null note is absent on the domain type and null again on the way back', () => {
  const event = toScoreEvent(scoreEventRow({ note: null }));
  assert.equal('note' in event, false);
  assert.equal(toScoreEventInsert(event, { quizId: 'q1' }).note, null);
});

// ─── Quiz-level configuration ───────────────────────────────────────────────

test('scoring config and rule toggles come across from the quiz row', () => {
  const state = toQuizState(
    load({ quiz: quizRow({ direct_pounce_wrong: -10, rule_pouncers_may_bounce: true }) }),
    resolve,
  );
  assert.equal(state.directScoring.pounceWrong, -10);
  assert.equal(state.directScoring.pounceCorrect, 10);
  assert.equal(state.rules.pouncersMayBounce, true);
});

test('connect stages keep their decay order', () => {
  const state = toQuizState(
    load({
      connectStages: [
        { id: 's3', quiz_id: 'q1', position: 3, correct: 5, wrong: 0 },
        { id: 's1', quiz_id: 'q1', position: 1, correct: 15, wrong: -10 },
        { id: 's0', quiz_id: 'q1', position: 0, correct: 20, wrong: -15 },
        { id: 's2', quiz_id: 'q1', position: 2, correct: 10, wrong: -5 },
      ],
    }),
    resolve,
  );
  assert.deepEqual(state.connectStages.map((s) => s.correct), [20, 15, 10, 5]);
});

test('the opening round honours its configured starting team', () => {
  const state = toQuizState(
    load({ rounds: [roundRow({ starting_team_position: 1 })] }),
    resolve,
  );
  assert.equal(state.nextDirectTeamIdx, 1);
});

test('with no configured starting team the first direct goes to seat 0', () => {
  assert.equal(toQuizState(load(), resolve).nextDirectTeamIdx, 0);
});

test('the loaded state is the state before any action has been replayed', () => {
  const state = toQuizState(load({ ledger: [scoreEventRow()] }), resolve);
  assert.equal(state.roundIdx, 0);
  assert.equal(state.questionIdx, 0);
  assert.equal(state.active, null);
  assert.equal(state.ledger.length, 1);
});
