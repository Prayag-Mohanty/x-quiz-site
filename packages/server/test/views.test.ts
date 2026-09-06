/**
 * What each role is allowed to receive.
 *
 * These are the most important tests in Phase 1. Everything else is a bug that
 * annoys someone; a leak here silently ruins a quiz, and nobody in the room
 * would know it had happened.
 *
 * The assertions are deliberately written against the SERIALISED view — the
 * bytes that actually reach the browser — rather than against object
 * properties. A team opening dev tools sees exactly this string, so if a secret
 * is not in the string, it did not leak, whatever the UI does with it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONNECT_STAGES,
  DEFAULT_DIRECT_SCORING,
  DEFAULT_RULES,
  DEFAULT_WRITTEN_SCORING,
  reduce,
  type Action,
  type QuizState,
} from '@quizmaster/engine';

import {
  buildQmView,
  buildScoreboardView,
  buildTeamView,
  type RoomContext,
} from '../src/views.js';

const ANSWER = 'Cream and Disraeli Gears';
const SECRET_POUNCE = 'Led Zeppelin — Houses of the Holy';

function baseState(): QuizState {
  return {
    teams: [
      { id: 't1', name: 'Alpha', members: [] },
      { id: 't2', name: 'Beta', members: [] },
      { id: 't3', name: 'Gamma', members: [] },
      { id: 't4', name: 'Delta', members: [] },
    ],
    rounds: [
      {
        id: 'r1',
        type: 'DIRECT',
        title: 'Round 1',
        direction: 'CW',
        questions: [
          {
            id: 'q1',
            text: 'Name the band and the album.',
            media: [],
            parts: [
              { id: 'p1', label: 'Band', canonicalAnswer: 'Cream' },
              { id: 'p2', label: 'Album', canonicalAnswer: 'Disraeli Gears' },
            ],
            answerText: ANSWER,
            answerMedia: [],
          },
        ],
      },
    ],
    roundIdx: 0,
    questionIdx: 0,
    active: null,
    ledger: [],
    rules: DEFAULT_RULES,
    directScoring: DEFAULT_DIRECT_SCORING,
    writtenScoring: DEFAULT_WRITTEN_SCORING,
    connectStages: DEFAULT_CONNECT_STAGES,
    nextDirectTeamIdx: 0,
  };
}

const ctx: RoomContext = {
  quizTitle: 'Test Quiz',
  presence: new Map(),
  drafts: new Map(),
  // No sealed copies: these fixtures have no real media behind them, which is
  // also the fallback case — a client with nothing preloaded fetches as before.
  sealed: new Map(),
};

function run(state: QuizState, actions: Action[]): QuizState {
  return actions.reduce((s, a) => reduce(s, a), state);
}

const asTeam = (s: QuizState, teamId = 't2') =>
  JSON.stringify(buildTeamView(s, ctx, { teamId, displayName: 'Someone' }));

// ─── The answer ─────────────────────────────────────────────────────────────

test('the answer is not on the wire before the reveal', () => {
  let state = run(baseState(), [{ type: 'PRESENT_QUESTION', questionId: 'q1' }]);
  assert.equal(asTeam(state).includes(ANSWER), false);

  state = run(state, [{ type: 'OPEN_POUNCE' }, { type: 'CLOSE_POUNCE' }]);
  assert.equal(asTeam(state).includes(ANSWER), false);

  state = run(state, [
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_CORRECT', eventId: 'e1' },
  ]);
  // Resolved, but not yet revealed — still nothing.
  assert.equal(asTeam(state).includes(ANSWER), false);

  state = run(state, [{ type: 'REVEAL_ANSWER' }]);
  assert.equal(asTeam(state).includes(ANSWER), true);
});

test('canonical part answers never reach a team, even after the reveal', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_CORRECT', eventId: 'e1' },
    { type: 'REVEAL_ANSWER' },
  ]);
  const view = JSON.parse(asTeam(state));
  // The answer text is public now; the authoring crib sheet never is.
  assert.equal(view.reveal.text, ANSWER);
  assert.equal(JSON.stringify(view).includes('canonicalAnswer'), false);
});

// ─── Pounces are written-blind — FORMAT_SPEC §2.1 ───────────────────────────

test("a team never receives another team's pounce text", () => {
  let state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't3', text: SECRET_POUNCE },
  ]);
  // While open.
  assert.equal(asTeam(state, 't2').includes(SECRET_POUNCE), false);

  state = run(state, [{ type: 'CLOSE_POUNCE' }]);
  // After close — the QM may read it; the other teams may not, ever.
  assert.equal(asTeam(state, 't2').includes(SECRET_POUNCE), false);

  state = run(state, [
    { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: 'e1' },
    { type: 'FINISH_POUNCE_EVALUATION' },
  ]);
  assert.equal(asTeam(state, 't2').includes(SECRET_POUNCE), false);
});

test('a team does receive its own pounce text back', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't3', text: SECRET_POUNCE },
  ]);
  const view = buildTeamView(state, ctx, { teamId: 't3', displayName: 'Someone' });
  assert.equal(view.pounce.yourText, SECRET_POUNCE);
  assert.equal(view.pounce.submitted, true);
});

test('the QM sees who has pounced but not what, until the window is closed', () => {
  let state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't3', text: SECRET_POUNCE },
  ]);

  let qm = buildQmView(state, ctx);
  assert.equal(qm.pounces.length, 1);
  assert.equal(qm.pounces[0]?.teamName, 'Gamma');
  // Knowing WHAT came in should not inform the decision to close.
  assert.equal(qm.pounces[0]?.text, null);
  assert.equal(JSON.stringify(qm).includes(SECRET_POUNCE), false);

  state = run(state, [{ type: 'CLOSE_POUNCE' }]);
  qm = buildQmView(state, ctx);
  assert.equal(qm.pounces[0]?.text, SECRET_POUNCE);
});

// ─── Withheld partials — the reason PENDING exists ──────────────────────────

test('a withheld partial does not move a team score on the wire', () => {
  // Team 1 gets one part of two on bounce. Bounce continues, no reveal.
  let state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_PARTIAL', partIds: ['p1'], eventId: 'e1' },
  ]);

  const teamView = buildTeamView(state, ctx, { teamId: 't3', displayName: 'Someone' });
  const alpha = teamView.standings.find((s) => s.teamId === 't1');
  // If this were 5, Gamma could infer that the band had been confirmed and
  // spend the rest of the bounce working only on the album.
  assert.equal(alpha?.score, 0);

  // The QM, meanwhile, can see it banked.
  const qm = buildQmView(state, ctx);
  const alphaQm = qm.standings.find((s) => s.teamId === 't1');
  assert.equal(alphaQm?.score, 0);
  assert.equal(alphaQm?.provisionalScore, 5);
  assert.equal(alphaQm?.withheldPoints, 5);

  // At the reveal it is published to everyone.
  state = run(state, [
    { type: 'BOUNCE_WRONG' },
    { type: 'BOUNCE_WRONG' },
    { type: 'BOUNCE_WRONG' },
    { type: 'REVEAL_ANSWER' },
  ]);
  const after = buildTeamView(state, ctx, { teamId: 't3', displayName: 'Someone' });
  assert.equal(after.standings.find((s) => s.teamId === 't1')?.score, 5);
});

// ─── The question itself ────────────────────────────────────────────────────

test('a question is not on the wire before the QM presents it', () => {
  const state = baseState();
  const view = buildTeamView(state, ctx, { teamId: 't1', displayName: 'Someone' });
  assert.equal(view.question, null);
  assert.equal(view.phase, 'IDLE');
  assert.equal(JSON.stringify(view).includes('Name the band'), false);
});

test('a team is told how many parts a question has, but not what they are', () => {
  const state = run(baseState(), [{ type: 'PRESENT_QUESTION', questionId: 'q1' }]);
  const view = buildTeamView(state, ctx, { teamId: 't1', displayName: 'Someone' });
  assert.equal(view.question?.partCount, 2);
  assert.equal(JSON.stringify(view).includes('Disraeli'), false);
});

// ─── Bounce ─────────────────────────────────────────────────────────────────

test('a team is told when the bounce reaches it', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
  ]);
  // Direct team is seat 0 = Alpha, so bounce starts there.
  assert.equal(buildTeamView(state, ctx, { teamId: 't1', displayName: 'x' }).bounce.onYou, true);
  assert.equal(buildTeamView(state, ctx, { teamId: 't2', displayName: 'x' }).bounce.onYou, false);
  // Whose turn it is, is not a secret — the room can hear it.
  assert.equal(
    buildTeamView(state, ctx, { teamId: 't2', displayName: 'x' }).bounce.onTeamName,
    'Alpha',
  );
});

test('the QM keeps the whole bounce order in view, marked up', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_WRONG' },
  ]);
  const qm = buildQmView(state, ctx);
  // Clockwise from Alpha, every team once — this is what stops a QM losing
  // track under wrap-around.
  assert.deepEqual(qm.bounce.order.map((o) => o.name), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.equal(qm.bounce.order.find((o) => o.current)?.name, 'Beta');
  assert.equal(qm.bounce.onTeamName, 'Beta');
});

// ─── The QM's crib sheet ────────────────────────────────────────────────────

test('the QM gets the part split already worked out', () => {
  const state = run(baseState(), [{ type: 'PRESENT_QUESTION', questionId: 'q1' }]);
  const qm = buildQmView(state, ctx);
  // 10 across two parts, so the console offers +5 / +5 rather than arithmetic
  // done live while talking.
  assert.deepEqual(qm.answer?.parts.map((p) => [p.label, p.value]), [
    ['Band', 5],
    ['Album', 5],
  ]);
  assert.equal(qm.answer?.text, ANSWER);
});

test('the QM can see which part has already been credited, and to whom', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_PARTIAL', partIds: ['p1'], eventId: 'e1' },
  ]);
  const qm = buildQmView(state, ctx);
  assert.equal(qm.answer?.parts.find((p) => p.id === 'p1')?.creditedTo, 'Alpha');
  assert.equal(qm.answer?.parts.find((p) => p.id === 'p2')?.creditedTo, null);
});

// ─── Attendance ─────────────────────────────────────────────────────────────

test('a team sees who is here, across every team', () => {
  const withPresence: RoomContext = {
    quizTitle: 'Test Quiz',
    presence: new Map([
      ['t1', ['Asha', 'Ravi']],
      ['t2', ['Meera']],
    ]),
    drafts: new Map(),
    sealed: new Map(),
  };
  const view = buildTeamView(baseState(), withPresence, {
    teamId: 't2',
    displayName: 'Meera',
  });

  // Attendance is not a secret — everyone is on the same call — and a team
  // needs it for the same reason the QM does: is the quiz waiting on someone?
  assert.deepEqual(view.presence, [
    { teamId: 't1', teamName: 'Alpha', members: ['Asha', 'Ravi'] },
    { teamId: 't2', teamName: 'Beta', members: ['Meera'] },
    { teamId: 't3', teamName: 'Gamma', members: [] },
    { teamId: 't4', teamName: 'Delta', members: [] },
  ]);
});

// ─── Written rounds ─────────────────────────────────────────────────────────

const SHEET_ALPHA = '1. Bombay\n2. Cream\n3. Ganges';
const SHEET_BETA = '1. Madras\n2. Clapton\n3. Indus';

/** A quiz whose second round is written, with three questions. */
function writtenState(): QuizState {
  const state = baseState();
  return {
    ...state,
    roundIdx: 1,
    rounds: [
      ...state.rounds,
      {
        id: 'r2',
        type: 'WRITTEN',
        title: 'Written',
        questions: [1, 2, 3].map((n) => ({
          id: `w${n}`,
          text: `Written question ${n}`,
          media: [],
          parts: [],
          answerText: `Written answer ${n}`,
          answerMedia: [],
        })),
      },
    ],
  };
}

