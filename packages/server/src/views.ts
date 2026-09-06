/**
 * Role projections.
 *
 * The server holds one QuizState. Nobody receives it. Each connected client is
 * sent a view built for their role, and the views are built here so there is one
 * place to check what leaks.
 *
 * The rule, restated because it is the one that matters: anything a team must
 * not know must not be SENT. Filtering at render time is not filtering — the
 * browser already has the bytes. So:
 *
 *   - the answer is absent until the QM reveals
 *   - a team sees its own pounce text and nobody else's, ever
 *   - the QM sees WHO has pounced while the window is open and WHAT only once it
 *     is closed (§2.1 binds the QM too — the decision to close should not be
 *     informed by what has arrived)
 *   - PENDING partials never reach a team, which is the entire reason that
 *     status exists
 *
 * All three round types are built out here. What differs between them is which
 * block is non-null — `written` for §2.2, `connect` for §2.3 — so a client can
 * branch on the round type and find everything that round needs in one place.
 */

import {
  bounceOrder,
  partValue,
  publicScore,
  provisionalScore,
  standings,
  type Media,
  type Question,
  type QuizState,
  type Round,
  type TeamId,
} from '@quizmaster/engine';
import type {
  ConnectView,
  SealedMedia,
  PublicQuestion,
  QmConnectView,
  QmWrittenView,
  TeamWrittenView,
  PublicStanding,
  QmPounce,
  QmStanding,
  QmView,
  RoundHeader,
  ScoreboardView,
  TeamDraft,
  TeamView,
  ViewMedia,
} from '@quizmaster/shared';

/** What a sealed asset needs, keyed by media asset id. */
export interface SealedAsset {
  preloadId: string;
  /** Base64 AES key, or null if the asset has not been sealed yet. */
  key: string | null;
  bytes: number | null;
}

/** Ephemeral per-room state that is not quiz state and never touches the reducer. */
export interface RoomContext {
  quizTitle: string;
  /** teamId -> display names currently connected. */
  presence: Map<TeamId, string[]>;
  /** teamId -> the shared answer draft. */
  drafts: Map<TeamId, TeamDraft>;
  /** media asset id -> its sealed copy. Empty when nothing has been sealed. */
  sealed: Map<string, SealedAsset>;
}

const EMPTY_DRAFT: TeamDraft = { text: '', updatedBy: null, typing: [] };

/**
 * Media a client may see NOW.
 *
 * Carries the sealed id and its key, so a client holding the ciphertext can
 * decrypt what it already has instead of fetching. The key rides along with the
 * plaintext URL and never ahead of it — this function is only ever called for
 * media that is already being disclosed.
 */
function toViewMedia(media: readonly Media[], ctx?: RoomContext): ViewMedia[] {
  return media.map((m) => {
    const sealed = ctx?.sealed.get(m.id);
    return {
      id: m.id,
      kind: m.kind,
      url: m.url,
      ...(sealed ? { preloadId: sealed.preloadId } : {}),
      ...(sealed?.key ? { key: sealed.key } : {}),
    };
  });
}

/**
 * Every asset in the current round, sealed.
 *
 * The whole round, including questions not yet asked, which is safe precisely
 * because it is ciphertext and the keys are not here. A client fetches these
 * once and holds them; the key for any one of them arrives only when its
 * question is presented.
 */
function preloadList(state: QuizState, ctx: RoomContext): SealedMedia[] {
  const round = currentRound(state);
  if (!round) return [];

  const seen = new Set<string>();
  const list: SealedMedia[] = [];
  for (const question of round.questions) {
    for (const media of [
      ...question.media,
      ...question.answerMedia,
      ...(question.revealSequence ?? []),
    ]) {
      const sealed = ctx.sealed.get(media.id);
      // No sealed copy means no preload for that asset — the client falls back
      // to fetching it when the question appears, which is what it did before
      // any of this existed.
      if (!sealed || seen.has(sealed.preloadId)) continue;
      seen.add(sealed.preloadId);
      list.push({
        id: sealed.preloadId,
        url: `/media/sealed/${sealed.preloadId}`,
        bytes: sealed.bytes,
      });
    }
  }
  return list;
}

