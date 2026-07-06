import { describe, expect, it } from 'vitest';
import { isWithinVerticalReach, STANDING_REACH, TOUCH_VERTICAL_MARGIN } from '../src/index';

describe('isWithinVerticalReach (§b.5 vertical touch reach gate)', () => {
  it('is reachable exactly at the standing-reach + margin ceiling', () => {
    const ceiling = 0 + STANDING_REACH + 0 + TOUCH_VERTICAL_MARGIN;
    expect(isWithinVerticalReach(ceiling, 0, 0)).toBe(true);
    expect(isWithinVerticalReach(ceiling + 0.001, 0, 0)).toBe(false);
  });

  it('a grounded player cannot reach a ball far above them', () => {
    expect(isWithinVerticalReach(5, 0, 0)).toBe(false);
  });

  it('a jumping player extends reach by exactly jumpY', () => {
    const groundedCeiling = STANDING_REACH + TOUCH_VERTICAL_MARGIN;
    const ballJustAboveGroundedReach = groundedCeiling + 0.5;
    expect(isWithinVerticalReach(ballJustAboveGroundedReach, 0, 0)).toBe(false);
    expect(isWithinVerticalReach(ballJustAboveGroundedReach, 0, 0.5)).toBe(true);
  });

  it('accounts for a non-zero player ground reference (playerY)', () => {
    const ballAtStandingReachAboveElevatedPlayer = 3 + STANDING_REACH;
    expect(isWithinVerticalReach(ballAtStandingReachAboveElevatedPlayer, 3, 0)).toBe(true);
    expect(isWithinVerticalReach(ballAtStandingReachAboveElevatedPlayer, 0, 0)).toBe(false);
  });
});
