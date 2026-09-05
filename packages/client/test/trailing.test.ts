/**
 * Blank space under a question.
 *
 * Two lines' worth normally, one when the last line is short — a short line
 * already leaves white space to its right, so two below it reads as a hole
 * rather than as breathing room.
 *
 * The measure is the last AUTHORED line, not the last line the browser wraps
 * to, which is what keeps this the same on a phone, a laptop and a projector.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { trailingLines } from '../src/live/trailing.js';

describe('trailingLines', () => {
  test('a short last line gets one', () => {
    assert.equal(trailingLines('What got its name?'), 1);
    assert.equal(trailingLines('One two three four five'), 1);
  });

  test('a full last line gets two', () => {
    assert.equal(trailingLines('One two three four five six'), 2);
    assert.equal(
      trailingLines(
        'Between 1937 and 1943, Italy used a form of scouting airplane in Libya named after a wind.',
      ),
      2,
    );
  });

  test('it is the last line that counts, not the first', () => {
    assert.equal(trailingLines('A long opening line with plenty of words in it\nShort tail'), 1);
    assert.equal(trailingLines('Short head\nA long closing line with plenty of words in it'), 2);
  });

  test('trailing blank lines in the source are ignored', () => {
    // Otherwise a question authored with a stray newline would measure an
    // empty last line and silently get the wide spacing.
    assert.equal(trailingLines('Short tail\n\n\n'), 1);
  });

  test('an empty question does not get the narrow spacing by accident', () => {
    assert.equal(trailingLines(''), 2);
    assert.equal(trailingLines('   '), 2);
  });
});
