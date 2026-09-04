import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bounceOrder, nextDirectTeam, step } from '../src/rotation.js';

describe('rotation (FORMAT_SPEC §2.1)', () => {
  test('CW steps forward and wraps', () => {
    assert.equal(step(0, 'CW', 8), 1);
    assert.equal(step(7, 'CW', 8), 0, 'team 8 wraps to team 1');
  });

  test('ACW steps backward and wraps', () => {
    assert.equal(step(7, 'ACW', 8), 6);
    assert.equal(step(0, 'ACW', 8), 7, 'team 1 wraps to team 8');
  });

  test('bounce order covers every team exactly once, CW', () => {
    const order = bounceOrder(5, 'CW', 8);
    assert.deepEqual(order, [5, 6, 7, 0, 1, 2, 3, 4]);
    assert.equal(new Set(order).size, 8);
  });

  test('bounce order covers every team exactly once, ACW', () => {
    const order = bounceOrder(2, 'ACW', 8);
    assert.deepEqual(order, [2, 1, 0, 7, 6, 5, 4, 3]);
    assert.equal(new Set(order).size, 8);
  });

  test('spec example: CW, direct T1, T2 answers on bounce -> next direct is T3', () => {
    // zero-indexed: direct=0, resolver=1, expect 2
    const next = nextDirectTeam({
      previousDirectIdx: 0,
      bounceResolverIdx: 1,
      direction: 'CW',
      teamCount: 8,
    });
    assert.equal(next, 2);
  });

  test('question dies unanswered -> next direct is after the PREVIOUS direct team', () => {
    const next = nextDirectTeam({
      previousDirectIdx: 3,
      bounceResolverIdx: null,
      direction: 'CW',
      teamCount: 8,
    });
    assert.equal(next, 4);
  });

  test('a pounce win does NOT shift the rotation anchor', () => {
    // Team 6 pounced correctly, but direct was team 3. Next direct = 4, not 7.
    const next = nextDirectTeam({
      previousDirectIdx: 3,
      bounceResolverIdx: null, // pounce wins pass null
      direction: 'CW',
      teamCount: 8,
    });
    assert.equal(next, 4);
  });

  test('ACW advancement wraps correctly', () => {
    const next = nextDirectTeam({
      previousDirectIdx: 0,
      bounceResolverIdx: null,
      direction: 'ACW',
      teamCount: 8,
    });
    assert.equal(next, 7);
  });
});
