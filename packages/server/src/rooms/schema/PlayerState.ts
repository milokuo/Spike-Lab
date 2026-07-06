// Colyseus @colyseus/schema v3 player row. Built with the functional `schema()`
// API (not decorators, not `defineTypes` + class fields): class-field
// initializers create own-properties that shadow the accessors schema installs,
// which drops the collection `$childType` and breaks encoding. `schema()`
// constructs the class with the correct descriptors already in place.
import { schema } from '@colyseus/schema';
import type { Side, TouchMode } from '@spike/shared';

const PlayerStateClass = schema({
  id: 'string',
  side: 'string',
  name: 'string', // M2.1 §b.6 — lobby/HUD roster display name
  slotIndex: 'number', // M2.6 §1 — team slot index (0..5); serve-rotation order key
  x: 'number',
  y: 'number',
  z: 'number',
  stamina: 'number',
  mode: 'string', // M2.2 §2.2 — authoritative touch mode ('dig'|'set'|'spike')
  isCharging: 'boolean', // M2.8 §1 — authoritative charge-hold state, streamed every frame
  lastProcessedSeq: 'number',
  facing: 'number', // M2.5 §1 — authoritative horizontal facing (radians, yaw convention)
});

// Narrow `side`/`mode` from the wire-level `string` back to their domain unions.
export type PlayerState = Omit<InstanceType<typeof PlayerStateClass>, 'side' | 'mode'> & {
  side: Side;
  mode: TouchMode;
};

export const PlayerState = PlayerStateClass as unknown as { new (): PlayerState };
export const PlayerStateSchema = PlayerStateClass; // raw ctor for map child typing
