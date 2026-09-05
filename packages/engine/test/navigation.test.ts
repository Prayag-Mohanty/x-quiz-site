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
 * skipping one that turns out to be unusable, or jumping between rounds. The
 * rules that matter are that navigating cannot interrupt a question in play,
 * and cannot rewrite anything the quiz has already decided.
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

  test('GO_TO_QUESTION cannot interrupt a question in play', () => {
    const presented = reduce(makeState({}), { type: 'PRESENT_QUESTION', questionId: 'q1' });
    assert.throws(() => reduce(presented, { type: 'GO_TO_QUESTION', index: 1 }), /not legal/);
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

  test('START_ROUND cannot interrupt a question in play', () => {
    const presented = reduce(makeState({}), { type: 'PRESENT_QUESTION', questionId: 'q1' });
    assert.throws(() => reduce(presented, { type: 'START_ROUND', roundIdx: 0 }), /not legal/);
  });

  test('the ledger survives navigation — points already awarded stay awarded', () => {
    const s = run(makeState({}), [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'CORRECT', eventId: 'e1' },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'REVEAL_ANSWER' },
      { type: 'NEXT_QUESTION' },
    ]);

    const before = s.ledger.length;
    const moved = reduce(s, { type: 'GO_TO_QUESTION', index: 0 });
    assert.equal(moved.ledger.length, before);
    assert.equal(moved.ledger[0]?.status, 'APPLIED');
  });
});
