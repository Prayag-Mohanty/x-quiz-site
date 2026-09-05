/**
 * The team client.
 *
 * What up to three people in three different cities look at during a quiz.
 *
 * Two layouts, one component tree. On a phone it is one column with the thing
 * that matters most at the top. On a desktop the question takes the width it
 * deserves — it is what everyone is reading — and the scoreboard, attendance
 * and team notes move into a sidebar beside it rather than below the fold.
 * The breakpoint is `lg`, so tablets get the phone layout, which is right:
 * a narrow window is a narrow window.
 *
 * The three jobs it does that a Meet call plus WhatsApp cannot:
 *   - a pounce that nobody else can see, submitted by any member
 *   - a shared answer draft the team edits together, with typing indicators
 *   - a live scoreboard that is honest about withheld partials
 */

import { useEffect, useRef, useState } from 'react';
import type { TeamView } from '@quizmaster/shared';

import { Rich } from './Rich.js';
import { trailingLines } from './trailing.js';
import {
  clearSession,
  loadSession,
  saveSession,
  socketUrl,
  useLive,
  type StoredSession,
} from './socket.js';

export function TeamApp() {
  // A QM session in the same browser is not a team session. Without the role
  // check this screen tries to join the quiz as the quizmaster and sits on
  // "Connecting…" forever, which looks like the server being down.
  const [session, setSession] = useState<StoredSession | null>(() => {
    const stored = loadSession();
    return stored?.role === 'TEAM' ? stored : null;
  });
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

  const rejoin = () => {
    clearSession();
    setSession(null);
  };

  if (status === 'rejected') {
    return (
      <Centre>
        <p className="mb-3 text-sm text-red-700">
          That session is no longer valid — the quiz may have been reset. Join
          again with your team code.
        </p>
        <button className="rounded border border-neutral-400 px-3 py-1 text-sm" onClick={rejoin}>
          Join again
        </button>
      </Centre>
    );
  }

  if (!view || view.role !== 'TEAM') {
    // Never a dead end. Connecting can fail for reasons this screen cannot see —
    // a stale token, a quiz that no longer exists, a server that is down — and
    // "Connecting…" with no way out is indistinguishable from all of them.
    return <Connecting status={status} onRejoin={rejoin} />;
  }

  return <TeamScreen view={view} onLeave={() => {
    clearSession();
    setSession(null);
  }} />;
}

/**
 * The waiting screen, with an escape hatch.
 *
 * After a few seconds of not connecting, offer the one action that fixes most
 * causes: join again. Sitting on a spinner forever is the worst possible answer
 * two minutes before a quiz starts.
 */
