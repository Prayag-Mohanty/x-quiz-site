/**
 * Importing a question set from a spreadsheet.
 *
 * TSV or CSV, with a header row. Columns are matched by name rather than
 * position, because a quizmaster who moves a column should not have to know
 * that mattered:
 *
 *   round / roundNo / round no       the round this belongs to
 *   question / questionNo / q no     what the source calls the question
 *   questionText / question text     the question itself          (required)
 *   answer / answerText              the answer                   (required)
 *   image / imageUrl / media / video one or more URLs, comma separated
 *   notes / qmNotes                  the quizmaster's own notes
 *
 * ─── Rounds, and the thing worth warning about ──────────────────────────────
 *
 * A league sheet often names a round for the round AND the player whose turn it
 * is — "Round 1 Player 1". The round is "Round 1"; the player is who receives
 * it. So the leading "Round <n>" is what groups, and the rest is kept as part
 * of the question's label.
 *
 * That exposes a real mismatch, which is warned about rather than papered over:
 * this app advances the direct team once per QUESTION, and a sheet that gives
 * each player two questions in a row expects it to advance every two. Nothing
 * here can decide which is right — the quizmaster can, once told.
 */

import type { ImportedQuestion, ImportedQuiz, ImportedRound } from './model.js';
import { titleFromFilename } from './model.js';

/**
 * Split delimited text into rows of fields.
 *
 * RFC 4180 quoting: a field may be wrapped in double quotes, a doubled quote
 * inside one is a literal quote, and a quoted field may contain the delimiter
 * and newlines. Written out rather than split() because a question containing a
 * comma is not unusual, and losing half of it would be silent.
 */
export function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // A file that does not end in a newline still has a last row.
  if (field !== '' || row.length > 0) endRow();
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** Tabs if the header has more of them than commas. Nothing cleverer is needed. */
export function detectDelimiter(text: string): string {
  const header = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (header.match(/\t/g) ?? []).length;
  const commas = (header.match(/,/g) ?? []).length;
  return tabs >= commas && tabs > 0 ? '\t' : ',';
}

/** Header names, normalised so `Question Text`, `questionText` and `question_text` match. */
const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

const COLUMNS = {
  round: ['round', 'roundno', 'roundnumber', 'roundname'],
  question: ['question', 'questionno', 'questionnumber', 'qno', 'no'],
  text: ['questiontext', 'text', 'body', 'q', 'questions'],
  answer: ['answer', 'answertext', 'answers', 'a'],
  media: ['image', 'imageurl', 'images', 'media', 'mediaurl', 'video', 'videourl', 'url'],
  notes: ['notes', 'qmnotes', 'note', 'explanation', 'comment', 'comments'],
} as const;

type Column = keyof typeof COLUMNS;

function mapHeader(header: string[]): Partial<Record<Column, number>> {
  const found: Partial<Record<Column, number>> = {};
  header.forEach((raw, index) => {
    const key = normalise(raw);
    for (const column of Object.keys(COLUMNS) as Column[]) {
      // First match wins, so a sheet with both `image` and `imageUrl` uses the
      // leftmost rather than whichever happened to be checked last.
      if (found[column] === undefined && (COLUMNS[column] as readonly string[]).includes(key)) {
        found[column] = index;
      }
    }
  });
  return found;
}

/**
 * "Round 1 Player 3" -> { round: "Round 1", rest: "Player 3" }.
 *
 * Anything that does not start with a round number is taken whole as the round
 * name — "Music", "Long Visual Connect" and "Round 1" all group correctly.
 */
export function splitRoundLabel(value: string): { round: string; rest: string } {
  const match = /^(round\s*\d+|r\s*\d+)\b\s*(.*)$/i.exec(value.trim());
  if (!match) return { round: value.trim() || 'Round 1', rest: '' };
  return { round: match[1]!.trim(), rest: (match[2] ?? '').trim() };
}

export function parseDelimited(text: string, filename: string): ImportedQuiz {
  const warnings: string[] = [];
  const rows = parseRows(text, detectDelimiter(text));

  if (rows.length < 2) {
    return { title: titleFromFilename(filename), rounds: [], warnings: ['The file has no rows under its header.'] };
  }

  const header = rows[0]!;
  const columns = mapHeader(header);

  if (columns.text === undefined) {
    return {
      title: titleFromFilename(filename),
      rounds: [],
      warnings: [
        `No question column. Name one of them "questionText", and the answers "answer". Found: ${header
          .filter((h) => h.trim())
          .join(', ')}.`,
      ],
    };
  }
  if (columns.answer === undefined) {
    warnings.push('No answer column, so every question is imported without one.');
  }

  const cell = (row: string[], column: Column | undefined) =>
    column === undefined ? '' : (row[columns[column] ?? -1] ?? '').trim();

  const byRound = new Map<string, ImportedRound>();
  const playersSeen = new Map<string, Set<string>>();
  let unanswered = 0;

  for (const [index, row] of rows.slice(1).entries()) {
    const text_ = cell(row, 'text');
    if (!text_) continue;

    const { round: roundTitle, rest } = splitRoundLabel(cell(row, 'round') || 'Round 1');
    const label = [rest, cell(row, 'question')].filter(Boolean).join(' · ') || `Row ${index + 2}`;

    let round = byRound.get(roundTitle);
    if (!round) {
      // Everything lands as DIRECT. A written or connect round is a decision
      // about how it is RUN, not something a column can tell you, and it is one
      // dropdown in the editor afterwards.
      round = { title: roundTitle, type: 'DIRECT', questions: [] };
      byRound.set(roundTitle, round);
    }

    const answer = cell(row, 'answer');
    if (!answer) unanswered += 1;

    const question: ImportedQuestion = {
      text: text_,
      answer,
      mediaUrls: splitUrls(cell(row, 'media')),
      label,
    };
    const notes = cell(row, 'notes');
    if (notes) question.notes = notes;
    round.questions.push(question);

    if (rest) {
      const players = playersSeen.get(roundTitle) ?? new Set<string>();
      players.add(rest);
      playersSeen.set(roundTitle, players);
    }
  }

  if (unanswered > 0) {
    warnings.push(
      `${unanswered} question${unanswered === 1 ? ' has' : 's have'} no answer. They import, but the console will have nothing to show you at the reveal.`,
    );
  }

  // The rotation mismatch, said once rather than per round.
  const doubled = [...byRound.entries()].find(([title, round]) => {
    const players = playersSeen.get(title);
    return players && players.size > 1 && round.questions.length > players.size;
  });
  if (doubled) {
    warnings.push(
      'The sheet gives each player more than one question in a row. This app moves the direct question to the next team after EVERY question, so the order will not match the sheet unless you meant it to.',
    );
  }

  return { title: titleFromFilename(filename), rounds: [...byRound.values()], warnings };
}

/**
 * One cell, several URLs.
 *
 * Split on whitespace and commas, because a sheet with two images in one cell
 * is common and there is no ambiguity: a URL contains neither.
 */
function splitUrls(value: string): string[] {
  if (!value.trim()) return [];
  return value
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter((url) => /^https?:\/\//i.test(url));
}
