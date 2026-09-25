/**
 * Importing a question set from a PDF.
 *
 * The excerpts below are lifted from two real quiz PDFs — a BBQL question paper
 * and a college prelims deck — because the only interesting failures are the
 * ones real documents cause. The rest is invented to pin edges.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { looksLabelled, parseLabelled, parsePdfPages, parseSlides } from '../src/import/pdf.js';

// ─── A question paper ───────────────────────────────────────────────────────

const PAPER = [
  [
    'Business Brain Quiz League GW 1 Season 3',
    ' Welcome. 48 questions, 12 quads. 30 seconds per question.',
    'Round 1',
    'Player 1 Question 1: Quad: 3.2',
    "For a 1994 Vanity Fair dinner at London's Serpentine Gallery, Greek designer Christina",
    'Stambolian crafted an off-the-shoulder black silk gown.',
    'By what nickname is this attire remembered?',
    'Answer: REVENGE Dress of LADY DIANA (Either will do)',
    'The term "revenge dress" was coined after Princess Diana wore it in 1994,',
    'the same night Prince Charles admitted his infidelity.',
    'Player 1 Question 2: Quad: 1.2',
    'What brand featured a polar bear in its 2026 Super Bowl commercial?',
    'Answer: PEPSI',
  ].join('\n'),
  [
    'Round 2',
    'Player 2 Question 1: Quad: 8.3',
    'Not only is the logo an abbreviation of the London Symphony Orchestra,',
    'but it also represents what?',
    'Answer: CONDUCTOR',
    'Accept Maestro, accept any answer with conductor in it',
  ].join('\n'),
];

describe('a question paper', () => {
  const quiz = parseLabelled(PAPER, 'BBQL_GW1_Season3.pdf');

  test('rounds come from the round lines', () => {
    assert.deepEqual(
      quiz.rounds.map((r) => `${r.title}:${r.questions.length}`),
      ['Round 1:2', 'Round 2:1'],
    );
  });

  test('the question is the text between its header and Answer', () => {
    const first = quiz.rounds[0]!.questions[0]!;
    assert.ok(first.text.startsWith('For a 1994 Vanity Fair dinner'));
    assert.ok(first.text.endsWith('By what nickname is this attire remembered?'));
    assert.equal(first.text.includes('REVENGE'), false, 'the answer leaked into the question');
  });

  test('the answer is the Answer line and nothing after it', () => {
    const first = quiz.rounds[0]!.questions[0]!;
    assert.equal(first.answer, 'REVENGE Dress of LADY DIANA (Either will do)');
    // The paragraphs under an answer are the quizmaster explaining themselves.
    // In the answer they would be on the reveal slide in front of everyone.
    assert.ok(first.notes?.startsWith('The term "revenge dress"'));
    assert.equal(first.answer.includes('Prince Charles'), false);
  });

  test('the source label is kept, so a reviewer can find it in the PDF', () => {
    assert.equal(quiz.rounds[0]!.questions[0]!.label, 'Player 1 Question 1');
    assert.equal(quiz.rounds[1]!.questions[0]!.label, 'Player 2 Question 1');
  });

  test("the league's own grid reference is not part of the question", () => {
    assert.equal(
      quiz.rounds.flatMap((r) => r.questions).some((q) => /quad/i.test(q.text)),
      false,
    );
  });

  test('the preamble above the first round is not a question', () => {
    assert.equal(
      quiz.rounds.flatMap((r) => r.questions).some((q) => q.text.includes('30 seconds')),
      false,
    );
  });

  test('a paper with no round lines is still one round of questions', () => {
    const quiz = parseLabelled(['Question 1: What?', 'Answer: This'], 'x.pdf');
    assert.equal(quiz.rounds.length, 1);
    assert.equal(quiz.rounds[0]?.title, 'Round 1');
    assert.equal(quiz.rounds[0]?.questions[0]?.answer, 'This');
  });

  test('an unanswered question is counted out loud', () => {
    const quiz = parseLabelled(
      ['Question 1: Answered?', 'Answer: Yes', 'Question 2: Not answered?'].join('\n').split('|'),
      'x.pdf',
    );
    assert.ok(quiz.warnings.some((w) => w.includes('without an answer')));
  });
});

// ─── A slide deck ───────────────────────────────────────────────────────────

const DECK = [
  'Christ College Autonomous), Irinjalakuda\npresents\nChrist Com Quiz 2026\nPrelims',
  "1.\n• What is the inspiration behind Allahabad Bank's logo?",
  'Triveni Sangam\nThe holy confluence of the Ganga, Yamuna, and Saraswati rivers in Allahabad Prayagraj)',
  "2.\n• Who is the inventor of this equipment or which 'happy' film details this invention?",
  "Joy Mangano\nFamously sold the self-wringing Miracle Mop on QVC, later dramatized in the 2015 film 'Joy'",
];

describe('a slide deck', () => {
  const quiz = parseSlides(DECK, 'ChristCom.pdf');

  test('a numbered page is a question and the page after it is the answer', () => {
    assert.equal(quiz.rounds[0]?.questions.length, 2);
    const first = quiz.rounds[0]!.questions[0]!;
    assert.equal(first.text, "What is the inspiration behind Allahabad Bank's logo?");
    assert.equal(first.answer, 'Triveni Sangam');
    assert.ok(first.notes?.startsWith('The holy confluence'));
  });

  test('the title page is not a question', () => {
    assert.equal(
      quiz.rounds[0]?.questions.some((q) => q.text.includes('Christ College')),
      false,
    );
  });

  test('bullets are layout, not language', () => {
    assert.equal(
      quiz.rounds[0]?.questions.some((q) => q.text.includes('•')),
      false,
    );
  });

  test('exporter glyphs do not arrive as boxes in the middle of a question', () => {
    // Some exporters emit private-use characters where a bracket was drawn.
    assert.equal(
      JSON.stringify(quiz).match(/[-]/),
      null,
      'a private-use character survived into the import',
    );
  });

  test('it says it guessed, because it did', () => {
    assert.ok(quiz.warnings.some((w) => w.includes('slide deck')));
  });

  test('a question whose next page is another question simply has no answer', () => {
    const quiz = parseSlides(['1.\nFirst?', '2.\nSecond?', 'An answer'], 'x.pdf');
    assert.equal(quiz.rounds[0]?.questions[0]?.answer, '');
    assert.equal(quiz.rounds[0]?.questions[1]?.answer, 'An answer');
  });
});

// ─── Choosing between them ──────────────────────────────────────────────────

describe('choosing a strategy', () => {
  test('Answer: markers mean a question paper', () => {
    assert.equal(looksLabelled(PAPER), true);
    assert.equal(parsePdfPages(PAPER, 'x.pdf').rounds.length, 2);
  });

  test('a deck has none, so it is read as slides', () => {
    assert.equal(looksLabelled(DECK), false);
    assert.equal(parsePdfPages(DECK, 'x.pdf').rounds[0]?.questions.length, 2);
  });

  test('one stray "Answer:" is not enough to call it a paper', () => {
    assert.equal(looksLabelled(['Answer: just the one']), false);
  });

  test('a PDF that is neither says so rather than importing nothing silently', () => {
    const quiz = parsePdfPages(['Just some prose.', 'And some more.'], 'x.pdf');
    assert.deepEqual(quiz.rounds, []);
    assert.ok(quiz.warnings[0]?.includes('No questions found'));
  });
});
