// Fixed-capacity ring buffers of per-tick history for lag compensation (plan §3).
// One buffer tracks the authoritative ball {pos, vel}; a parallel per-player
// buffer tracks positions so the toucher can be rewound to their delayed
// instant. query(serverTime) linearly interpolates between bracketing samples.
import { RING_BUFFER_TICKS, type Vec3 } from '@spike/shared';

interface BallSample {
  serverTime: number;
  pos: Vec3;
  vel: Vec3;
}

interface PosSample {
  serverTime: number;
  pos: Vec3;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});

// Generic bounded, time-ordered sample store. Push is O(1); query is O(n) over
// a tiny (<=45) window, which is trivial for a 2-player room.
class TimeSeries<T extends { serverTime: number }> {
  private readonly samples: T[] = [];

  constructor(private readonly capacity: number) {}

  push(sample: T): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  clear(): void {
    this.samples.length = 0;
  }

  /** Drop every sample at or after `serverTime` (splice a rebound in cleanly). */
  dropFrom(serverTime: number): void {
    while (this.samples.length && this.samples[this.samples.length - 1]!.serverTime >= serverTime) {
      this.samples.pop();
    }
  }

  get length(): number {
    return this.samples.length;
  }

  /** Find the two samples bracketing serverTime and return t in [0,1]. */
  bracket(serverTime: number): { lo: T; hi: T; t: number } | null {
    const n = this.samples.length;
    if (n === 0) return null;
    const first = this.samples[0]!;
    const last = this.samples[n - 1]!;
    if (serverTime <= first.serverTime) return { lo: first, hi: first, t: 0 };
    if (serverTime >= last.serverTime) return { lo: last, hi: last, t: 0 };

    for (let i = 1; i < n; i++) {
      const hi = this.samples[i]!;
      if (hi.serverTime >= serverTime) {
        const lo = this.samples[i - 1]!;
        const span = hi.serverTime - lo.serverTime;
        const t = span > 0 ? (serverTime - lo.serverTime) / span : 0;
        return { lo, hi, t };
      }
    }
    return { lo: last, hi: last, t: 0 };
  }

  get oldestTime(): number | null {
    return this.samples.length ? this.samples[0]!.serverTime : null;
  }

  get newestTime(): number | null {
    return this.samples.length ? this.samples[this.samples.length - 1]!.serverTime : null;
  }
}

export class BallRingBuffer {
  private readonly series = new TimeSeries<BallSample>(RING_BUFFER_TICKS);

  record(serverTime: number, pos: Vec3, vel: Vec3): void {
    this.series.push({ serverTime, pos, vel });
  }

  clear(): void {
    this.series.clear();
  }

  /** Drop every ball sample at or after `serverTime` (see MatchSim.installRebound). */
  dropFrom(serverTime: number): void {
    this.series.dropFrom(serverTime);
  }

  get hasData(): boolean {
    return this.series.length > 0;
  }

  get windowStart(): number | null {
    return this.series.oldestTime;
  }

  get windowEnd(): number | null {
    return this.series.newestTime;
  }

  /** Interpolated ball position at serverTime, or null if no history. */
  query(serverTime: number): { pos: Vec3; vel: Vec3 } | null {
    const b = this.series.bracket(serverTime);
    if (!b) return null;
    return {
      pos: lerpVec(b.lo.pos, b.hi.pos, b.t),
      vel: lerpVec(b.lo.vel, b.hi.vel, b.t),
    };
  }
}

export class PlayerHistory {
  private readonly byId = new Map<string, TimeSeries<PosSample>>();

  record(id: string, serverTime: number, pos: Vec3): void {
    let ts = this.byId.get(id);
    if (!ts) {
      ts = new TimeSeries<PosSample>(RING_BUFFER_TICKS);
      this.byId.set(id, ts);
    }
    ts.push({ serverTime, pos });
  }

  remove(id: string): void {
    this.byId.delete(id);
  }

  /** Interpolated position of a player at serverTime, or null if unknown. */
  query(id: string, serverTime: number): Vec3 | null {
    const ts = this.byId.get(id);
    if (!ts) return null;
    const b = ts.bracket(serverTime);
    if (!b) return null;
    return lerpVec(b.lo.pos, b.hi.pos, b.t);
  }
}
