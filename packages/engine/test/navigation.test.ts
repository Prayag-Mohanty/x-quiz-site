import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/reducer.js';
import { makeState, simpleQuestion } from './helpers.js';
import type { Round, QuizState } from '../src/types.js';
import type { Action } from '../src/actions.js';

/** Apply a sequence of actions, as the other suites do. */
function run(state: QuizState, actions: Action[]): QuizState {
  return actions.reduce(reduce, state);
}

/**
 * Moving around the quiz.
 *
 * Not a FORMAT_SPEC rule — this is the QM going back to re-read a question, or
 * skipping one that turns out to be unusable, or jumping between rounds. It
 * works mid-question too: the usual reason to want it is that the wrong
 * question is on screen, and "finish this one first" is the app arguing with
 * the room about a question the QM did not mean to start.
 *
 * The rule that matters is that navigating cannot rewrite anything the quiz
 * has already decided. It discards the question state; it never touches the
 * ledger.
 */
describe('navigating between questions and rounds', () => {
  const twoRounds: Round[] = [
    {
      id: 'r1',
      type: 'DIRECT',
      title: 'Round 1',
      direction: 'CW',
      questions: [simpleQuestion('q1'), simpleQuestion('q2'), simpleQuestion('q3')],
    },
    {
      id: 'r2',
      type: 'DIRECT',
      title: 'Round 2',
      direction: 'ACW',
      questions: [simpleQuestion('q4'), simpleQuestion('q5')],
    },
  ];

  test('GO_TO_QUESTION moves forward without playing through', () => {
    const s = reduce(makeState({}), { type: 'GO_TO_QUESTION', index: 2 });
    assert.equal(s.questionIdx, 2);
  });

  test('GO_TO_QUESTION goes backwards', () => {
    const s = makeState({});
    const forward = reduce(s, { type: 'GO_TO_QUESTION', index: 2 });
    assert.equal(reduce(forward, { type: 'GO_TO_QUESTION', index: 0 }).questionIdx, 0);
  });

  test('navigating does not shift whose turn it is', () => {
    // Rotation follows from what has been PLAYED, not from what the QM is
    // looking at. Browsing to another question must not change the direct team.
    const s = makeState({ nextDirectTeamIdx: 5 });
    const moved = reduce(s, { type: 'GO_TO_QUESTION', index: 1 });
    assert.equal(moved.nextDirectTeamIdx, 5);
    assert.equal(moved.ledger.length, 0);
  });

  test('GO_TO_QUESTION leaves a question that is still in play', () => {
    const presented = run(makeState({}), [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
    ]);
    const moved = reduce(presented, { type: 'GO_TO_QUESTION', index: 1 });
    assert.equal(moved.questionIdx, 1);
    assert.equal(moved.active, null, 'the abandoned question is cleared');
  });

  test('presenting an abandoned question again starts it clean', () => {
    const abandoned = run(makeState({}), [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
      { type: 'GO_TO_QUESTION', index: 0 },
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
    ]);
    // The pounce is gone with the rest of the question state. Anything that
    // reached the ledger would still be there; nothing did here.
    assert.equal(abandoned.active?.kind === 'DIRECT' && abandoned.active.pounces.length, 0);
    assert.equal(abandoned.active?.phase, 'PRESENTED');
    assert.equal(abandoned.ledger.length, 0);
  });

  test('leaving mid-question keeps applied points and leaves withheld ones withheld', () => {
    const s = run(makeState({ nextDirectTeamIdx: 0 }), [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
      { type: 'CLOSE_POUNCE' },
      // Withheld until the reveal, and there is not going to be one.
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'CORRECT', eventId: 'e1' },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'OPEN_BOUNCE' },
      // Applied immediately, and the room has already seen it.
      { type: 'BOUNCE_CORRECT', eventId: 'e2' },
    ]);

    const moved = reduce(s, { type: 'GO_TO_QUESTION', index: 2 });
    assert.equal(moved.ledger.length, 2, 'nothing is removed');
    assert.equal(moved.ledger.find((e) => e.id === 'e2')?.status, 'APPLIED');
    // Abandoning is not a reveal. The withheld award stays withheld rather
    // than being published or silently dropped — the post-quiz breakdown is
    // where it surfaces, flagged as recorded and never published.
    assert.equal(moved.ledger.find((e) => e.id === 'e1')?.status, 'PENDING');
  });

  test('GO_TO_QUESTION refuses an index the round does not have', () => {
    assert.throws(() => reduce(makeState({}), { type: 'GO_TO_QUESTION', index: 9 }), /No question/);
    assert.throws(() => reduce(makeState({}), { type: 'GO_TO_QUESTION', index: -1 }), /No question/);
  });

  test('START_ROUND moves to another round and starts at its first question', () => {
    const s = makeState({ rounds: twoRounds });
    const moved = reduce(reduce(s, { type: 'GO_TO_QUESTION', index: 2 }), {
      type: 'START_ROUND',
      roundIdx: 1,
    });
    assert.equal(moved.roundIdx, 1);
    assert.equal(moved.questionIdx, 0);
  });

  test('START_ROUND goes back to an earlier round too', () => {
    const s = makeState({ rounds: twoRounds });
    const forward = reduce(s, { type: 'START_ROUND', roundIdx: 1 });
    assert.equal(reduce(forward, { type: 'START_ROUND', roundIdx: 0 }).roundIdx, 0);
  });

  test('START_ROUND refuses a round that does not exist', () => {
    assert.throws(() => reduce(makeState({}), { type: 'START_ROUND', roundIdx: 9 }), /No round/);
  });

  test('START_ROUND leaves a question that is still in play', () => {
    const presented = reduce(makeState({ rounds: twoRounds }), {
      type: 'PRESENT_QUESTION',
      questionId: 'q1',
    });
    const moved = reduce(presented, { type: 'START_ROUND', roundIdx: 1 });
    assert.equal(moved.roundIdx, 1);
    assert.equal(moved.questionIdx, 0);
    assert.equal(moved.active, null);
  });

  test('the ledger survives navigation — points already awarded stay awarded', () => {
    const s = run(makeState({}), [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'CORRECT', eventId: 'e1' },
      { type: 'FINISH_POUNCE_EVALUATION' },
      // The bounce runs after the pounce window regardless (§2.1), so the
      // question has to be played out before it can be revealed.
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_CORRECT', eventId: 'e2' },
      { type: 'REVEAL_ANSWER' },
      { type: 'NEXT_QUESTION' },
    ]);

    const before = s.ledger.length;
    const moved = reduce(s, { type: 'GO_TO_QUESTION', index: 0 });
    assert.equal(moved.ledger.length, before);
    assert.equal(moved.ledger[0]?.status, 'APPLIED');
  });
});

