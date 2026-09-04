/**
 * The team client.
 *
 * What up to three people in three different cities look at during a quiz. It
 * has to work on a phone, so it is one column, and the thing that matters right
 * now is always at the top.
 *
 * The three jobs it does that a Meet call plus WhatsApp cannot:
 *   - a pounce that nobody else can see, submitted by any member
 *   - a shared answer draft the team edits together, with typing indicators
 *   - a live scoreboard that is honest about withheld partials
 */

import { useEffect, useRef, useState } from 'react';
import type { TeamView } from '@quizmaster/shared';

import {
  clearSession,
  loadSession,
  saveSession,
  socketUrl,
  useLive,
  type StoredSession,
} from './socket.js';

export function TeamApp() {
  const [session, setSession] = useState<StoredSession | null>(() => loadSession());
  const connect = useLive((s) => s.connect);
  const disconnect = useLive((s) => s.disconnect);
  const view = useLive((s) => s.view);
  const status = useLive((s) => s.status);

  useEffect(() => {
    if (!session) return;
    connect(socketUrl({ token: session.token }));
    return () => disconnect();
  }, [session, connect, disconnect]);

  if (!session) return <JoinForm onJoined={setSession} />;

  if (status === 'rejected') {
    return (
      <Centre>
        <p className="mb-3 text-sm text-red-700">
          That session is no longer valid. Join again with your team code.
        </p>
        <button
          className="rounded border border-neutral-400 px-3 py-1 text-sm"
          onClick={() => {
            clearSession();
            setSession(null);
          }}
        >
          Join again
        </button>
      </Centre>
    );
  }

  if (!view || view.role !== 'TEAM') {
    return <Centre>Connecting…</Centre>;
  }

  return <TeamScreen view={view} onLeave={() => {
    clearSession();
    setSession(null);
  }} />;
}

// ─── Joining ────────────────────────────────────────────────────────────────

function JoinForm({ onJoined }: { onJoined: (s: StoredSession) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), displayName: name.trim() }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? 'Could not join.');
        return;
      }
      const session: StoredSession = {
        token: body.token,
        role: 'TEAM',
        quizId: body.quizId,
        teamName: body.teamName,
        displayName: body.displayName,
      };
      saveSession(session);
      onJoined(session);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Centre>
      <p className="mb-1 text-xs font-semibold uppercase tracking-widest text-neutral-400">
        Quizmaster
      </p>
      <h1 className="mb-2 text-2xl font-semibold text-neutral-900">Join your team</h1>
      <p className="mb-5 text-sm text-neutral-600">
        This is the team screen for a live quiz. Once you are in, the questions
        appear here as the quizmaster reads them, and this is where you pounce.
      </p>
      <p className="mb-4 rounded bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
        Your whole team shares one code. Everyone joins with it and adds their own
        name, so you can see who is typing.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-neutral-600">
            Team code
          </label>
          <input
            className="w-full rounded border border-neutral-300 bg-white px-3 py-2 font-mono text-lg tracking-widest text-neutral-900 uppercase"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABCD1234"
            autoCapitalize="characters"
            autoCorrect="off"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold uppercase text-neutral-600">
            Your name
          </label>
          <input
            className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="So your teammates know who is typing"
          />
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={busy || !code.trim() || !name.trim()}
          className="w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40"
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </Centre>
  );
}

// ─── Playing ────────────────────────────────────────────────────────────────

