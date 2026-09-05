import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/reducer.js';
import { publicScore, provisionalScore } from '../src/scoring.js';
import { eid, makeState, simpleQuestion, twoPartQuestion } from './helpers.js';
import type { QuizState } from '../src/types.js';
import type { Action } from '../src/actions.js';

/** Apply a sequence of actions. */
function run(state: QuizState, actions: Action[]): QuizState {
  return actions.reduce(reduce, state);
}

describe('DIRECT round — pounce (FORMAT_SPEC §2.1)', () => {
  test('pounce is blind: contents are stored but phase gates QM reading', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'guess' },
    ]);
    assert.equal(s.active?.kind, 'DIRECT');
    assert.equal(s.active?.phase, 'POUNCE_OPEN');
    // Evaluation is illegal until the window is closed.
    assert.throws(() =>
      reduce(s, { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'CORRECT', eventId: eid() }),
    );
  });

  test('the direct team cannot pounce on its own question', () => {
    let s = makeState({ nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
    ]);
    assert.throws(
      () => reduce(s, { type: 'SUBMIT_POUNCE', teamId: 't1', text: 'mine' }),
      /direct team cannot pounce/,
    );
  });

  test('correct pounce is +10, and the bounce still runs afterwards', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'right' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'CORRECT', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
    ]);
    // Banked, but withheld: the bounce is about to run and a visible +10 would
    // tell the room the question is already answered.
    assert.equal(publicScore(s.ledger, 't3'), 0, 'not on the public scoreboard yet');
    assert.equal(provisionalScore(s.ledger, 't3'), 10, 'the QM can see it');
    // A pounce is answered on paper before the question is opened to the room.
    // It does not take the question away from the room (§2.1).
    assert.equal(s.active?.phase, 'POUNCE_EVALUATED', 'the room still gets the question');

    s = run(s, [{ type: 'OPEN_BOUNCE' }]);
    assert.equal(s.active?.phase, 'BOUNCE');
  });

  test('a team that pounced is out of the bounce, right or wrong', () => {
    // 8 teams, direct is t1. t2 pounces right, t3 pounces wrong; both are spent.
    let s = makeState({ teams: 8, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'right' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'wrong' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't2', verdict: 'CORRECT', eventId: eid() },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'OPEN_BOUNCE' },
    ]);
    // Starts at the direct team, who never pounces.
    assert.equal(s.active?.kind === 'DIRECT' && s.active.bounceTeamIdx, 0);

    // Next should skip t2 AND t3 and land on t4.
    s = run(s, [{ type: 'BOUNCE_WRONG' }]);
    assert.equal(s.active?.kind === 'DIRECT' && s.active.bounceTeamIdx, 3, 'skips both pouncers');
  });

  test('if every other team pounced, the bounce is the direct team alone', () => {
    let s = makeState({ teams: 4, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'a' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'b' },
      { type: 'SUBMIT_POUNCE', teamId: 't4', text: 'c' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't2', verdict: 'WRONG', eventId: eid() },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: eid() },
      { type: 'EVALUATE_POUNCE', teamId: 't4', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_WRONG' },
    ]);
    // Nobody eligible is left, so the question dies rather than looping.
    assert.equal(s.active?.phase, 'DEAD');
  });

  test('pouncersMayBounce restores the older behaviour when set', () => {
    let s = makeState({ teams: 4, nextDirectTeamIdx: 0 });
    s = { ...s, rules: { ...s.rules, pouncersMayBounce: true } };
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't2', text: 'a' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't2', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_WRONG' },
    ]);
    assert.equal(s.active?.kind === 'DIRECT' && s.active.bounceTeamIdx, 1, 't2 is offered it');
  });

  test('wrong pounce is -5 and bounce still opens', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'wrong' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't3', verdict: 'WRONG', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
    ]);
    assert.equal(publicScore(s.ledger, 't3'), 0, 'withheld until the reveal');
    assert.equal(provisionalScore(s.ledger, 't3'), -5);
    assert.equal(s.active?.phase, 'POUNCE_EVALUATED');
    s = reduce(s, { type: 'OPEN_BOUNCE' });
    assert.equal(s.active?.phase, 'BOUNCE');

    // The bounce dies, the QM reveals, and now everyone sees the -5.
    // Loop rather than a fixed count: t3 pounced, so it is skipped and the
    // number of offers is one fewer than the number of teams.
    while (s.active?.phase === 'BOUNCE') s = reduce(s, { type: 'BOUNCE_WRONG' });
    assert.equal(s.active?.phase, 'DEAD');
    s = reduce(s, { type: 'REVEAL_ANSWER' });
    assert.equal(publicScore(s.ledger, 't3'), -5, 'published with everyone else');
  });

  test('one pounce per team: resubmission replaces rather than duplicates', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'first' },
      { type: 'SUBMIT_POUNCE', teamId: 't3', text: 'second' },
    ]);
    const active = s.active;
    assert.ok(active?.kind === 'DIRECT');
    assert.equal(active.pounces.length, 1);
    assert.equal(active.pounces[0]?.text, 'second');
  });
});