function currentRound(state: QuizState): Round | null {
  return state.rounds[state.roundIdx] ?? null;
}

function activeQuestion(state: QuizState): Question | null {
  const round = currentRound(state);
  // Bound to a local so the discriminated union stays narrowed inside the
  // closure below — `state.active` re-widens on every property access.
  const active = state.active;
  if (!round || !active) return null;
  if (active.kind === 'WRITTEN') return round.questions[active.shownIdx] ?? null;
  return round.questions.find((q) => q.id === active.questionId) ?? null;
}

function roundHeader(state: QuizState): RoundHeader | null {
  const round = currentRound(state);
  if (!round) return null;
  return {
    id: round.id,
    title: round.title,
    type: round.type,
    direction: round.direction ?? null,
    index: state.roundIdx,
    total: state.rounds.length,
  };
}

/** The current phase, or IDLE between questions. */
function phaseOf(state: QuizState): TeamView['phase'] {
  return state.active ? state.active.phase : 'IDLE';
}

/**
 * A question is only public once the QM has presented it. Before that the room
 * has not seen it, so neither has the wire.
 */
function publicQuestion(state: QuizState, ctx: RoomContext): PublicQuestion | null {
  const round = currentRound(state);
  const question = activeQuestion(state);
  if (!round || !question || !state.active) return null;
  if (state.active.phase === 'IDLE') return null;

  const index = round.questions.findIndex((q) => q.id === question.id);
  return {
    id: question.id,
    index: index < 0 ? 0 : index,
    total: round.questions.length,
    text: question.text,
    // For a visual connect, only the stages revealed so far.
    media:
      state.active.kind === 'VISUAL_CONNECT'
        ? toViewMedia((question.revealSequence ?? []).slice(0, state.active.stageIdx + 1), ctx)
        : toViewMedia(question.media, ctx),
    partCount: question.parts.length,
  };
}

/**
 * Scores, in SEAT order.
 *
 * scoring.ts sorts by score descending, which is right for a post-quiz
 * breakdown and wrong for a scoreboard people read during a quiz: rows jump
 * around every time anyone scores, so you lose your own team mid-glance. Seat
 * order is stable and is already the order everyone thinks in, since it is the
 * bounce order too.
 *
 * FORMAT_SPEC §3 is happy either way — the system displays tiebreak signals and
 * the QM decides — but a self-reordering list also quietly implies a ranking
 * the format does not claim to compute.
 */
/**
 * The whole round's questions, for a written round.
 *
 * Written rounds show four questions and then collect all four answers at once,
 * so unlike a DIRECT round there is no single "current" question — teams need
 * them all in front of them once collection opens.
 */
function writtenQuestions(state: QuizState, ctx: RoomContext): PublicQuestion[] {
  const round = currentRound(state);
  if (!round) return [];
  return round.questions.map((q, i) => ({
    id: q.id,
    index: i,
    total: round.questions.length,
    text: q.text,
    media: toViewMedia(q.media, ctx),
    partCount: q.parts.length,
  }));
}

function buildTeamWritten(state: QuizState, teamId: TeamId, ctx: RoomContext): TeamWrittenView | null {
  const active = state.active;
  if (!active || active.kind !== 'WRITTEN') return null;
  return {
    phase: active.phase,
    shownIdx: active.shownIdx,
    // Before collection opens, only the question being shown is public.
    // Every question the QM has reached, so the answer boxes below can stay put
    // while the question above them changes.
    questions: writtenQuestions(state, ctx).filter(
      (q) => active.phase !== 'SHOWING' || q.index <= active.shownIdx,
    ),
    currentQuestion:
      writtenQuestions(state, ctx).find((q) => q.index === active.shownIdx) ?? null,
    collecting: active.phase === 'SHOWING' || active.phase === 'COLLECTING',
    // Own answers only. Another team's written answer is as private as a pounce.
    yourAnswers: active.answers
      .filter((a) => a.teamId === teamId)
      .map((a) => ({
        questionId: a.questionId,
        text: a.text,
        staked: a.staked,
        verdict: a.verdict ?? null,
      })),
  };
}