function TeamScreen({ view, onLeave }: { view: TeamView; onLeave: () => void }) {
  const status = useLive((s) => s.status);
  const error = useLive((s) => s.error);

  return (
    <div className="mx-auto min-h-screen max-w-2xl bg-neutral-50 p-3 pb-24">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold">{view.you.teamName}</h1>
          <p className="text-xs text-neutral-500">
            {view.quizTitle}
            {view.round ? ` · ${view.round.title}` : ''}
          </p>
        </div>
        <div className="text-right">
          <ConnectionDot status={status} />
          <button onClick={onLeave} className="ml-2 text-xs text-neutral-400 underline">
            leave
          </button>
        </div>
      </header>

      {view.you.present.length > 1 && (
        <p className="mb-3 text-xs text-neutral-500">
          Here: {view.you.present.join(', ')}
        </p>
      )}

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* The bounce reaching you is the single most urgent thing on this screen. */}
      {view.bounce.onYou && (
        <div className="mb-3 rounded border-2 border-green-600 bg-green-50 px-4 py-3">
          <p className="text-lg font-semibold text-green-900">Your turn — answer out loud.</p>
          <p className="text-sm text-green-800">
            No penalty for a wrong answer on the bounce.
          </p>
        </div>
      )}
      {view.bounce.active && !view.bounce.onYou && (
        <p className="mb-3 text-sm text-neutral-600">
          Bounce is with <strong>{view.bounce.onTeamName}</strong>.
        </p>
      )}

      <QuestionCard view={view} />
      <PounceBox view={view} />
      <DraftBox view={view} />
      <RevealCard view={view} />
      <Scoreboard view={view} />
    </div>
  );
}

function ConnectionDot({ status }: { status: string }) {
  const colour =
    status === 'live' ? 'bg-green-500' : status === 'reconnecting' ? 'bg-amber-500' : 'bg-neutral-400';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-neutral-500">
      <span className={`inline-block h-2 w-2 rounded-full ${colour}`} />
      {status === 'live' ? 'live' : status === 'reconnecting' ? 'reconnecting' : status}
    </span>
  );
}

function QuestionCard({ view }: { view: TeamView }) {
  if (!view.question) {
    return (
      <div className="mb-3 rounded border border-neutral-200 bg-white p-6 text-center text-sm text-neutral-500">
        Waiting for the quizmaster.
      </div>
    );
  }
  return (
    <div className="mb-3 rounded border border-neutral-200 bg-white p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Question {view.question.index + 1} of {view.question.total}
        {view.question.partCount > 1 && ` · ${view.question.partCount} parts`}
      </p>
      <p className="text-lg whitespace-pre-wrap">{view.question.text}</p>
      {view.question.media.map((m) =>
        m.kind === 'IMAGE' ? (
          <img key={m.id} src={m.url} alt="" className="mt-3 max-w-full rounded" />
        ) : (
          <audio key={m.id} src={m.url} controls className="mt-3 w-full" />
        ),
      )}
    </div>
  );
}

/**
 * The pounce box.
 *
 * Written-blind: nobody else sees this, including the quizmaster, until the
 * window closes. One pounce per team per question, so it locks after submitting
 * — that is the rule, not a UI convenience, and the screen should say why.
 */
function PounceBox({ view }: { view: TeamView }) {
  const send = useLive((s) => s.send);
  const [text, setText] = useState('');

  if (view.pounce.spent) {
    return (
      <div className="mb-3 rounded border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        You have already pounced on this connect — one per team, whatever the outcome.
      </div>
    );
  }

  if (view.pounce.submitted) {
    return (
      <div className="mb-3 rounded border border-blue-200 bg-blue-50 p-4">
        <p className="text-xs font-semibold uppercase text-blue-800">Pounce submitted</p>
        <p className="mt-1 whitespace-pre-wrap">{view.pounce.yourText}</p>
        {view.pounce.yourVerdict ? (
          <p
            className={`mt-2 text-sm font-semibold ${
              view.pounce.yourVerdict === 'CORRECT' ? 'text-green-700' : 'text-red-700'
            }`}
          >
            {view.pounce.yourVerdict === 'CORRECT' ? 'Correct' : 'Wrong'}
          </p>
        ) : (
          <p className="mt-2 text-xs text-blue-700">Nobody can see this until the window closes.</p>
        )}
      </div>
    );
  }

  // FORMAT_SPEC §2.1: the direct team does not pounce — the question is already
  // theirs. Say that, rather than offering a box the engine will refuse.
  if (view.you.isDirectTeam) {
    return (
      <div className="mb-3 rounded border border-neutral-300 bg-white p-4 text-sm">
        <p className="font-semibold">This one is yours.</p>
        <p className="text-neutral-600">
          The question was posed to your team, so there is no pounce for you — the
          bounce starts here if you do not get it.
        </p>
      </div>
    );
  }

  if (!view.pounce.open) return null;

  return (
    <div
      className={`mb-3 rounded border-2 bg-white p-4 ${
        view.pounce.finalCall ? 'border-amber-500' : 'border-blue-400'
      }`}
    >
      <p className="mb-1 text-sm font-semibold">
        {view.pounce.finalCall ? 'Final call — pounce now' : 'Pounce open'}
      </p>
      <p className="mb-2 text-xs text-neutral-600">
        +10 if right, −5 if wrong. One per team. Nobody else sees what you write.
      </p>
      <textarea
        className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Your answer"
      />
      <button
        disabled={!text.trim()}
        onClick={() => send({ type: 'POUNCE', text: text.trim() })}
        className="mt-2 w-full rounded bg-blue-700 px-3 py-2 text-white disabled:opacity-40"
      >
        Submit pounce
      </button>
    </div>
  );
}

