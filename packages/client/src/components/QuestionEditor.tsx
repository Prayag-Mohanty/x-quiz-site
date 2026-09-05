/**
 * One question: body, answer, QM notes, and its parts.
 *
 * Parts are what make partial credit possible. A simple question has exactly
 * one; a multi-part question has two or more, and the QM can weight them
 * individually because parts are not always worth the same. Leaving a part's
 * value blank means "split the question value evenly", which is what the engine
 * does when the field is absent.
 */

import { api } from '../api.js';
import { useStore } from '../store.js';
import { MediaPanel } from './MediaPanel.js';
import { AddForm, Button, EditableText, Panel } from './ui.js';

export function QuestionEditor() {
  const detail = useStore((s) => s.detail);
  const selectedId = useStore((s) => s.selectedQuestionId);
  const mutate = useStore((s) => s.mutate);

  if (!detail || !selectedId) {
    return (
      <Panel title="Question">
        <p className="text-sm text-neutral-500">Pick a question to edit it.</p>
      </Panel>
    );
  }

  const question = detail.questions.find((q) => q.id === selectedId);
  if (!question) {
    return (
      <Panel title="Question">
        <p className="text-sm text-neutral-500">That question is gone.</p>
      </Panel>
    );
  }

  const round = detail.rounds.find((r) => r.id === question.round_id);
  const parts = detail.parts
    .filter((p) => p.question_id === question.id)
    .sort((a, b) => a.position - b.position);

  const value = detail.quiz.direct_question_value;
  const evenSplit = parts.length > 0 ? value / parts.length : value;

  return (
    <Panel
      title="Question"
      aside={
        <Button danger onClick={() => void mutate(() => api.deleteQuestion(question.id))}>
          Delete question
        </Button>
      }
    >
      <div className="space-y-4">
        <Field
          label="Question text"
          hint="Always required. B / I / U format the selection; the markers are stored as plain text."
        >
          <EditableText
            multiline
            formatting
            value={question.body}
            placeholder="What the teams are asked…"
            onSave={(body) => void mutate(() => api.updateQuestion(question.id, { body }))}
          />
        </Field>

        <Field label="Answer">
          <EditableText
            multiline
            formatting
            value={question.answer_text}
            placeholder="The answer, as you will read it out…"
            onSave={(answer_text) =>
              void mutate(() => api.updateQuestion(question.id, { answer_text }))
            }
          />
        </Field>

        <Field label="QM notes" hint="Only you see this — shown beside the answer while judging.">
          <EditableText
            multiline
            value={question.qm_notes ?? ''}
            placeholder="Anything you want in front of you when marking…"
            onSave={(qm_notes) =>
              void mutate(() => api.updateQuestion(question.id, { qm_notes: qm_notes || null }))
            }
          />
        </Field>

        <div className="border-t border-neutral-200 pt-3">
          <MediaPanel question={question} />
        </div>

        {/* Parts drive bounce partial credit, which only DIRECT rounds have. */}
        {round?.type === 'DIRECT' && (
          <Field
            label={`Parts (${parts.length})`}
            hint={
              parts.length > 1
                ? `Answering some but not all earns partial credit, withheld until the reveal. Blank value = ${evenSplit} each.`
                : 'One part is a simple question. Add a second to make it multi-part.'
            }
          >
            <ul className="space-y-2">
              {parts.map((part, i) => (
                <li key={part.id} className="flex items-start gap-2">
                  <span className="mt-1.5 w-5 shrink-0 text-right font-mono text-xs text-neutral-500">
                    {i + 1}
                  </span>
                  <div className="flex-1 space-y-1">
                    <EditableText
                      value={part.label}
                      placeholder="Label, e.g. the film"
                      onSave={(label) => void mutate(() => api.updatePart(part.id, { label }))}
                    />
                    <EditableText
                      value={part.canonical_answer}
                      placeholder="Accepted answer"
                      onSave={(canonical_answer) =>
                        void mutate(() => api.updatePart(part.id, { canonical_answer }))
                      }
                    />
                  </div>
                  <input
                    className="mt-0 w-20 rounded border border-neutral-300 px-2 py-1 text-sm"
                    type="number"
                    defaultValue={part.partial_value ?? ''}
                    placeholder={String(evenSplit)}
                    title="Points for this part alone. Blank splits the question value evenly."
                    onBlur={(e) => {
                      const raw = e.target.value.trim();
                      const next = raw === '' ? null : Number(raw);
                      if (next !== (part.partial_value ?? null)) {
                        void mutate(() => api.updatePart(part.id, { partial_value: next }));
                      }
                    }}
                  />
                  <Button
                    danger
                    disabled={parts.length <= 1}
                    onClick={() => void mutate(() => api.deletePart(part.id))}
                  >
                    ✕
                  </Button>
                </li>
              ))}
            </ul>
            <div className="mt-2">
              <AddForm
                label="Add part"
                placeholder="Part label"
                onAdd={(label) => void mutate(() => api.addPart(question.id, label))}
              />
            </div>
          </Field>
        )}
      </div>
    </Panel>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold tracking-wide text-neutral-600 uppercase">
        {label}
      </label>
      {hint && <p className="mb-1 text-xs text-neutral-500">{hint}</p>}
      {children}
    </div>
  );
}
