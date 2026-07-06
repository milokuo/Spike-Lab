// Barrel: re-exports all public cross-boundary contracts from @spike/shared.
// Server and client packages import ONLY from this barrel.

export * from './constants';
export * from './channels';

export * from './math/vec3';

export * from './types/messages';
export * from './types/state';
export * from './types/blocks';
export * from './types/lobby';

export * from './quality/fDistance';
export * from './quality/fTiming';
export * from './quality/charge';
export * from './quality/overcharge';
export * from './quality/quality';
export * from './quality/reach';
export * from './quality/dig';

export * from './intent/direction';
export * from './intent/viewSpace';
export * from './intent/facing';

export * from './ballistics/trajectory';
export * from './ballistics/launch';
export * from './ballistics/net';

// M3.0a — flight model v2 + spin + touch fidelity.
export * from './physics/flight';
export * from './physics/events';
export * from './physics/spin';
export * from './physics/spinPresets';
export * from './physics/fidelity';
export * from './physics/vecmath';

export * from './kinematics/jump';
export * from './kinematics/serveSweep';

export * from './rotation/serveRotation';