/**
 * A long visual connect, for everyone.
 *
 * The decay ladder is a rule, not a secret — the room is told it out loud
 * before the round starts — so teams get the whole thing. What a team must
 * decide, every reveal, is whether the connection is worth 20 to them yet, and
 * that decision is worse when the numbers are in someone's memory rather than
 * on the screen (FORMAT_SPEC §2.3).
 */
function buildConnect(state: QuizState): ConnectView | null {
  const active = state.active;
  if (!active || active.kind !== 'VISUAL_CONNECT') return null;
  const ladder = state.connectStages.map((s) => ({ correct: s.correct, wrong: s.wrong }));
  // Past the end of the ladder the question is dead, but the view still has to
  // render; fall back to the last rung rather than to undefined.
  const stage = ladder[active.stageIdx] ?? ladder[ladder.length - 1] ?? { correct: 0, wrong: 0 };
  return {
    stageIdx: active.stageIdx,
    stageCount: ladder.length,
    value: stage,
    ladder,
  };
}

function buildQmConnect(state: QuizState, ctx: RoomContext): QmConnectView | null {
  const base = buildConnect(state);
  const active = state.active;
  if (!base || !active || active.kind !== 'VISUAL_CONNECT') return null;

  const question = activeQuestion(state);
  const sequence = question?.revealSequence ?? [];

  return {
    ...base,
    // One row per STAGE, not per image: a connect dies when the stages run out,
    // so a question with three images and four stages has a hole in it, and the
    // console is where that should be visible rather than a blank fourth screen.
    reveals: Array.from({ length: base.stageCount }, (_, index) => {
      const media = sequence[index];
      return {
        index,
        media: media ? (toViewMedia([media], ctx)[0] ?? null) : null,
        shown: index <= active.stageIdx,
      };
    }),
    // Spent is per QUESTION, not per stage (§2.3) — which is exactly the thing
    // a QM loses track of three reveals in.
    spent: state.teams
      .filter((t) => active.spentTeams.includes(t.id))
      .map((t) => ({ teamId: t.id, name: t.name })),
    eligible: state.teams
      .filter((t) => !active.spentTeams.includes(t.id))
      .map((t) => ({ teamId: t.id, name: t.name })),
  };
}

function buildQmWritten(state: QuizState, ctx: RoomContext): QmWrittenView | null {
  const active = state.active;
  if (!active || active.kind !== 'WRITTEN') return null;
  const round = currentRound(state);
  const teamName = (id: TeamId) => state.teams.find((t) => t.id === id)?.name ?? 'Unknown';

  // A row per team per question, including blanks, so the grading grid has no
  // holes and a team that answered nothing is visibly a team that answered
  // nothing rather than a missing row.
  const answers: QmWrittenView['answers'] = [];
  for (const question of round?.questions ?? []) {
    for (const team of state.teams) {
      const given = active.answers.find(
        (a) => a.teamId === team.id && a.questionId === question.id,
      );
      answers.push({
        teamId: team.id,
        teamName: teamName(team.id),
        questionId: question.id,
        // Withheld while teams are still typing, exactly as pounces are.
        text: active.phase === 'COLLECTING' ? null : (given?.text ?? null),
        staked: given?.staked ?? false,
        verdict: given?.verdict ?? null,
      });
    }
  }

  return {
    phase: active.phase,
    shownIdx: active.shownIdx,
    questions: (round?.questions ?? []).map((q, i) => ({
      id: q.id,
      index: i,
      text: q.text,
      media: toViewMedia(q.media, ctx),
      answerText: q.answerText,
    })),
    answers,
  };
}

