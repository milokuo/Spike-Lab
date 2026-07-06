import { describe, expect, it } from 'vitest';
import { computeFacing, initialFacing } from '../src/index';

// M2.5 §1 — facing priority: explicit yaw > movement direction > previous
// facing. Convention matches moveToWorld/viewSpace.ts: forward(yaw) =
// (sin(yaw), cos(yaw)); yaw=0 is +Z, yaw=π/2 is +X.
describe('initialFacing (spawn facing the net)', () => {
  it('side A (z<0 half) spawns facing +Z -> yaw 0', () => {
    expect(initialFacing('A')).toBe(0);
  });

  it('side B (z>0 half) spawns facing -Z -> yaw π', () => {
    expect(initialFacing('B')).toBe(Math.PI);
  });
});

describe('computeFacing priority', () => {
  it('explicit yaw always wins, regardless of movement', () => {
    expect(computeFacing(0, 'A', { x: 1, y: 1 }, Math.PI / 2)).toBe(Math.PI / 2);
    expect(computeFacing(0, 'A', { x: 0, y: 0 }, -1.2)).toBe(-1.2);
  });

  it('non-finite yaw is treated as absent (falls through to movement/prev)', () => {
    expect(computeFacing(0.5, 'A', { x: 0, y: 0 }, Number.NaN)).toBe(0.5);
  });

  it('movement direction wins over previous facing when yaw is null', () => {
    // Side A pressing "toward net" (view y=+1) resolves to world +Z (forwardZ(A)=1)
    // -> forward(yaw)=(0,1) -> yaw=0.
    expect(computeFacing(Math.PI, 'A', { x: 0, y: 1 }, null)).toBeCloseTo(0, 6);
  });

  it('moving toward world +X yields facing = π/2 (forward(π/2) = (1,0))', () => {
    // side A: rightX(A) = -1, so view x=-1 -> world +X.
    expect(computeFacing(0, 'A', { x: -1, y: 0 }, null)).toBeCloseTo(Math.PI / 2, 6);
    // side B: rightX(B) = +1, so view x=+1 -> world +X.
    expect(computeFacing(0, 'B', { x: 1, y: 0 }, null)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('idle (no yaw, no movement) keeps the previous facing', () => {
    expect(computeFacing(1.234, 'A', { x: 0, y: 0 }, null)).toBe(1.234);
    expect(computeFacing(initialFacing('B'), 'B', { x: 0, y: 0 }, null)).toBe(initialFacing('B'));
  });
});
