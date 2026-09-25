/**
 * Importing a question set by dropping a file on it.
 *
 * Spreadsheet or PDF. The file is read in this browser — nothing is uploaded to
 * parse it — and what comes out is shown for review before a single row is
 * written. That review is not politeness: reading someone else's document is
 * guesswork, and a quiz assembled from a bad guess is only discovered in front
 * of ten people.
 *
 * So the panel has three states and they are deliberately in this order:
 * drop it, look at what was found, then import.
 */

import { useRef, useState } from 'react';

import { useStore } from '../store.js';
import { Panel } from './ui.js';
import type { ImportedQuiz } from '../import/model.js';
import { questionCount } from '../import/model.js';
import { parseDelimited } from '../import/delimited.js';
import type { RenderedPage } from '../import/readPdf.js';
import { runImport, type ImportProgress, type ImportResult } from '../import/run.js';

type Stage =
  | { name: 'idle' }
  | { name: 'reading'; filename: string }
  | { name: 'review'; quiz: ImportedQuiz; pages: RenderedPage[] }
  | { name: 'importing'; progress: ImportProgress }
  | { name: 'done'; result: ImportResult }
  | { name: 'failed'; message: string };

export function ImportPanel() {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const selectQuiz = useStore((s) => s.selectQuiz);
  const loadQuizzes = useStore((s) => s.loadQuizzes);

  const read = async (file: File) => {
    setStage({ name: 'reading', filename: file.name });
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.pdf')) {
        // Loaded on demand: the PDF reader is ~350KB and belongs to this screen
        // alone, not to the team client on a phone.
        const { readPdf } = await import('../import/readPdf.js');
        const { quiz, pages } = await readPdf(file);
        setStage({ name: 'review', quiz, pages });
        return;
      }
      if (lower.endsWith('.tsv') || lower.endsWith('.csv') || lower.endsWith('.txt')) {
        setStage({ name: 'review', quiz: parseDelimited(await file.text(), file.name), pages: [] });
        return;
      }
      setStage({
        name: 'failed',
        message: `${file.name} is not a .tsv, .csv or .pdf. Export the sheet as TSV and drop that.`,
      });
    } catch (err) {
      setStage({ name: 'failed', message: `Could not read ${file.name}: ${(err as Error).message}` });
    }
  };

  const start = async (quiz: ImportedQuiz, pages: RenderedPage[]) => {
    setStage({ name: 'importing', progress: { step: 'Starting', done: 0, total: 1 } });
    try {
      const result = await runImport(quiz, pages, (progress) =>
        setStage({ name: 'importing', progress }),
      );
      await loadQuizzes();
      setStage({ name: 'done', result });
    } catch (err) {
      setStage({ name: 'failed', message: (err as Error).message });
    }
  };

  if (stage.name === 'review') {
    return (
      <Review
        quiz={stage.quiz}
        pages={stage.pages}
        onCancel={() => setStage({ name: 'idle' })}
        onImport={(quiz) => void start(quiz, stage.pages)}
      />
    );
  }

  if (stage.name === 'importing') {
    const { done, total, step } = stage.progress;
    return (
      <Panel title="Importing">
        <p className="text-sm text-neutral-700">{step}</p>
        <div className="mt-2 h-2 w-full overflow-hidden rounded bg-neutral-200">
          <div
            className="h-full bg-blue-700 transition-all"
            style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 0}%` }}
          />
        </div>
        <p className="mt-1 text-xs text-neutral-500">
          {done} of {total}. Leave this open — closing it stops it part-finished.
        </p>
      </Panel>
    );
  }

  if (stage.name === 'done') {
    const { result } = stage;
    return (
      <Panel title="Imported">
        <p className="text-sm">
          <strong>{result.questions}</strong> questions in <strong>{result.rounds}</strong> rounds
          {result.mediaAttached > 0 && <>, with {result.mediaAttached} files attached</>}.
        </p>
        {result.problems.length > 0 && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2">
            <p className="text-xs font-semibold text-amber-900">
              {result.problems.length} thing{result.problems.length === 1 ? '' : 's'} did not work.
              The questions are all there; these are the attachments.
            </p>
            <ul className="mt-1 space-y-0.5 text-xs text-amber-900">
              {result.problems.map((problem, i) => (
                <li key={i}>• {problem}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => {
              void selectQuiz(result.quizId);
              setStage({ name: 'idle' });
            }}
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
          >
            Open it
          </button>
          <button
            onClick={() => setStage({ name: 'idle' })}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm"
          >
            Import another
          </button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="Import a question set">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void read(file);
        }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded border-2 border-dashed px-4 py-6 text-center text-sm ${
          dragging ? 'border-blue-600 bg-blue-50' : 'border-neutral-300 text-neutral-600'
        }`}
      >
        {stage.name === 'reading' ? (
          <p>Reading {stage.filename}…</p>
        ) : (
          <>
            <p className="font-medium text-neutral-800">Drop a spreadsheet or a PDF here</p>
            <p className="mt-1 text-xs">
              TSV or CSV with a <code>questionText</code> and <code>answer</code> column, or a
              question paper or slide deck as PDF. Nothing is uploaded until you have seen what
              it found.
            </p>
          </>
        )}
      </div>

      <input
        ref={input}
        type="file"
        accept=".tsv,.csv,.txt,.pdf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void read(file);
          e.target.value = '';
        }}
      />

      {stage.name === 'failed' && (
        <p className="mt-2 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">
          {stage.message}
        </p>
      )}
    </Panel>
  );
}