/**
 * The bounce circle, in order.
 *
 * Identical for the QM and for teams: the order is the seating order and who
 * pounced is public once the window closes, so there is nothing here to
 * withhold. Built once so the two views cannot drift apart.
 */
function bounceOrderFor(state: QuizState): TeamView['bounce']['order'] {
  const active = state.active;
  const round = currentRound(state);
  if (!active || active.kind !== 'DIRECT' || !round) return [];
  return bounceOrder(active.directTeamIdx, round.direction ?? 'CW', state.teams.length).map(
    (idx) => {
      const team = state.teams[idx];
      const spent =
        !state.rules.pouncersMayBounce &&
        Boolean(team) &&
        active.pounces.some((p) => p.teamId === team?.id);
      return {
        teamId: team?.id ?? '',
        name: team?.name ?? '',
        offered: team ? active.bounceOffered.includes(team.id) : false,
        current: idx === active.bounceTeamIdx,
        spent,
      };
    },
  );
}

function publicStandings(state: QuizState): PublicStanding[] {
  const seatOf = new Map(state.teams.map((t, i) => [t.id, i]));
  return standings(state)
    .slice()
    .sort((a, b) => (seatOf.get(a.teamId) ?? 0) - (seatOf.get(b.teamId) ?? 0))
    .map((s) => ({
    teamId: s.teamId,
    name: s.name,
    score: s.score,
    pouncesAttempted: s.pouncesAttempted,
    pouncesCorrect: s.pouncesCorrect,
    pouncesWrong: s.pouncesWrong,
    }));
}

/** Pounce text is readable only once the window is shut. */
function pouncesAreOpen(state: QuizState): boolean {
  const active = state.active;
  if (!active || active.kind === 'WRITTEN') return false;
  return active.phase === 'POUNCE_OPEN' || active.phase === 'POUNCE_FINAL_CALL';
}

// ─── Team view ──────────────────────────────────────────────────────────────

