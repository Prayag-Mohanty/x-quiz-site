/**
 * The public scoreboard.
 *
 * Read-only, no credential. A projector in the room is not a participant, and
 * this shows only what every team can already see: APPLIED points. A partial you
 * have awarded but not revealed is deliberately absent, which is the same rule
 * the team client follows and for the same reason.
 *
 * Built to be read from across a room, or shared into a stream, so it is large
 * and has nothing on it but the standings.
 */

import { useEffect } from 'react';
import type { ScoreboardView } from '@quizmaster/shared';

import { socketUrl, useLive } from './socket.js';

export function ScoreboardApp() {
  const connect = useLive((s) => s.connect);
  const disconnect = useLive((s) => s.disconnect);
  const view = useLive((s) => s.view);
  const status = useLive((s) => s.status);

  // The quiz id is in the link. Nothing secret is served here.
  const quizId = new URLSearchParams(location.search).get('quiz') ?? '';

  useEffect(() => {
    if (!quizId) return;
    connect(socketUrl({ scoreboard: quizId }));
    return () => disconnect();
  }, [quizId, connect, disconnect]);

  if (!quizId) {
    return (
      <Shell>
        <p className="text-neutral-500">
          Add a quiz to the link: <code>/scoreboard?quiz=…</code>
        </p>
      </Shell>
    );
  }

  if (!view || view.role !== 'SCOREBOARD') {
    return <Shell><p className="text-neutral-500">Connecting…</p></Shell>;
  }

  return <Board view={view} status={status} />;
}

function Board({ view, status }: { view: ScoreboardView; status: string }) {
  // Rows are in SEAT order, which is also the bounce order. Deliberately not
  // sorted by score: a scoreboard that reshuffles every time someone scores is
  // unreadable from across a room, and ranking teams would imply a placing the
  // format does not claim to compute (§3 — the QM decides ties, not the system).
  const leader = Math.max(0, ...view.standings.map((t) => t.score));

  return (
    <Shell>
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-4xl font-semibold">{view.quizTitle}</h1>
          {view.round && (
            <p className="mt-1 text-xl text-neutral-500">
              {view.round.title} · round {view.round.index + 1} of {view.round.total}
            </p>
          )}
        </div>
        {status !== 'live' && <span className="text-sm text-amber-600">{status}</span>}
      </header>

      <ol className="space-y-2">
        {view.standings.map((team, i) => (
          <li
            key={team.teamId}
            className={`flex items-baseline gap-4 rounded px-6 py-4 shadow-sm ${
              team.score === leader && leader > 0 ? 'bg-amber-50' : 'bg-white'
            }`}
          >
            <span className="w-10 font-mono text-2xl text-neutral-400">{i + 1}</span>
            <span className="flex-1 text-3xl">{team.name}</span>
            <span className="text-3xl font-semibold tabular-nums">{team.score}</span>
          </li>
        ))}
      </ol>

      {view.standings.length === 0 && (
        <p className="text-neutral-500">No teams in this quiz yet.</p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100 p-10">{children}</div>;
}
