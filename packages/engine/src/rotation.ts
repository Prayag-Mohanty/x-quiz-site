/**
 * Team rotation under CW/ACW direction with circular wrap-around.
 *
 * FORMAT_SPEC §2.1. This is small but easy to get wrong, so it lives alone and is
 * tested exhaustively. Every index here is an index into QuizState.teams.
 */

import type { Direction } from './types.js';

/** The next team index in round direction, wrapping circularly. */
export function step(idx: number, direction: Direction, teamCount: number): number {
  if (teamCount <= 0) throw new Error('teamCount must be positive');
  const delta = direction === 'CW' ? 1 : -1;
  return (((idx + delta) % teamCount) + teamCount) % teamCount;
}

/**
 * The full bounce order for a question, starting at the direct team and walking the
 * whole circle exactly once.
 */
export function bounceOrder(
  directIdx: number,
  direction: Direction,
  teamCount: number,
): number[] {
  const order: number[] = [];
  let cur = directIdx;
  for (let i = 0; i < teamCount; i++) {
    order.push(cur);
    cur = step(cur, direction, teamCount);
  }
  return order;
}

/**
 * Who receives the NEXT direct question.
 *
 * FORMAT_SPEC §2.1:
 *  - resolved on bounce by team X  → the team after X
 *  - died unanswered               → the team after the previous direct team
 *  - won on pounce                 → the team after the previous direct team
 *    (a pounce does not shift the rotation)
 */
export function nextDirectTeam(args: {
  previousDirectIdx: number;
  /** Index of the team that answered correctly ON BOUNCE, or null. */
  bounceResolverIdx: number | null;
  direction: Direction;
  teamCount: number;
}): number {
  const { previousDirectIdx, bounceResolverIdx, direction, teamCount } = args;
  const anchor = bounceResolverIdx ?? previousDirectIdx;
  return step(anchor, direction, teamCount);
}
