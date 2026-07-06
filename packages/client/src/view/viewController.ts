import { wrapYaw, type Side } from '@spike/shared';
import { FPV_MOUSE_SENSITIVITY, FPV_PITCH_CLAMP_RAD } from '../config';

export type ViewMode = 'third' | 'first';

// Bridge to the HUD so the controller stays UI-framework agnostic: a transient
// notice (used only on a hard pointer-lock failure) plus a persistent overlay
// prompting the player to click to restore view control (§2).
export interface ViewHudBridge {
  showRevertNotice(text: string): void;
  setLockPrompt(visible: boolean): void;
}

// Surface ViewController needs from KeyboardInput. cancelPendingCharge guards
// the re-lock click (§2). startCharge/releaseCharge make the FPV+locked left
// mouse button an H-equivalent (M2.7 §8): mousedown begins a charge, mouseup
// releases it (the touch executes at that instant, exactly like the H key).
export interface KeyboardChargeGuard {
  cancelPendingCharge(): void;
  startCharge(): void;
  releaseCharge(): void;
}

// yaw that makes FPV start "facing the net" per side (§5.1). Derived from the
// shared moveToWorld convention (yaw=0 → world +Z): side A (z<0 half) faces the
// net at +Z, side B (z>0 half) faces -Z. Matches intent/viewSpace.ts docs.
function netFacingYaw(side: Side): number {
  return side === 'A' ? 0 : Math.PI;
}

// M2.3 §5 / M2.4 §2 — first-person view controller. Owns the third↔first toggle
// (V), pointer lock lifecycle, and mouselook yaw/pitch. yaw is streamed to the
// server via InputFrame.yaw (moveToWorld drives movement); pitch is view-only.
//
// M2.4 §2: an INVOLUNTARY lock loss (Esc, alt-tab, focus/OS) NO LONGER exits
// FPV. The camera stays first-person, yaw freezes at its last value, and a
// persistent overlay prompts the player to click the canvas to re-request the
// lock. Only the V key exits FPV. A hard pointerlockerror (requestPointerLock
// unsupported / rejected outright) is the only path that falls back to third.
export class ViewController {
  private mode: ViewMode = 'third';
  private yaw = 0;
  private pitch = 0;
  private side: Side | undefined;
  private active = false; // FPV only allowed during a live match phase

  constructor(
    private readonly canvas: HTMLElement,
    private readonly hud: ViewHudBridge,
    private readonly keyboard: KeyboardChargeGuard,
  ) {
    window.addEventListener('keydown', (event) => this.handleKeyDown(event));
    document.addEventListener('mousemove', (event) => this.handleMouseMove(event));
    document.addEventListener('pointerlockchange', () => this.handlePointerLockChange());
    document.addEventListener('pointerlockerror', () => this.handlePointerLockError());
    // §2 — while in FPV but unlocked (the click-to-restore state), a canvas
    // click re-requests the lock and is swallowed so it doesn't leak through
    // as a stray click elsewhere (charge/serve is on the H key, not the mouse).
    this.canvas.addEventListener('mousedown', (event) => this.handleCanvasMouseDown(event));
    // §8 — LMB release ends an FPV charge. On document so a release still fires
    // if the pointer-locked cursor is nominally off the canvas element.
    document.addEventListener('mouseup', (event) => this.handleMouseUp(event));
  }

  // Set once the local side is known (ensureLocalPlayer). Seeds the net-facing
  // yaw so a later toggle into FPV starts pointed at the net.
  setSide(side: Side): void {
    this.side = side;
    if (this.mode === 'third') this.yaw = netFacingYaw(side);
  }

  // M2.8 playtest §2 — serve mirror fix. Re-seed the FPV heading to face the net
  // whenever the LOCAL player's serve begins. The serve-direction HUD (serveArc)
  // is a SCREEN overlay whose needle mapping assumes the camera faces the net
  // (the serve stance). Nothing else resets yaw at serve-phase start, so a stale
  // heading retained from the previous rally's accumulated mouse-look would leave
  // the FPV camera turned while the HUD stayed net-facing — projecting the shot
  // to the OPPOSITE screen side in FPV only (third person + opponent stay
  // correct). Forcing net-facing here keeps camera and HUD in lockstep, so the
  // whole cross-camera chain agrees (see test/cameraBasis.test.ts). No-op in
  // third person (yaw is unused there — movement takes the mirrored-per-side
  // path), so this never affects the third-person camera or strafing.
  faceNetForServe(): void {
    if (this.mode === 'first' && this.side) this.yaw = netFacingYaw(this.side);
  }

