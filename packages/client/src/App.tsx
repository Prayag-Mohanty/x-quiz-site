/**
 * Phase 0 authoring UI.
 *
 * Two layouts, not one. With nothing selected there is exactly one thing worth
 * doing — pick a quiz or make one — so that gets the middle of the screen on its
 * own. Once a quiz is open it becomes three columns: the quiz and its readiness
 * on the left, its rounds in the middle, and the question you are editing on the
 * right, which only exists while you are editing one.
 *
 * Plain and ugly on purpose. The console that has to work under pressure is
 * Phase 1; this is the tool that stops you hand-editing JSON at 2am.
 */

import { useEffect } from 'react';
import { api } from './api.js';
import { useStore } from './store.js';
import { QuestionEditor } from './components/QuestionEditor.js';
import { RoundsPanel } from './components/RoundsPanel.js';
import { RunPanel } from './components/RunPanel.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AddForm, Button, EditableText, Panel } from './components/ui.js';

export function App() {
  const detail = useStore((s) => s.detail);
  const error = useStore((s) => s.error);
  const selectedQuestionId = useStore((s) => s.selectedQuestionId);
  const loadQuizzes = useStore((s) => s.loadQuizzes);
  const clearError = useStore((s) => s.clearError);

  useEffect(() => {
    void loadQuizzes();
  }, [loadQuizzes]);

  // The editor is only present while a question is open, so the third column
  // appears and disappears with it rather than sitting there empty.
  const editing = Boolean(detail && selectedQuestionId);

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <header className="border-b border-neutral-300 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Quizmaster — authoring</h1>
        <p className="text-xs text-neutral-500">Write the quiz down. Running it is Phase 1.</p>
      </header>

      {error && (
        <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-red-600 underline">
            dismiss
          </button>
        </div>
      )}

      {!detail ? (
        <div className="mx-auto max-w-md p-6">
          <QuizListPanel standalone />
        </div>
      ) : (
        <div
          className={`grid gap-4 p-4 ${
            editing ? 'lg:grid-cols-[20rem_1fr_26rem]' : 'lg:grid-cols-[20rem_1fr]'
          }`}
        >
          <div className="space-y-4">
            <QuizListPanel />
            <TeamsPanel />
            <IssuesPanel />
            <RunPanel />
          </div>

          <div className="space-y-4">
            <Panel
              title="Quiz"
              aside={
                <Button danger onClick={() => void useStore.getState().mutate(() => api.deleteQuiz(detail.quiz.id))}>
                  Delete quiz
                </Button>
              }
            >
              <EditableText
                value={detail.quiz.title}
                onSave={(title) =>
                  void useStore.getState().mutate(() => api.updateQuiz(detail.quiz.id, { title }))
                }
              />
            </Panel>
            <RoundsPanel />
          </div>

          {editing && (
            <div className="space-y-4">
              <QuestionEditor />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The quiz list, and the only way to make one.
 *
 * `standalone` is the empty state: the same panel, centred, carrying the prompt
 * that used to sit in an otherwise empty box beside it.
 */
function QuizListPanel({ standalone = false }: { standalone?: boolean }) {
  const quizzes = useStore((s) => s.quizzes);
  const detail = useStore((s) => s.detail);
  const loading = useStore((s) => s.loading);
  const selectQuiz = useStore((s) => s.selectQuiz);
  const mutate = useStore((s) => s.mutate);

  return (
    <Panel title="Quizzes">
      {standalone && quizzes.length > 0 && (
        <p className="mb-2 text-sm text-neutral-600">Pick a quiz, or make one.</p>
      )}

      <ul className="mb-3 space-y-1">
        {quizzes.map((quiz) => (
          <li key={quiz.id}>
            <button
              onClick={() => void selectQuiz(quiz.id)}
              className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-neutral-100 ${
                detail?.quiz.id === quiz.id ? 'bg-blue-50 font-medium' : ''
              }`}
            >
              {quiz.title}
              <span className="ml-1 text-xs text-neutral-500">{quiz.status}</span>
            </button>
          </li>
        ))}
      </ul>

      {quizzes.length === 0 && !loading && (
        <p className="mb-3 text-sm text-neutral-600">
          No quizzes yet. Name one below to start.
        </p>
      )}

      <AddForm
        label="New"
        placeholder="Quiz title"
        onAdd={(title) =>
          void mutate(async () => {
            const created = await api.createQuiz(title);
            await selectQuiz(created.id);
          })
        }
      />
    </Panel>
  );
}

/**
 * Readiness.
 *
 * These are the rules that span rows — team counts, a written round's four
 * questions, a question with no parts — which cannot be column constraints and
 * are not errors while you are still writing. ERROR means it cannot be run;
 * WARN means it can, but you probably forgot something.
 */
function IssuesPanel() {
  const issues = useStore((s) => s.detail?.issues ?? []);
  const errors = issues.filter((i) => i.severity === 'ERROR');
  const warnings = issues.filter((i) => i.severity === 'WARN');

  return (
    <Panel
      title="Ready to run?"
      aside={
        <span className={`text-xs ${errors.length === 0 ? 'text-green-700' : 'text-red-700'}`}>
          {errors.length === 0 ? 'yes' : `${errors.length} blocking`}
        </span>
      }
    >
      {issues.length === 0 && <p className="text-sm text-green-700">Nothing outstanding.</p>}
      <ul className="space-y-1 text-sm">
        {errors.map((issue, i) => (
          <li key={`e${i}`} className="text-red-700">
            <span className="font-mono text-xs">{issue.entity}</span> — {issue.issue}
          </li>
        ))}
        {warnings.map((issue, i) => (
          <li key={`w${i}`} className="text-amber-700">
            <span className="font-mono text-xs">{issue.entity}</span> — {issue.issue}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
