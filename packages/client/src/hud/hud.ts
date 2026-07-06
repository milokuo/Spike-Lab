import {
  OVERCHARGE_MAX,
  STAMINA_MAX,
  type DeathCause,
  type MatchPhase,
  type PlayerSnapshot,
  type ScoreState,
  type Side,
  type TeamNames,
  type TouchMode,
  type TouchRejection,
  type TouchResult,
} from '@spike/shared';
import type { ConnectionStatus } from '../net/connection';
import {
  DIVE_FEEDBACK_DURATION_MS,
  HUD_POPUP_DURATION_MS,
  PERFECT_HITSTOP_MS,
  PLAYER_LEFT_BANNER_DURATION_MS,
  SCORE_BANNER_DURATION_MS,
} from '../config';
import { SkillGrid } from './skillGrid';
import { ServeArcHud } from './serveArc';
import { Scoreboard } from './scoreboard';
import { applyConnectionStatus, buildPracticeChip, createBarFill, labeled, track } from './hudDom';
import { injectHudStyles } from './hudStyles';
import { TransientPopup } from './transientPopup';
import {
  CHARGE_NORMAL_PCT,
  CONTROLS_HELP,
  DEATH_CAUSE_TEXT,
  DEFAULT_TEAM_NAMES,
  DIVE_TEXT,
  FPV_LOCK_PROMPT,
  GRADE_COLOR,
  ILLEGAL_TOUCH_COLOR,
  ILLEGAL_TOUCH_TEXT,
  OVERCHARGE_NOTE,
  PRACTICE_RESET_TEXT,
  SERVE_HINT,
} from './hudText';

export interface HudCallbacks {
  onRetry: () => void;
  // M2.9 §5 — practice chip's 離開 button (full teardown back to the menu).
  onLeavePractice: () => void;
}

// Plain DOM/CSS HUD: score, serve indicator, stamina + charge bars, mode grid,
// feedback popups, roster, connection status. In-game only (lobbyView covers 'lobby').
export class Hud {
  private scoreboard: Scoreboard;
  private rosterEl: HTMLElement;
  private staminaFillEl: HTMLElement;
  private chargeFillEl: HTMLElement;
  private serveHintEl: HTMLElement;
  private fpvLockPromptEl: HTMLElement;
  private skillGrid: SkillGrid;
  private serveArc: ServeArcHud;
  private gradePopupEl: HTMLElement;
  private gradePopup: TransientPopup;
  private divePopup: TransientPopup;
  private playerLeftPopup: TransientPopup;
  private scoreBannerPopup: TransientPopup;
  private connectionOverlay: HTMLElement;
  private connectionMessageEl: HTMLElement;
  private retryButton: HTMLButtonElement;
  private flashEl: HTMLElement;
  private practiceChip: HTMLElement;
  private hitstopUntilMs = 0;
  private currentMode: TouchMode | undefined;