  // Gates FPV on a live match: leaving to lobby/gameover forces third person and
  // drops any pointer lock so the menu pointer works normally.
  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (!active) this.exitToThird();
  }

  get viewMode(): ViewMode {
    return this.mode;
  }

  get lookPitch(): number {
    return this.pitch;
  }

  get lookYaw(): number {
    return this.yaw;
  }

  // §5.2 — yaw streamed in every InputFrame: a wrapped heading in FPV, null in
  // third person (server then takes the existing mirrored-per-side path). Note
  // yaw is streamed even while the lock is lost — it stays frozen at its last
  // value, so movement keeps a stable heading until control is restored.
  currentYaw(): number | null {
    return this.mode === 'first' ? wrapYaw(this.yaw) : null;
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (event.key.toLowerCase() !== 'v') return;
    if (!this.active) return;
    // V is the ONLY way to leave FPV (§2) — works whether or not the pointer is
    // currently locked.
    if (this.mode === 'third') this.enterFirst();
    else this.exitToThird();
  }

  private enterFirst(): void {
    this.mode = 'first';
    this.pitch = 0;
    if (this.side) this.yaw = netFacingYaw(this.side);
    this.requestLock();
  }

  // §2/§8 — canvas mousedown handling, split by lock state:
  //  - Third person: LMB is inert (early return).
  //  - FPV but UNLOCKED: this click re-requests the lock and is swallowed so it
  //    doesn't leak through; the re-lock click must NOT start a charge, so we
  //    also defensively cancel any pending one (§2).
  //  - FPV and LOCKED: LMB is the H-equivalent — begin a charge (§8).
  private handleCanvasMouseDown(event: MouseEvent): void {
    if (this.mode !== 'first') return; // third person: LMB inert
    if (document.pointerLockElement !== this.canvas) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.keyboard.cancelPendingCharge();
      this.requestLock();
      return;
    }
    if (event.button === 0) this.keyboard.startCharge();
  }

  // §8 — LMB release in FPV+locked executes the charged touch (H-key equivalent).
  // releaseCharge no-ops if no charge is in flight (e.g. the re-lock click's own
  // mouseup), so this is safe to call on every left-button release.
  private handleMouseUp(event: MouseEvent): void {
    if (this.mode !== 'first' || document.pointerLockElement !== this.canvas) return;
    if (event.button === 0) this.keyboard.releaseCharge();
  }

  private requestLock(): void {
    // requestPointerLock resolves async in modern browsers; a hard failure also
    // fires pointerlockerror, which is our only fallback to third person.
    const request = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (request && typeof request.catch === 'function') request.catch(() => this.handlePointerLockError());
  }

  // Intentional exit (V key or leaving the match): set mode BEFORE releasing the
  // lock so the resulting pointerlockchange (element → null) is treated as a
  // deliberate exit, not an involuntary loss. Clears the restore prompt.
  private exitToThird(): void {
    this.mode = 'third';
    this.hud.setLockPrompt(false);
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.side) this.yaw = netFacingYaw(this.side);
  }

  private handleMouseMove(event: MouseEvent): void {
    if (this.mode !== 'first' || document.pointerLockElement !== this.canvas) return;
    // Convention (derived from viewSpace.ts forward/right-from-yaw + renderer's
    // camera.lookAt): increasing yaw rotates forward(yaw)=(sin yaw, cos yaw)
    // toward screen-LEFT (d(forward)/dyaw == -right(yaw) for all yaw), so a
    // rightward turn requires DECREASING yaw — mouse right (movementX > 0)
    // must subtract, giving "mouse right -> view right".
    this.yaw = wrapYaw(this.yaw - event.movementX * FPV_MOUSE_SENSITIVITY) ?? this.yaw;
    const nextPitch = this.pitch - event.movementY * FPV_MOUSE_SENSITIVITY;
    this.pitch = Math.max(-FPV_PITCH_CLAMP_RAD, Math.min(FPV_PITCH_CLAMP_RAD, nextPitch));
  }

  // §2 — involuntary lock loss (Esc, tab blur, OS) NO LONGER exits FPV: stay in
  // first person, freeze yaw (handleMouseMove already no-ops while unlocked),
  // and show the restore prompt. Re-locking (element === canvas) hides it.
  private handlePointerLockChange(): void {
    if (this.mode !== 'first') {
      this.hud.setLockPrompt(false);
      return;
    }
    const locked = document.pointerLockElement === this.canvas;
    this.hud.setLockPrompt(!locked);
  }

  // Hard failure: the browser could not grant pointer lock at all. This is the
  // ONLY involuntary path that falls back to third person (§2).
  private handlePointerLockError(): void {
    if (this.mode !== 'first') return;
    this.mode = 'third';
    this.hud.setLockPrompt(false);
    if (this.side) this.yaw = netFacingYaw(this.side);
    this.hud.showRevertNotice('無法鎖定滑鼠，已退回第三人稱');
  }
}
