/**
 * The wire protocol.
 *
 * Types only — no runtime code, so both sides can depend on it freely.
 *
 * ─── The rule this file exists to enforce ───────────────────────────────────
 *
 * A team client is NEVER sent the full QuizState. Not a filtered copy at render
 * time — it never crosses the wire. Anyone can open dev tools and read whatever
 * their browser received, so anything a team must not know must not be sent:
 *
 *   - the answer, before the reveal
 *   - other teams' pounce text, ever (pounces are written-blind, FORMAT_SPEC §2.1)
 *   - their OWN pounce text is fine — they wrote it
 *   - withheld partial awards (PENDING), which is the whole point of the
 *     PENDING status: a visible score bump would tell later teams that a part
 *     had been confirmed (§2.1)
 *   - QM notes, canonical answers, accepted variants
 *
 * TeamView below contains none of those. That is not a convention to remember;
 * it is the shape of the type, and the server cannot send a team anything else.
 *
 * DECISIONS.md: client → server messages mirror the engine's Action type rather
 * than inventing a second vocabulary for the network.
 */

import type { Action, ConnectPhase, DirectPhase, WrittenPhase } from '@quizmaster/engine';

export type Role = 'QM' | 'TEAM' | 'SCOREBOARD';

export type Phase = DirectPhase | ConnectPhase | WrittenPhase;

/** What every client may know about a team's score. APPLIED events only. */
export interface PublicStanding {
  teamId: string;
  name: string;
  /** SUM(points) WHERE status = 'APPLIED'. Withheld partials are absent. */
  score: number;
  pouncesAttempted: number;
  pouncesCorrect: number;
  pouncesWrong: number;
}

/** Media a client may preload and play. */
export interface ViewMedia {
  id: string;
  kind: 'IMAGE' | 'AUDIO' | 'VIDEO';
  url: string;
}

export interface RoundHeader {
  id: string;
  title: string;
  type: 'DIRECT' | 'WRITTEN' | 'VISUAL_CONNECT';
  direction: 'CW' | 'ACW' | null;
  index: number;
  total: number;
}

/** The question as teams may see it: the prompt, never the answer. */
export interface PublicQuestion {
  id: string;
  index: number;
  total: number;
  text: string;
  media: ViewMedia[];
  /** How many parts, so a team knows it is a multi-part question. Not what they are. */
  partCount: number;
}

/**
 * The shared team draft.
 *
 * Deliberately NOT engine state. It is coordination between three people, not a
 * quiz transition, so it lives in the room and never touches the reducer —
 * which stays pure and replayable. Last-write-wins with author attribution.
 */
export interface TeamDraft {
  text: string;
  updatedBy: string | null;
  /** Display names of people who have typed in the last few seconds. */
  typing: string[];
}

// ─── Long visual connect ────────────────────────────────────────────────────

/**
 * Where a long visual connect is, and what a pounce is worth right now.
 *
 * FORMAT_SPEC §2.3: one connection revealed through a series of images, and the
 * value decays with each reveal — +20/−15, then +15/−10, then +10/−5, then
 * +5/0. Teams need this in front of them, because the whole round is the
 * decision "is it worth 20 to me yet?", and a team doing that arithmetic from
 * memory is a team getting it wrong.
 *
 * Public in full: the decay ladder is a rule, not a secret.
 */
export interface ConnectView {
  /** 0-based index of the reveal being shown. */
  stageIdx: number;
  /** How many reveals this connect runs to before it dies (§5.4). */
  stageCount: number;
  /** What a pounce is worth at THIS reveal. */
  value: { correct: number; wrong: number };
  /** Every stage's value, so a team can see what waiting costs. */
  ladder: { correct: number; wrong: number }[];
}

export interface QmConnectView extends ConnectView {
  /**
   * The reveal images in order.
   *
   * `media` is null when the question has fewer images than there are stages —
   * an authoring gap the QM should see on the console rather than discover by
   * advancing into a blank screen.
   */
  reveals: { index: number; media: ViewMedia | null; shown: boolean }[];
  /** Teams out for the rest of this connect, having already pounced (§2.3). */
  spent: { teamId: string; name: string }[];
  /** Teams that may still pounce. */
  eligible: { teamId: string; name: string }[];
}

// ─── Team view ──────────────────────────────────────────────────────────────

export interface TeamView {
  role: 'TEAM';
  quizTitle: string;
  round: RoundHeader | null;
  phase: Phase | 'IDLE';
  question: PublicQuestion | null;

  you: {
    teamId: string;
    teamName: string;
    /** Everyone currently connected on this team identity. */
    present: string[];
    displayName: string;
    /**
     * Whether this question was posed to this team.
     *
     * FORMAT_SPEC §2.1: the direct team does not pounce, because the question is
     * already theirs. Without this the client shows them a pounce box that the
     * engine will refuse, which reads as a broken app rather than a rule.
     */
    isDirectTeam: boolean;
  };

