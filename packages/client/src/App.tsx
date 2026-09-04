/**
 * Phase 0 authoring UI.
 *
 * One screen: quizzes down the left, the selected quiz to the right. No router
 * — there is one page. Plain and ugly on purpose; the console that has to work
 * under pressure is Phase 1, and this is the tool that stops you hand-editing
 * JSON at 2am.
 */

import { useEffect } from 'react';
import { api } from './api.js';
import { useStore } from './store.js';
import { QuestionEditor } from './components/QuestionEditor.js';
import { RoundsPanel } from './components/RoundsPanel.js';
import { TeamsPanel } from './components/TeamsPanel.js';
import { AddForm, Button, EditableText, Panel } from './components/ui.js';

export function App() {
  const quizzes = useStore((s) => s.quizzes);
  const detail = useStore((s) => s.detail);
  const error = useStore((s) => s.error);
  const loading = useStore((s) => s.loading);
  const loadQuizzes = useStore((s) => s.loadQuizzes);
  const selectQuiz = useStore((s) => s.selectQuiz);
  const clearError = useStore((s) => s.clearError);
  const mutate = useStore((s) => s.mutate);

  useEffect(() => {
    void loadQuizzes();
  }, [loadQuizzes]);

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <header className="border-b border-neutral-300 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Quizmaster — authoring</h1>
        <p className="text-xs text-neutral-500">
          Write the quiz down. Running it is Phase 1.
        </p>
      </header>

      {error && (
        <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <span className="flex-1">{error}</span>
          <button onClick={clearError} className="text-red-600 underline">
            dismiss
          </button>
        </div>
      )}

      <div className="grid gap-4 p-4 lg:grid-cols-[18rem_1fr_24rem]">
        {/* Quizzes */}
        <div className="space-y-4">
          <Panel title="Quizzes">
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
              <p className="mb-3 text-sm text-neutral-500">No quizzes yet.</p>
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

          {detail && <TeamsPanel />}
        </div>

        {/* The quiz */}
        <div className="space-y-4">
          {!detail && (
            <Panel title="Quiz">
              <p className="text-sm text-neutral-500">Pick a quiz, or make one.</p>
            </Panel>
          )}
          {detail && (
            <>
              <Panel
                title="Quiz"
                aside={
                  <Button danger onClick={() => void mutate(() => api.deleteQuiz(detail.quiz.id))}>
                    Delete quiz
                  </Button>
                }
              >
                <EditableText
                  value={detail.quiz.title}
                  onSave={(title) => void mutate(() => api.updateQuiz(detail.quiz.id, { title }))}
                />
              </Panel>
              <RoundsPanel />
            </>
          )}
        </div>

        {/* Question + readiness */}
        <div className="space-y-4">
          {detail && <QuestionEditor />}
          {detail && <IssuesPanel />}
        </div>
      </div>
    </div>
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
      {issues.length === 0 && (
        <p className="text-sm text-green-700">Nothing outstanding.</p>
      )}
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
