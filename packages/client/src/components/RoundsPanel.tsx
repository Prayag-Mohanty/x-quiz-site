/**
 * Rounds and their questions.
 *
 * Direction is offered only for DIRECT rounds, because it only means anything
 * there — it is the pounce-and-bounce order. The schema enforces that too; the
 * UI just avoids offering something that would be rejected.
 */

import { useState } from 'react';
import { api, type RoundRow } from '../api.js';
import { useStore } from '../store.js';
import { Button, EditableText, Panel } from './ui.js';

const ROUND_TYPES = [
  { value: 'DIRECT', label: 'Direct (pounce + bounce)' },
  { value: 'WRITTEN', label: 'Written (4 questions, staking)' },
  { value: 'VISUAL_CONNECT', label: 'Long visual connect' },
] as const;

export function RoundsPanel() {
  const detail = useStore((s) => s.detail);
  const mutate = useStore((s) => s.mutate);
  const selectQuestion = useStore((s) => s.selectQuestion);
  const selectedQuestionId = useStore((s) => s.selectedQuestionId);

  const [newType, setNewType] = useState<string>('DIRECT');
  const [newTitle, setNewTitle] = useState('');

  if (!detail) return null;
  const { quiz, rounds, questions } = detail;

  const addRound = () => {
    const title = newTitle.trim();
    if (!title) return;
    void mutate(() =>
      api.addRound(quiz.id, {
        type: newType,
        title,
        direction: newType === 'DIRECT' ? 'CW' : null,
      }),
    );
    setNewTitle('');
  };

  return (
    <Panel title={`Rounds (${rounds.length})`}>
      <div className="space-y-4">
        {rounds.map((round, i) => (
          <RoundBlock
            key={round.id}
            index={i}
            round={round}
            questions={questions.filter((q) => q.round_id === round.id)}
            selectedQuestionId={selectedQuestionId}
            onSelectQuestion={selectQuestion}
          />
        ))}
      </div>

      {rounds.length === 0 && <p className="text-sm text-neutral-500">No rounds yet.</p>}

      <div className="mt-4 flex gap-2 border-t border-neutral-200 pt-3">
        <select
          className="rounded border border-neutral-300 px-2 py-1 text-sm"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
        >
          {ROUND_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <input
          className="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm"
          placeholder="Round title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addRound();
          }}
        />
        <Button onClick={addRound}>Add round</Button>
      </div>
    </Panel>
  );
}

function RoundBlock({
  round,
  index,
  questions,
  selectedQuestionId,
  onSelectQuestion,
}: {
  round: RoundRow;
  index: number;
  questions: { id: string; position: number; body: string }[];
  selectedQuestionId: string | null;
  onSelectQuestion: (id: string) => void;
}) {
  const mutate = useStore((s) => s.mutate);
  const teams = useStore((s) => s.detail?.teams ?? []);

  return (
    <div className="rounded border border-neutral-200">
      <div className="flex items-center gap-2 bg-neutral-50 px-3 py-2">
        <span className="font-mono text-xs text-neutral-500">R{index + 1}</span>
        <div className="flex-1">
          <EditableText
            value={round.title}
            onSave={(title) => void mutate(() => api.updateRound(round.id, { title }))}
          />
        </div>
        <span className="rounded bg-neutral-200 px-2 py-0.5 text-xs">{round.type}</span>

        {/* Direction is a DIRECT-round concept: it is the bounce order. */}
        {round.type === 'DIRECT' && (
          <select
            className="rounded border border-neutral-300 px-1 py-1 text-xs"
            value={round.direction ?? 'CW'}
            onChange={(e) =>
              void mutate(() => api.updateRound(round.id, { direction: e.target.value }))
            }
          >
            <option value="CW">Clockwise</option>
            <option value="ACW">Anticlockwise</option>
          </select>
        )}

        {round.type === 'DIRECT' && (
          <select
            className="rounded border border-neutral-300 px-1 py-1 text-xs"
            value={round.starting_team_position ?? ''}
            onChange={(e) =>
              void mutate(() =>
                api.updateRound(round.id, {
                  starting_team_position: e.target.value === '' ? null : Number(e.target.value),
                }),
              )
            }
            title="Which team gets the first direct question"
          >
            <option value="">Starts: carry on</option>
            {teams.map((t, i) => (
              <option key={t.id} value={i}>
                Starts: {t.name}
              </option>
            ))}
          </select>
        )}

        <Button danger onClick={() => void mutate(() => api.deleteRound(round.id))}>
          ✕
        </Button>
      </div>

      <ul className="divide-y divide-neutral-100">
        {questions
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((q, qi) => (
            <li key={q.id}>
              <button
                onClick={() => onSelectQuestion(q.id)}
                className={`flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-neutral-50 ${
                  selectedQuestionId === q.id ? 'bg-blue-50' : ''
                }`}
              >
                <span className="font-mono text-xs text-neutral-500">Q{qi + 1}</span>
                <span className={q.body.trim() ? '' : 'text-neutral-400 italic'}>
                  {q.body.trim() || 'Empty question'}
                </span>
              </button>
            </li>
          ))}
      </ul>

      <div className="px-3 py-2">
        <Button onClick={() => void mutate(() => api.addQuestion(round.id, ''))}>
          + Question
        </Button>
        {round.type === 'WRITTEN' && questions.length !== 4 && (
          <span className="ml-2 text-xs text-amber-700">
            A written round is four questions ({questions.length} so far).
          </span>
        )}
      </div>
    </div>
  );
}
