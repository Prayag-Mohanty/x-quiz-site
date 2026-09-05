/**
 * The inline formatter.
 *
 * A text parser that fails silently is the worst kind: a question renders with
 * a stray asterisk in it and nobody notices until it is on ten screens. The
 * cases that matter are the ones where a quizmaster typed a character that
 * happens to be a marker and meant nothing by it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { hasMarkup, parseRich, toggleMark } from '../src/richtext.js';

const flat = (s: string) => parseRich(s).map((t) => [t.text, t.marks.join('+')]);

describe('parseRich', () => {
  test('plain text passes through as one run', () => {
    assert.deepEqual(parseRich('Name the band and the album.'), [
      { text: 'Name the band and the album.', marks: [] },
    ]);
  });

  test('the empty string yields nothing', () => {
    assert.deepEqual(parseRich(''), []);
  });

  test('marks each of bold, italic and underline', () => {
    assert.deepEqual(flat('a **b** c *i* d _u_ e'), [
      ['a ', ''],
      ['b', 'bold'],
      [' c ', ''],
      ['i', 'italic'],
      [' d ', ''],
      ['u', 'underline'],
      [' e', ''],
    ]);
  });

  test('marks nest', () => {
    assert.deepEqual(flat('**bold and *both* back**'), [
      ['bold and ', 'bold'],
      ['both', 'bold+italic'],
      [' back', 'bold'],
    ]);
  });

  test('bold wins over italic, so ** is never read as two *', () => {
    assert.deepEqual(flat('**x**'), [['x', 'bold']]);
  });

  // The ones that decide whether this is safe to turn on for existing content.
  test('an unclosed marker stays literal', () => {
    assert.deepEqual(flat('2 * 3 = 6'), [['2 * 3 = 6', '']]);
    assert.deepEqual(flat('snake_case identifier'), [['snake_case identifier', '']]);
    assert.deepEqual(flat('**unfinished'), [['**unfinished', '']]);
  });

  test('a lone marker at the end of the text stays literal', () => {
    assert.deepEqual(flat('five stars *'), [['five stars *', '']]);
  });

  test('text with no markers reports no markup', () => {
    assert.equal(hasMarkup('Rose Mallow is a lesser-known name'), false);
    assert.equal(hasMarkup('a **body of water**'), true);
    assert.equal(hasMarkup('2 * 3'), false);
  });

  /**
   * Round trip: putting the markers back must reproduce what was typed.
   *
   * This is the property that says no text is lost. A parser that dropped a
   * character would show up here and nowhere else — the marked-up runs all
   * still look right individually.
   */
  test('re-serialising the tokens reproduces the input', () => {
    const marker: Record<string, string> = { bold: '**', italic: '*', underline: '_' };
    const serialise = (input: string) => {
      let out = '';
      let open: string[] = [];
      for (const token of parseRich(input)) {
        const marks = token.marks.map((m) => marker[m] ?? '');
        // Close what is no longer open, innermost first, then open what is new.
        for (const m of [...open].reverse()) if (!marks.includes(m)) out += m;
        for (const m of marks) if (!open.includes(m)) out += m;
        open = marks;
        out += token.text;
      }
      for (const m of [...open].reverse()) out += m;
      return out;
    };

    for (const input of [
      'a **b** c *i* d _u_ e',
      '**bold and *both* back**',
      'Name the band and the album.',
      '2 * 3 = 6',
      'snake_case identifier',
      '',
    ]) {
      assert.equal(serialise(input), input, `round trip failed for: ${input}`);
    }
  });
});

describe('toggleMark', () => {
  test('wraps a selection and keeps the caret around it', () => {
    const r = toggleMark('a body of water', 2, 15, 'bold');
    assert.equal(r.text, 'a **body of water**');
    assert.equal(r.text.slice(r.start, r.end), 'body of water');
  });

  test('a second press unwraps, with the selection unmoved', () => {
    const first = toggleMark('a body of water', 2, 15, 'bold');
    const second = toggleMark(first.text, first.start, first.end, 'bold');
    assert.equal(second.text, 'a body of water');
    assert.equal(second.text.slice(second.start, second.end), 'body of water');
  });

  test('unwraps when the markers are inside the selection too', () => {
    const r = toggleMark('a **body** of water', 2, 10, 'bold');
    assert.equal(r.text, 'a body of water');
    assert.equal(r.text.slice(r.start, r.end), 'body');
  });

  test('an empty selection inserts the pair to type between', () => {
    const r = toggleMark('abc', 3, 3, 'italic');
    assert.equal(r.text, 'abc**');
    assert.equal(r.start, 4);
    assert.equal(r.end, 4);
  });
});