/**
 * FORMAT_SPEC §2.2, and the shape of the team UI: one sheet, submitted against
 * every question, so the QM can still grade question by question. What must not
 * follow from that is a sheet reaching anyone but its own team.
 */
test("a team's written sheet never reaches another team", () => {
  const state = run(writtenState(), [
    { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
    { type: 'SHOW_WRITTEN_QUESTION', index: 1 },
    { type: 'SHOW_WRITTEN_QUESTION', index: 2 },
    { type: 'OPEN_COLLECTION' },
    ...['w1', 'w2', 'w3'].map(
      (questionId): Action => ({
        type: 'SUBMIT_WRITTEN',
        teamId: 't1',
        questionId,
        text: SHEET_ALPHA,
        staked: false,
      }),
    ),
    ...['w1', 'w2', 'w3'].map(
      (questionId): Action => ({
        type: 'SUBMIT_WRITTEN',
        teamId: 't2',
        questionId,
        text: SHEET_BETA,
        staked: false,
      }),
    ),
  ]);

  // The sheets are multi-line, and these assertions are against the serialised
  // bytes, so compare against the JSON-escaped form — the actual wire text.
  const onWire = (text: string) => JSON.stringify(text).slice(1, -1);

  const beta = asTeam(state, 't2');
  assert.equal(beta.includes(onWire(SHEET_BETA)), true, 'a team gets its own sheet back');
  assert.equal(beta.includes(onWire(SHEET_ALPHA)), false, "and never another team's");

  // The written answers are the QM's crib sheet too — not on a team's wire.
  assert.equal(beta.includes('Written answer 2'), false);
});

test('the same sheet is what the QM grades, question by question', () => {
  const state = run(writtenState(), [
    { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
    { type: 'SHOW_WRITTEN_QUESTION', index: 1 },
    { type: 'OPEN_COLLECTION' },
    ...['w1', 'w2'].map(
      (questionId): Action => ({
        type: 'SUBMIT_WRITTEN',
        teamId: 't1',
        questionId,
        text: SHEET_ALPHA,
        staked: questionId === 'w2',
      }),
    ),
    { type: 'CLOSE_COLLECTION' },
  ]);

  const written = buildQmView(state, ctx).written;
  assert.ok(written);

  // One row per team per question, so the grid has no holes, and Alpha's sheet
  // sits under each question it was submitted against.
  const alpha = written.answers.filter((a) => a.teamId === 't1');
  assert.equal(alpha.length, 3);
  assert.equal(alpha.find((a) => a.questionId === 'w1')?.text, SHEET_ALPHA);
  assert.equal(alpha.find((a) => a.questionId === 'w2')?.text, SHEET_ALPHA);
  assert.equal(alpha.find((a) => a.questionId === 'w3')?.text, null);

  // The stake is the one thing that stays per question.
  assert.equal(alpha.find((a) => a.questionId === 'w1')?.staked, false);
  assert.equal(alpha.find((a) => a.questionId === 'w2')?.staked, true);
});

// ─── Long visual connect ────────────────────────────────────────────────────

const CONNECTION = 'They all played at the Isle of Wight';
const SECRET_CONNECT_POUNCE = 'Gamma guesses Woodstock';

/**
 * A quiz whose second round is a connect with three reveal images — one fewer
 * than the four stages the default ladder runs to, which is the authoring gap
 * the QM console is supposed to show rather than hide.
 */
function connectState(): QuizState {
  const state = baseState();
  return {
    ...state,
    roundIdx: 1,
    rounds: [
      ...state.rounds,
      {
        id: 'r2',
        type: 'VISUAL_CONNECT',
        title: 'Connect',
        questions: [
          {
            id: 'c1',
            text: 'What connects these?',
            media: [],
            parts: [],
            answerText: CONNECTION,
            answerMedia: [],
            revealSequence: [1, 2, 3].map((n) => ({
              id: `img${n}`,
              kind: 'IMAGE' as const,
              url: `/media/img${n}.jpg`,
            })),
          },
        ],
      },
    ],
  };
}

test('a team gets the decay ladder, and only the reveals shown so far', () => {
  let state = run(connectState(), [{ type: 'PRESENT_QUESTION', questionId: 'c1' }]);

  let view = buildTeamView(state, ctx, { teamId: 't2', displayName: 'Someone' });
  assert.equal(view.connect?.stageIdx, 0);
  assert.equal(view.connect?.stageCount, 4);
  // FORMAT_SPEC §2.3: the first reveal is worth +20 / −15.
  assert.deepEqual(view.connect?.value, { correct: 20, wrong: -15 });
  assert.equal(view.connect?.ladder.length, 4);
  // One image shown, not the three that exist. The rest have not been revealed
  // to the room, so they are not on the wire either.
  assert.deepEqual(view.question?.media.map((m) => m.id), ['img1']);
  assert.equal(JSON.stringify(view).includes('img2'), false);

  state = run(state, [
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'ADVANCE_REVEAL' },
  ]);

  view = buildTeamView(state, ctx, { teamId: 't2', displayName: 'Someone' });
  assert.equal(view.connect?.stageIdx, 1);
  assert.deepEqual(view.connect?.value, { correct: 15, wrong: -10 });
  assert.deepEqual(view.question?.media.map((m) => m.id), ['img1', 'img2']);
  // Still not the answer, three reveals in.
  assert.equal(JSON.stringify(view).includes(CONNECTION), false);
});

test('the QM sees who is spent and which reveal has no image', () => {
  const state = run(connectState(), [
    { type: 'PRESENT_QUESTION', questionId: 'c1' },
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't3', text: SECRET_CONNECT_POUNCE },
    { type: 'CLOSE_POUNCE' },
    { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: 'e1' },
  ]);

  const connect = buildQmView(state, ctx).connect;
  assert.ok(connect);

  // Spent is per QUESTION, not per reveal — Gamma is out for the rest of it.
  assert.deepEqual(connect.spent.map((t) => t.name), ['Gamma']);
  assert.deepEqual(connect.eligible.map((t) => t.name), ['Alpha', 'Beta', 'Delta']);

  // Four stages, three images: the fourth row is a hole, and the console shows
  // it rather than advancing into a blank screen.
  assert.equal(connect.reveals.length, 4);
  assert.deepEqual(
    connect.reveals.map((r) => r.media?.id ?? null),
    ['img1', 'img2', 'img3', null],
  );
  assert.deepEqual(connect.reveals.map((r) => r.shown), [true, false, false, false]);
});

