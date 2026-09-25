/**
 * Importing a question set from a PDF.
 *
 * This is guesswork and says so. A spreadsheet has columns; a PDF has whatever
 * the person who wrote it happened to type, and two quiz PDFs from two leagues
 * share no structure at all. So there are two strategies, each matched to a
 * shape these documents actually come in, and the result always goes through
 * the same review screen as everything else.
 *
 * ─── LABELLED ──────────────────────────────────────────────────────────────
 *
 * A question paper, written as continuous text with markers:
 *
 *     Round 1
 *     Player 1 Question 1: Quad: 3.2
 *     For a 1994 Vanity Fair fundraising dinner ...
 *     By what famous nickname is this attire remembered?
 *     Answer: REVENGE Dress of LADY DIANA
 *     The term "revenge dress" was famously coined after ...
 *
 * The markers are the parse: a round line starts a round, a question line
 * starts a question, `Answer:` ends the question and starts the answer, and the
 * paragraphs after the answer are the quizmaster's notes rather than part of it.
 *
 * ─── SLIDES ────────────────────────────────────────────────────────────────
 *
 * A deck exported to PDF, one question per page and its answer on the next:
 *
 *     page 2:  1.  • What is the inspiration behind Allahabad Bank's logo?
 *     page 3:  Triveni Sangam — the confluence of the Ganga, Yamuna ...
 *
 * Here the page IS the unit. A numbered page is a question, the page after it
 * is that answer, and a leading page with neither is the title.
 *
 * Which one runs is decided by the document, not by the person importing it:
 * text with `Answer:` markers in it is labelled, otherwise slides.
 */

import type { ImportedQuestion, ImportedQuiz, ImportedRound } from './model.js';
import { titleFromFilename } from './model.js';

/** `Round 3`, `ROUND 3`, `Round Three` — on a line of its own. */
const ROUND_LINE = /^\s*round\s+([0-9]+|[a-z]+)\s*:?\s*$/i;

/**
 * A question header.
 *
 * `Player 1 Question 2: Quad: 9.4`, `Question 7:`, `Q7.`, `7.` — everything
 * after the marker is metadata the source cared about and this does not, but it
 * is kept as the label so a reviewer can find the question in the original.
 */
const QUESTION_LINE =
  /^\s*((?:player\s*\d+\s*)?(?:question|q)\s*\d+\s*[:.]|(?:\d{1,2})\s*[.)])\s*(.*)$/i;

/** `Answer: X`, `Ans: X`, `A. X`. */
const ANSWER_LINE = /^\s*(?:answer|ans|a)\s*[:.]\s*(.*)$/i;

/** Whether the labelled strategy has anything to work with. */
export function looksLabelled(pages: string[]): boolean {
  const text = pages.join('\n');
  const answers = (text.match(/^\s*(?:answer|ans)\s*[:.]/gim) ?? []).length;
  return answers >= 2;
}

interface Building {
  label: string;
  textLines: string[];
  answerLines: string[];
  noteLines: string[];
  inAnswer: boolean;
}

function finish(building: Building): ImportedQuestion | null {
  const text = building.textLines.join('\n').trim();
  if (!text) return null;
  const question: ImportedQuestion = {
    text,
    answer: building.answerLines.join(' ').trim(),
    mediaUrls: [],
    label: building.label,
  };
  const notes = building.noteLines.join('\n').trim();
  if (notes) question.notes = notes;
  return question;
}

