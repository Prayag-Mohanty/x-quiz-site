import type {
  Question,
  QuizState,
  Round,
  Team,
} from '../src/types.js';
import {
  DEFAULT_CONNECT_STAGES,
  DEFAULT_DIRECT_SCORING,
  DEFAULT_RULES,
  DEFAULT_WRITTEN_SCORING,
} from '../src/types.js';

export function makeTeams(n: number): Team[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i + 1}`,
    name: `Team ${i + 1}`,
    members: [],
  }));
}

export function simpleQuestion(id: string): Question {
  return {
    id,
    text: `Question ${id}`,
    media: [],
    parts: [{ id: `${id}p1`, label: 'Answer', canonicalAnswer: 'x' }],
    answerText: 'x',
    answerMedia: [],
  };
}

export function twoPartQuestion(id: string): Question {
  return {
    id,
    text: `Two-part question ${id}`,
    media: [],
    parts: [
      { id: `${id}pA`, label: 'Part A', canonicalAnswer: 'a' },
      { id: `${id}pB`, label: 'Part B', canonicalAnswer: 'b' },
    ],
    answerText: 'a and b',
    answerMedia: [],
  };
}

export function makeState(opts: {
  teams?: number;
  rounds?: Round[];
  nextDirectTeamIdx?: number;
}): QuizState {
  const teams = makeTeams(opts.teams ?? 8);
  const rounds: Round[] = opts.rounds ?? [
    {
      id: 'r1',
      type: 'DIRECT',
      title: 'Round 1',
      direction: 'CW',
      questions: [simpleQuestion('q1'), simpleQuestion('q2'), twoPartQuestion('q3')],
    },
  ];
  return {
    teams,
    rounds,
    roundIdx: 0,
    questionIdx: 0,
    active: null,
    ledger: [],
    rules: { ...DEFAULT_RULES },
    directScoring: { ...DEFAULT_DIRECT_SCORING },
    writtenScoring: { ...DEFAULT_WRITTEN_SCORING },
    connectStages: DEFAULT_CONNECT_STAGES,
    nextDirectTeamIdx: opts.nextDirectTeamIdx ?? 0,
  };
}

let counter = 0;
/** Deterministic ids — the reducer is pure, so ids come from outside. */
export function eid(): string {
  return `e${++counter}`;
}