/**
 * A connect pounce judged at reveal one is cleared from live state when the
 * round advances, so the ledger is the only place the verdict survives. It is
 * still withheld until the answer is read out, exactly like every other one.
 */
test('a connect verdict from an earlier reveal reaches the team at the reveal, not before', () => {
  let state = run(connectState(), [
    { type: 'PRESENT_QUESTION', questionId: 'c1' },
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't3', text: SECRET_CONNECT_POUNCE },
    { type: 'CLOSE_POUNCE' },
    { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: 'e1' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'ADVANCE_REVEAL' },
  ]);

  const gamma = () => buildTeamView(state, ctx, { teamId: 't3', displayName: 'Someone' });

  // Spent, and told so — but not told the outcome, because the connect is still
  // running and a −15 on the board would tell the room the guess was wrong.
  assert.equal(gamma().pounce.spent, true);
  assert.equal(gamma().pounce.yourVerdict, null);
  assert.equal(gamma().standings.find((s) => s.teamId === 't3')?.score, 0);

  state = run(state, [
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'ADVANCE_REVEAL' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'ADVANCE_REVEAL' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    // Out of reveals with nobody right: the connect dies (§5.4 default).
    { type: 'ADVANCE_REVEAL' },
  ]);
  assert.equal(state.active?.phase, 'DEAD');
  assert.equal(gamma().pounce.yourVerdict, null, 'still withheld while DEAD');

  state = run(state, [{ type: 'REVEAL_ANSWER' }]);
  assert.equal(gamma().pounce.yourVerdict, 'WRONG');
  assert.equal(gamma().standings.find((s) => s.teamId === 't3')?.score, -15);
});