/**
 * The shared draft.
 *
 * Three people, one team identity, three different rooms. This is the thing
 * that replaces the WhatsApp thread: everyone types into the same box and sees
 * who is typing. It is not quiz state, so it never touches the reducer.
 */
function DraftBox({ view }: { view: TeamView }) {
  const send = useLive((s) => s.send);
  const [local, setLocal] = useState(view.draft.text);
  const typingRef = useRef(0);

  // Take the server's text unless this person is mid-edit, so a teammate's
  // change lands without yanking the cursor out of your own sentence.
  useEffect(() => {
    if (Date.now() - typingRef.current > 1500) setLocal(view.draft.text);
  }, [view.draft.text]);

  if (!view.question) return null;

  const others = view.draft.typing.filter((n) => n !== view.you.displayName);

  return (
    <div className="mb-3 rounded border border-neutral-200 bg-white p-4">
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Team notes
        </p>
        <p className="text-xs text-neutral-500">
          {others.length > 0 ? `${others.join(', ')} typing…` : view.draft.updatedBy ? `last edit: ${view.draft.updatedBy}` : ''}
        </p>
      </div>
      <textarea
        className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900"
        rows={3}
        value={local}
        placeholder="Work it out together here. Only your team sees this."
        onChange={(e) => {
          setLocal(e.target.value);
          typingRef.current = Date.now();
          send({ type: 'TYPING' });
        }}
        onBlur={() => send({ type: 'DRAFT', text: local })}
      />
      <button
        onClick={() => send({ type: 'DRAFT', text: local })}
        className="mt-2 rounded border border-neutral-400 px-2 py-1 text-xs"
      >
        Share with team
      </button>
    </div>
  );
}

function RevealCard({ view }: { view: TeamView }) {
  if (!view.reveal) return null;
  return (
    <div className="mb-3 rounded border border-green-300 bg-green-50 p-4">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-green-800">Answer</p>
      <p className="whitespace-pre-wrap text-lg">{view.reveal.text}</p>
      {view.reveal.media.map((m) =>
        m.kind === 'IMAGE' ? (
          <img key={m.id} src={m.url} alt="" className="mt-3 max-w-full rounded" />
        ) : null,
      )}
    </div>
  );
}

/**
 * The scoreboard, live.
 *
 * These are public scores: APPLIED events only. A partial you have been awarded
 * but which has not been revealed yet is deliberately not in here — if it were,
 * the teams still bouncing could work out that a part had been confirmed.
 */
function Scoreboard({ view }: { view: TeamView }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Scores
      </p>
      <ol className="space-y-1">
        {view.standings.map((team) => (
          <li
            key={team.teamId}
            className={`flex justify-between text-sm ${
              team.teamId === view.you.teamId ? 'font-semibold' : ''
            }`}
          >
            <span>{team.name}</span>
            <span className="font-mono">{team.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Centre({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4">
      <div className="w-full max-w-sm rounded border border-neutral-200 bg-white p-6">
        {children}
      </div>
    </div>
  );
}
