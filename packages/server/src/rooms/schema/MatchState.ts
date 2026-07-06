// Root Colyseus schema (plan §0: low-frequency authoritative state only —
// players, score, phase, serving). The ball is deliberately NOT in schema; it is
// broadcast as BallLaunch packets and replayed as a pure function on every end.
import { schema, type MapSchema } from '@colyseus/schema';
import type { MapId, MatchPhase } from '@spike/shared';
import { PlayerStateSchema, type PlayerState } from './PlayerState';

const MatchStateClass = schema({
  players: { map: PlayerStateSchema },
  scoreA: 'number',
  scoreB: 'number',
  phase: 'string',
  servingId: 'string',
  hostId: 'string', // M2.1 §d — lobby host (first joiner; promoted on host leave)
  map: 'string', // M2.7 §4 — selected map ('indoor'|'outdoor')
  teamNameA: 'string', // M2.7 §5 — side A display name
  teamNameB: 'string', // M2.7 §5 — side B display name
});

// Narrow `phase`/`players`/`map` from wire-level primitives to the domain types.
export type MatchState = Omit<InstanceType<typeof MatchStateClass>, 'phase' | 'players' | 'map'> & {
  phase: MatchPhase;
  players: MapSchema<PlayerState>;
  map: MapId;
};

export const MatchState = MatchStateClass as unknown as { new (): MatchState };