export function buildTeamView(
  state: QuizState,
  ctx: RoomContext,
  viewer: { teamId: TeamId; displayName: string },
): TeamView {
  const active = state.active;
  const team = state.teams.find((t) => t.id === viewer.teamId);

  const own =
    active && active.kind !== 'WRITTEN'
      ? active.pounces.find((p) => p.teamId === viewer.teamId)
      : undefined;

  const open = pouncesAreOpen(state);
  const bounceActive = active?.kind === 'DIRECT' && active.phase === 'BOUNCE';
  const onTeam =
    bounceActive && active.bounceTeamIdx !== null
      ? (state.teams[active.bounceTeamIdx] ?? null)
      : null;

  const revealed = active?.phase === 'REVEALED';
  const question = activeQuestion(state);

  /**
   * A connect pounce judged at an earlier reveal.
   *
   * FINISH_POUNCE_EVALUATION clears `pounces` when nobody was right, because
   * the next reveal starts a fresh window — so by the time the answer is read
   * out, the team that pounced at image one has nothing left in live state and
   * would be told nothing at all. The ledger still has it. Gated on `revealed`
   * exactly like every other verdict: before that, this is the withheld result.
   */
  const connectVerdict = (): 'CORRECT' | 'WRONG' | null => {
    if (!revealed || active?.kind !== 'VISUAL_CONNECT') return null;
    const event = state.ledger.find(
      (e) =>
        e.teamId === viewer.teamId &&
        e.questionId === active.questionId &&
        e.status !== 'VOIDED' &&
        (e.reason === 'CONNECT_CORRECT' || e.reason === 'CONNECT_WRONG'),
    );
    if (!event) return null;
    return event.reason === 'CONNECT_CORRECT' ? 'CORRECT' : 'WRONG';
  };

  return {
    role: 'TEAM',
    quizTitle: ctx.quizTitle,
    round: roundHeader(state),
    phase: phaseOf(state),
    question: publicQuestion(state, ctx),

    you: {
      teamId: viewer.teamId,
      teamName: team?.name ?? 'Unknown team',
      present: ctx.presence.get(viewer.teamId) ?? [],
      displayName: viewer.displayName,
      isDirectTeam:
        active?.kind === 'DIRECT'
          ? state.teams[active.directTeamIdx]?.id === viewer.teamId
          : false,
    },

    pounce: {
      open,
      finalCall: active?.kind !== 'WRITTEN' && active?.phase === 'POUNCE_FINAL_CALL',
      submitted: Boolean(own),
      // Their own words. Withholding these from the team that typed them would
      // be theatre, and the UI needs to show what was submitted.
      yourText: own?.text ?? null,
      /**
       * Held back until the reveal, along with the points.
       *
       * The QM judges pounces before the bounce runs, but in the room nobody is
       * told the outcome until the answer is read out. Showing a team "correct"
       * mid-bounce would be the same disclosure the withheld score prevents,
       * arriving by a different route.
       */
      yourVerdict: revealed ? (own?.verdict ?? connectVerdict()) : null,
      spent:
        active?.kind === 'VISUAL_CONNECT' ? active.spentTeams.includes(viewer.teamId) : false,
    },

    bounce: {
      active: bounceActive,
      onTeamName: onTeam?.name ?? null,
      onYou: onTeam?.id === viewer.teamId,
      order: bounceOrderFor(state),
    },

    draft: ctx.drafts.get(viewer.teamId) ?? EMPTY_DRAFT,

    // Who has turned up. Same list the QM sees, and for the same reason: it is
    // the answer to "are we waiting for someone?", which every screen in the
    // room asks. Nothing here is withheld from anyone.
    presence: state.teams.map((t) => ({
      teamId: t.id,
      teamName: t.name,
      members: ctx.presence.get(t.id) ?? [],
    })),

    // Public score only. A withheld partial is invisible here by construction:
    // publicScore() sums APPLIED events and nothing else.
    standings: publicStandings(state),

    // The answer exists on the wire only after the QM reveals it.
    reveal:
      revealed && question
        ? { text: question.answerText, media: toViewMedia(question.answerMedia, ctx) }
        : null,

    written: buildTeamWritten(state, viewer.teamId, ctx),

    connect: buildConnect(state),

    preload: preloadList(state, ctx),
  };
}

// ─── QM view ────────────────────────────────────────────────────────────────