  constructor(root: HTMLElement, callbacks: HudCallbacks) {
    injectHudStyles();
    root.innerHTML = '';

    this.scoreboard = new Scoreboard();

    this.rosterEl = document.createElement('div');
    this.rosterEl.className = 'hud-roster';

    this.skillGrid = new SkillGrid();
    this.serveArc = new ServeArcHud();

    const bottomBar = document.createElement('div');
    bottomBar.className = 'hud-bottom-bar';
    this.staminaFillEl = createBarFill('hud-stamina-fill');
    this.chargeFillEl = createBarFill('hud-charge-fill');
    const chargeTrack = track(this.chargeFillEl);
    // §5 — mark the red overcharge zone as the right ~23% of the track.
    chargeTrack.style.background = `linear-gradient(to right, rgba(255,255,255,0.15) 0 ${CHARGE_NORMAL_PCT}%, rgba(255,80,80,0.32) ${CHARGE_NORMAL_PCT}% 100%)`;
    const overchargeNote = document.createElement('div');
    overchargeNote.className = 'hud-overcharge-note';
    overchargeNote.textContent = OVERCHARGE_NOTE;
    const controlsHelp = document.createElement('div');
    controlsHelp.className = 'hud-controls-help';
    controlsHelp.textContent = CONTROLS_HELP;
    bottomBar.append(
      labeled('Stamina', track(this.staminaFillEl)),
      labeled('Charge', chargeTrack),
      overchargeNote,
      controlsHelp,
    );

    this.serveHintEl = document.createElement('div');
    this.serveHintEl.className = 'hud-serve-hint';
    this.serveHintEl.textContent = SERVE_HINT;
    this.serveHintEl.style.display = 'none';

    this.gradePopupEl = document.createElement('div');
    this.gradePopupEl.className = 'hud-grade-popup';
    this.gradePopup = new TransientPopup(this.gradePopupEl, 'hud-grade-popup-show');

    const diveFeedbackEl = document.createElement('div');
    diveFeedbackEl.className = 'hud-dive-feedback';
    this.divePopup = new TransientPopup(diveFeedbackEl, 'hud-dive-feedback-show');

    const playerLeftBannerEl = document.createElement('div');
    playerLeftBannerEl.className = 'hud-player-left-banner';
    this.playerLeftPopup = new TransientPopup(playerLeftBannerEl, 'hud-player-left-banner-show');

    // §3 — centered "{隊名} 得分 — {原因}" banner on DeathEvent, tinted A/B.
    const scoreBannerEl = document.createElement('div');
    scoreBannerEl.className = 'hud-score-banner';
    this.scoreBannerPopup = new TransientPopup(scoreBannerEl, 'hud-score-banner-show', [
      'hud-score-banner-A',
      'hud-score-banner-B',
      'hud-score-banner-neutral',
    ]);

    // §2 — "click to restore view control" overlay; pointer-events:none so the
    // click passes through to the canvas (which re-requests the pointer lock).
    this.fpvLockPromptEl = document.createElement('div');
    this.fpvLockPromptEl.className = 'hud-fpv-lock-prompt';
    this.fpvLockPromptEl.textContent = FPV_LOCK_PROMPT;
    this.fpvLockPromptEl.style.display = 'none';

    this.flashEl = document.createElement('div');
    this.flashEl.className = 'hud-flash';

    // §5 — practice-mode chip (top-left "練習模式" + 離開). Hidden until
    // setPracticeMode(true); the 離開 button tears down back to the menu.
    this.practiceChip = buildPracticeChip(() => callbacks.onLeavePractice());

    this.connectionOverlay = document.createElement('div');
    this.connectionOverlay.className = 'hud-connection-overlay';
    this.connectionMessageEl = document.createElement('div');
    this.connectionMessageEl.className = 'hud-connection-message';
    this.retryButton = document.createElement('button');
    this.retryButton.className = 'hud-retry-button';
    this.retryButton.textContent = 'Retry connection';
    this.retryButton.style.display = 'none';
    this.retryButton.addEventListener('click', () => callbacks.onRetry());
    this.connectionOverlay.append(this.connectionMessageEl, this.retryButton);

    root.append(
      this.scoreboard.root,
      this.rosterEl,
      this.skillGrid.root,
      this.serveArc.root,
      bottomBar,
      this.serveHintEl,
      this.gradePopupEl,
      this.divePopup.element,
      this.playerLeftPopup.element,
      this.scoreBannerPopup.element,
      this.fpvLockPromptEl,
      this.flashEl,
      this.practiceChip,
      this.connectionOverlay,
    );

    this.setScore({ A: 0, B: 0 });
    this.setPhase('lobby');
    this.setStamina(STAMINA_MAX);
    this.setCharge(0);
    this.setMode('dig');
  }

  setScore(score: ScoreState): void {
    this.scoreboard.setScore(score);
  }

  // §5 — HUD score display uses the lobby's team names, not raw "A"/"B".
  setTeamNames(names: TeamNames): void {
    this.scoreboard.setTeamNames(names);
  }

  setPhase(phase: MatchPhase): void {
    this.scoreboard.setPhaseText(phase === 'lobby' ? 'Waiting in lobby...' : phase.toUpperCase());
    if (phase !== 'serve') {
      this.scoreboard.setServingSide(null);
      this.clearServeAffordances();
    }
  }

  // §5 — pulsing dot beside the serving team's score on the scoreboard panel.
  setServingSide(side: Side | null): void {
    this.scoreboard.setServingSide(side);
  }

  // §4 發球 grid cell + §3.2 mechanic hint: lit only during YOUR serve (setPhase
  // clears these on any non-serve phase so they never linger).
  setServeActive(active: boolean): void {
    this.skillGrid.setServeActive(active);
    this.serveHintEl.style.display = active ? 'block' : 'none';
  }

