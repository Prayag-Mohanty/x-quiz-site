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
 * Written and visual-connect rounds get a truthful but minimal view here; their
 * dedicated UIs are Phase 4. A DIRECT round is the one Phase 1 must run well.
 */

import {
  bounceOrder,
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
  PublicQuestion,
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

/** Ephemeral per-room state that is not quiz state and never touches the reducer. */
export interface RoomContext {
  quizTitle: string;
  /** teamId -> display names currently connected. */
  presence: Map<TeamId, string[]>;
  /** teamId -> the shared answer draft. */
  drafts: Map<TeamId, TeamDraft>;
}

const EMPTY_DRAFT: TeamDraft = { text: '', updatedBy: null, typing: [] };

function toViewMedia(media: readonly Media[]): ViewMedia[] {
  return media.map((m) => ({ id: m.id, kind: m.kind, url: m.url }));
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
function publicQuestion(state: QuizState): PublicQuestion | null {
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
        ? toViewMedia((question.revealSequence ?? []).slice(0, state.active.stageIdx + 1))
        : toViewMedia(question.media),
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
function writtenQuestions(state: QuizState): PublicQuestion[] {
  const round = currentRound(state);
  if (!round) return [];
  return round.questions.map((q, i) => ({
    id: q.id,
    index: i,
    total: round.questions.length,
    text: q.text,
    media: toViewMedia(q.media),
    partCount: q.parts.length,
  }));
}

function buildTeamWritten(state: QuizState, teamId: TeamId): TeamWrittenView | null {
  const active = state.active;
  if (!active || active.kind !== 'WRITTEN') return null;
  return {
    phase: active.phase,
    shownIdx: active.shownIdx,
    // Before collection opens, only the question being shown is public.
    questions:
      active.phase === 'SHOWING'
        ? writtenQuestions(state).filter((q) => q.index === active.shownIdx)
        : writtenQuestions(state),
    collecting: active.phase === 'COLLECTING',
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

function buildQmWritten(state: QuizState): QmWrittenView | null {
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
      media: toViewMedia(q.media),
      answerText: q.answerText,
    })),
    answers,
  };
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

  return {
    role: 'TEAM',
    quizTitle: ctx.quizTitle,
    round: roundHeader(state),
    phase: phaseOf(state),
    question: publicQuestion(state),

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
      yourVerdict: revealed ? (own?.verdict ?? null) : null,
      spent:
        active?.kind === 'VISUAL_CONNECT' ? active.spentTeams.includes(viewer.teamId) : false,
    },

    bounce: {
      active: bounceActive,
      onTeamName: onTeam?.name ?? null,
      onYou: onTeam?.id === viewer.teamId,
    },

    draft: ctx.drafts.get(viewer.teamId) ?? EMPTY_DRAFT,

    // Public score only. A withheld partial is invisible here by construction:
    // publicScore() sums APPLIED events and nothing else.
    standings: publicStandings(state),

    // The answer exists on the wire only after the QM reveals it.
    reveal:
      revealed && question
        ? { text: question.answerText, media: toViewMedia(question.answerMedia) }
        : null,

    written: buildTeamWritten(state, viewer.teamId),
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
        media: toViewMedia(question.answerMedia),
        notes: null,
        parts: question.parts.map((part) => {
          const evenSplit =
            state.directScoring.questionValue / Math.max(question.parts.length, 1);
          const creditedTeam =
            active?.kind === 'DIRECT' ? active.partsCredited[part.id] : undefined;
          return {
            id: part.id,
            label: part.label,
            canonicalAnswer: part.canonicalAnswer,
            value: part.partialValue ?? evenSplit,
            creditedTo: creditedTeam ? teamName(creditedTeam) : null,
          };
        }),
      }
    : null;

  // The bounce order, always visible. Under wrap-around and direction changes a
  // QM loses track, and the screen should never let that happen (ARCHITECTURE §6).
  const order: QmView['bounce']['order'] =
    active?.kind === 'DIRECT' && round
      ? bounceOrder(active.directTeamIdx, round.direction ?? 'CW', state.teams.length).map(
          (idx) => {
            const team = state.teams[idx];
            const pounced =
              !state.rules.pouncersMayBounce &&
              Boolean(team) &&
              active.pounces.some((p) => p.teamId === team?.id);
            return {
              teamId: team?.id ?? '',
              name: team?.name ?? '',
              offered: team ? active.bounceOffered.includes(team.id) : false,
              current: idx === active.bounceTeamIdx,
              spent: pounced,
            };
          },
        )
      : [];

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
    question: publicQuestion(state),
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

    written: buildQmWritten(state),

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
  };
}

// ─── Scoreboard view ────────────────────────────────────────────────────────

export function buildScoreboardView(state: QuizState, ctx: RoomContext): ScoreboardView {
  return {
    role: 'SCOREBOARD',
    quizTitle: ctx.quizTitle,
    round: roundHeader(state),
    standings: publicStandings(state),
  };
}
