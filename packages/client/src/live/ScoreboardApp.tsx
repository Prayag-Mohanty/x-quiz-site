/**
 * The projector view.
 *
 * Read-only, no credential. This is the one screen you put on a shared display
 * or into a stream: the question as it is read, whose turn it is on the bounce,
 * the answer when it is revealed, and the scores.
 *
 * It shows exactly what a TEAM is allowed to see and nothing that is theirs. No
 * pounce text, no canonical answer before the reveal, and APPLIED points only —
 * a partial that has been awarded and not yet revealed is as absent from here
 * as it is from a team's screen, which is the whole reason PENDING exists.
 *
 * Built to be read from across a room: the question dominates, the scores sit
 * beside it, and there is a full-screen button because a projector wants the
 * browser chrome gone.
 */

import { useEffect, useRef, useState } from 'react';
import type { ScoreboardView } from '@quizmaster/shared';

import { MediaView } from './MediaView.js';
import { clearPreloaded, preload } from './preload.js';
import { Rich } from './Rich.js';
import { trailingLines } from './trailing.js';
import { socketUrl, useLive } from './socket.js';

const SLIDE_HEADER = 'bg-[#1b0a63] text-white';
const LINE_BREAK = '\n';

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
    return (
      <Shell>
        <p className="text-neutral-500">Connecting…</p>
      </Shell>
    );
  }

  return <Board view={view} status={status} />;
}

function Board({ view, status }: { view: ScoreboardView; status: string }) {
  const page = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);

  // The projector holds the round's sealed media too — a screen in the room
  // lagging a second behind the teams looking at it would be its own problem.
  const roundId = view.round?.id ?? null;
  const preloadCount = view.preload.length;
  useEffect(() => {
    void preload(view.preload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundId, preloadCount]);
  useEffect(() => () => clearPreloaded(), [roundId]);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void page.current?.requestFullscreen?.().catch(() => undefined);
  };

  return (
    <div ref={page} className="min-h-screen bg-neutral-100 p-6 lg:p-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold lg:text-4xl">{view.quizTitle}</h1>
          {view.round && (
            <p className="mt-1 text-lg text-neutral-500 lg:text-xl">
              {view.round.title} · round {view.round.index + 1} of {view.round.total}
            </p>
          )}
        </div>
        <div className="flex items-center gap-4">
          {status !== 'live' && <span className="text-sm text-amber-600">{status}</span>}
          <button
            onClick={toggleFull}
            className="rounded border border-neutral-400 px-3 py-1.5 text-sm text-neutral-600"
          >
            {full ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>
      </header>

      {/* Question first and widest — it is what the room is looking at. The
          scores are the thing you glance at, so they sit beside it. */}
      <div className="grid gap-6 lg:grid-cols-[1fr_24rem] lg:items-start">
        <div className="min-w-0 space-y-4">
          <ConnectLadder view={view} />
          <Slide view={view} />
          <BounceStrip view={view} />
          <Answer view={view} />
        </div>
        <Standings view={view} />
      </div>
    </div>
  );
}

