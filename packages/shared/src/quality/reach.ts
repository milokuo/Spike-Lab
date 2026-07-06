import { STANDING_REACH, TOUCH_VERTICAL_MARGIN } from '../constants';

// Vertical touch reach gate (§b.5 / feedback #5 consequence). Used alongside
// the existing horizontal REACH_MAX gate in adjudicateTouch: a ball far above
// a grounded player is unreachable, but a jumping player can meet it.
//
// ballY: ball height above ground at the adjudicated instant.
// playerY: toucher's ground reference (base of stance, typically 0).
// jumpY: toucher's current jump height above playerY (0 when grounded).
export function isWithinVerticalReach(ballY: number, playerY: number, jumpY: number): boolean {
  return ballY <= playerY + STANDING_REACH + jumpY + TOUCH_VERTICAL_MARGIN;
}
