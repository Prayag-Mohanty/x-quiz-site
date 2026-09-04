/**
 * Teams — and therefore the seating order.
 *
 * The order here is not cosmetic. A team's position is its seat at the notional
 * table, and CW/ACW rotation, bounce order and next-direct advancement are all
 * computed from those indices. Moving a team changes how the quiz plays, so the
 * panel says so rather than presenting it as a sort preference.
 */

import { api } from '../api.js';
import { useStore } from '../store.js';
import { AddForm, Button, EditableText, Panel } from './ui.js';

export function TeamsPanel() {
  const detail = useStore((s) => s.detail);
  const mutate = useStore((s) => s.mutate);
  if (!detail) return null;

  const { quiz, teams } = detail;

  const move = (index: number, delta: number) => {
    const next = [...teams];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    void mutate(() => api.reorderTeams(quiz.id, next.map((t) => t.id)));
  };

  return (
    <Panel
      title={`Teams (${teams.length})`}
      aside={<span className="text-xs text-neutral-500">seat order = rotation order</span>}
    >
      <ol className="mb-3 space-y-1">
        {teams.map((team, i) => (
          <li key={team.id} className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-right font-mono text-xs text-neutral-500">{i + 1}</span>
            <div className="flex-1">
              <EditableText
                value={team.name}
                onSave={(name) => void mutate(() => api.updateTeam(team.id, { name }))}
              />
            </div>
            <Button onClick={() => move(i, -1)} disabled={i === 0}>
              ↑
            </Button>
            <Button onClick={() => move(i, 1)} disabled={i === teams.length - 1}>
              ↓
            </Button>
            <Button danger onClick={() => void mutate(() => api.deleteTeam(team.id))}>
              ✕
            </Button>
          </li>
        ))}
      </ol>

      {teams.length === 0 && (
        <p className="mb-3 text-sm text-neutral-500">
          No teams yet. The format expects between 2 and 12.
        </p>
      )}

      <AddForm
        label="Add team"
        placeholder="Team name"
        onAdd={(name) => void mutate(() => api.addTeam(quiz.id, name))}
      />
    </Panel>
  );
}
