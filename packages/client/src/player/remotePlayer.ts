import type { Vec3 } from '@spike/shared';
import { REMOTE_INTERP_DELAY_MS } from '../config';

interface BufferedSample {
  serverTime: number;
  pos: Vec3;
}

// Remote player: buffers incoming positions and interpolates between the two
// samples bracketing (renderTime - REMOTE_INTERP_DELAY_MS), so movement
// stays smooth despite snapshots arriving only at 30Hz (plan §5 / WP3 task 5).
export class RemotePlayer {
  private buffer: BufferedSample[] = [];
  private lastRenderedPos: Vec3;

  constructor(startPos: Vec3) {
    this.lastRenderedPos = { ...startPos };
  }

  pushSample(serverTime: number, pos: Vec3): void {
    this.buffer.push({ serverTime, pos });
    // Keep a bounded window; interpolation only ever needs the last couple seconds.
    const cutoff = serverTime - REMOTE_INTERP_DELAY_MS * 20;
    while (this.buffer.length > 2 && this.buffer[0]!.serverTime < cutoff) this.buffer.shift();
  }

  // serverTimeNow: current authoritative-clock estimate (ms).
  positionAt(serverTimeNow: number): Vec3 {
    const renderTime = serverTimeNow - REMOTE_INTERP_DELAY_MS;

    if (this.buffer.length === 0) return this.lastRenderedPos;
    if (this.buffer.length === 1) {
      this.lastRenderedPos = this.buffer[0]!.pos;
      return this.lastRenderedPos;
    }

    let older = this.buffer[0]!;
    let newer = this.buffer[this.buffer.length - 1]!;
    for (let i = 0; i < this.buffer.length - 1; i++) {
      const a = this.buffer[i]!;
      const b = this.buffer[i + 1]!;
      if (a.serverTime <= renderTime && renderTime <= b.serverTime) {
        older = a;
        newer = b;
        break;
      }
    }

    const span = newer.serverTime - older.serverTime;
    const t = span > 0 ? Math.min(1, Math.max(0, (renderTime - older.serverTime) / span)) : 1;
    this.lastRenderedPos = {
      x: older.pos.x + (newer.pos.x - older.pos.x) * t,
      y: older.pos.y + (newer.pos.y - older.pos.y) * t,
      z: older.pos.z + (newer.pos.z - older.pos.z) * t,
    };
    return this.lastRenderedPos;
  }
}
