/**
 * The quizmaster console.
 *
 * The whole product thesis is that this is ONE screen and you never switch tabs.
 * You are talking and reading while using it, so:
 *
 *   - there is always exactly one obvious next action, and Space does it
 *   - the bounce order is always visible, with the current team marked, because
 *     under wrap-around and direction changes a QM loses track and the screen
 *     should never let that happen
 *   - the part split is pre-computed into buttons, so partial credit is a click
 *     and not arithmetic done live
 *   - undo is one keystroke and always available
 *   - nothing auto-advances, ever
 *
 * ARCHITECTURE §6. The last point is the one that shapes everything: there are
 * no timers here that touch quiz state.
 */

import { useEffect } from 'react';
import type { Action } from '@quizmaster/engine';
import type { QmView } from '@quizmaster/shared';

import { clearSession, loadSession, saveSession, socketUrl, useLive, type StoredSession } from './socket.js';
import { useState } from 'react';

export function QmApp() {
  const [session, setSession] = useState<StoredSession | null>(() => {
    const stored = loadSession();
    return stored?.role === 'QM' ? stored : null;
  });
  const connect = useLive((s) => s.connect);
  const disconnect = useLive((s) => s.disconnect);
  const view = useLive((s) => s.view);

  useEffect(() => {
    if (!session) return;
    connect(socketUrl({ token: session.token }));
    return () => disconnect();
  }, [session, connect, disconnect]);

  if (!session) return <QmJoin onJoined={setSession} />;
  if (!view || view.role !== 'QM') {
    return <div className="p-8 text-center text-neutral-500">Connecting…</div>;
  }
  return <Console view={view} onLeave={() => { clearSession(); setSession(null); }} />;
}

function QmJoin({ onJoined }: { onJoined: (s: StoredSession) => void }) {
  // The token may come from the link, so the QM never types it.
  const fromUrl = new URLSearchParams(location.search).get('token') ?? '';
  const [token, setToken] = useState(fromUrl);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/api/join/qm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qmToken: token.trim() }),
    });
    const body = await res.json();
    if (!res.ok) {
      setError(body.message ?? 'Could not open that quiz.');
      return;
    }
    const session: StoredSession = { token: body.token, role: 'QM', quizId: body.quizId };
    saveSession(session);
    onJoined(session);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded border border-neutral-200 bg-white p-6">
        <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-400">
          Quizmaster
        </p>
        <h1 className="mb-2 text-2xl font-semibold">Open your console</h1>
        <p className="mb-4 text-sm text-neutral-600">
          Paste the quizmaster link for the quiz you are about to run. Get it from
          the authoring screen.
        </p>
        <input
          className="w-full rounded border border-neutral-300 bg-white px-3 py-2 font-mono text-sm text-neutral-900"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Quizmaster token"
        />
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={!token.trim()}
          className="mt-3 w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40"
        >
          Open
        </button>
      </form>
    </div>
  );
}

/**
 * The single next action for the current phase.
 *
 * Every transition is an explicit QM action, so the console's job is to make the
 * expected one unmissable and everything else reachable. Returning null means
 * the phase needs a per-team judgement rather than a single step.
 */
function primaryAction(view: QmView): { label: string; action: Action } | null {
  // Round type first. The phases share names across round types but the legal
  // actions do not, and offering a DIRECT action in a WRITTEN round is how you
  // get "PRESENT_QUESTION is not legal in phase WRITTEN round" — a button that
  // cannot work is worse than no button.
  if (view.round?.type === 'WRITTEN') return writtenPrimaryAction(view);
  if (view.round?.type === 'VISUAL_CONNECT') return null;

  switch (view.phase) {
    case 'IDLE':
      return view.nextQuestion
        ? { label: 'Present question', action: { type: 'PRESENT_QUESTION', questionId: view.nextQuestion.id } }
        : null;
    case 'PRESENTED':
      return { label: 'Open pounce', action: { type: 'OPEN_POUNCE' } };
    case 'POUNCE_OPEN':
      return { label: 'Final call', action: { type: 'FINAL_CALL' } };
    case 'POUNCE_FINAL_CALL':
      return { label: 'Close pounce', action: { type: 'CLOSE_POUNCE' } };
    case 'POUNCE_CLOSED':
      return { label: 'Done evaluating', action: { type: 'FINISH_POUNCE_EVALUATION' } };
    case 'POUNCE_EVALUATED':
      return { label: 'Open bounce', action: { type: 'OPEN_BOUNCE' } };
    case 'RESOLVED':
    case 'DEAD':
      return { label: 'Reveal answer', action: { type: 'REVEAL_ANSWER' } };
    case 'REVEALED':
      return { label: 'Next question', action: { type: 'NEXT_QUESTION' } };
    default:
      return null;
  }
}

