/**
 * The quiz state machine.
 *
 * PURE. No I/O, no Date.now(), no randomness, no mutation of the input state.
 * Everything non-deterministic (ids, timestamps) is passed in via the action.
 *
 * This is the part of the system where a bug is visible to ten people at once and
 * unfixable in the moment. It is deliberately over-engineered and exhaustively tested.
 *
 * FORMAT_SPEC.md is normative. Each transition below cites the section it implements.
 */

import { type Action, IllegalTransition } from './actions.js';
import { bounceOrder, nextDirectTeam, step } from './rotation.js';
import type {
  ConnectQuestionState,
  DirectQuestionState,
  Question,
  QuizState,
  Round,
  ScoreEvent,
  TeamId,
  WrittenRoundState,
} from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertNever(x: never, message: string): never {
  throw new Error(`${message}: ${JSON.stringify(x)}`);
}

function currentRound(state: QuizState): Round {
  const round = state.rounds[state.roundIdx];
  if (!round) throw new Error(`No round at index ${state.roundIdx}`);
  return round;
}

function currentQuestion(state: QuizState): Question {
  const round = currentRound(state);
  const q = round.questions[state.questionIdx];
  if (!q) throw new Error(`No question at index ${state.questionIdx}`);
  return q;
}

function teamIdAt(state: QuizState, idx: number): TeamId {
  const team = state.teams[idx];
  if (!team) throw new Error(`No team at index ${idx}`);
  return team.id;
}

function teamIdxOf(state: QuizState, teamId: TeamId): number {
  const idx = state.teams.findIndex((t) => t.id === teamId);
  if (idx < 0) throw new Error(`Unknown team ${teamId}`);
  return idx;
}

function requireDirect(state: QuizState): DirectQuestionState {
  if (!state.active || state.active.kind !== 'DIRECT') {
    throw new Error('No active DIRECT question');
  }
  return state.active;
}

function requireConnect(state: QuizState): ConnectQuestionState {
  if (!state.active || state.active.kind !== 'VISUAL_CONNECT') {
    throw new Error('No active VISUAL_CONNECT question');
  }
  return state.active;
}

function requireWritten(state: QuizState): WrittenRoundState {
  if (!state.active || state.active.kind !== 'WRITTEN') {
    throw new Error('No active WRITTEN round');
  }
  return state.active;
}

function append(state: QuizState, event: ScoreEvent): ScoreEvent[] {
  return [...state.ledger, event];
}

/**
 * Publish every PENDING event for a question.
 *
 * FORMAT_SPEC §2.1: partial awards are recorded when earned but withheld from the
 * public scoreboard until the answer is revealed — otherwise later teams could infer
 * a confirmed part. This runs on REVEAL_ANSWER, including when the question died.
 */
function publishPending(ledger: ScoreEvent[], questionId: string): ScoreEvent[] {
  return ledger.map((e) =>
    e.questionId === questionId && e.status === 'PENDING'
      ? { ...e, status: 'APPLIED' as const }
      : e,
  );
}

// ─── DIRECT round transitions ───────────────────────────────────────────────

