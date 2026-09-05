import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/reducer.js';
import { publicScore, provisionalScore } from '../src/scoring.js';
import { eid, makeState } from './helpers.js';
import type { QuizState, Round } from '../src/types.js';
import type { Action } from '../src/actions.js';

function run(state: QuizState, actions: Action[]): QuizState {
  return actions.reduce(reduce, state);
}

const connectRound: Round = {
  id: 'rc',
  type: 'VISUAL_CONNECT',
  title: 'Long Visual Connect',
  questions: [
    {
      id: 'lvc1',
      text: 'What connects these?',
      media: [],
      parts: [{ id: 'lvc1p', label: 'Connection', canonicalAnswer: 'answer' }],
      answerText: 'answer',
      answerMedia: [],
    },
  ],
};

describe('VISUAL_CONNECT (FORMAT_SPEC §2.3)', () => {
  test('stage values decay: 20/15/10/5 correct, -15/-10/-5/0 wrong', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'guess' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't1', verdict: 'CORRECT', eventId: eid() },
    ]);
    // Withheld until the reveal, like every other pounce award.
    assert.equal(provisionalScore(s.ledger, 't1'), 20, 'first reveal is worth 20');
    assert.equal(publicScore(s.ledger, 't1'), 0, 'not public until the reveal');

    // Second stage
    let s2 = makeState({ teams: 6, rounds: [connectRound] });
    s2 = run(s2, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'wrong' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't1', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'ADVANCE_REVEAL' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'right' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't2', verdict: 'CORRECT', eventId: eid() },
    ]);
    assert.equal(provisionalScore(s2.ledger, 't1'), -15, 'wrong at stage 1 costs 15');
    assert.equal(provisionalScore(s2.ledger, 't2'), 15, 'stage 2 is worth 15');
  });

  test('one pounce per team per QUESTION, not per reveal', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'wrong' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't1', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'ADVANCE_REVEAL' },
      { type: 'OPEN_POUNCE' },
    ]);
    assert.throws(
      () => reduce(s, { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'again' }),
      /already pounced/,
      't1 is spent for the rest of this connect',
    );
    // But another team is fine.
    assert.doesNotThrow(() =>
      reduce(s, { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'ok' }),
    );
  });

  test('multiple teams may pounce at the same stage and all get that value', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'a' },
      { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'b' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't1', verdict: 'WRONG', eventId: eid() },
      { type: 'EVALUATE_POUNCE', teamId: 't2', verdict: 'CORRECT', eventId: eid() },
    ]);
    // Both banked, neither public until the reveal.
    assert.equal(provisionalScore(s.ledger, 't1'), -15);
    assert.equal(provisionalScore(s.ledger, 't2'), 20);
    assert.equal(publicScore(s.ledger, 't1'), 0);
    assert.equal(publicScore(s.ledger, 't2'), 0);
  });

  test('a correct pounce ends the question immediately', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'right' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't1', verdict: 'CORRECT', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
    ]);
    assert.equal(s.active?.phase, 'RESOLVED');
    assert.throws(() => reduce(s, { type: 'ADVANCE_REVEAL' }));
  });

  test('running out of reveals with no correct answer kills the question', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    const cycle = (team: string): Action[] => [
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: team, text: 'no' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: team, verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'ADVANCE_REVEAL' },
    ];
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      ...cycle('t1'),
      ...cycle('t2'),
      ...cycle('t3'),
      ...cycle('t4'),
    ]);
    assert.equal(s.active?.phase, 'DEAD', 'four reveals exhausted');
  });

  test('the fourth reveal has no penalty for a wrong answer', () => {
    let s = makeState({ teams: 6, rounds: [connectRound] });
    const advance = (team: string): Action[] => [
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: team, text: 'no' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: team, verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'ADVANCE_REVEAL' },
    ];
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'lvc1' },
      ...advance('t1'),
      ...advance('t2'),
      ...advance('t3'),
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't4', text: 'no' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't4', verdict: 'WRONG', eventId: eid() },
    ]);
    assert.equal(publicScore(s.ledger, 't4'), 0, 'stage 4 wrong costs nothing');
  });
});