function Connecting({ status, onRejoin }: { status: string; onRejoin: () => void }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Centre>
      <p className="mb-1 font-medium">
        {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
      </p>
      <p className="text-sm text-neutral-600">
        {status === 'reconnecting'
          ? 'The connection dropped. This will pick up where you left off.'
          : 'Joining the quiz.'}
      </p>
      {slow && (
        <div className="mt-4 border-t border-neutral-200 pt-3">
          <p className="mb-2 text-sm text-neutral-600">
            Taking longer than it should. Your saved session may be for a quiz
            that no longer exists.
          </p>
          <button
            className="rounded border border-neutral-400 px-3 py-1 text-sm"
            onClick={onRejoin}
          >
            Start over and enter my code again
          </button>
        </div>
      )}
    </Centre>
  );
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

/**
 * The slide header: deep navy, white text.
 *
 * One constant because the question, the written sheet and the reveal all wear
 * it, and three hand-written hexes drift apart the first time one is tweaked.
 */
const SLIDE_HEADER = 'bg-[#1b0a63] text-white';

/** Named because a bare newline escape inside JSX braces is easy to misread. */
const LINE_BREAK = '\n';

function TeamScreen({ view, onLeave }: { view: TeamView; onLeave: () => void }) {
  const status = useLive((s) => s.status);
  const error = useLive((s) => s.error);

  return (
    <div className="mx-auto min-h-screen max-w-7xl bg-neutral-50 p-3 pb-24 lg:p-6">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold lg:text-lg">{view.you.teamName}</h1>
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

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </div>
      )}

      {/* The bounce reaching you is the single most urgent thing on this screen,
          so it spans the whole width and sits above everything else. */}
      {view.bounce.onYou && (
        <div className="mb-3 rounded border-2 border-green-600 bg-green-50 px-4 py-3">
          <p className="text-lg font-semibold text-green-900 lg:text-xl">
            Your turn — answer out loud.
          </p>
          <p className="text-sm text-green-800">
            No penalty for a wrong answer on the bounce.
          </p>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[1fr_20rem] lg:items-start lg:gap-6">
        {/* The question and everything you do about it. */}
        <div className="min-w-0">
          <TeamBounceOrder view={view} />
          {view.written ? (
            <WrittenRound view={view} />
          ) : (
            <>
              <ConnectStrip view={view} />
              <QuestionCard view={view} />
              <PounceBox view={view} />
              <RevealCard view={view} />
            </>
          )}
        </div>

        {/* Everything you glance at. On a phone this falls below the question,
            which is the same priority order stacked instead of side by side. */}
        <div className="space-y-3">
          <DraftBox view={view} />
          <Scoreboard view={view} />
          <PresenceBox view={view} />
        </div>
      </div>
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

/**
 * The question, as a slide.
 *
 * Navy bar with the number, white body with the text in Inter, set large —
 * this is what everyone in the room is reading, and on a desktop it should look
 * like the slide it replaces rather than a paragraph in a phone app. The size
 * steps down on narrow screens because a phone cannot afford 30px type.
 *
 * The header carries the number and nothing else. "Question 1 of 3" was there
 * and is not: on a slide it is chrome, and it tells the room how much is left
 * in the round, which is the quizmaster's business rather than a fact the
 * question needs to state about itself.
 */
/**
 * Filling the screen with the question.
 *
 * Two mechanisms, because one of them is not available everywhere. The CSS
 * overlay is the real feature — fixed to the viewport, bigger type, works in
 * every browser including iOS Safari, which refuses requestFullscreen on
 * anything that is not a video. The Fullscreen API is attempted on top of it
 * where it exists, purely to hide the browser's own chrome; if it is refused
 * the overlay is still exactly what the team asked for.
 *
 * Escape leaves, and so does the button, and the two stay in step: the browser
 * fires its own exit on Escape when it took the request, so the state follows
 * the document rather than assuming.
 */
function useFullscreen() {
  const ref = useRef<HTMLDivElement>(null);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOn(false);
    };
    // If the browser drops out of fullscreen by any route of its own, follow it.
    const onChange = () => {
      if (!document.fullscreenElement) setOn(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onChange);
    };
  }, [on]);

  const enter = () => {
    setOn(true);
    // Best effort. Not supported on iOS Safari for a div, and refused if the
    // click was not trusted; the overlay does the work either way.
    void ref.current?.requestFullscreen?.().catch(() => undefined);
  };

  const exit = () => {
    setOn(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  return { ref, on, enter, exit };
}

function QuestionCard({ view }: { view: TeamView }) {
  const full = useFullscreen();

  if (!view.question) {
    return (
      <div className="font-question mb-3 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className={`${SLIDE_HEADER} px-5 py-4`}>
          <p className="text-lg font-bold">·</p>
        </div>
        <p className="p-10 text-center text-sm text-neutral-500">
          Waiting for the quizmaster.
        </p>
      </div>
    );
  }
  return (
    <div
      ref={full.ref}
      className={
        full.on
          ? 'font-question fixed inset-0 z-50 flex flex-col overflow-auto bg-white'
          : 'font-question mb-3 overflow-hidden rounded-lg border border-neutral-200 bg-white'
      }
    >
      <div className={`${SLIDE_HEADER} flex items-baseline justify-between gap-3 px-5 py-4`}>
        <p className="text-2xl font-bold lg:text-3xl">{view.question.index + 1}.</p>
        <div className="flex items-baseline gap-4">
          {/* A multi-part question is a fact about THIS question, so it stays.
              The running count is not, so it went. */}
          {view.question.partCount > 1 && (
            <p className="text-xs tracking-wide text-white/70 uppercase">
              {view.question.partCount} parts
            </p>
          )}
          <button
            onClick={full.on ? full.exit : full.enter}
            className="rounded border border-white/40 px-2 py-1 text-xs text-white/90 hover:bg-white/10"
            title={full.on ? 'Back to the rest of the screen — or press Escape' : 'Fill the screen with the question'}
          >
            {full.on ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </div>
      <div className={full.on ? 'flex-1 p-8 lg:p-16' : 'p-5 lg:p-8'}>
        <p
          className={
            full.on
              ? 'text-2xl leading-relaxed whitespace-pre-wrap lg:text-5xl lg:leading-relaxed'
              : 'text-lg leading-relaxed whitespace-pre-wrap lg:text-2xl lg:leading-relaxed'
          }
        >
          <Rich text={view.question.text} />
          {/* Rendered as newlines rather than padding so it scales with the type:
              two lines of 24px text is more room than two lines of 18px, which is
              the point on a projector. */}
          {LINE_BREAK.repeat(trailingLines(view.question.text))}
        </p>
        {view.question.media.map((m) =>
          m.kind === 'IMAGE' ? (
            <img
              key={m.id}
              src={m.url}
              alt=""
              className={full.on ? 'mt-6 max-h-[55vh] rounded' : 'mt-4 max-w-full rounded'}
            />
          ) : (
            <audio key={m.id} src={m.url} controls className="mt-4 w-full" />
          ),
        )}
      </div>

      {/* Full screen hides the pounce box, the scoreboard and everything else,
          so say how to get back rather than leaving it to be discovered. */}
      {full.on && (
        <p className="px-8 pb-6 text-sm text-neutral-500 lg:px-16">
          Press <kbd className="rounded border border-neutral-300 px-1">Esc</kbd> to get back
          to your pounce box and the scoreboard.
        </p>
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
      <div className="mb-3 rounded border border-neutral-200 bg-white p-4 text-sm">
        <p className="text-neutral-600">
          You have already pounced on this connect — one per team, whatever the
          outcome.
        </p>
        {/* Your own pounce may have been two reveals ago, and the round clears
            it from play each time it advances. This is where you find out. */}
        {view.pounce.yourVerdict && (
          <p
            className={`mt-2 font-semibold ${
              view.pounce.yourVerdict === 'CORRECT' ? 'text-green-700' : 'text-red-700'
            }`}
          >
            {view.pounce.yourVerdict === 'CORRECT' ? 'You had it.' : 'Not this time.'}
          </p>
        )}
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
        {view.connect
          ? `+${view.connect.value.correct} if right, ${
              view.connect.value.wrong === 0
                ? 'nothing lost'
                : `−${Math.abs(view.connect.value.wrong)} if wrong`
            }. One per team for the whole connect — this is your only shot at it.`
          : '+10 if right, −5 if wrong. One per team.'}{' '}
        Nobody else sees what you write.
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
    <div className="font-question mb-3 overflow-hidden rounded-lg border border-green-300 bg-white">
      {/* Same shape as the question, different colour: it is the other slide. */}
      <div className="bg-green-800 px-5 py-3 text-xs font-semibold tracking-wide text-white uppercase">
        Answer
      </div>
      <div className="p-5 lg:p-8">
      <p className="text-lg leading-relaxed whitespace-pre-wrap lg:text-2xl lg:leading-relaxed">
        <Rich text={view.reveal.text} />
      </p>
      {view.reveal.media.map((m) =>
        m.kind === 'IMAGE' ? (
          <img key={m.id} src={m.url} alt="" className="mt-4 max-w-full rounded" />
        ) : null,
      )}
      </div>
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
    <div className="rounded border border-neutral-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Live scoreboard
      </p>
      <ol className="space-y-0.5">
        {view.standings.map((team, i) => (
          <li
            key={team.teamId}
            className={`flex items-baseline justify-between rounded px-1.5 py-0.5 text-sm ${
              team.teamId === view.you.teamId ? 'bg-blue-50 font-semibold' : ''
            }`}
          >
            <span className="truncate">
              <span className="mr-1.5 font-mono text-xs text-neutral-400">{i + 1}</span>
              {team.name}
              {team.teamId === view.you.teamId && (
                <span className="ml-1 text-xs text-blue-700">you</span>
              )}
            </span>
            <span className="font-mono text-base tabular-nums">{team.score}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-neutral-500">
        Partial credit appears when the answer is revealed.
      </p>
    </div>
  );
}

/**
 * Who is here.
 *
 * The same list the quizmaster has. Attendance is not secret — everyone is on
 * the same call — and it answers the question every screen in the room is
 * silently asking before a round starts: are we still waiting for someone?
 */
function PresenceBox({ view }: { view: TeamView }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Who is here
      </p>
      <ul className="space-y-0.5">
        {view.presence.map((t) => {
          const you = t.teamId === view.you.teamId;
          return (
            <li
              key={t.teamId}
              className={`flex items-baseline justify-between gap-2 rounded px-1.5 py-0.5 text-sm ${
                you ? 'bg-blue-50 font-semibold' : ''
              }`}
            >
              <span className={t.members.length === 0 ? 'text-neutral-400' : ''}>
                {t.teamName}
              </span>
              <span className="truncate text-right text-xs text-neutral-500">
                {t.members.length === 0 ? 'not connected' : t.members.join(', ')}
              </span>
            </li>
          );
        })}
      </ul>
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

/**
 * A written round, from a team's side — FORMAT_SPEC §2.2.
 *
 * ONE answer sheet. The questions are read out one at a time in the box above
 * and keep changing; the box below them does not. That is how a written round
 * works on paper, and it is why there is no second box — a team writes
 * "1. … 2. …" in one place rather than tabbing between four fields while the
 * quizmaster is still reading the third question.
 *
 * The sheet is submitted against every question the QM has reached, so grading
 * stays question-by-question on the QM's side without the team ever seeing more
 * than one box. The stake is the one thing that is still per question, because
 * the stake IS per question: +15 / −5 instead of +10 / 0, and collapsing it
 * would lose the rule rather than simplify it.
 */
function WrittenRound({ view }: { view: TeamView }) {
  const written = view.written;
  const send = useLive((s) => s.send);
  const [local, setLocal] = useState('');
  const typingRef = useRef(0);
  /**
   * What has already gone out, per question.
   *
   * Blur and the save button both fire on a click, and the server's echo has
   * not come back in between — so without this the same sheet is submitted
   * twice and the action log, which is the crash-recovery record, grows a
   * duplicate for every save.
   */
  const sentRef = useRef(new Map<string, string>());

  /**
   * The sheet as the server has it.
   *
   * Every question carries the same text, so the first non-empty one is the
   * sheet. It is per team, not per person, which is what makes this shared
   * between three people in three cities with no extra plumbing.
   */
  const savedSheet = written?.yourAnswers.find((a) => a.text.trim() !== '')?.text ?? '';

  // Take a teammate's edit, unless this person is mid-sentence.
  useEffect(() => {
    if (Date.now() - typingRef.current > 1500) setLocal(savedSheet);
  }, [savedSheet]);

  const questionCount = written?.questions.length ?? 0;
  const open = written?.collecting ?? false;

  /**
   * A question the QM reaches AFTER the sheet was written still needs the sheet
   * attached to it, or there is nothing under it to grade. Fires when the QM
   * moves on, not while anyone is typing.
   */
  useEffect(() => {
    if (!open || !written || !local.trim()) return;
    for (const q of written.questions) {
      if (written.yourAnswers.some((a) => a.questionId === q.id)) continue;
      if (sentRef.current.get(q.id) === `-${local}`) continue;
      sentRef.current.set(q.id, `-${local}`);
      send({ type: 'WRITTEN_ANSWER', questionId: q.id, text: local, staked: false });
    }
    // Deliberately not keyed on `local`: this is about the question list growing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionCount, open]);

  if (!written) return null;

  const stakedIds = new Set(
    written.yourAnswers.filter((a) => a.staked).map((a) => a.questionId),
  );
  const dirty = local !== savedSheet;
  const graded = written.yourAnswers.filter((a) => a.verdict);

  /** Write the sheet to every question the QM has reached. */
  const push = (text: string, staked: Set<string>) => {
    for (const q of written.questions) {
      const existing = written.yourAnswers.find((a) => a.questionId === q.id);
      const wantStaked = staked.has(q.id);
      if (!existing && !text.trim() && !wantStaked) continue;
      if (existing && existing.text === text && existing.staked === wantStaked) continue;
      const signature = `${wantStaked ? 'S' : '-'}${text}`;
      if (sentRef.current.get(q.id) === signature) continue;
      sentRef.current.set(q.id, signature);
      send({ type: 'WRITTEN_ANSWER', questionId: q.id, text, staked: wantStaked });
    }
  };

  const toggleStake = (questionId: string) => {
    const next = new Set(stakedIds);
    if (next.has(questionId)) next.delete(questionId);
    else next.add(questionId);
    push(local, next);
  };

  return (
    <div className="mb-3 space-y-3">
      {/* The question being read out. This is the part that changes. */}
      <div className="font-question overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className={`${SLIDE_HEADER} flex items-baseline justify-between gap-3 px-5 py-4`}>
          <p className="text-2xl font-bold lg:text-3xl">
            {written.currentQuestion ? `${written.currentQuestion.index + 1}.` : '·'}
          </p>
          <p className="text-xs tracking-wide text-white/70 uppercase">Written round</p>
        </div>
        <div className="p-5 lg:p-8">
        {written.currentQuestion ? (
          <>
            <p className="text-lg leading-relaxed whitespace-pre-wrap lg:text-2xl lg:leading-relaxed">
              <Rich text={written.currentQuestion.text} />
              {LINE_BREAK.repeat(trailingLines(written.currentQuestion.text))}
            </p>
            {written.currentQuestion.media.map((m) =>
              m.kind === 'IMAGE' ? (
                <img key={m.id} src={m.url} alt="" className="mt-4 max-w-full rounded" />
              ) : null,
            )}
          </>
        ) : (
          <p className="text-sm text-neutral-500">Waiting for the quizmaster.</p>
        )}
        </div>
      </div>

      {/* The answer sheet. One box, however many questions there are. */}
      <div className="rounded border border-neutral-200 bg-white p-4">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Your answer sheet
          </p>
          <p className="text-xs text-neutral-500">
            {!open ? 'locked' : dirty ? 'not saved yet' : savedSheet ? 'saved' : ''}
          </p>
        </div>

        <textarea
          className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-neutral-900 disabled:bg-neutral-50 disabled:text-neutral-500"
          rows={8}
          value={local}
          disabled={!open}
          placeholder={'1.\n2.\n3.\n4.'}
          onChange={(e) => {
            setLocal(e.target.value);
            typingRef.current = Date.now();
          }}
          onBlur={() => push(local, stakedIds)}
        />

        {open ? (
          <>
            <button
              onClick={() => push(local, stakedIds)}
              disabled={!dirty}
              className="mt-2 w-full rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-40"
            >
              {dirty ? 'Save answers' : 'Saved'}
            </button>
            <p className="mt-2 text-xs text-neutral-600">
              Number your answers and write them all here. You can keep editing
              until the quizmaster closes the sheet. Any team member can type;
              the last edit wins.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm text-neutral-600">
            The sheet is closed. The quizmaster is grading it now.
          </p>
        )}
      </div>

      {/* Staking. Per question, because the rule is per question. */}
      {written.questions.length > 0 && (
        <div className="rounded border border-neutral-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Stake
          </p>
          <div className="flex flex-wrap gap-2">
            {written.questions.map((q) => {
              const on = stakedIds.has(q.id);
              return (
                <button
                  key={q.id}
                  disabled={!open}
                  onClick={() => toggleStake(q.id)}
                  className={`rounded border px-3 py-1 text-sm disabled:opacity-60 ${
                    on
                      ? 'border-amber-500 bg-amber-50 font-semibold text-amber-900'
                      : 'border-neutral-300 text-neutral-600'
                  }`}
                >
                  Q{q.index + 1}
                  {on && ' staked'}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-xs text-neutral-600">
            Staked: <strong>+15</strong> if right, <strong>−5</strong> if wrong.
            Unstaked: +10 / 0. Locks when the sheet closes.
          </p>
        </div>
      )}

      {/* Results, once the quizmaster has graded. Read-only. */}
      {graded.length > 0 && (
        <div className="rounded border border-neutral-200 bg-white p-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
            Marked
          </p>
          <ul className="space-y-1 text-sm">
            {written.questions.map((q) => {
              const answer = written.yourAnswers.find((a) => a.questionId === q.id);
              if (!answer?.verdict) return null;
              const right = answer.verdict === 'CORRECT';
              return (
                <li key={q.id} className="flex items-baseline justify-between gap-2">
                  <span>Q{q.index + 1}</span>
                  <span className={right ? 'text-green-700' : 'text-red-700'}>
                    {right
                      ? answer.staked
                        ? 'Correct — +15'
                        : 'Correct — +10'
                      : answer.staked
                        ? 'Wrong — −5'
                        : 'Wrong'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Where the connect is, and what it is worth right now — FORMAT_SPEC §2.3.
 *
 * The whole round is one decision made over and over: is the connection worth
 * 20 to us yet, or do we wait for an image that makes it worth 15? A team doing
 * that from memory gets it wrong, so the ladder is on the screen with the
 * current rung marked and the spent ones struck through.
 *
 * None of this is secret. The decay is a rule and the room is told it out loud.
 */
function ConnectStrip({ view }: { view: TeamView }) {
  const connect = view.connect;
  if (!connect) return null;

  return (
    <div className="mb-3 rounded border border-neutral-300 bg-white p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          Reveal {connect.stageIdx + 1} of {connect.stageCount}
        </p>
        <p className="font-mono text-sm">
          <span className="text-green-700">+{connect.value.correct}</span>
          <span className="mx-1 text-neutral-400">/</span>
          <span className="text-red-700">
            {connect.value.wrong === 0 ? '0' : `−${Math.abs(connect.value.wrong)}`}
          </span>
        </p>
      </div>
      <ol className="flex flex-wrap gap-1.5">
        {connect.ladder.map((rung, i) => (
          <li
            key={i}
            className={`rounded border px-2 py-0.5 font-mono text-xs ${
              i === connect.stageIdx
                ? 'border-blue-600 bg-blue-50 font-semibold'
                : i < connect.stageIdx
                  ? 'border-neutral-200 text-neutral-400 line-through'
                  : 'border-neutral-300 text-neutral-600'
            }`}
          >
            +{rung.correct} / {rung.wrong === 0 ? '0' : `−${Math.abs(rung.wrong)}`}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-neutral-600">
        One pounce per team for the whole connect, right or wrong. Every image
        after this one is worth less.
      </p>
    </div>
  );
}

/**
 * The bounce order, for teams.
 *
 * Nothing here is secret: the order is the seating order and who pounced is
 * announced as soon as the window closes. Teams need it for the same reason the
 * QM does — knowing your turn is two away is the difference between being ready
 * and being caught out. Horizontal, because it is a circle being walked, not a
 * ranking.
 */
function TeamBounceOrder({ view }: { view: TeamView }) {
  if (!view.bounce.active || view.bounce.order.length === 0) return null;
  return (
    <div className="mb-3 rounded border border-neutral-200 bg-white p-3">
      <p className="mb-2 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Bounce order
      </p>
      <ol className="flex flex-wrap gap-2">
        {view.bounce.order.map((t) => {
          const you = t.teamId === view.you.teamId;
          return (
            <li
              key={t.teamId}
              className={`flex flex-col rounded border px-2 py-1 text-sm ${
                t.current
                  ? 'border-green-600 bg-green-50 font-semibold'
                  : t.spent
                    ? 'border-neutral-200 bg-neutral-50 text-neutral-400'
                    : t.offered
                      ? 'border-neutral-200 text-neutral-400'
                      : 'border-neutral-300'
              }`}
            >
              <span className={t.spent || t.offered ? 'line-through' : ''}>
                {t.name}
                {you && <span className="ml-1 text-xs text-blue-700">you</span>}
              </span>
              <span className="text-xs">
                {t.current ? 'answering' : t.spent ? 'pounced' : t.offered ? 'passed' : ' '}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