/**
 * What was found, before anything is written.
 *
 * Every question is listed with the label it had in the source, so this can be
 * read side by side with the document it came from. Rounds can be dropped — a
 * PDF often has a preamble page that parses as a round of nonsense — and the
 * title is editable, because it is only a filename.
 */
function Review({
  quiz,
  pages,
  onCancel,
  onImport,
}: {
  quiz: ImportedQuiz;
  pages: RenderedPage[];
  onCancel: () => void;
  onImport: (quiz: ImportedQuiz) => void;
}) {
  const [title, setTitle] = useState(quiz.title);
  const [dropped, setDropped] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(quiz.rounds[0]?.title ?? null);

  const kept = quiz.rounds.filter((r) => !dropped.has(r.title));
  const keptCount = questionCount({ ...quiz, rounds: kept });

  return (
    <Panel
      title="Check this before importing"
      aside={
        <button onClick={onCancel} className="text-xs text-neutral-500 underline">
          cancel
        </button>
      }
    >
      {quiz.rounds.length === 0 ? (
        <div>
          <p className="text-sm text-neutral-700">Nothing could be read out of that file.</p>
          {quiz.warnings.map((warning, i) => (
            <p key={i} className="mt-2 text-xs text-neutral-600">
              {warning}
            </p>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold uppercase text-neutral-600">
              Quiz title
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
            />
          </label>

          {quiz.warnings.length > 0 && (
            <ul className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              {quiz.warnings.map((warning, i) => (
                <li key={i}>• {warning}</li>
              ))}
            </ul>
          )}

          <div className="space-y-1">
            {quiz.rounds.map((round) => {
              const isDropped = dropped.has(round.title);
              return (
                <div key={round.title} className="rounded border border-neutral-200">
                  <div className="flex items-center gap-2 px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={!isDropped}
                      onChange={() =>
                        setDropped((current) => {
                          const next = new Set(current);
                          if (next.has(round.title)) next.delete(round.title);
                          else next.add(round.title);
                          return next;
                        })
                      }
                    />
                    <button
                      onClick={() => setOpen(open === round.title ? null : round.title)}
                      className={`flex-1 text-left text-sm ${isDropped ? 'text-neutral-400 line-through' : ''}`}
                    >
                      {round.title}{' '}
                      <span className="text-xs text-neutral-500">
                        · {round.questions.length} questions
                      </span>
                    </button>
                  </div>

                  {open === round.title && (
                    <ol className="space-y-2 border-t border-neutral-200 p-2">
                      {round.questions.map((question, i) => (
                        <li key={i} className="text-xs">
                          <p className="font-mono text-[0.65rem] text-neutral-400">
                            {question.label}
                          </p>
                          <p className="whitespace-pre-wrap text-neutral-800">{question.text}</p>
                          <p className="text-green-800">
                            {question.answer || <em className="text-red-700">no answer</em>}
                          </p>
                          {question.mediaUrls.map((url) => (
                            <p key={url} className="truncate text-blue-700">
                              {url}
                            </p>
                          ))}
                          {pages.some((p) => p.label === question.label) && (
                            <p className="text-neutral-500">+ the page it came from, as a picture</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              );
            })}
          </div>

          <button
            onClick={() => onImport({ ...quiz, title: title.trim() || quiz.title, rounds: kept })}
            disabled={keptCount === 0}
            className="w-full rounded bg-blue-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            Import {keptCount} question{keptCount === 1 ? '' : 's'} into a new quiz
          </button>
          <p className="text-xs text-neutral-500">
            This makes a new quiz. Nothing you already have is touched.
          </p>
        </div>
      )}
    </Panel>
  );
}
