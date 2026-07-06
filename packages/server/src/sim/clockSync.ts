// Per-session clock offset from the ping/pong stream (plan §3). The server keeps
// its own EMA of (serverReceiveTime - clientTime) so it can map an incoming
// TouchIntent.clientTime back onto the authoritative server clock for lag
// compensation. Mirrors the client-side EMA but seeded from received pings.

const EMA_ALPHA = 0.2; // weight of each new sample
const OUTLIER_FACTOR = 3; // drop samples > 3x the current estimate magnitude

interface SessionClock {
  offsetMs: number; // EMA of serverRecv - clientTime (~ up-latency + skew)
  initialized: boolean;
}

export class ClockSync {
  private readonly sessions = new Map<string, SessionClock>();

  /** Record a ping receipt. Returns nothing; call toServerTime later. */
  observePing(sessionId: string, clientTime: number, serverRecvTime: number): void {
    if (!Number.isFinite(clientTime) || !Number.isFinite(serverRecvTime)) return;
    const sample = serverRecvTime - clientTime;

    const existing = this.sessions.get(sessionId);
    if (!existing || !existing.initialized) {
      this.sessions.set(sessionId, { offsetMs: sample, initialized: true });
      return;
    }

    // Outlier rejection: ignore wild spikes so a single stalled packet cannot
    // poison the estimate (plan §3: drop outliers).
    const magnitude = Math.abs(existing.offsetMs) || 1;
    if (Math.abs(sample - existing.offsetMs) > OUTLIER_FACTOR * magnitude + 100) {
      return;
    }

    existing.offsetMs = existing.offsetMs * (1 - EMA_ALPHA) + sample * EMA_ALPHA;
  }

  /** Map a client-stamped time onto the server clock. */
  toServerTime(sessionId: string, clientTime: number): number {
    const s = this.sessions.get(sessionId);
    const offset = s?.initialized ? s.offsetMs : 0;
    return clientTime + offset;
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
