// Authoritative ball driver. Holds the active BallLaunch, exposes pos/vel at any
// server time via the shared pure-function trajectory, and pre-computes the
// deterministic first death/net event so the room can fire it at the right tick.
// The ball is never in schema — this object is the server's private authority.
import {
  ballPosition,
  ballVelocity,
  firstEvent,
  type BallLaunch,
  type TrajectoryEvent,
  type Vec3,
} from '@spike/shared';
import { MAX_TRAJECTORY_MS } from '../config';

export class BallServer {
  private launch: BallLaunch | null = null;
  private predicted: TrajectoryEvent | null = null;

  get active(): boolean {
    return this.launch !== null;
  }

  get currentLaunch(): BallLaunch | null {
    return this.launch;
  }

  get predictedEvent(): TrajectoryEvent | null {
    return this.predicted;
  }

  /** Install a new trajectory and (re)compute its deterministic first event. */
  setLaunch(launch: BallLaunch): void {
    this.launch = launch;
    this.predicted = firstEvent(launch, MAX_TRAJECTORY_MS);
  }

  clear(): void {
    this.launch = null;
    this.predicted = null;
  }

  private elapsed(serverTime: number): number {
    return this.launch ? serverTime - this.launch.serverTime : 0;
  }

  positionAt(serverTime: number): Vec3 | null {
    if (!this.launch) return null;
    return ballPosition(this.launch, this.elapsed(serverTime));
  }

  velocityAt(serverTime: number): Vec3 | null {
    if (!this.launch) return null;
    return ballVelocity(this.launch, this.elapsed(serverTime));
  }

  /** True once the pre-computed death/net event time has been reached. */
  eventDue(serverTime: number): boolean {
    if (!this.launch || !this.predicted || this.predicted.kind === 'none') return false;
    return this.elapsed(serverTime) >= this.predicted.atMs;
  }
}