describe('DIRECT round — bounce (FORMAT_SPEC §2.1)', () => {
  test('bounce starts at the direct team', () => {
    let s = makeState({ nextDirectTeamIdx: 2 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
    ]);
    const active = s.active;
    assert.ok(active?.kind === 'DIRECT');
    assert.equal(active.bounceTeamIdx, 2);
  });

  test('infinite bounce: dies only after every team has been offered it', () => {
    let s = makeState({ teams: 4, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_WRONG' }, // t1 -> t2
      { type: 'BOUNCE_WRONG' }, // t2 -> t3
      { type: 'BOUNCE_WRONG' }, // t3 -> t4
    ]);
    assert.equal(s.active?.phase, 'BOUNCE', 'still alive with one team left');
    s = reduce(s, { type: 'BOUNCE_WRONG' }); // t4 was the last
    assert.equal(s.active?.phase, 'DEAD');
  });

  test('bounce correct is +10 with no negative marking anywhere on bounce', () => {
    let s = makeState({ teams: 4, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_WRONG' },
      { type: 'BOUNCE_CORRECT', eventId: eid() },
    ]);
    assert.equal(publicScore(s.ledger, 't1'), 0, 'wrong on bounce costs nothing');
    assert.equal(publicScore(s.ledger, 't2'), 10);
  });
});

describe('partial credit — the withheld-points rule (FORMAT_SPEC §2.1)', () => {
  test('a partial is recorded but NOT published until reveal', () => {
    let s = makeState({
      teams: 4,
      nextDirectTeamIdx: 0,
      rounds: [
        {
          id: 'r1',
          type: 'DIRECT',
          title: 'R1',
          direction: 'CW',
          questions: [twoPartQuestion('q1')],
        },
      ],
    });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_PARTIAL', partIds: ['q1pA'], eventId: eid() },
    ]);

    assert.equal(publicScore(s.ledger, 't1'), 0, 'withheld from the public scoreboard');
    assert.equal(provisionalScore(s.ledger, 't1'), 5, 'but visible to the QM');
    assert.equal(s.active?.phase, 'BOUNCE', 'bounce CONTINUES after a partial');
  });

  test('the worked example: question yields 15 points across two teams', () => {
    let s = makeState({
      teams: 4,
      nextDirectTeamIdx: 0,
      rounds: [
        {
          id: 'r1',
          type: 'DIRECT',
          title: 'R1',
          direction: 'CW',
          questions: [twoPartQuestion('q1')],
        },
      ],
    });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_PARTIAL', partIds: ['q1pA'], eventId: eid() }, // t1 gets part A
      { type: 'BOUNCE_WRONG' },                                      // t2 wrong
      { type: 'BOUNCE_CORRECT', eventId: eid() },                    // t3 gets both
      { type: 'REVEAL_ANSWER' },
    ]);

    assert.equal(publicScore(s.ledger, 't1'), 5, 'partial published at reveal');
    assert.equal(publicScore(s.ledger, 't3'), 10);
    const total = ['t1', 't2', 't3', 't4'].reduce(
      (sum, t) => sum + publicScore(s.ledger, t), 0,
    );
    assert.equal(total, 15, 'points are NOT conserved — this is intended');
  });

  test('withheld partials are still published when the question dies', () => {
    let s = makeState({
      teams: 3,
      nextDirectTeamIdx: 0,
      rounds: [
        {
          id: 'r1',
          type: 'DIRECT',
          title: 'R1',
          direction: 'CW',
          questions: [twoPartQuestion('q1')],
        },
      ],
    });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_PARTIAL', partIds: ['q1pA'], eventId: eid() },
      { type: 'BOUNCE_WRONG' },
      { type: 'BOUNCE_WRONG' },
    ]);
    assert.equal(s.active?.phase, 'DEAD');
    assert.equal(publicScore(s.ledger, 't1'), 0, 'still withheld while DEAD');
    s = reduce(s, { type: 'REVEAL_ANSWER' });
    assert.equal(publicScore(s.ledger, 't1'), 5, 'published at reveal even though it died');
  });

  test('QM may override the partial value for unequally weighted parts', () => {
    let s = makeState({
      teams: 4,
      nextDirectTeamIdx: 0,
      rounds: [
        {
          id: 'r1',
          type: 'DIRECT',
          title: 'R1',
          direction: 'CW',
          questions: [twoPartQuestion('q1')],
        },
      ],
    });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_PARTIAL', partIds: ['q1pA'], points: 7, eventId: eid() },
      { type: 'BOUNCE_WRONG' },
      { type: 'BOUNCE_WRONG' },
      { type: 'BOUNCE_WRONG' },
      { type: 'REVEAL_ANSWER' },
    ]);
    assert.equal(publicScore(s.ledger, 't1'), 7);
  });
});