/**
 * Getting out of a finished round.
 *
 * A written round ends at REVEALED with `active` still set, and every way out
 * used to refuse — the QM was simply stuck. A revealed question or round is
 * over; only an unfinished one should block navigation.
 */
describe('leaving a finished round', () => {
  const writtenThenDirect: Round[] = [
    {
      id: 'w1',
      type: 'WRITTEN',
      title: 'Written',
      questions: [simpleQuestion('w-q1'), simpleQuestion('w-q2')],
    },
    {
      id: 'r2',
      type: 'DIRECT',
      title: 'Round 2',
      direction: 'CW',
      questions: [simpleQuestion('q1')],
    },
  ];

  test('a written round can be left once it has been graded', () => {
    const s = run(makeState({ rounds: writtenThenDirect }), [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'CLOSE_COLLECTION' },
      { type: 'FINISH_WRITTEN_EVALUATION' },
    ]);
    assert.equal(s.active?.phase, 'REVEALED');

    const moved = reduce(s, { type: 'START_ROUND', roundIdx: 1 });
    assert.equal(moved.roundIdx, 1);
    assert.equal(moved.active, null, 'the finished round is cleared');
  });

  test('an unfinished written round can be left too', () => {
    const s = run(makeState({ rounds: writtenThenDirect }), [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w-q1', text: 'a', staked: false },
    ]);
    const moved = reduce(s, { type: 'START_ROUND', roundIdx: 1 });
    assert.equal(moved.roundIdx, 1);
    assert.equal(moved.active, null);
    // Collected answers live in the question state, not the ledger, so they go
    // with it. Nothing had been graded, so there is nothing to keep.
    assert.equal(moved.ledger.length, 0);
  });

  test('teams may answer from the moment the round starts', () => {
    // The questions are read one at a time; a team that has the first one
    // should not have to wait for the fourth to write it down.
    const s = run(makeState({ rounds: writtenThenDirect }), [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w-q1', text: 'early', staked: false },
    ]);
    assert.equal(s.active?.kind === 'WRITTEN' && s.active.answers.length, 1);
  });

  test('answers are refused once the QM closes the boxes', () => {
    const s = run(makeState({ rounds: writtenThenDirect }), [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'CLOSE_COLLECTION' },
    ]);
    assert.throws(
      () =>
        reduce(s, {
          type: 'SUBMIT_WRITTEN',
          teamId: 't1',
          questionId: 'w-q1',
          text: 'too late',
          staked: false,
        }),
      /not legal/,
    );
  });
});
