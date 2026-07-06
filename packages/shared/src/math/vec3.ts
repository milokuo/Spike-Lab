// Pure, immutable 3D vector helpers. Y is up; court lies on the X-Z plane.
// Ground = y = 0. Net is the plane z = 0, height NET_HEIGHT (see constants.ts).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scale = (a: Vec3, s: number): Vec3 => ({
  x: a.x * s,
  y: a.y * s,
  z: a.z * s,
});

export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);

export const dist = (a: Vec3, b: Vec3): number => len(sub(a, b));

// Horizontal (X-Z plane) distance, used by the quality function (spec §6.2).
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