  pounce: {
    open: boolean;
    finalCall: boolean;
    /** Whether THIS team has pounced. Never who else has, while open. */
    submitted: boolean;
    /** This team's own pounce text. Their own words are not a secret from them. */
    yourText: string | null;
    /** Set once the QM has judged it, not before. */
    yourVerdict: 'CORRECT' | 'WRONG' | null;
    /** Spent for the rest of this connect (§2.3), so the UI can say why. */
    spent: boolean;
  };

  bounce: {
    active: boolean;
    /** Whose turn it is. Public — everyone in the room can hear it anyway. */
    onTeamName: string | null;
    /** True when it is this team's turn to answer. */
    onYou: boolean;
    /**
     * The whole circle, same as the QM sees.
     *
     * Public by nature: the order is the seating order, and who has pounced is
     * announced the moment the window closes. Teams need it to know when their
     * turn is coming — which is the difference between being ready and being
     * caught out.
     */
    order: { teamId: string; name: string; offered: boolean; current: boolean; spent: boolean }[];
  };

  draft: TeamDraft;

  /**
   * Who is connected, across every team.
   *
   * Not a secret: everyone is on the same video call and can see who turned up.
   * Teams need it for the reason the QM does — a quiz that is waiting on a team
   * that has not joined should say so on every screen, not just the console.
   */
  presence: { teamId: string; teamName: string; members: string[] }[];

  /** Public scores. Teams see these live — DECISIONS.md open question 6. */
  standings: PublicStanding[];

  /** Populated only once the QM has revealed. Null at every other moment. */
  reveal: { text: string; media: ViewMedia[] } | null;

  /** Present only during a WRITTEN round (FORMAT_SPEC §2.2). */
  written: TeamWrittenView | null;

  /** Present only during a VISUAL_CONNECT round (FORMAT_SPEC §2.3). */
  connect: ConnectView | null;
}

/**
 * A written round, from a team's side.
 *
 * Questions are shown one at a time and the team writes on ONE answer sheet —
 * a single box, the way a paper written round works. The sheet is submitted
 * against every question the QM has reached, so the QM can still grade question
 * by question (FORMAT_SPEC §2.2) while the team only ever sees one box.
 *
 * Staking is therefore the one thing that stays per question: it is declared at
 * submission and locks when the round closes, +15/−5 instead of +10/0.
 */
export interface TeamWrittenView {
  phase: WrittenPhase;
  /** Which question the QM is currently showing, during SHOWING. */
  shownIdx: number;
  /** Every question in the round; teams see them all once collection opens. */
  questions: PublicQuestion[];
  /**
   * True while answers may still be changed.
   *
   * Open from the moment the round starts, not only once every question has
   * been read: a team that has the first answer should be able to write it
   * down while the second is being read out.
   */
  collecting: boolean;
  /** The question the QM is reading out right now, if any. */
  currentQuestion: PublicQuestion | null;
  /** This team's own answers. Never another team's. */
  yourAnswers: {
    questionId: string;
    text: string;
    staked: boolean;
    /** Set only after the QM has graded, which is after the round closes. */
    verdict: 'CORRECT' | 'WRONG' | null;
  }[];
}

// ─── QM view ────────────────────────────────────────────────────────────────

export interface QmPounce {
  teamId: string;
  teamName: string;
  /**
   * Null while the window is open. The QM sees WHO has pounced but not WHAT
   * until they close it — FORMAT_SPEC §2.1 binds the QM too, so that the
   * decision to close is not influenced by what has come in.
   */
  text: string | null;
  verdict: 'CORRECT' | 'WRONG' | null;
}

export interface QmStanding extends PublicStanding {
  /** Includes PENDING. What the QM knows and the teams do not. */
  provisionalScore: number;
  withheldPoints: number;
}

export interface QmView {
  role: 'QM';
  quizTitle: string;
  round: RoundHeader | null;
  phase: Phase | 'IDLE';
  question: PublicQuestion | null;

  /** The QM's crib sheet: answer, notes, and the part split for partial credit. */
  answer: {
    text: string;
    media: ViewMedia[];
    notes: string | null;
    parts: {
      id: string;
      label: string;
      canonicalAnswer: string;
      /** Points this part alone is worth, already resolved from the even split. */
      value: number;
      /** Which team has already been credited with it, if any. */
      creditedTo: string | null;
    }[];
  } | null;

  pounces: QmPounce[];