const writtenRound: Round = {
  id: 'rw',
  type: 'WRITTEN',
  title: 'Written',
  questions: ['w1', 'w2', 'w3', 'w4'].map((id) => ({
    id,
    text: `Written ${id}`,
    media: [],
    parts: [{ id: `${id}p`, label: 'A', canonicalAnswer: 'x' }],
    answerText: 'x',
    answerMedia: [],
  })),
};

describe('WRITTEN round (FORMAT_SPEC §2.2)', () => {
  test('unstaked answers score +10 / 0', () => {
    let s = makeState({ teams: 4, rounds: [writtenRound] });
    s = run(s, [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'OPEN_COLLECTION' },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'a', staked: false },
      { type: 'SUBMIT_WRITTEN', teamId: 't2', questionId: 'w1', text: 'b', staked: false },
      { type: 'CLOSE_COLLECTION' },
      { type: 'EVALUATE_WRITTEN', teamId: 't1', questionId: 'w1', verdict: 'CORRECT', eventId: eid() },
      { type: 'EVALUATE_WRITTEN', teamId: 't2', questionId: 'w1', verdict: 'WRONG', eventId: eid() },
    ]);
    assert.equal(publicScore(s.ledger, 't1'), 10);
    assert.equal(publicScore(s.ledger, 't2'), 0);

    // A miss is worth nothing, which is why this went unnoticed: the reason has
    // to say so anyway. The ledger is the audit trail and the post-quiz
    // breakdown reads these out loud, so "WRITTEN_CORRECT, 0 points" is a lie
    // about what the quizmaster decided.
    assert.deepEqual(
      s.ledger.map((e) => [e.teamId, e.reason, e.points]),
      [
        ['t1', 'WRITTEN_CORRECT', 10],
        ['t2', 'WRITTEN_WRONG', 0],
      ],
    );
  });

  test('staked answers score +15 / -5', () => {
    let s = makeState({ teams: 4, rounds: [writtenRound] });
    s = run(s, [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'OPEN_COLLECTION' },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'a', staked: true },
      { type: 'SUBMIT_WRITTEN', teamId: 't2', questionId: 'w1', text: 'b', staked: true },
      { type: 'CLOSE_COLLECTION' },
      { type: 'EVALUATE_WRITTEN', teamId: 't1', questionId: 'w1', verdict: 'CORRECT', eventId: eid() },
      { type: 'EVALUATE_WRITTEN', teamId: 't2', questionId: 'w1', verdict: 'WRONG', eventId: eid() },
    ]);
    assert.equal(publicScore(s.ledger, 't1'), 15);
    assert.equal(publicScore(s.ledger, 't2'), -5);
    assert.deepEqual(
      s.ledger.map((e) => e.reason),
      ['STAKE_CORRECT', 'STAKE_WRONG'],
    );
  });

  test('stakes lock at collection close', () => {
    let s = makeState({ teams: 4, rounds: [writtenRound] });
    s = run(s, [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'OPEN_COLLECTION' },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'a', staked: false },
      { type: 'CLOSE_COLLECTION' },
    ]);
    assert.throws(() =>
      reduce(s, {
        type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'a', staked: true,
      }),
    );
  });

  test('answers may be revised freely while collection is open', () => {
    let s = makeState({ teams: 4, rounds: [writtenRound] });
    s = run(s, [
      { type: 'SHOW_WRITTEN_QUESTION', index: 0 },
      { type: 'OPEN_COLLECTION' },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'first', staked: false },
      { type: 'SUBMIT_WRITTEN', teamId: 't1', questionId: 'w1', text: 'final', staked: true },
    ]);
    const active = s.active;
    assert.ok(active?.kind === 'WRITTEN');
    assert.equal(active.answers.length, 1);
    assert.equal(active.answers[0]?.text, 'final');
    assert.equal(active.answers[0]?.staked, true);
  });
});