function Slide({ view }: { view: ScoreboardView }) {
  if (!view.question) {
    return (
      <div className="font-question overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <div className={`${SLIDE_HEADER} px-6 py-5`}>
          <p className="text-2xl font-bold">·</p>
        </div>
        <p className="p-16 text-center text-neutral-400">Waiting for the next question.</p>
      </div>
    );
  }

  return (
    <div className="font-question overflow-hidden rounded-lg border border-neutral-200 bg-white">
      <div className={`${SLIDE_HEADER} flex items-baseline justify-between gap-3 px-6 py-5`}>
        <p className="text-3xl font-bold">{view.question.index + 1}.</p>
        {view.question.partCount > 1 && (
          <p className="text-xs tracking-wide text-white/70 uppercase">
            {view.question.partCount} parts
          </p>
        )}
      </div>
      <div className="p-6 lg:p-10">
        <p className="text-2xl leading-relaxed whitespace-pre-wrap lg:text-4xl lg:leading-relaxed">
          <Rich text={view.question.text} />
          {LINE_BREAK.repeat(trailingLines(view.question.text))}
        </p>
        {view.question.media.map((m) => (
          <MediaView
            key={m.id}
            media={m}
            className={m.kind === 'IMAGE' ? 'mt-6 max-h-[50vh] rounded' : 'mt-4 w-full'}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Whose turn it is.
 *
 * The order is announced out loud anyway, and a room that can see it does not
 * need the quizmaster to keep saying it. Struck through once a team has been
 * offered, greyed once they have pounced and are out (§2.1).
 */
function BounceStrip({ view }: { view: ScoreboardView }) {
  if (!view.bounce.active || view.bounce.order.length === 0) return null;
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="mb-3 text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Bounce — {view.bounce.onTeamName ?? '—'}
      </p>
      <ol className="flex flex-wrap gap-3">
        {view.bounce.order.map((t) => (
          <li
            key={t.teamId}
            className={`rounded border px-3 py-2 text-xl ${
              t.current
                ? 'border-green-600 bg-green-50 font-semibold text-green-900'
                : t.spent
                  ? 'border-neutral-200 bg-neutral-50 text-neutral-400 line-through'
                  : t.offered
                    ? 'border-neutral-200 text-neutral-400 line-through'
                    : 'border-neutral-300'
            }`}
          >
            {t.name}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The decay ladder during a connect, with the rung the room is on marked. */
function ConnectLadder({ view }: { view: ScoreboardView }) {
  const connect = view.connect;
  if (!connect) return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-lg border border-neutral-200 bg-white p-4">
      <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        Reveal {connect.stageIdx + 1} of {connect.stageCount}
      </p>
      <ol className="flex flex-wrap gap-2">
        {connect.ladder.map((rung, i) => (
          <li
            key={i}
            className={`rounded border px-2 py-1 font-mono text-sm ${
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
    </div>
  );
}

function Answer({ view }: { view: ScoreboardView }) {
  if (!view.reveal) return null;
  return (
    <div className="font-question overflow-hidden rounded-lg border border-green-300 bg-white">
      <div className="bg-green-800 px-6 py-3 text-xs font-semibold tracking-wide text-white uppercase">
        Answer
      </div>
      <div className="p-6 lg:p-10">
        <p className="text-2xl leading-relaxed whitespace-pre-wrap lg:text-4xl">
          <Rich text={view.reveal.text} />
        </p>
        {view.reveal.media.map((m) => (
          <MediaView key={m.id} media={m} className="mt-6 max-h-[40vh] rounded" />
        ))}
      </div>
    </div>
  );
}

/**
 * Scores, in SEAT order.
 *
 * Deliberately not sorted: a scoreboard that reshuffles every time someone
 * scores is unreadable from across a room, and ranking teams would imply a
 * placing the format does not claim to compute (§3 — the QM decides ties, not
 * the system). The leader is tinted instead, which says the same thing without
 * moving anything.
 */
function Standings({ view }: { view: ScoreboardView }) {
  const leader = Math.max(0, ...view.standings.map((t) => t.score));

  if (view.standings.length === 0) {
    return <p className="text-neutral-500">No teams in this quiz yet.</p>;
  }

  return (
    <ol className="space-y-2">
      {view.standings.map((team, i) => (
        <li
          key={team.teamId}
          className={`flex items-baseline gap-3 rounded px-4 py-3 shadow-sm ${
            team.score === leader && leader > 0 ? 'bg-amber-50' : 'bg-white'
          }`}
        >
          <span className="w-6 font-mono text-lg text-neutral-400">{i + 1}</span>
          <span className="flex-1 text-2xl">{team.name}</span>
          <span className="text-2xl font-semibold tabular-nums">{team.score}</span>
        </li>
      ))}
    </ol>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100 p-10">{children}</div>;
}
