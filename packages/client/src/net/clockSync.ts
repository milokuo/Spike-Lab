import type { Room } from 'colyseus.js';
import type { Pong } from '@spike/shared';
import {
  CLOCK_SYNC_OFFSET_EMA_ALPHA,
  CLOCK_SYNC_OUTLIER_RTT_MULT,
  CLOCK_SYNC_PING_INTERVAL_MS,
} from '../config';
import { onPong, sendPing } from './messages';

// Client half of ping/pong clock sync (plan §3). Maintains an EMA of the
// server-minus-client clock offset so serverTimeNow() tracks the
// authoritative clock without needing per-message correction.
export class ClockSync {
  private offsetMs = 0;
  private rttEmaMs = 0; // only meaningful once `synced` is true
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private synced = false;

  start(room: Room): void {
    onPong(room, (pong) => this.handlePong(pong));
    this.sendPingNow(room);
    this.intervalId = setInterval(() => this.sendPingNow(room), CLOCK_SYNC_PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId !== undefined) clearInterval(this.intervalId);
  }

  private sendPingNow(room: Room): void {
    sendPing(room, { clientTime: performance.now() });
  }

  private handlePong(pong: Pong): void {
    const now = performance.now();
    const rtt = now - pong.clientTime;
    if (this.synced && rtt > this.rttEmaMs * CLOCK_SYNC_OUTLIER_RTT_MULT) {
      return; // drop outlier RTT samples (plan §3)
    }

    const oneWay = rtt / 2;
    const offsetSample = pong.serverTime + oneWay - now;

    if (!this.synced) {
      this.offsetMs = offsetSample;
      this.rttEmaMs = rtt;
      this.synced = true;
      return;
    }

    this.offsetMs =
      this.offsetMs * (1 - CLOCK_SYNC_OFFSET_EMA_ALPHA) + offsetSample * CLOCK_SYNC_OFFSET_EMA_ALPHA;
    this.rttEmaMs = this.rttEmaMs * (1 - CLOCK_SYNC_OFFSET_EMA_ALPHA) + rtt * CLOCK_SYNC_OFFSET_EMA_ALPHA;
  }

  // Best estimate of the current authoritative server clock (ms).
  serverTimeNow(): number {
    return performance.now() + this.offsetMs;
  }

  isSynced(): boolean {
    return this.synced;
  }
}