  private clearServeAffordances(): void {
    this.setServeActive(false);
  }

  // M2.3 §5.1 — brief notice for a hard FPV fallback to third person
  // (pointerlockerror). Reuses the transient banner presentation.
  showViewNotice(text: string): void {
    this.showBanner(text);
  }

  // M2.4 §2 — persistent "click to restore view control" overlay while FPV has
  // lost its pointer lock; driven from ViewController.
  setFpvLockPrompt(visible: boolean): void {
    this.fpvLockPromptEl.style.display = visible ? 'flex' : 'none';
  }

  // §4 — clear all match-specific HUD state on room teardown so nothing bleeds
  // into the next room before its first snapshot arrives.
  resetMatchState(): void {
    this.rosterEl.innerHTML = '';
    this.setScore({ A: 0, B: 0 });
    this.setPhase('lobby');
    this.setStamina(STAMINA_MAX);
    this.setCharge(0);
    this.scoreboard.setServingSide(null);
    this.clearServeAffordances();
    this.updateServeArc(false, 0, 0);
    this.setFpvLockPrompt(false);
    this.gradePopup.clear();
    this.divePopup.clear();
    this.playerLeftPopup.clear();
    this.scoreBannerPopup.clear();
    this.setTeamNames(DEFAULT_TEAM_NAMES);
    // §5 — restore the scoreboard + hide the practice chip so nothing leaks into
    // the next room before its wire sets the real mode.
    this.setPracticeMode(false);
  }

  // Roster for up to 4 players (M2.1 §d 2v2 lobby carries through to in-game
  // HUD): grouped by side, local player highlighted.
  setRoster(players: PlayerSnapshot[], localId: string): void {
    this.rosterEl.innerHTML = '';
    for (const side of ['A', 'B'] as const) {
      const column = document.createElement('div');
      column.className = 'hud-roster-column';
      const heading = document.createElement('div');
      heading.className = 'hud-roster-heading';
      heading.textContent = `Side ${side}`;
      column.appendChild(heading);
      for (const player of players.filter((p) => p.side === side)) {
        const row = document.createElement('div');
        row.className = player.id === localId ? 'hud-roster-row hud-roster-row-self' : 'hud-roster-row';
        row.textContent = player.name;
        column.appendChild(row);
      }
      this.rosterEl.appendChild(column);
    }
  }

  // Transient banner for a mid-match departure (M2.1 §d leave policy has no
  // dedicated wire event beyond the roster shrinking / gameover-by-forfeit,
  // so this is driven by main.ts noticing a known player id disappear).
  showPlayerLeftNotice(name: string): void {
    this.showBanner(`${name} left the match`);
  }

  // Shared transient top banner used for player-left + FPV-revert notices.
  private showBanner(text: string): void {
    this.playerLeftPopup.element.textContent = text;
    this.playerLeftPopup.show(PLAYER_LEFT_BANNER_DURATION_MS);
  }

  setStamina(value: number): void {
    const pct = Math.min(100, Math.max(0, (value / STAMINA_MAX) * 100));
    this.staminaFillEl.style.width = `${pct}%`;
  }

  // §5 — charge now runs 0..OVERCHARGE_MAX. The bar is scaled to that cap so
  // the right ~23% is the red overcharge zone; once charge passes 1.0 the fill
  // turns red and pulses as an accuracy-loss warning.
  setCharge(charge: number): void {
    const pct = Math.min(100, Math.max(0, (charge / OVERCHARGE_MAX) * 100));
    this.chargeFillEl.style.width = `${pct}%`;
    this.chargeFillEl.classList.toggle('hud-charge-over', charge > 1);
  }

  // M2.2 §2.3: highlight the active mode badge from the local player's live
  // touchMode. No-ops when unchanged to avoid per-frame DOM churn.
  setMode(mode: TouchMode): void {
    if (this.currentMode === mode) return;
    this.currentMode = mode;
    this.skillGrid.setMode(mode);
  }

  // M2.7 §8 — the wheel/Q-E "selected cell" (distinct from the active-mode glow).
  setSelection(index: number): void {
    this.skillGrid.setSelection(index);
  }

