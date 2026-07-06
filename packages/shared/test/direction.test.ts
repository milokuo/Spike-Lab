import { describe, expect, it } from 'vitest';
import { resolveIntent, type IntentInput } from '../src/index';

const NEUTRAL_DIR = { x: 0 as const, y: 0 as const };

function makeInput(overrides: Partial<IntentInput>): IntentInput {
  return {
    mode: 'set',
    dirInput: NEUTRAL_DIR,
    charge: 0,
    toucherPos: { x: 0, y: 1, z: -5 },
    toucherSide: 'A',
    ...overrides,
  };
}

describe('resolveIntent (§5.1 direction table)', () => {
  describe('J (dig) — 1v1 fallback (documented deviation from §5.1)', () => {
    it('lofts the ball upward-and-inward on the toucher\'s own half (self-set)', () => {
      const result = resolveIntent(makeInput({ mode: 'dig', toucherPos: { x: 3, y: 1, z: -5 } }));
      expect(result.arcType).toBe('dig');
      expect(result.direction.y).toBeGreaterThan(0);
      // toucher is at x=3, court center is x=0 -> direction should point inward (negative x)
      expect(result.direction.x).toBeLessThan(0);
    });

    it('ignores dirInput — §5.1: dig always targets the setter/nearest teammate, direction keys do not change the target', () => {
      const noDir = resolveIntent(makeInput({ mode: 'dig', dirInput: { x: 0, y: 0 } }));
      const withDir = resolveIntent(makeInput({ mode: 'dig', dirInput: { x: 1, y: -1 } }));
      expect(withDir.direction).toEqual(noDir.direction);
    });
  });

  describe('J (dig) — 2v2 teammate targeting (§5.1/§b.7)', () => {
    it('lofts toward the nearest teammate when teammates are present', () => {
      const toucherPos = { x: 0, y: 1, z: -5 };
      const near = { x: 2, y: 1, z: -5 };
      const far = { x: -4, y: 1, z: -5 };
      const result = resolveIntent(
        makeInput({ mode: 'dig', toucherPos, teammates: [far, near] }),
      );
      expect(result.arcType).toBe('dig');
      // near teammate is at +x relative to toucher -> direction.x > 0
      expect(result.direction.x).toBeGreaterThan(0);
      expect(result.direction.y).toBeGreaterThan(0);
    });

    it('falls back to the self-set behavior when teammates is empty', () => {
      const toucherPos = { x: 3, y: 1, z: -5 };
      const withEmptyTeammates = resolveIntent(makeInput({ mode: 'dig', toucherPos, teammates: [] }));
      const withoutTeammates = resolveIntent(makeInput({ mode: 'dig', toucherPos, teammates: undefined }));
      expect(withEmptyTeammates.direction).toEqual(withoutTeammates.direction);
      // self-set fallback: toucher at x=3, court center x=0 -> pulls inward (negative x)
      expect(withEmptyTeammates.direction.x).toBeLessThan(0);
    });

    it('picks the nearer of two teammates regardless of list order', () => {
      const toucherPos = { x: 0, y: 1, z: -5 };
      const nearer = { x: 1, y: 1, z: -5 };
      const farther = { x: 4, y: 1, z: -5 };
      const orderA = resolveIntent(makeInput({ mode: 'dig', toucherPos, teammates: [farther, nearer] }));
      const orderB = resolveIntent(makeInput({ mode: 'dig', toucherPos, teammates: [nearer, farther] }));
      expect(orderA.direction).toEqual(orderB.direction);
    });
  });

  describe('K (set)', () => {
    it('defaults to straight up when no direction is pressed', () => {
      const result = resolveIntent(makeInput({ mode: 'set', dirInput: { x: 0, y: 0 } }));
      expect(result.arcType).toBe('set');
      expect(result.direction).toEqual({ x: 0, y: 1, z: 0 });
    });

    it('flies toward the pressed direction from the hitter view (side A)', () => {
      // Player-view "right + back": right (x=1) maps to world -X for side A,
      // back (y=-1, away from net) maps to world -Z for side A.
      const result = resolveIntent(makeInput({ mode: 'set', dirInput: { x: 1, y: -1 }, toucherSide: 'A' }));
      expect(result.direction.x).toBeLessThan(0); // side A right = world -X
      expect(result.direction.z).toBeLessThan(0); // back = away from net = -Z on side A
      expect(result.direction.y).toBeGreaterThan(0); // still has loft
    });

    it('mirrors set aim for side B (same player-view input -> mirrored world)', () => {
      // Same player-view "right + back" on side B maps to world +X / +Z
      // (side B faces -Z, so away-from-net is +Z and right is +X).
      const result = resolveIntent(
        makeInput({ mode: 'set', dirInput: { x: 1, y: -1 }, toucherSide: 'B', toucherPos: { x: 0, y: 1, z: 5 } }),
      );
      expect(result.direction.x).toBeGreaterThan(0); // side B right = world +X
      expect(result.direction.z).toBeGreaterThan(0); // back = away from net = +Z on side B
      expect(result.direction.y).toBeGreaterThan(0);
    });
  });

  describe('L (spike)', () => {
    it('defaults to the opponent court center when no direction is pressed', () => {
      const result = resolveIntent(
        makeInput({ mode: 'spike', dirInput: { x: 0, y: 0 }, toucherSide: 'A', toucherPos: { x: 2, y: 1, z: -5 } }),
      );
      expect(result.arcType).toBe('spike');
      // Side A attacks toward +Z (opponent half); x should trend toward 0 (center).
      expect(result.direction.z).toBeGreaterThan(0);
      expect(result.direction.x).toBeLessThan(0); // toucher at x=2 aiming at x=0 -> pulls left
    });

    it('aims to the hitter LEFT for side A (world +X), still into +Z half', () => {
      // Side A hitter faces +Z; the hitter's own left hand points to world +X.
      const result = resolveIntent(
        makeInput({ mode: 'spike', dirInput: { x: -1, y: 0 }, toucherSide: 'A', toucherPos: { x: 0, y: 1, z: -5 } }),
      );
      expect(result.direction.x).toBeGreaterThan(0); // hitter-left on side A = world +X
      expect(result.direction.z).toBeGreaterThan(0);
    });

    it('aims to the hitter RIGHT for side A (world -X), still into +Z half', () => {
      const result = resolveIntent(
        makeInput({ mode: 'spike', dirInput: { x: 1, y: 0 }, toucherSide: 'A', toucherPos: { x: 0, y: 1, z: -5 } }),
      );
      expect(result.direction.x).toBeLessThan(0); // hitter-right on side A = world -X
      expect(result.direction.z).toBeGreaterThan(0);
    });

    it('attacks toward -Z for side B (opposite half)', () => {
      const result = resolveIntent(
        makeInput({ mode: 'spike', dirInput: { x: 0, y: 0 }, toucherSide: 'B', toucherPos: { x: 0, y: 1, z: 5 } }),
      );
      expect(result.direction.z).toBeLessThan(0);
    });

    it('side B LEFT aim lands toward side A -X corner (playtest requirement)', () => {
      // The live-playtest e2e case: side B hitter presses LEFT; from the
      // hitter's perspective that is world -X (side B faces -Z), so the spike
      // heads to the -X corner of side A's half — the "correct corner".
      const result = resolveIntent(
        makeInput({ mode: 'spike', dirInput: { x: -1, y: 0 }, toucherSide: 'B', toucherPos: { x: 0, y: 1, z: 5 } }),
      );
      expect(result.direction.x).toBeLessThan(0); // hitter-left on side B = world -X
      expect(result.direction.z).toBeLessThan(0); // into side A half
    });
  });

  it('produces a normalized (unit-length) direction for every mode', () => {
    const modes = ['dig', 'set', 'spike'] as const;
    for (const mode of modes) {
      const result = resolveIntent(makeInput({ mode }));
      const len = Math.hypot(result.direction.x, result.direction.y, result.direction.z);
      expect(len).toBeCloseTo(1, 5);
    }
  });
});