  bounce: {
    active: boolean;
    onTeamId: string | null;
    onTeamName: string | null;
    /**
     * The whole circle in order, so the QM never loses track under wrap-around.
     *
     * `spent` means the team pounced and is therefore out of this bounce (§2.1).
     * Without it the panel lists teams that will be silently skipped, which is
     * the exact confusion it exists to prevent.
     */
    order: {
      teamId: string;
      name: string;
      offered: boolean;
      current: boolean;
      spent: boolean;
    }[];
  };

  /** Who is connected, so the QM knows a team has actually arrived. */
  presence: { teamId: string; teamName: string; members: string[] }[];

  standings: QmStanding[];

  /** Recent ledger entries, newest first — undo targets. */
  recent: {
    eventId: string;
    teamName: string;
    points: number;
    reason: string;
    status: 'PENDING' | 'APPLIED' | 'VOIDED';
    note: string | null;
  }[];

  revealed: boolean;

  /** Present only during a WRITTEN round (FORMAT_SPEC §2.2). */
  written: QmWrittenView | null;

  /** Present only during a VISUAL_CONNECT round (FORMAT_SPEC §2.3). */
  connect: QmConnectView | null;

  /**
   * The question PRESENT_QUESTION should be called with next.
   *
   * The engine tracks a question index and PRESENT_QUESTION takes an id, so
   * without this the console would have to keep its own copy of the running
   * order — a second source of truth for which question is next, which is
   * exactly the bookkeeping this product exists to remove.
   */
  nextQuestion: { id: string; index: number; total: number; preview: string } | null;

  /**
   * Where the quiz actually is, even past the end of a round.
   *
   * Deriving this from nextQuestion is wrong once the round is finished:
   * nextQuestion is null there, and a navigation control that falls back to 0
   * tells the QM they are on question 1 of 3 while the screen says there are
   * none left.
   */
  questionIdx: number;

  /** Every round, so the QM can jump between them between questions. */
  rounds: { id: string; title: string; type: string; index: number; questionCount: number }[];

  /** Which team the next direct question goes to, under the current rotation. */
  nextDirectTeamName: string | null;

  /**
   * Points recorded against the question in play and not yet published.
   *
   * Navigating away is legal mid-question and does not touch the ledger, so a
   * withheld award on the question being left never gets published — it just
   * sits there, and turns up in the post-quiz breakdown as points recorded and
   * never revealed. The console warns before that happens rather than after.
   *
   * Zero when nothing is withheld, or when no question is in play.
   */
  withheldOnQuestion: number;
}

/**
 * A written round, from the QM's side.
 *
 * The evaluation surface is a grid — questions down, teams across — because
 * grading one question across every team at once is the only way to be
 * consistent about what counts as close enough (ARCHITECTURE §3).
 */
export interface QmWrittenView {
  phase: WrittenPhase;
  shownIdx: number;
  questions: {
    id: string;
    index: number;
    text: string;
    media: ViewMedia[];
    /** The QM's crib sheet. Never sent to a team. */
    answerText: string;
  }[];
  /** One row per team per question, including teams that did not answer. */
  answers: {
    teamId: string;
    teamName: string;
    questionId: string;
    text: string | null;
    staked: boolean;
    verdict: 'CORRECT' | 'WRONG' | null;
  }[];
}

// ─── Scoreboard view ────────────────────────────────────────────────────────

export interface ScoreboardView {
  role: 'SCOREBOARD';
  quizTitle: string;
  round: RoundHeader | null;
  standings: PublicStanding[];
}

export type View = TeamView | QmView | ScoreboardView;

// ─── Messages ───────────────────────────────────────────────────────────────

export type ClientMessage =
  /** Sent once on connect. The token identifies the session and its role. */
  | { type: 'HELLO'; token: string }
  /**
   * A QM intent. Rejected outright from a team socket — the server is
   * authoritative and never trusts a client to say which role it has.
   */
  | { type: 'ACTION'; action: Action }
  /** A team submitting its pounce. Separate from ACTION because teams may send it. */
  | { type: 'POUNCE'; text: string }
  /** A team's written-round answer, with its stake. Teams may send this. */
  | { type: 'WRITTEN_ANSWER'; questionId: string; text: string; staked: boolean }
  /** Shared-draft editing. Room state, never engine state. */
  | { type: 'DRAFT'; text: string }
  | { type: 'TYPING' }
  | { type: 'PING' };

export type ServerMessage =
  /**
   * The whole view, every time.
   *
   * ARCHITECTURE §5 calls for snapshot-then-deltas. At ten teams a full view is
   * a couple of kilobytes, and sending it whole removes an entire class of
   * desync bugs — the client replaces its state rather than reconciling it,
   * which is exactly what makes reconnection trivially correct. The message
   * shape already allows deltas later without the client changing how it
   * handles this one.
   */
  | { type: 'STATE'; seq: number; view: View }
  /** A rejected action, with the reason in words the UI can show. */
  | { type: 'ERROR'; message: string }
  | { type: 'PONG' };
