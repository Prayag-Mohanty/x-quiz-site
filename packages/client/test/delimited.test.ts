/**
 * Importing a question set from a spreadsheet.
 *
 * The cases that matter are the ones where a wrong guess is silent: a question
 * containing a comma, a round label that is really a round AND a player, a
 * column somebody moved. A parser that loses half a question does not announce
 * it — the quiz just runs with half a question in it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectDelimiter,
  parseDelimited,
  parseRows,
  splitRoundLabel,
} from '../src/import/delimited.js';

const TAB = '\t';

describe('parseRows', () => {
  test('splits plain rows', () => {
    assert.deepEqual(parseRows('a,b,c\n1,2,3', ','), [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  test('a quoted field may contain the delimiter', () => {
    assert.deepEqual(parseRows('a,b\n"one, two",three', ','), [
      ['a', 'b'],
      ['one, two', 'three'],
    ]);
  });

  test('a quoted field may contain newlines', () => {
    const rows = parseRows('q,a\n"line one\nline two",answer', ',');
    assert.equal(rows[1]?.[0], 'line one\nline two');
    assert.equal(rows.length, 2, 'the embedded newline must not start a row');
  });

  test('a doubled quote is one literal quote', () => {
    assert.deepEqual(parseRows('a\n"He said ""no""."', ','), [['a'], ['He said "no".']]);
  });

  test('blank lines are dropped, and a missing final newline is not', () => {
    assert.deepEqual(parseRows('a,b\n\n1,2', ','), [
      ['a', 'b'],
      ['1', '2'],
    ]);
    assert.deepEqual(parseRows('a,b\n1,2', ','), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  test('CRLF is handled, since these files come off Windows', () => {
    assert.deepEqual(parseRows('a,b\r\n1,2\r\n', ','), [
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('detectDelimiter', () => {
  test('tabs win when the header has them', () => {
    assert.equal(detectDelimiter(`round${TAB}question${TAB}answer\n`), TAB);
  });
  test('commas otherwise', () => {
    assert.equal(detectDelimiter('round,question,answer\n'), ',');
  });
  test('a tab-separated header containing commas is still tab-separated', () => {
    assert.equal(detectDelimiter(`round${TAB}question, with comma${TAB}answer\n`), TAB);
  });
});

describe('splitRoundLabel', () => {
  test('separates the round from the player', () => {
    assert.deepEqual(splitRoundLabel('Round 1 Player 3'), { round: 'Round 1', rest: 'Player 3' });
    assert.deepEqual(splitRoundLabel('Round 12 Player 4'), { round: 'Round 12', rest: 'Player 4' });
  });
  test('a plain round stays whole', () => {
    assert.deepEqual(splitRoundLabel('Round 2'), { round: 'Round 2', rest: '' });
  });
  test('a named round is not mangled into a number', () => {
    assert.deepEqual(splitRoundLabel('Long Visual Connect'), {
      round: 'Long Visual Connect',
      rest: '',
    });
  });
  test('an empty label still names a round', () => {
    assert.equal(splitRoundLabel('  ').round, 'Round 1');
  });
});

describe('parseDelimited', () => {
  const header = ['roundNo', 'questionNo', 'questionText', 'imageUrl', 'answerText'].join(TAB);
  const sheet = [
    header,
    ['Round 1 Player 1', 'Question 1', 'Who wrote it?', 'https://example.com/a.png', 'Someone'].join(TAB),
    ['Round 1 Player 1', 'Question 2', 'And the sequel?', '', 'Someone else'].join(TAB),
    ['Round 1 Player 2', 'Question 1', 'A third?', '', 'A third answer'].join(TAB),
    ['Round 2 Player 1', 'Question 1', 'A new round.', '', 'Yes'].join(TAB),
  ].join('\n');

  test('groups by round, not by round-and-player', () => {
    const quiz = parseDelimited(sheet, 'LQL S4 GW1.tsv');
    assert.deepEqual(
      quiz.rounds.map((r) => r.title),
      ['Round 1', 'Round 2'],
    );
    assert.equal(quiz.rounds[0]?.questions.length, 3);
    assert.equal(quiz.rounds[1]?.questions.length, 1);
  });

  test('keeps the player label, so the preview can be checked against the sheet', () => {
    const quiz = parseDelimited(sheet, 'x.tsv');
    assert.equal(quiz.rounds[0]?.questions[0]?.label, 'Player 1 · Question 1');
  });

  test('takes the title from the filename', () => {
    assert.equal(parseDelimited(sheet, 'LQL S4 GW1.tsv').title, 'LQL S4 GW1');
  });

  test('carries the image URL through', () => {
    const quiz = parseDelimited(sheet, 'x.tsv');
    assert.deepEqual(quiz.rounds[0]?.questions[0]?.mediaUrls, ['https://example.com/a.png']);
    assert.deepEqual(quiz.rounds[0]?.questions[1]?.mediaUrls, []);
  });

  test('warns that the app rotates every question, not every player', () => {
    const quiz = parseDelimited(sheet, 'x.tsv');
    assert.ok(
      quiz.warnings.some((w) => w.includes('after EVERY question')),
      `no rotation warning in: ${quiz.warnings.join(' | ')}`,
    );
  });

  test('columns are matched by name, in any order', () => {
    const moved = [
      ['answer', 'questionText', 'round'].join(','),
      ['An answer', 'A question', 'Round 4'].join(','),
    ].join('\n');
    const quiz = parseDelimited(moved, 'x.csv');
    assert.equal(quiz.rounds[0]?.title, 'Round 4');
    assert.equal(quiz.rounds[0]?.questions[0]?.text, 'A question');
    assert.equal(quiz.rounds[0]?.questions[0]?.answer, 'An answer');
  });

  test('a sheet with no question column refuses, and says what it wanted', () => {
    const quiz = parseDelimited('alpha,beta\n1,2', 'x.csv');
    assert.deepEqual(quiz.rounds, []);
    assert.ok(quiz.warnings[0]?.includes('questionText'));
    assert.ok(quiz.warnings[0]?.includes('alpha'), 'it should say what it did find');
  });

  test('missing answers import, and are counted out loud', () => {
    const quiz = parseDelimited(
      ['questionText,answer', 'Has one,Yes', 'Has none,'].join('\n'),
      'x.csv',
    );
    assert.equal(quiz.rounds[0]?.questions.length, 2);
    assert.ok(quiz.warnings.some((w) => w.includes('1 question has no answer')));
  });

  test('several URLs in one cell all come through, and non-URLs do not', () => {
    const quiz = parseDelimited(
      ['questionText,media', 'Q,"https://a.test/1.png, https://b.test/2.mp4, not a url"'].join('\n'),
      'x.csv',
    );
    assert.deepEqual(quiz.rounds[0]?.questions[0]?.mediaUrls, [
      'https://a.test/1.png',
      'https://b.test/2.mp4',
    ]);
  });

  test('a question containing a comma survives a CSV', () => {
    const quiz = parseDelimited(
      ['questionText,answer', '"Name the band, and the album.",Cream'].join('\n'),
      'x.csv',
    );
    assert.equal(quiz.rounds[0]?.questions[0]?.text, 'Name the band, and the album.');
  });

  test('rows with no question text are skipped rather than imported blank', () => {
    const quiz = parseDelimited(
      ['questionText,answer', 'Real question,Yes', ',Orphan answer'].join('\n'),
      'x.csv',
    );
    assert.equal(quiz.rounds[0]?.questions.length, 1);
  });
});
