import type { Vec3 } from '../math/vec3';

export type Side = 'A' | 'B'; // A = z<0 half, B = z>0 half
// M2.1 §b.6/§d: 'waiting' is replaced by 'lobby' (pre-start roster room with
// code/host/canStart) — see types/lobby.ts. Breaking change, allowed per §f.
export type MatchPhase = 'lobby' | 'serve' | 'rally' | 'deadball' | 'gameover';

export interface ScoreState {
  A: number;
  B: number;
}

// Plain mirror of the server-owned Colyseus schema class. The client consumes
// this shape via StateSnapshot messages and never needs schema knowledge.
export interface PlayerState {
  id: string;
  side: Side;
  name: string; // M2.1 §b.6 — shown in HUD/lobby roster
  pos: Vec3;
  stamina: number;
  lastProcessedSeq: number;
}