export function buildQmView(state: QuizState, ctx: RoomContext): QmView {
  const active = state.active;
  const round = currentRound(state);
  const question = activeQuestion(state);
  const open = pouncesAreOpen(state);

  const teamName = (id: TeamId) => state.teams.find((t) => t.id === id)?.name ?? 'Unknown';

  const pounces: QmPounce[] =
    active && active.kind !== 'WRITTEN'
      ? active.pounces.map((p) => ({
          teamId: p.teamId,
          teamName: teamName(p.teamId),
          // Withheld from the QM too, while the window is open.
          text: open ? null : p.text,
          verdict: p.verdict ?? null,
        }))
      : [];

  // The part split, already resolved — the console shows "+5 / +5", not a sum
  // the QM has to do while talking.
  const answer: QmView['answer'] = question
    ? {
        text: question.answerText,
        media: toViewMedia(question.answerMedia, ctx),
        notes: null,
        parts: question.parts.map((part, index) => {
          const creditedTeam =
            active?.kind === 'DIRECT' ? active.partsCredited[part.id] : undefined;
          return {
            id: part.id,
            label: part.label,
            canonicalAnswer: part.canonicalAnswer,
            // The same integer split the reducer will score with, so the button
            // never promises a number the award cannot be.
            value: partValue(state.directScoring.questionValue, question.parts, index),
            creditedTo: creditedTeam ? teamName(creditedTeam) : null,
          };
        }),
      }
    : null;

  // The bounce order, always visible. Under wrap-around and direction changes a
  // QM loses track, and the screen should never let that happen (ARCHITECTURE §6).
  const order: QmView['bounce']['order'] = bounceOrderFor(state);

  const qmStandings: QmStanding[] = publicStandings(state).map((s) => {
    const provisional = provisionalScore(state.ledger, s.teamId);
    return {
      ...s,
      provisionalScore: provisional,
      // What is banked but not yet published. The QM's private arithmetic.
      withheldPoints: provisional - publicScore(state.ledger, s.teamId),
    };
  });

  const recent = state.ledger
    .slice(-12)
    .reverse()
    .map((e) => ({
      eventId: e.id,
      teamName: teamName(e.teamId),
      points: e.points,
      reason: e.reason,
      status: e.status,
      note: e.note ?? null,
    }));

  return {
    role: 'QM',
    quizTitle: ctx.quizTitle,
    round: roundHeader(state),
    phase: phaseOf(state),
    question: publicQuestion(state, ctx),
    answer,
    pounces,
    bounce: {
      active: active?.kind === 'DIRECT' && active.phase === 'BOUNCE',
      onTeamId:
        active?.kind === 'DIRECT' && active.bounceTeamIdx !== null
          ? (state.teams[active.bounceTeamIdx]?.id ?? null)
          : null,
      onTeamName:
        active?.kind === 'DIRECT' && active.bounceTeamIdx !== null
          ? (state.teams[active.bounceTeamIdx]?.name ?? null)
          : null,
      order,
    },
    presence: state.teams.map((t) => ({
      teamId: t.id,
      teamName: t.name,
      members: ctx.presence.get(t.id) ?? [],
    })),
    standings: qmStandings,
    recent,
    revealed: active?.phase === 'REVEALED',

    written: buildQmWritten(state, ctx),

    connect: buildQmConnect(state, ctx),

    // What to present next. Null while a question is still in play.
    nextQuestion:
      round && !active
        ? (() => {
            const question = round.questions[state.questionIdx];
            if (!question) return null;
            return {
              id: question.id,
              index: state.questionIdx,
              total: round.questions.length,
              // Enough to recognise it, not the whole thing.
              preview: question.text.slice(0, 120),
            };
          })()
        : null,

    questionIdx: state.questionIdx,

    rounds: state.rounds.map((r, i) => ({
      id: r.id,
      title: r.title,
      type: r.type,
      index: i,
      questionCount: r.questions.length,
    })),

    nextDirectTeamName: state.teams[state.nextDirectTeamIdx]?.name ?? null,

    withheldOnQuestion:
      active && active.kind !== 'WRITTEN'
        ? state.ledger
            .filter((e) => e.questionId === active.questionId && e.status === 'PENDING')
            .reduce((sum, e) => sum + e.points, 0)
        : 0,
  };
}

// ─── Scoreboard view ────────────────────────────────────────────────────────

export function buildScoreboardView(state: QuizState, ctx: RoomContext): ScoreboardView {
  const active = state.active;
  const bounceActive = active?.kind === 'DIRECT' && active.phase === 'BOUNCE';
  const revealed = active?.phase === 'REVEALED';
  const question = activeQuestion(state);

  return {
    role: 'SCOREBOARD',
    quizTitle: ctx.quizTitle,
    round: roundHeader(state),
    standings: publicStandings(state),

    phase: phaseOf(state),
    // Exactly the team projection: presented questions only, and for a connect
    // only the reveals already shown. Nothing here that a team does not have.
    question: publicQuestion(state, ctx),
    reveal:
      revealed && question
        ? { text: question.answerText, media: toViewMedia(question.answerMedia, ctx) }
        : null,
    bounce: {
      active: bounceActive,
      onTeamName:
        bounceActive && active.bounceTeamIdx !== null
          ? (state.teams[active.bounceTeamIdx]?.name ?? null)
          : null,
      order: bounceOrderFor(state),
    },
    connect: buildConnect(state),
    preload: preloadList(state, ctx),
  };
}