// ─── The projector view ─────────────────────────────────────────────────────

/**
 * The scoreboard now carries the question, so it needs the same scrutiny the
 * team view gets — and more, because it has no credential at all. Anyone with
 * the quiz id can open it, and the quiz id is in the link you project.
 */
const asBoard = (s: QuizState) => JSON.stringify(buildScoreboardView(s, ctx));

test('the projector shows the question but never the answer before the reveal', () => {
  let state = run(baseState(), [{ type: 'PRESENT_QUESTION', questionId: 'q1' }]);
  assert.equal(asBoard(state).includes('Name the band and the album.'), true);
  assert.equal(asBoard(state).includes(ANSWER), false);

  state = run(state, [
    { type: 'OPEN_POUNCE' },
    { type: 'SUBMIT_POUNCE', teamId: 't2', text: SECRET_POUNCE },
    { type: 'CLOSE_POUNCE' },
  ]);
  // Pounce text is written-blind and stays that way on a screen in the room.
  assert.equal(asBoard(state).includes(SECRET_POUNCE), false);
  assert.equal(asBoard(state).includes(ANSWER), false);

  state = run(state, [
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_CORRECT', eventId: 'e1' },
    { type: 'REVEAL_ANSWER' },
  ]);
  assert.equal(asBoard(state).includes(ANSWER), true);
});

