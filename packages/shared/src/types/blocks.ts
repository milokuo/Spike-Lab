// Type-only placeholders for the skill-block system (spec §8). Block LOGIC is
// out of scope for M2 — these shapes exist only so BallLaunch can carry
// optional (always-empty in M2) appliedBlocks/pendingBlocks fields without
// the wire contract needing to change again in M3.

export type BlockCategory = 'instant' | 'deferred' | 'stateChange';

export interface BlockDef {
  id: string;
  category: BlockCategory;
  // Acceleration applied, in units/s^2, along the block's configured axis.
  accel: import('../math/vec3').Vec3;
  durationMs: number; // randomized per-player at draft time (§8.2)
  tensionCost: number;
}

// A block effect attached to a future touch event on this ball (§6.4 / §8.2).
export interface PendingBlock {
  block: BlockDef;
  triggerTouchOffset: 1 | 2; // "next touch" or "touch after next"
}

export interface SkillSlotConfig {
  slot: 'U' | 'I' | 'O' | 'M' | ',' | '.';
  blocks: BlockDef[]; // stacked in activation order; may be empty
}