function reduceDirect(state: QuizState, action: Action): QuizState {
  const round = currentRound(state);
  const direction = round.direction ?? 'CW';
  const teamCount = state.teams.length;

  switch (action.type) {
    case 'PRESENT_QUESTION': {
      if (state.active !== null) {
        throw new IllegalTransition(action.type, 'question already active');
      }
      const active: DirectQuestionState = {
        kind: 'DIRECT',
        phase: 'PRESENTED',
        questionId: action.questionId,
        directTeamIdx: state.nextDirectTeamIdx,
        bounceTeamIdx: null,
        bounceOffered: [],
        pounces: [],
        partsCredited: {},
      };
      return { ...state, active };
    }

    case 'OPEN_POUNCE': {
      const active = requireDirect(state);
      if (active.phase !== 'PRESENTED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: { ...active, phase: 'POUNCE_OPEN' } };
    }

    case 'FINAL_CALL': {
      const active = requireDirect(state);
      if (active.phase !== 'POUNCE_OPEN') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Advisory only — teams may still submit. It is a UI signal, not a lock.
      return { ...state, active: { ...active, phase: 'POUNCE_FINAL_CALL' } };
    }

    case 'SUBMIT_POUNCE': {
      const active = requireDirect(state);
      if (active.phase !== 'POUNCE_OPEN' && active.phase !== 'POUNCE_FINAL_CALL') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // The direct team does not pounce — the question is already theirs (§2.1).
      if (teamIdxOf(state, action.teamId) === active.directTeamIdx) {
        throw new Error('The direct team cannot pounce on its own question');
      }
      // One pounce per team per question. Re-submission replaces the draft.
      const others = active.pounces.filter((p) => p.teamId !== action.teamId);
      return {
        ...state,
        active: {
          ...active,
          pounces: [...others, { teamId: action.teamId, text: action.text }],
        },
      };
    }

    case 'CLOSE_POUNCE': {
      const active = requireDirect(state);
      if (active.phase !== 'POUNCE_OPEN' && active.phase !== 'POUNCE_FINAL_CALL') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Only now may the QM read pounce contents (§2.1 written-blind).
      return { ...state, active: { ...active, phase: 'POUNCE_CLOSED' } };
    }

    case 'EVALUATE_POUNCE': {
      const active = requireDirect(state);
      if (active.phase !== 'POUNCE_CLOSED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const pounce = active.pounces.find((p) => p.teamId === action.teamId);
      if (!pounce) throw new Error(`No pounce from team ${action.teamId}`);

      const correct = action.verdict === 'CORRECT';
      const event: ScoreEvent = {
        id: action.eventId,
        teamId: action.teamId,
        roundId: round.id,
        questionId: active.questionId,
        points: correct
          ? state.directScoring.pounceCorrect
          : state.directScoring.pounceWrong,
        reason: correct ? 'POUNCE_CORRECT' : 'POUNCE_WRONG',
        // Pounce results are published immediately — only partials are withheld.
        status: 'APPLIED',
      };

      return {
        ...state,
        ledger: append(state, event),
        active: {
          ...active,
          pounces: active.pounces.map((p) =>
            p.teamId === action.teamId ? { ...p, verdict: action.verdict } : p,
          ),
        },
      };
    }

    case 'FINISH_POUNCE_EVALUATION': {
      const active = requireDirect(state);
      if (active.phase !== 'POUNCE_CLOSED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const anyCorrect = active.pounces.some((p) => p.verdict === 'CORRECT');
      // A correct pounce resolves the question outright — bounce never opens (§2.1).
      return {
        ...state,
        active: { ...active, phase: anyCorrect ? 'RESOLVED' : 'POUNCE_EVALUATED' },
      };
    }

    case 'OPEN_BOUNCE': {
      const active = requireDirect(state);
      if (active.phase !== 'PRESENTED' && active.phase !== 'POUNCE_EVALUATED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Bounce always begins at the direct team (§2.1), regardless of pounces.
      return {
        ...state,
        active: {
          ...active,
          phase: 'BOUNCE',
          bounceTeamIdx: active.directTeamIdx,
          bounceOffered: [teamIdAt(state, active.directTeamIdx)],
        },
      };
    }

    case 'BOUNCE_CORRECT': {
      const active = requireDirect(state);
      if (active.phase !== 'BOUNCE' || active.bounceTeamIdx === null) {
        throw new IllegalTransition(action.type, active.phase);
      }
      const teamId = teamIdAt(state, active.bounceTeamIdx);
      const event: ScoreEvent = {
        id: action.eventId,
        teamId,
        roundId: round.id,
        questionId: active.questionId,
        points: state.directScoring.bounceCorrect,
        reason: 'BOUNCE_CORRECT',
        status: 'APPLIED',
      };
      return {
        ...state,
        ledger: append(state, event),
        active: { ...active, phase: 'RESOLVED' },
      };
    }

    case 'BOUNCE_PARTIAL': {
      const active = requireDirect(state);
      if (active.phase !== 'BOUNCE' || active.bounceTeamIdx === null) {
        throw new IllegalTransition(action.type, active.phase);
      }
      const question = currentQuestion(state);
      const teamId = teamIdAt(state, active.bounceTeamIdx);

      const defaultPer =
        state.directScoring.questionValue / Math.max(question.parts.length, 1);
      const points =
        action.points ??
        action.partIds.reduce((sum, pid) => {
          const part = question.parts.find((p) => p.id === pid);
          return sum + (part?.partialValue ?? defaultPer);
        }, 0);

      const event: ScoreEvent = {
        id: action.eventId,
        teamId,
        roundId: round.id,
        questionId: active.questionId,
        points,
        reason: 'PARTIAL',
        // WITHHELD until reveal (§2.1) — this is the whole reason the ledger exists.
        status: 'PENDING',
      };

      const partsCredited = { ...active.partsCredited };
      for (const pid of action.partIds) partsCredited[pid] = teamId;

      // Bounce CONTINUES after a partial — no reveal, next team (§2.1).
      const nextIdx = step(active.bounceTeamIdx, direction, teamCount);
      const exhausted = active.bounceOffered.length >= teamCount;

      return {
        ...state,
        ledger: append(state, event),
        active: {
          ...active,
          partsCredited,
          phase: exhausted ? 'DEAD' : 'BOUNCE',
          bounceTeamIdx: exhausted ? active.bounceTeamIdx : nextIdx,
          bounceOffered: exhausted
            ? active.bounceOffered
            : [...active.bounceOffered, teamIdAt(state, nextIdx)],
        },
      };
    }

    case 'BOUNCE_WRONG': {
      const active = requireDirect(state);
      if (active.phase !== 'BOUNCE' || active.bounceTeamIdx === null) {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Infinite bounce: continue until someone is correct or every team has had it.
      if (active.bounceOffered.length >= teamCount) {
        return { ...state, active: { ...active, phase: 'DEAD' } };
      }
      const nextIdx = step(active.bounceTeamIdx, direction, teamCount);
      return {
        ...state,
        active: {
          ...active,
          bounceTeamIdx: nextIdx,
          bounceOffered: [...active.bounceOffered, teamIdAt(state, nextIdx)],
        },
      };
    }

    case 'REVEAL_ANSWER': {
      const active = requireDirect(state);
      if (active.phase !== 'RESOLVED' && active.phase !== 'DEAD') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return {
        ...state,
        ledger: publishPending(state.ledger, active.questionId),
        active: { ...active, phase: 'REVEALED' },
      };
    }

    case 'NEXT_QUESTION': {
      const active = requireDirect(state);
      if (active.phase !== 'REVEALED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Only a BOUNCE resolution shifts the rotation anchor (§2.1).
      const resolvedOnBounce = state.ledger.some(
        (e) =>
          e.questionId === active.questionId &&
          e.reason === 'BOUNCE_CORRECT' &&
          e.status === 'APPLIED',
      );
      const bounceResolverIdx =
        resolvedOnBounce && active.bounceTeamIdx !== null ? active.bounceTeamIdx : null;

      return {
        ...state,
        active: null,
        questionIdx: state.questionIdx + 1,
        nextDirectTeamIdx: nextDirectTeam({
          previousDirectIdx: active.directTeamIdx,
          bounceResolverIdx,
          direction,
          teamCount,
        }),
      };
    }

    default:
      throw new IllegalTransition(action.type, 'DIRECT round');
  }
}

// ─── VISUAL_CONNECT transitions ─────────────────────────────────────────────

function reduceConnect(state: QuizState, action: Action): QuizState {
  const round = currentRound(state);

  switch (action.type) {
    case 'PRESENT_QUESTION': {
      if (state.active !== null) {
        throw new IllegalTransition(action.type, 'question already active');
      }
      const active: ConnectQuestionState = {
        kind: 'VISUAL_CONNECT',
        phase: 'REVEAL_SHOWN',
        questionId: action.questionId,
        stageIdx: 0,
        pounces: [],
        spentTeams: [],
      };
      return { ...state, active };
    }

    case 'OPEN_POUNCE': {
      const active = requireConnect(state);
      if (active.phase !== 'REVEAL_SHOWN') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: { ...active, phase: 'POUNCE_OPEN' } };
    }

    case 'SUBMIT_POUNCE': {
      const active = requireConnect(state);
      if (active.phase !== 'POUNCE_OPEN') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // One pounce per team per QUESTION, not per stage (§2.3).
      if (active.spentTeams.includes(action.teamId)) {
        throw new Error(`Team ${action.teamId} has already pounced on this connect`);
      }
      const others = active.pounces.filter((p) => p.teamId !== action.teamId);
      return {
        ...state,
        active: {
          ...active,
          pounces: [...others, { teamId: action.teamId, text: action.text }],
        },
      };
    }

    case 'CLOSE_POUNCE': {
      const active = requireConnect(state);
      if (active.phase !== 'POUNCE_OPEN') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: { ...active, phase: 'POUNCE_CLOSED' } };
    }

    case 'EVALUATE_POUNCE': {
      const active = requireConnect(state);
      if (active.phase !== 'POUNCE_CLOSED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const stage = state.connectStages[active.stageIdx];
      if (!stage) throw new Error(`No stage config at index ${active.stageIdx}`);

      const correct = action.verdict === 'CORRECT';
      const event: ScoreEvent = {
        id: action.eventId,
        teamId: action.teamId,
        roundId: round.id,
        questionId: active.questionId,
        points: correct ? stage.correct : stage.wrong,
        reason: correct ? 'CONNECT_CORRECT' : 'CONNECT_WRONG',
        status: 'APPLIED',
      };

      return {
        ...state,
        ledger: append(state, event),
        active: {
          ...active,
          pounces: active.pounces.map((p) =>
            p.teamId === action.teamId ? { ...p, verdict: action.verdict } : p,
          ),
          // Spent for the rest of the question, right or wrong (§2.3).
          spentTeams: [...active.spentTeams, action.teamId],
        },
      };
    }

    case 'FINISH_POUNCE_EVALUATION': {
      const active = requireConnect(state);
      if (active.phase !== 'POUNCE_CLOSED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const anyCorrect = active.pounces.some((p) => p.verdict === 'CORRECT');
      return {
        ...state,
        active: {
          ...active,
          phase: anyCorrect ? 'RESOLVED' : 'POUNCE_EVALUATED',
          pounces: anyCorrect ? active.pounces : [],
        },
      };
    }

    case 'ADVANCE_REVEAL': {
      const active = requireConnect(state);
      if (active.phase !== 'POUNCE_EVALUATED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const nextStage = active.stageIdx + 1;
      // Out of reveals with no correct answer: the question dies (§5.4 default).
      if (nextStage >= state.connectStages.length) {
        return { ...state, active: { ...active, phase: 'DEAD' } };
      }
      return {
        ...state,
        active: {
          ...active,
          phase: 'REVEAL_SHOWN',
          stageIdx: nextStage,
          pounces: [],
        },
      };
    }

    case 'REVEAL_ANSWER': {
      const active = requireConnect(state);
      if (active.phase !== 'RESOLVED' && active.phase !== 'DEAD') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return {
        ...state,
        ledger: publishPending(state.ledger, active.questionId),
        active: { ...active, phase: 'REVEALED' },
      };
    }

    case 'NEXT_QUESTION': {
      const active = requireConnect(state);
      if (active.phase !== 'REVEALED') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: null, questionIdx: state.questionIdx + 1 };
    }

    default:
      throw new IllegalTransition(action.type, 'VISUAL_CONNECT round');
  }
}

// ─── WRITTEN transitions ────────────────────────────────────────────────────

function reduceWritten(state: QuizState, action: Action): QuizState {
  const round = currentRound(state);

  switch (action.type) {
    case 'SHOW_WRITTEN_QUESTION': {
      const active: WrittenRoundState = state.active?.kind === 'WRITTEN'
        ? state.active
        : { kind: 'WRITTEN', phase: 'SHOWING', shownIdx: 0, answers: [] };
      if (active.phase !== 'SHOWING' && active.phase !== 'IDLE') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return {
        ...state,
        active: { ...active, phase: 'SHOWING', shownIdx: action.index },
      };
    }

    case 'OPEN_COLLECTION': {
      const active = requireWritten(state);
      if (active.phase !== 'SHOWING') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: { ...active, phase: 'COLLECTING' } };
    }

    case 'SUBMIT_WRITTEN': {
      const active = requireWritten(state);
      if (active.phase !== 'COLLECTING') {
        throw new IllegalTransition(action.type, active.phase);
      }
      if (!state.rules.multipleStakesAllowed && action.staked) {
        const already = active.answers.some(
          (a) => a.teamId === action.teamId && a.staked && a.questionId !== action.questionId,
        );
        if (already) throw new Error('Only one stake permitted per team per round');
      }
      const others = active.answers.filter(
        (a) => !(a.teamId === action.teamId && a.questionId === action.questionId),
      );
      return {
        ...state,
        active: {
          ...active,
          answers: [
            ...others,
            {
              teamId: action.teamId,
              questionId: action.questionId,
              text: action.text,
              staked: action.staked,
            },
          ],
        },
      };
    }

    case 'CLOSE_COLLECTION': {
      const active = requireWritten(state);
      if (active.phase !== 'COLLECTING') {
        throw new IllegalTransition(action.type, active.phase);
      }
      // Stakes lock here.
      return { ...state, active: { ...active, phase: 'EVALUATING' } };
    }

    case 'EVALUATE_WRITTEN': {
      const active = requireWritten(state);
      if (active.phase !== 'EVALUATING') {
        throw new IllegalTransition(action.type, active.phase);
      }
      const answer = active.answers.find(
        (a) => a.teamId === action.teamId && a.questionId === action.questionId,
      );
      if (!answer) throw new Error('No such written answer');

      const correct = action.verdict === 'CORRECT';
      const s = state.writtenScoring;
      const points = answer.staked
        ? correct
          ? s.stakeCorrect
          : s.stakeWrong
        : correct
          ? s.correct
          : s.wrong;

      const event: ScoreEvent = {
        id: action.eventId,
        teamId: action.teamId,
        roundId: round.id,
        questionId: action.questionId,
        points,
        reason: answer.staked
          ? correct
            ? 'STAKE_CORRECT'
            : 'STAKE_WRONG'
          : 'WRITTEN_CORRECT',
        status: 'APPLIED',
      };

      return {
        ...state,
        ledger: append(state, event),
        active: {
          ...active,
          answers: active.answers.map((a) =>
            a.teamId === action.teamId && a.questionId === action.questionId
              ? { ...a, verdict: action.verdict }
              : a,
          ),
        },
      };
    }

    case 'FINISH_WRITTEN_EVALUATION': {
      const active = requireWritten(state);
      if (active.phase !== 'EVALUATING') {
        throw new IllegalTransition(action.type, active.phase);
      }
      return { ...state, active: { ...active, phase: 'REVEALED' } };
    }

    default:
      throw new IllegalTransition(action.type, 'WRITTEN round');
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export function reduce(state: QuizState, action: Action): QuizState {
  // Cross-cutting actions, legal in any phase.
  switch (action.type) {
    case 'MANUAL_ADJUST': {
      const round = currentRound(state);
      const event: ScoreEvent = {
        id: action.eventId,
        teamId: action.teamId,
        roundId: round.id,
        questionId: state.active?.kind === 'WRITTEN' ? '' : (state.active?.questionId ?? ''),
        points: action.points,
        reason: 'MANUAL_ADJUST',
        status: 'APPLIED',
        note: action.note,
      };
      return { ...state, ledger: append(state, event) };
    }

    case 'VOID_EVENT': {
      // Undo. Never delete — the audit trail is the point.
      return {
        ...state,
        ledger: state.ledger.map((e) =>
          e.id === action.eventId ? { ...e, status: 'VOIDED' as const } : e,
        ),
      };
    }

    case 'START_ROUND': {
      if (state.active !== null) {
        throw new IllegalTransition(action.type, 'a question is still active');
      }
      return { ...state, roundIdx: action.roundIdx, questionIdx: 0, active: null };
    }

    default:
      break;
  }

  const round = currentRound(state);
  switch (round.type) {
    case 'DIRECT':
      return reduceDirect(state, action);
    case 'VISUAL_CONNECT':
      return reduceConnect(state, action);
    case 'WRITTEN':
      return reduceWritten(state, action);
    default:
      return assertNever(round.type, 'Unhandled round type');
  }
}
