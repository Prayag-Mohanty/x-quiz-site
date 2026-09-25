/**
 * What an imported question set looks like before it becomes a quiz.
 *
 * Every importer — spreadsheet, structured PDF, slide PDF — produces this and
 * nothing else. That is the whole point of it existing: the thing that creates
 * rounds and questions through the API knows one shape, and adding a fourth
 * source later means writing a parser and no more.
 *
 * ─── Nothing imports without being looked at ────────────────────────────────
 *
 * Parsing someone else's document is guesswork, and a quiz assembled from a bad
 * guess is worse than no quiz: you find out in front of ten people. So a parse
 * carries its own `warnings`, every question keeps the `label` it had in the
 * source, and the UI shows all of it for review before a single row is written.
 */

export type ImportedRoundType = 'DIRECT' | 'WRITTEN' | 'VISUAL_CONNECT';

export interface ImportedQuestion {
  text: string;
  answer: string;
  /** The quizmaster's own notes — the explanation paragraphs under an answer. */
  notes?: string;
  /** Remote media named in the source, fetched at import time. */
  mediaUrls: string[];
  /**
   * What the source called this question — "Player 1 Question 2", "Q7".
   *
   * Kept so the preview can be checked against the document it came from. A
   * reviewer comparing a screen to a PDF needs the same handles in both.
   */
  label: string;
}

export interface ImportedRound {
  title: string;
  type: ImportedRoundType;
  questions: ImportedQuestion[];
}

export interface ImportedQuiz {
  title: string;
  rounds: ImportedRound[];
  /**
   * What the parser was unsure about, in the quizmaster's language.
   *
   * Not errors — a parse that produced warnings still produced a quiz. These
   * are the things worth a second look before it is run: a question with no
   * answer, a round whose structure does not match how the app rotates, a URL
   * that does not look like one.
   */
  warnings: string[];
}

/** Total questions, for the preview to show without walking the tree twice. */
export function questionCount(quiz: ImportedQuiz): number {
  return quiz.rounds.reduce((sum, round) => sum + round.questions.length, 0);
}

/**
 * A title for the quiz, from the file it came from.
 *
 * `LQL S4 GW1.tsv` becomes `LQL S4 GW1`. The quizmaster renames it in the
 * editor if they want something else; this only has to be better than
 * "Untitled".
 */
export function titleFromFilename(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, '');
  const cleaned = withoutExtension.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'Imported quiz';
}
