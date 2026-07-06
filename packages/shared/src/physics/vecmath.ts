// Small pure vector helpers the physics module needs on top of math/vec3
// (which has no cross product). Kept local to physics/ because P0 may not modify
// math/vec3.ts. Right-handed cross product (world is right-handed, up = +Y).
import type { Vec3 } from '../math/vec3';

export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const negate = (a: Vec3): Vec3 => ({ x: -a.x, y: -a.y, z: -a.z });
