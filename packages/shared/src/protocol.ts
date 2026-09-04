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
  };

  draft: TeamDraft;

  /** Public scores. Teams see these live — DECISIONS.md open question 6. */
  standings: PublicStanding[];

  /** Populated only once the QM has revealed. Null at every other moment. */
  reveal: { text: string; media: ViewMedia[] } | null;
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
    /** The whole circle in order, so the QM never loses track under wrap-around. */
    order: { teamId: string; name: string; offered: boolean; current: boolean }[];
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
