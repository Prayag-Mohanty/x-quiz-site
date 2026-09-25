/**
 * Turning a reviewed import into a quiz.
 *
 * Nothing clever: the same API calls the authoring screen makes by hand, in the
 * order a person would make them. Rounds, then questions, then answers, then
 * media. Using the ordinary endpoints means the database's rules apply exactly
 * as they always do — positions stay contiguous, a reveal image is refused on a
 * question that is not a connect — rather than an import path that quietly
 * knows better.
 *
 * ─── Media is allowed to fail ───────────────────────────────────────────────
 *
 * A dead link in a year-old spreadsheet is normal. The question still imports;
 * the failure is collected and reported at the end with the link in it, so the
 * quizmaster can fix that one thing rather than re-run the whole import.
 */

import { api } from '../api.js';
import { optimiseImage } from '../optimiseImage.js';
import type { ImportedQuiz } from './model.js';
import type { RenderedPage } from './readPdf.js';

export interface ImportProgress {
  /** What is happening now, in words, for the one line of UI that shows it. */
  step: string;
  done: number;
  total: number;
}

export interface ImportResult {
  quizId: string;
  rounds: number;
  questions: number;
  mediaAttached: number;
  /** One line per thing that did not work. Empty is the happy case. */
  problems: string[];
}

export async function runImport(
  quiz: ImportedQuiz,
  pages: RenderedPage[],
  onProgress: (progress: ImportProgress) => void,
): Promise<ImportResult> {
  const problems: string[] = [];
  const questionTotal = quiz.rounds.reduce((n, r) => n + r.questions.length, 0);
  const mediaTotal =
    quiz.rounds.reduce((n, r) => n + r.questions.reduce((m, q) => m + q.mediaUrls.length, 0), 0) +
    pages.length;
  const total = questionTotal + mediaTotal;
  let done = 0;

  const step = (text: string) => onProgress({ step: text, done, total });

  step('Creating the quiz');
  const created = await api.createQuiz(quiz.title);
  let mediaAttached = 0;

  for (const round of quiz.rounds) {
    const madeRound = await api.addRound(created.id, { type: round.type, title: round.title });

    for (const question of round.questions) {
      step(`${round.title} — ${question.label}`);
      const madeQuestion = await api.addQuestion(madeRound.id, question.text);

      // The answer and the notes are a PATCH rather than part of creation,
      // because that is the shape the authoring API already has.
      const patch: Record<string, unknown> = {};
      if (question.answer) patch['answer_text'] = question.answer;
      if (question.notes) patch['qm_notes'] = question.notes;
      if (Object.keys(patch).length > 0) {
        await api.updateQuestion(madeQuestion.id, patch).catch((err: Error) => {
          problems.push(`${question.label}: could not save the answer — ${err.message}`);
        });
      }

      done += 1;
      step(`${round.title} — ${question.label}`);

      for (const url of question.mediaUrls) {
        step(`Fetching ${shorten(url)}`);
        try {
          await api.attachMediaFromUrl(madeQuestion.id, 'PROMPT', url);
          mediaAttached += 1;
        } catch (err) {
          problems.push(`${question.label}: ${(err as Error).message}`);
        }
        done += 1;
      }

      const rendered = pages.find((p) => p.label === question.label);
      if (rendered) {
        step(`Attaching the page for ${question.label}`);
        try {
          await api.uploadMedia(madeQuestion.id, 'PROMPT', await optimiseImage(rendered.file));
          mediaAttached += 1;
        } catch (err) {
          problems.push(`${question.label}: could not attach its page — ${(err as Error).message}`);
        }
        done += 1;
      }
    }
  }

  onProgress({ step: 'Done', done: total, total });
  return {
    quizId: created.id,
    rounds: quiz.rounds.length,
    questions: questionTotal,
    mediaAttached,
    problems,
  };
}

/** A URL short enough for one line of progress. */
function shorten(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const file = pathname.split('/').filter(Boolean).pop() ?? '';
    return `${hostname}/…/${decodeURIComponent(file).slice(0, 30)}`;
  } catch {
    return url.slice(0, 40);
  }
}
