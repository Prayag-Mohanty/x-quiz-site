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
      <TeamBounceOrder view={view} />

      {view.written ? (
        <WrittenRound view={view} />
      ) : (
        <>
          <QuestionCard view={view} />
          <PounceBox view={view} />
          <DraftBox view={view} />
          <RevealCard view={view} />
        </>
      )}
      {/* Scores and attendance read together: who is here, and where they are.
          Side by side on anything wider than a phone, stacked below that. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Scoreboard view={view} />
        <PresenceBox view={view} />
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
      <div className="rounded border-2 border-neutral-300 bg-white p-4">
        <p className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
          {written.currentQuestion
            ? `Question ${written.currentQuestion.index + 1}`
            : 'Written round'}
        </p>
        {written.currentQuestion ? (
          <>
            <p className="text-lg whitespace-pre-wrap">{written.currentQuestion.text}</p>
            {written.currentQuestion.media.map((m) =>
              m.kind === 'IMAGE' ? (
                <img key={m.id} src={m.url} alt="" className="mt-3 max-w-full rounded" />
              ) : null,
            )}
          </>
        ) : (
          <p className="text-sm text-neutral-500">Waiting for the quizmaster.</p>
        )}
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