/** A question paper: markers in continuous text. */
export function parseLabelled(pages: string[], filename: string): ImportedQuiz {
  const warnings: string[] = [];
  const rounds: ImportedRound[] = [];
  let round: ImportedRound | null = null;
  let building: Building | null = null;

  const closeQuestion = () => {
    if (!building || !round) return;
    const question = finish(building);
    if (question) round.questions.push(question);
    building = null;
  };
  const openRound = (title: string) => {
    closeQuestion();
    round = { title, type: 'DIRECT', questions: [] };
    rounds.push(round);
  };

  for (const line of pages.join('\n').split(/\r?\n/)) {
    const roundMatch = ROUND_LINE.exec(line);
    if (roundMatch) {
      openRound(line.trim().replace(/:$/, ''));
      continue;
    }

    const questionMatch = QUESTION_LINE.exec(line);
    if (questionMatch) {
      closeQuestion();
      // A paper that never says "Round" is still one round of questions.
      if (!round) openRound('Round 1');
      building = {
        label: questionMatch[1]!.trim().replace(/[:.]$/, ''),
        // Anything on the header line after the marker is already question text.
        textLines: questionMatch[2]?.trim() ? [stripMetadata(questionMatch[2]!.trim())] : [],
        answerLines: [],
        noteLines: [],
        inAnswer: false,
      };
      continue;
    }

    if (!building) continue;

    const answerMatch = ANSWER_LINE.exec(line);
    if (answerMatch) {
      building.inAnswer = true;
      building.answerLines.push(answerMatch[1]!.trim());
      continue;
    }

    if (!line.trim()) continue;
    if (building.inAnswer) {
      // The answer is the line that said "Answer:". What follows it is the
      // quizmaster explaining themselves, which belongs in the notes — putting
      // it in the answer would put a paragraph on the reveal slide.
      building.noteLines.push(line.trim());
    } else {
      building.textLines.push(line.trim());
    }
  }
  closeQuestion();

  const withQuestions = rounds.filter((r) => r.questions.length > 0);
  const unanswered = withQuestions.flatMap((r) => r.questions).filter((q) => !q.answer).length;
  if (unanswered > 0) {
    warnings.push(`${unanswered} question${unanswered === 1 ? '' : 's'} came through without an answer.`);
  }
  if (withQuestions.length === 0) {
    warnings.push(
      'No questions found. This reader looks for lines like "Question 1:" and "Answer:" — if the PDF uses something else, a spreadsheet will import exactly.',
    );
  }

  return { title: titleFromFilename(filename), rounds: withQuestions, warnings };
}

/**
 * Metadata the source cared about and a quiz does not.
 *
 * `Quad: 3.2` is BBQL's own difficulty grid. Leaving it on the front of the
 * question text would put it on the screen in front of the teams.
 */
function stripMetadata(value: string): string {
  return value.replace(/^\s*quad\s*:\s*[\d.]+\s*/i, '').trim();
}

/** A page that opens with a number is a question in a deck. */
const SLIDE_NUMBER = /^\s*(\d{1,3})\s*[.)]/;

/**
 * A deck: one question per page, its answer on the next.
 *
 * Pages carry their own images, which this cannot see — the caller renders them
 * and attaches them, because a deck question that says "identify this" is
 * nothing without the picture.
 */
export function parseSlides(pages: string[], filename: string): ImportedQuiz {
  const warnings: string[] = [];
  const questions: ImportedQuestion[] = [];

  for (let i = 0; i < pages.length; i++) {
    const match = SLIDE_NUMBER.exec(pages[i] ?? '');
    if (!match) continue;

    const text = cleanSlide((pages[i] ?? '').replace(SLIDE_NUMBER, ''));
    if (!text) continue;

    // The next page is the answer unless it is itself a numbered question, in
    // which case this one simply has no answer slide.
    const next = pages[i + 1] ?? '';
    const answerIsNext = Boolean(next.trim()) && !SLIDE_NUMBER.test(next);

    questions.push({
      text,
      answer: answerIsNext ? cleanSlide(next).split('\n')[0]!.trim() : '',
      ...(answerIsNext && cleanSlide(next).split('\n').length > 1
        ? { notes: cleanSlide(next).split('\n').slice(1).join('\n').trim() }
        : {}),
      mediaUrls: [],
      label: `Slide ${i + 1} · Q${match[1]}`,
    });
    if (answerIsNext) i += 1;
  }

  if (questions.length === 0) {
    warnings.push(
      'No questions found. This reader expects one numbered question per page with its answer on the page after.',
    );
  } else {
    warnings.push(
      `Read as a slide deck: ${questions.length} question${questions.length === 1 ? '' : 's'}, each taking the following page as its answer. Worth checking a few against the file.`,
    );
  }

  return {
    title: titleFromFilename(filename),
    rounds: questions.length > 0 ? [{ title: 'Round 1', type: 'DIRECT', questions }] : [],
    warnings,
  };
}

/**
 * Slide text, tidied.
 *
 * Bullets become nothing — they are layout, not language — and the private-use
 * characters that some exporters emit for ligatures and brackets become the
 * bracket they were drawn as, because otherwise they arrive as a box glyph in
 * the middle of a question.
 */
function cleanSlide(value: string): string {
  return value
    .replace(/[-]/g, '(')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[•▪◦\-–]\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Pick a strategy from the document itself, and run it. */
export function parsePdfPages(pages: string[], filename: string): ImportedQuiz {
  return looksLabelled(pages) ? parseLabelled(pages, filename) : parseSlides(pages, filename);
}
