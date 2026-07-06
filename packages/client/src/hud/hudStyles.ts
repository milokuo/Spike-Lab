import {
  DIVE_FEEDBACK_DURATION_MS,
  HUD_POPUP_DURATION_MS,
  PLAYER_LEFT_BANNER_DURATION_MS,
  SCORE_BANNER_DURATION_MS,
} from '../config';
import { SKILL_GRID_STYLES } from './skillGrid';
import { SERVE_ARC_STYLES } from './serveArc';
import { SCOREBOARD_STYLES } from './scoreboard';

// All HUD CSS, injected once. Kept out of hud.ts so that file stays focused on
// behaviour rather than a large style string.
let stylesInjected = false;

export function injectHudStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    ${SCOREBOARD_STYLES}
    .hud-roster { position: fixed; top: 12px; right: 16px; display: flex; gap: 16px; pointer-events: none; }
    .hud-roster-column { display: flex; flex-direction: column; gap: 2px; background: rgba(0,0,0,0.3); border-radius: 6px; padding: 6px 10px; min-width: 90px; }
    .hud-roster-heading { color: #9fd3ff; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; }
    .hud-roster-row { color: #fff; font-size: 13px; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
    .hud-roster-row-self { color: #ffe14d; font-weight: 700; }
    .hud-bottom-bar { position: fixed; bottom: 16px; left: 16px; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
    .hud-labeled { display: flex; align-items: center; gap: 8px; }
    .hud-label { color: #fff; font-size: 12px; width: 56px; text-shadow: 0 1px 2px rgba(0,0,0,0.6); }
    .hud-bar-track { width: 160px; height: 10px; background: rgba(255,255,255,0.15); border-radius: 5px; overflow: hidden; }
    .hud-bar-fill { height: 100%; width: 0%; transition: width 0.1s linear; }
    .hud-stamina-fill { background: #4dd67c; }
    .hud-charge-fill { background: #ffb03f; }
    .hud-charge-fill.hud-charge-over { background: #ff4040; animation: hud-charge-pulse 0.4s ease-in-out infinite; }
    @keyframes hud-charge-pulse { 0%, 100% { filter: brightness(1); } 50% { filter: brightness(1.75); } }
    .hud-overcharge-note { color: rgba(255,128,128,0.85); font-size: 11px; text-shadow: 0 1px 2px rgba(0,0,0,0.7); }
    .hud-controls-help { color: rgba(255,255,255,0.75); font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,0.7); margin-top: 2px; }
    .hud-fpv-lock-prompt { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; color: #fff; font-size: 22px; font-weight: 700; text-shadow: 0 2px 8px rgba(0,0,0,0.85); background: rgba(0,0,0,0.28); pointer-events: none; z-index: 8; }
    .hud-serve-hint { position: fixed; bottom: 84px; left: 50%; transform: translateX(-50%); color: #ffe14d; font-size: 14px; font-weight: 600; text-shadow: 0 2px 4px rgba(0,0,0,0.8); pointer-events: none; }
    ${SKILL_GRID_STYLES}
    ${SERVE_ARC_STYLES}
    .hud-grade-popup { position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%) scale(0.8); font-size: 42px; font-weight: 800; opacity: 0; pointer-events: none; text-shadow: 0 2px 8px rgba(0,0,0,0.8); }
    .hud-grade-popup-show { animation: hud-grade-pop ${HUD_POPUP_DURATION_MS}ms ease-out; }
    @keyframes hud-grade-pop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); } 15% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1); } }
    .hud-dive-feedback { position: fixed; top: 56%; left: 50%; transform: translate(-50%, -50%); font-size: 34px; font-weight: 800; opacity: 0; pointer-events: none; text-shadow: 0 2px 8px rgba(0,0,0,0.85); }
    .hud-dive-feedback-show { animation: hud-dive-pop ${DIVE_FEEDBACK_DURATION_MS}ms ease-out; }
    @keyframes hud-dive-pop { 0% { opacity: 0; transform: translate(-50%, -40%) scale(0.7); } 20% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); } 100% { opacity: 0; transform: translate(-50%, -50%) scale(1); } }
    .hud-player-left-banner { position: fixed; top: 90px; left: 50%; transform: translate(-50%, -8px); background: rgba(20,10,10,0.85); color: #ffb0b0; font-size: 16px; font-weight: 600; padding: 8px 16px; border-radius: 6px; opacity: 0; pointer-events: none; }
    .hud-player-left-banner-show { animation: hud-player-left-pop ${PLAYER_LEFT_BANNER_DURATION_MS}ms ease-out; }
    @keyframes hud-player-left-pop { 0% { opacity: 0; transform: translate(-50%, -8px); } 10% { opacity: 1; transform: translate(-50%, 0); } 85% { opacity: 1; } 100% { opacity: 0; } }
    .hud-score-banner { position: fixed; top: 32%; left: 50%; transform: translate(-50%, -50%) scale(0.85); font-size: 30px; font-weight: 800; padding: 12px 28px; border-radius: 10px; opacity: 0; pointer-events: none; text-shadow: 0 2px 6px rgba(0,0,0,0.7); border: 2px solid transparent; }
    .hud-score-banner-A { background: rgba(63,167,255,0.24); border-color: #3fa7ff; color: #cfe9ff; }
    .hud-score-banner-B { background: rgba(255,92,92,0.24); border-color: #ff5c5c; color: #ffd6d6; }
    .hud-score-banner-neutral { background: rgba(11,16,38,0.6); border-color: rgba(255,138,42,0.55); color: #fff6e8; }
    .hud-score-banner-show { animation: hud-score-banner-pop ${SCORE_BANNER_DURATION_MS}ms ease-out; }
    @keyframes hud-score-banner-pop { 0% { opacity: 0; transform: translate(-50%, -50%) scale(0.85); } 12% { opacity: 1; transform: translate(-50%, -50%) scale(1.04); } 20% { transform: translate(-50%, -50%) scale(1); } 82% { opacity: 1; } 100% { opacity: 0; } }
    .hud-flash { position: fixed; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
    .hud-flash-show { animation: hud-flash-pop 150ms ease-out; }
    @keyframes hud-flash-pop { 0% { opacity: 0.55; } 100% { opacity: 0; } }
    .hud-connection-overlay { position: fixed; inset: 0; background: rgba(5,5,10,0.85); display: none; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: #fff; font-size: 20px; z-index: 10; }
    .hud-retry-button { padding: 10px 20px; font-size: 16px; border-radius: 6px; border: none; background: #3fa7ff; color: #04121f; cursor: pointer; font-weight: 700; }
    .hud-practice-chip { position: fixed; top: 14px; left: 16px; display: none; align-items: center; gap: 10px; padding: 6px 8px 6px 14px; background: rgba(11,16,38,0.72); border: 1px solid rgba(255,138,42,0.55); border-radius: 999px; box-shadow: 0 4px 14px rgba(0,0,0,0.4); pointer-events: auto; z-index: 9; }
    .hud-practice-label { color: #ff8a2a; font-size: 13px; font-weight: 800; letter-spacing: 0.06em; }
    .hud-practice-leave { padding: 4px 13px; font-size: 12px; font-weight: 700; border: none; border-radius: 999px; background: rgba(255,255,255,0.14); color: #fff6e8; cursor: pointer; transition: background 150ms ease, color 150ms ease; }
    .hud-practice-leave:hover { background: rgba(255,138,42,0.9); color: #0b1026; }
  `;
  document.head.appendChild(style);
}