/**
 * The written round — FORMAT_SPEC §2.2.
 *
 * Four questions shown one at a time, then every team answers all four at once,
 * then the QM grades question by question across all teams.
 */
function writtenPrimaryAction(view: QmView): { label: string; action: Action } | null {
  const written = view.written;
  const total = written?.questions.length ?? 0;

  switch (written?.phase) {
    case undefined:
    case 'IDLE':
      return { label: 'Show question 1', action: { type: 'SHOW_WRITTEN_QUESTION', index: 0 } };
    case 'SHOWING':
      return written.shownIdx < total - 1
        ? {
            label: `Show question ${written.shownIdx + 2}`,
            action: { type: 'SHOW_WRITTEN_QUESTION', index: written.shownIdx + 1 },
          }
        : { label: 'Open answering', action: { type: 'OPEN_COLLECTION' } };
    case 'COLLECTING':
      return { label: 'Close answering', action: { type: 'CLOSE_COLLECTION' } };
    case 'EVALUATING':
      return { label: 'Done grading', action: { type: 'FINISH_WRITTEN_EVALUATION' } };
    default:
      return null;
  }
}

function Console({ view, onLeave }: { view: QmView; onLeave: () => void }) {
  const send = useLive((s) => s.send);
  const status = useLive((s) => s.status);
  const error = useLive((s) => s.error);
  const clearError = useLive((s) => s.clearError);

  const act = (action: Action) => send({ type: 'ACTION', action });
  const primary = primaryAction(view);
  const bouncing = view.bounce.active;

  // Keyboard first. During a quiz you are talking and reading; hunting for a
  // button breaks the flow (ARCHITECTURE §6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /INPUT|TEXTAREA|SELECT/.test(target.tagName)) return;

      if (e.key === ' ' && primary) {
        e.preventDefault();
        act(primary.action);
        return;
      }
      if (bouncing) {
        if (e.key === 'y' || e.key === 'Y') act({ type: 'BOUNCE_CORRECT', eventId: '' });
        if (e.key === 'n' || e.key === 'N') act({ type: 'BOUNCE_WRONG' });
      }
      if ((e.key === 'u' || e.key === 'U') && view.recent[0]) {
        act({ type: 'VOID_EVENT', eventId: view.recent[0].eventId });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="min-h-screen bg-neutral-100 text-neutral-900">
      <header className="flex items-baseline justify-between border-b border-neutral-300 bg-white px-4 py-2">
        <div>
          <span className="font-semibold">{view.quizTitle}</span>
          <span className="ml-2 text-sm text-neutral-500">
            {view.round ? `${view.round.title} · ${view.round.type}` : 'No round'}
            {view.round?.direction ? ` · ${view.round.direction}` : ''}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <span>{status}</span>
          <button onClick={onLeave} className="underline">
            close
          </button>
        </div>
      </header>

      {error && (
        <div className="flex justify-between gap-3 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          <span>{error}</span>
          <button onClick={clearError} className="underline">
            dismiss
          </button>
        </div>
      )}

      {/* The state bar. One obvious next step, and Space does it. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-neutral-300 bg-neutral-50 px-4 py-3">
        <span className="rounded bg-neutral-800 px-2 py-1 font-mono text-xs text-white">
          {view.phase}
        </span>
        {primary && (
          <button
            onClick={() => act(primary.action)}
            className="rounded bg-blue-700 px-4 py-2 font-semibold text-white"
          >
            {primary.label} <span className="ml-1 opacity-70">space</span>
          </button>
        )}
        {view.phase === 'PRESENTED' && (
          <button
            onClick={() => act({ type: 'OPEN_BOUNCE' })}
            className="rounded border border-neutral-400 px-3 py-2 text-sm"
            title="Skip the pounce window entirely"
          >
            Skip pounce → bounce
          </button>
        )}
        {view.recent[0] && (
          <button
            onClick={() => act({ type: 'VOID_EVENT', eventId: view.recent[0]!.eventId })}
            className="ml-auto rounded border border-neutral-400 px-3 py-2 text-sm"
          >
            Undo last <span className="opacity-60">u</span>
          </button>
        )}
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <NavigationPanel view={view} act={act} />

          {view.round?.type === 'WRITTEN' ? (
            <WrittenPanel view={view} act={act} />
          ) : view.round?.type === 'VISUAL_CONNECT' ? (
            <Panel title="Long visual connect">
              <p className="text-sm text-neutral-600">
                This round type has no console yet — it is Phase 4 in the build
                order. The engine supports it; the screen does not.
              </p>
            </Panel>
          ) : (
            <>
              <QuestionPanel view={view} />
              {view.phase === 'POUNCE_CLOSED' ||
              view.phase === 'POUNCE_OPEN' ||
              view.phase === 'POUNCE_FINAL_CALL' ? (
                <PouncePanel view={view} act={act} />
              ) : null}
              {bouncing && <BouncePanel view={view} act={act} />}
            </>
          )}
        </div>

        <div className="space-y-4">
          <BounceOrder view={view} />
          <ScorePanel view={view} />
          <PresencePanel view={view} />
        </div>
      </div>
    </div>
  );
}

/**
 * Moving around the quiz.
 *
 * Only available between questions: the engine refuses to navigate out of a
 * live pounce or bounce, and offering a button that will be refused is worse
 * than not offering it. Going back does not rewind the scores — points already
 * awarded stay awarded, and undo is how you take one back.
 */
function NavigationPanel({ view, act }: { view: QmView; act: (a: Action) => void }) {
  const between = view.phase === 'IDLE';
  const roundIdx = view.round?.index ?? 0;
  // The real index, not one derived from nextQuestion — that is null once the
  // round is finished, and falling back to 0 would claim you are at the start.
  const questionIdx = view.questionIdx;
  const questionCount = view.rounds[roundIdx]?.questionCount ?? 0;
  const pastEnd = questionIdx >= questionCount;

  return (
    <Panel
      title="Where you are"
      aside={
        !between ? (
          <span className="text-xs text-neutral-500">finish the question to move</span>
        ) : null
      }
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-500">Round</span>
        <select
          disabled={!between}
          value={roundIdx}
          onChange={(e) => act({ type: 'START_ROUND', roundIdx: Number(e.target.value) })}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-neutral-900 disabled:opacity-50"
        >
          {view.rounds.map((r) => (
            <option key={r.id} value={r.index}>
              {r.index + 1}. {r.title} ({r.type}, {r.questionCount}q)
            </option>
          ))}
        </select>

        <span className="ml-3 text-neutral-500">Question</span>
        <button
          disabled={!between || questionIdx <= 0}
          onClick={() => act({ type: 'GO_TO_QUESTION', index: questionIdx - 1 })}
          className="rounded border border-neutral-400 px-3 py-1 disabled:opacity-40"
        >
          ← Prev
        </button>
        <span className="font-mono">
          {questionCount === 0
            ? '—'
            : pastEnd
              ? `end of ${questionCount}`
              : `${questionIdx + 1} / ${questionCount}`}
        </span>
        <button
          disabled={!between || questionIdx >= questionCount - 1}
          onClick={() => act({ type: 'GO_TO_QUESTION', index: questionIdx + 1 })}
          className="rounded border border-neutral-400 px-3 py-1 disabled:opacity-40"
        >
          Next →
        </button>

        {view.nextDirectTeamName && between && (
          <span className="ml-auto text-xs text-neutral-500">
            next direct: <strong>{view.nextDirectTeamName}</strong>
          </span>
        )}
      </div>
    </Panel>
  );
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded border border-neutral-300 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">{title}</h2>
        {aside}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function QuestionPanel({ view }: { view: QmView }) {
  if (!view.question) {
    return (
      <Panel title="Question">
        {view.nextQuestion ? (
          <div>
            <p className="text-sm text-neutral-500">
              Up next — question {view.nextQuestion.index + 1} of {view.nextQuestion.total}
              {view.nextDirectTeamName && ` · direct to ${view.nextDirectTeamName}`}
            </p>
            <p className="mt-1 text-neutral-700">{view.nextQuestion.preview}…</p>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">No more questions in this round.</p>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      title={`Question ${view.question.index + 1} of ${view.question.total}`}
      aside={
        view.question.partCount > 1 ? (
          <span className="text-xs text-amber-700">{view.question.partCount} parts</span>
        ) : null
      }
    >
      <p className="whitespace-pre-wrap text-lg">{view.question.text}</p>
      {view.question.media.map((m) =>
        m.kind === 'IMAGE' ? <img key={m.id} src={m.url} alt="" className="mt-2 max-h-64 rounded" /> : null,
      )}

      {/* The QM's crib sheet. Teams never receive any of this. */}
      {view.answer && (
        <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3">
          <p className="text-xs font-semibold uppercase text-amber-800">Answer — yours only</p>
          <p className="mt-1 whitespace-pre-wrap">{view.answer.text}</p>
          {view.answer.parts.length > 1 && (
            <ul className="mt-2 space-y-1 text-sm">
              {view.answer.parts.map((p) => (
                <li key={p.id} className="flex justify-between">
                  <span>
                    {p.label}
                    {p.canonicalAnswer && <span className="text-neutral-600"> — {p.canonicalAnswer}</span>}
                  </span>
                  <span className="font-mono">
                    +{p.value}
                    {p.creditedTo && <span className="ml-1 text-green-700">({p.creditedTo})</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * Pounces.
 *
 * While the window is open this shows WHO has pounced and not what — the server
 * does not send the text yet, deliberately, so the decision to close is not
 * coloured by what has arrived.
 */
function PouncePanel({ view, act }: { view: QmView; act: (a: Action) => void }) {
  const open = view.phase === 'POUNCE_OPEN' || view.phase === 'POUNCE_FINAL_CALL';
  return (
    <Panel title={`Pounces (${view.pounces.length})`} aside={<span className="text-xs text-neutral-500">{open ? 'blind until closed' : '+10 / −5'}</span>}>
      {view.pounces.length === 0 && <p className="text-sm text-neutral-500">Nobody yet.</p>}
      <ul className="space-y-2">
        {view.pounces.map((p) => (
          <li key={p.teamId} className="flex items-start gap-2">
            <span className="w-24 shrink-0 font-medium">{p.teamName}</span>
            <span className="flex-1">
              {p.text === null ? (
                <em className="text-neutral-400">pounced</em>
              ) : (
                <span className="whitespace-pre-wrap">{p.text}</span>
              )}
            </span>
            {!open && (
              <span className="flex gap-1">
                {p.verdict ? (
                  <span className={p.verdict === 'CORRECT' ? 'text-green-700' : 'text-red-700'}>
                    {p.verdict === 'CORRECT' ? '+10' : '−5'}
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => act({ type: 'EVALUATE_POUNCE', teamId: p.teamId, verdict: 'CORRECT', eventId: '' })}
                      className="rounded border border-green-500 px-2 py-0.5 text-sm text-green-700"
                    >
                      ✓
                    </button>
                    <button
                      onClick={() => act({ type: 'EVALUATE_POUNCE', teamId: p.teamId, verdict: 'WRONG', eventId: '' })}
                      className="rounded border border-red-400 px-2 py-0.5 text-sm text-red-700"
                    >
                      ✗
                    </button>
                  </>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * Bounce judgement.
 *
 * Correct and wrong are one key each. Partial is a button per part, valued from
 * the split you authored — so a 3+3+4 question offers +3, +3, +4 and you click
 * what they got. Recorded immediately, published at the reveal.
 */
function BouncePanel({ view, act }: { view: QmView; act: (a: Action) => void }) {
  const parts = view.answer?.parts ?? [];
  const multiPart = parts.length > 1;

  return (
    <Panel
      title={`Bounce — ${view.bounce.onTeamName ?? '—'}`}
      aside={<span className="text-xs text-neutral-500">wrong costs nothing on bounce</span>}
    >
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => act({ type: 'BOUNCE_CORRECT', eventId: '' })}
          className="rounded bg-green-700 px-4 py-2 font-semibold text-white"
        >
          Correct +10 <span className="opacity-70">y</span>
        </button>
        <button
          onClick={() => act({ type: 'BOUNCE_WRONG' })}
          className="rounded border border-neutral-400 px-4 py-2"
        >
          Wrong / pass <span className="opacity-60">n</span>
        </button>
      </div>

      {multiPart && (
        <div className="mt-3 border-t border-neutral-200 pt-3">
          <p className="mb-1 text-xs font-semibold uppercase text-neutral-600">
            Partial — click what they got
          </p>
          <p className="mb-2 text-xs text-neutral-500">
            Recorded now, hidden from every team until you reveal. The bounce keeps
            going.
          </p>
          <div className="flex flex-wrap gap-2">
            {parts.map((p) => (
              <button
                key={p.id}
                disabled={Boolean(p.creditedTo)}
                onClick={() => act({ type: 'BOUNCE_PARTIAL', partIds: [p.id], eventId: '' })}
                className="rounded border border-amber-500 px-3 py-2 text-sm text-amber-800 disabled:opacity-40"
              >
                {p.label} +{p.value}
                {p.creditedTo && <span className="ml-1 text-xs">({p.creditedTo})</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Always visible, current team marked. Wrap-around is where QMs lose track. */
function BounceOrder({ view }: { view: QmView }) {
  if (view.bounce.order.length === 0) return null;
  return (
    <Panel title="Bounce order">
      <ol className="space-y-1 text-sm">
        {view.bounce.order.map((t) => (
          <li
            key={t.teamId}
            className={`flex justify-between rounded px-2 py-1 ${
              t.current
                ? 'bg-blue-100 font-semibold'
                : t.spent
                  ? 'text-neutral-400'
                  : t.offered
                    ? 'text-neutral-400 line-through'
                    : ''
            }`}
          >
            <span className={t.spent ? 'line-through' : ''}>{t.name}</span>
            {t.current && <span className="text-xs">now</span>}
            {/* Pounced, so skipped — say why rather than silently passing over. */}
            {!t.current && t.spent && <span className="text-xs">pounced</span>}
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/**
 * Scores.
 *
 * Two numbers per team, and the difference matters: the public score is what
 * the teams can see, and anything withheld is a partial you have awarded that
 * has not been revealed yet.
 */
function ScorePanel({ view }: { view: QmView }) {
  const anyWithheld = view.standings.some((s) => s.withheldPoints !== 0);
  return (
    <Panel
      title="Live scoreboard"
      aside={anyWithheld ? <span className="text-xs text-amber-700">withheld pending reveal</span> : null}
    >
      <ul className="space-y-1">
        {view.standings.map((s, i) => (
          <li key={s.teamId} className="flex items-baseline justify-between gap-2 text-base">
            <span>
              <span className="mr-2 font-mono text-xs text-neutral-400">{i + 1}</span>
              {s.name}
            </span>
            <span className="font-mono">
              {s.score}
              {s.withheldPoints !== 0 && (
                <span className="ml-1 text-amber-700">
                  ({s.withheldPoints > 0 ? '+' : ''}
                  {s.withheldPoints})
                </span>
              )}
              <span className="ml-2 text-xs text-neutral-400">
                {s.pouncesCorrect}/{s.pouncesAttempted}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-neutral-500">
        Right-hand figures are pounces correct out of attempted — the tiebreak
        signals. The system shows them; you decide.
      </p>
    </Panel>
  );
}

function PresencePanel({ view }: { view: QmView }) {
  return (
    <Panel title="Who is here">
      <ul className="space-y-1 text-sm">
        {view.presence.map((t) => (
          <li key={t.teamId} className="flex justify-between gap-2">
            <span className={t.members.length === 0 ? 'text-neutral-400' : ''}>{t.teamName}</span>
            <span className="text-xs text-neutral-500">
              {t.members.length === 0 ? 'not connected' : t.members.join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/**
 * The written round console.
 *
 * Two surfaces in one panel, because the round has two distinct jobs:
 * showing the questions, then grading a grid of answers.
 *
 * The grid is questions down, teams across, and it is graded question by
 * question rather than team by team — that is the only way to be consistent
 * about what counts as close enough, which is a judgement you make once per
 * question and then apply (ARCHITECTURE §3).
 */
function WrittenPanel({ view, act }: { view: QmView; act: (a: Action) => void }) {
  const written = view.written;
  if (!written) {
    return (
      <Panel title="Written round">
        <p className="text-sm text-neutral-600">Starting…</p>
      </Panel>
    );
  }

  const collecting = written.phase === 'COLLECTING';
  const grading = written.phase === 'EVALUATING' || written.phase === 'REVEALED';

  return (
    <>
      <Panel
        title={`Written round — ${written.phase}`}
        aside={
          <span className="text-xs text-neutral-500">
            +10 / 0, or +15 / −5 if staked
          </span>
        }
      >
        {/* Showing: one question at a time, so teams can write them down. */}
        {written.phase === 'SHOWING' && (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase text-neutral-500">
              Showing question {written.shownIdx + 1} of {written.questions.length}
            </p>
            <p className="text-lg whitespace-pre-wrap">
              {written.questions[written.shownIdx]?.text}
            </p>
            <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-sm">
              <span className="font-semibold">Answer: </span>
              {written.questions[written.shownIdx]?.answerText || <em>not written yet</em>}
            </p>
          </div>
        )}

        {collecting && (
          <p className="text-sm text-neutral-600">
            All four boxes are live on every team's screen. Answers are hidden
            from you until you close — same rule as a pounce, for the same reason.
          </p>
        )}

        {/* Jump back to any question while still showing. */}
        {(written.phase === 'SHOWING' || written.phase === 'IDLE') && (
          <div className="mt-3 flex flex-wrap gap-2 border-t border-neutral-200 pt-3">
            {written.questions.map((q) => (
              <button
                key={q.id}
                onClick={() => act({ type: 'SHOW_WRITTEN_QUESTION', index: q.index })}
                className={`rounded border px-3 py-1 text-sm ${
                  q.index === written.shownIdx && written.phase === 'SHOWING'
                    ? 'border-blue-600 bg-blue-50 font-semibold'
                    : 'border-neutral-400'
                }`}
              >
                Q{q.index + 1}
              </button>
            ))}
          </div>
        )}
      </Panel>

      {grading && (
        <Panel title="Grading">
          <div className="space-y-4">
            {written.questions.map((q) => (
              <div key={q.id}>
                <p className="text-sm font-semibold">
                  Q{q.index + 1}. {q.text}
                </p>
                <p className="mb-2 text-sm text-amber-800">
                  Answer: {q.answerText || <em>not written</em>}
                </p>
                <ul className="space-y-1">
                  {written.answers
                    .filter((a) => a.questionId === q.id)
                    .map((a) => (
                      <li key={a.teamId} className="flex items-center gap-2 text-sm">
                        <span className="w-24 shrink-0">{a.teamName}</span>
                        <span className="flex-1">
                          {a.text ? (
                            <span className="whitespace-pre-wrap">{a.text}</span>
                          ) : (
                            <em className="text-neutral-400">no answer</em>
                          )}
                          {a.staked && (
                            <span className="ml-2 rounded bg-amber-100 px-1 text-xs text-amber-800">
                              staked
                            </span>
                          )}
                        </span>
                        {a.verdict ? (
                          <span
                            className={
                              a.verdict === 'CORRECT' ? 'text-green-700' : 'text-red-700'
                            }
                          >
                            {a.verdict === 'CORRECT'
                              ? a.staked
                                ? '+15'
                                : '+10'
                              : a.staked
                                ? '−5'
                                : '0'}
                          </span>
                        ) : (
                          a.text !== null && (
                            <span className="flex gap-1">
                              <button
                                onClick={() =>
                                  act({
                                    type: 'EVALUATE_WRITTEN',
                                    teamId: a.teamId,
                                    questionId: q.id,
                                    verdict: 'CORRECT',
                                    eventId: '',
                                  })
                                }
                                className="rounded border border-green-500 px-2 py-0.5 text-green-700"
                              >
                                ✓
                              </button>
                              <button
                                onClick={() =>
                                  act({
                                    type: 'EVALUATE_WRITTEN',
                                    teamId: a.teamId,
                                    questionId: q.id,
                                    verdict: 'WRONG',
                                    eventId: '',
                                  })
                                }
                                className="rounded border border-red-400 px-2 py-0.5 text-red-700"
                              >
                                ✗
                              </button>
                            </span>
                          )
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}