  // M2.7 §7 — FPV serve-direction arc (visible only in FPV during own serve).
  // M2.8 §2b — side + yaw orient the needle in the CURRENT FPV view (yaw-aware
  // needle: it tracks where the ball will actually fly on screen, even if the
  // player mouse-turns during the charge). Optional so hide calls stay terse.
  updateServeArc(visible: boolean, needleDeg: number, charge: number, side: Side = 'A', yaw = 0): void {
    this.serveArc.setVisible(visible);
    if (visible) this.serveArc.update(needleDeg, charge, side, yaw);
  }

  // M2.2 §3: dive presentation feedback text (救球! / 撲空!), shown alongside
  // the normal grade popup when a TouchResult carries a dive outcome.
  showDiveFeedback(outcome: 'dive_success' | 'dive_fail'): void {
    const { text, color } = DIVE_TEXT[outcome];
    this.renderDiveSlotFeedback(text, color);
  }

  // M2.7 §2 — illegal-touch rejection (連擊犯規！/觸球次數用盡！), red text.
  // Reuses the same popup/timing as the dive feedback — the two are mutually
  // exclusive on TouchResult.outcome so there's no risk of clobbering.
  showIllegalTouchFeedback(outcome: TouchRejection): void {
    this.renderDiveSlotFeedback(ILLEGAL_TOUCH_TEXT[outcome], ILLEGAL_TOUCH_COLOR);
  }

  private renderDiveSlotFeedback(text: string, color: string): void {
    this.divePopup.element.textContent = text;
    this.divePopup.element.style.color = color;
    this.divePopup.show(DIVE_FEEDBACK_DURATION_MS);
  }

  // §3 — centered "{隊名} 得分 — {原因}" banner on DeathEvent, ~1.8s, tinted by
  // the scoring side (A blue / B red) via the CSS variant class.
  showScoreBanner(teamName: string, side: Side, cause: DeathCause): void {
    this.scoreBannerPopup.element.textContent = `${teamName} 得分 — ${DEATH_CAUSE_TEXT[cause]}`;
    this.scoreBannerPopup.show(SCORE_BANNER_DURATION_MS, [`hud-score-banner-${side}`]);
  }

  // M2.9 §5 — practice sandbox death: no team scored (score frozen 0:0), so the
  // banner shows a neutral, un-tinted "重新發球" line instead of the scoring show.
  showPracticeResetBanner(): void {
    this.scoreBannerPopup.element.textContent = PRACTICE_RESET_TEXT;
    this.scoreBannerPopup.show(SCORE_BANNER_DURATION_MS, ['hud-score-banner-neutral']);
  }

  // M2.9 §5 — practice sandbox: hide the scoreboard (frozen 0:0 is meaningless)
  // and show the practice chip + 離開 button. Called on room wire and cleared on
  // teardown (resetMatchState) so it never bleeds into a later versus match.
  setPracticeMode(active: boolean): void {
    this.scoreboard.root.style.display = active ? 'none' : '';
    this.practiceChip.style.display = active ? 'flex' : 'none';
  }

  // Shows the grade popup and, for PERFECT, a brief flash + hitstop window
  // (spec §10, kept minimal). Returns true if a hitstop should be applied by
  // the caller's render loop.
  showTouchResult(result: TouchResult): boolean {
    this.gradePopupEl.textContent = result.accepted ? result.grade : 'WHIFF';
    this.gradePopupEl.style.color = GRADE_COLOR[result.accepted ? result.grade : 'WHIFF'];
    this.gradePopup.show(HUD_POPUP_DURATION_MS);

    if (result.accepted && result.grade === 'PERFECT') {
      this.triggerPerfectFlash();
      return true;
    }
    return false;
  }

  private triggerPerfectFlash(): void {
    this.flashEl.classList.remove('hud-flash-show');
    void this.flashEl.offsetWidth;
    this.flashEl.classList.add('hud-flash-show');
    this.hitstopUntilMs = performance.now() + PERFECT_HITSTOP_MS;
  }

  // main.ts render loop calls this to know whether to skip advancing
  // simulation this frame (the 0.1s hitstop from §10).
  isHitstopActive(nowMs: number): boolean {
    return nowMs < this.hitstopUntilMs;
  }

  setConnectionStatus(status: ConnectionStatus): void {
    applyConnectionStatus(
      { overlay: this.connectionOverlay, message: this.connectionMessageEl, retryButton: this.retryButton },
      status,
    );
  }
}