describe('rotation across questions', () => {
  test('bounce resolver shifts the anchor; the next direct follows them', () => {
    let s = makeState({ teams: 8, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_WRONG' },                   // now on t2
      { type: 'BOUNCE_CORRECT', eventId: eid() }, // t2 wins
      { type: 'REVEAL_ANSWER' },
      { type: 'NEXT_QUESTION' },
    ]);
    assert.equal(s.nextDirectTeamIdx, 2, 'team after t2 is t3 (index 2)');
  });

  test('a pounce win leaves the anchor on the previous direct team', () => {
    let s = makeState({ teams: 8, nextDirectTeamIdx: 0 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_POUNCE' },
      { type: 'SUBMIT_POUNCE', teamId: 't6', text: 'right' },
      { type: 'CLOSE_POUNCE' },
      { type: 'EVALUATE_POUNCE', teamId: 't6', verdict: 'CORRECT', eventId: eid() },
      { type: 'FINISH_POUNCE_EVALUATION' },
      // The bounce still runs after a pounce, and dies unanswered here.
      { type: 'OPEN_BOUNCE' },
      ...Array.from({ length: 7 }, () => ({ type: 'BOUNCE_WRONG' }) as const),
      { type: 'REVEAL_ANSWER' },
      { type: 'NEXT_QUESTION' },
    ]);
    assert.equal(s.nextDirectTeamIdx, 1, 'follows direct team t1, not pouncer t6');
  });
});

describe('QM control — nothing auto-advances (CLAUDE.md core rule)', () => {
  test('reveal is illegal before the question resolves or dies', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
    ]);
    assert.throws(() => reduce(s, { type: 'REVEAL_ANSWER' }));
  });

  test('advancing to the next question is illegal before reveal', () => {
    let s = makeState({ teams: 3 });
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_CORRECT', eventId: eid() },
    ]);
    assert.throws(() => reduce(s, { type: 'NEXT_QUESTION' }));
  });

  test('the QM may skip the pounce window entirely', () => {
    let s = makeState({});
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
    ]);
    assert.equal(s.active?.phase, 'BOUNCE');
  });
});

describe('ledger integrity', () => {
  test('void undoes a score without deleting the audit trail', () => {
    let s = makeState({ teams: 3 });
    const evId = 'ev-void-me';
    s = run(s, [
      { type: 'PRESENT_QUESTION', questionId: 'q1' },
      { type: 'OPEN_BOUNCE' },
      { type: 'BOUNCE_CORRECT', eventId: evId },
    ]);
    assert.equal(publicScore(s.ledger, 't1'), 10);
    s = reduce(s, { type: 'VOID_EVENT', eventId: evId });
    assert.equal(publicScore(s.ledger, 't1'), 0);
    assert.equal(s.ledger.length, 1, 'the event is retained, not removed');
    assert.equal(s.ledger[0]?.status, 'VOIDED');
  });

  test('the reducer never mutates the input state', () => {
    const s = makeState({});
    const before = JSON.stringify(s);
    reduce(s, { type: 'PRESENT_QUESTION', questionId: 'q1' });
    assert.equal(JSON.stringify(s), before);
  });
});
