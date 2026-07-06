// Static text/color lookup tables for HUD feedback popups. Extracted from
// hud.ts to keep that file focused on HUD behaviour/state (mirrors hudDom.ts).
import { OVERCHARGE_MAX, type DeathCause, type TeamNames, type TouchGrade, type TouchRejection } from '@spike/shared';

export const GRADE_COLOR: Record<TouchGrade, string> = {
  PERFECT: '#ffe14d',
  GOOD: '#7cfc7c',
  OK: '#9fd3ff',
  WHIFF: '#ff6b6b',
};

// M2.2 §3 dive presentation feedback text.
export const DIVE_TEXT: Record<'dive_success' | 'dive_fail', { text: string; color: string }> = {
  dive_success: { text: '救球!', color: '#7cfc7c' },
  dive_fail: { text: '撲空!', color: '#ff6b6b' },
};

// M2.7 §2 — illegal-touch rejection feedback (red; no key lock, server rejects
// every repeat). Shares the same popup slot/timing as the dive feedback text.
export const ILLEGAL_TOUCH_COLOR = '#ff4d4d';
export const ILLEGAL_TOUCH_TEXT: Record<TouchRejection, string> = {
  illegal_double: '連擊犯規！',
  illegal_count: '觸球次數用盡！',
};

// M2.7 §3 — DeathCause -> banner reason text.
export const DEATH_CAUSE_TEXT: Record<DeathCause, string> = {
  ground: '球落地',
  out: '球出界',
};

// M2.9 §5 — practice sandbox death banner: score is frozen 0:0 so nobody
// "scored"; the neutral line just cues the auto re-serve loop.
export const PRACTICE_RESET_TEXT = '球落地 — 重新發球';

// M2.9 §5 — practice-mode HUD chip label.
export const PRACTICE_CHIP_LABEL = '練習模式';
export const PRACTICE_LEAVE_LABEL = '離開';

export const DEFAULT_TEAM_NAMES: TeamNames = { A: 'A 隊', B: 'B 隊' };

// Controls help line (§4/§5; M2.7 §8 adds wheel/Q-E cell select + FPV LMB).
export const CONTROLS_HELP = '空白鍵 跳 · J/K/L 模式 · H／FPV左鍵 蓄力 · 滾輪／Q/E 選格 · V 視角';

// M2.3 §3.2 — serve mechanic hint, shown only while it's your serve.
export const SERVE_HINT = '指針決定方向、蓄力決定力道、跳起時放開＝跳發';

// M2.4 §5 — overcharge note beside the charge bar (red zone = more power, less accuracy).
export const OVERCHARGE_NOTE = '紅區＝過蓄：力量更大，但過蓄會失準';

// M2.4 §2 — FPV pointer-lock lost prompt (Esc / alt-tab / focus). Click to restore; only V exits.
export const FPV_LOCK_PROMPT = '點擊畫面恢復視角控制';

// M2.4 §5 — charge bar scaled to the overcharge cap so the last ~23% reads as the red zone.
export const CHARGE_NORMAL_PCT = (1 / OVERCHARGE_MAX) * 100;