test('a question the QM has not presented is not on the projector', () => {
  const idle = baseState();
  assert.equal(buildScoreboardView(idle, ctx).question, null);
  assert.equal(asBoard(idle).includes('Name the band and the album.'), false);
});

test('the projector never carries canonical part answers', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_CORRECT', eventId: 'e1' },
    { type: 'REVEAL_ANSWER' },
  ]);
  // The reveal is the answer text, not the QM's crib sheet.
  assert.equal(asBoard(state).includes('Disraeli Gears'), true, 'the answer is shown');
  assert.equal(asBoard(state).includes('"canonicalAnswer"'), false);
  assert.equal(asBoard(state).includes('"Band"'), false, 'part labels are the QM\'s');
});

test('a withheld partial is as absent from the projector as from a team', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_POUNCE' },
    { type: 'CLOSE_POUNCE' },
    { type: 'FINISH_POUNCE_EVALUATION' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_PARTIAL', partIds: ['p1'], eventId: 'e1' },
  ]);
  const board = buildScoreboardView(state, ctx);
  // Recorded, and not on a screen in the room — the whole point of PENDING.
  assert.ok(state.ledger.some((e) => e.status === 'PENDING'));
  assert.ok(board.standings.every((s) => s.score === 0));
});

test('the projector shows whose turn it is on the bounce', () => {
  const state = run(baseState(), [
    { type: 'PRESENT_QUESTION', questionId: 'q1' },
    { type: 'OPEN_BOUNCE' },
    { type: 'BOUNCE_WRONG' },
  ]);
  const board = buildScoreboardView(state, ctx);
  assert.equal(board.bounce.active, true);
  assert.equal(board.bounce.onTeamName, 'Beta');
  assert.equal(board.bounce.order.find((t) => t.name === 'Alpha')?.offered, true);
});

test('a connect shows the room what the reveal is worth, and only the images shown', () => {
  const state = run(connectState(), [{ type: 'PRESENT_QUESTION', questionId: 'c1' }]);
  const board = buildScoreboardView(state, ctx);
  assert.deepEqual(board.connect?.value, { correct: 20, wrong: -15 });
  assert.deepEqual(board.question?.media.map((m) => m.id), ['img1']);
  assert.equal(asBoard(state).includes('img2'), false);
  assert.equal(asBoard(state).includes(CONNECTION), false);
});
