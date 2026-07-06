// WAITING / GAMEOVER / practice-transition CSS, injected once. The MENU layer's
// CSS (and the shared --spike-* palette custom properties it declares on :root)
// live in menuStyles.ts; this file only styles the in-room lobby screens, which
// M2.9 §3 reskins to semi-transparent glass cards over the live orbiting court
// (opacity ~0.78) using that same palette. The slot grid / map picker / team
// header structure + class names are unchanged (slotAnimation guard).
let stylesInjected = false;

export function injectLobbyStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .lobby-screen { position: fixed; inset: 0; display: none; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--spike-cream, #fff6e8); font-family: system-ui, sans-serif; z-index: 20; }
    .lobby-waiting, .lobby-gameover, .lobby-transition { background: radial-gradient(120% 120% at 20% 20%, rgba(6,9,24,0.6) 0%, rgba(4,6,18,0.82) 100%); }

    .lobby-glass-card { display: flex; flex-direction: column; align-items: center; gap: 12px; box-sizing: border-box; max-width: min(560px, 92vw); padding: clamp(22px, 3vw, 34px); background: rgba(11,16,38,0.62); border: 1px solid rgba(255,255,255,0.13); border-radius: 20px; box-shadow: 0 24px 60px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08); backdrop-filter: blur(14px) saturate(140%); -webkit-backdrop-filter: blur(14px) saturate(140%); }

    .lobby-title { margin: 0 0 4px; font-size: clamp(30px, 5vw, 46px); font-weight: 900; font-style: italic; letter-spacing: -0.01em; transform: skew(-6deg); background: linear-gradient(96deg, var(--spike-orange, #ff8a2a), #ffd166 60%, #fff2b0); -webkit-background-clip: text; background-clip: text; color: transparent; -webkit-text-fill-color: transparent; }

    .lobby-button { padding: 10px 20px; font-size: 16px; border-radius: 6px; border: none; background: rgba(255,255,255,0.14); color: var(--spike-cream, #fff6e8); cursor: pointer; font-weight: 700; transition: transform 150ms cubic-bezier(0.16,1,0.3,1), background 150ms ease; }
    .lobby-button:hover:not(:disabled) { transform: translateY(-2px); background: rgba(255,255,255,0.2); }
    .lobby-button:disabled { opacity: 0.4; cursor: not-allowed; }
    .lobby-button-primary { background: linear-gradient(96deg, var(--spike-orange, #ff8a2a), #ffab4d); color: var(--spike-navy, #0b1026); }
    .lobby-button-small { padding: 6px 12px; font-size: 13px; }
    .lobby-button-ghost { background: transparent; border: 1px solid rgba(255,255,255,0.25); }

    .lobby-code-label { color: rgba(255,246,232,0.7); font-size: 14px; }
    .lobby-code-display { font-size: 30px; font-weight: 900; letter-spacing: 0.08em; color: var(--spike-cream, #fff6e8); background: rgba(0,0,0,0.28); padding: 8px 20px; border-radius: 8px; user-select: all; border: 1px solid rgba(255,138,42,0.35); }
    .lobby-team-hint { color: rgba(255,246,232,0.65); font-size: 13px; margin-top: 4px; }
    .lobby-slot-grid { display: flex; gap: 20px; margin-top: 8px; }
    .lobby-slot-col { display: flex; flex-direction: column; gap: 8px; width: 190px; }
    .lobby-slot-header { display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 800; font-size: 17px; padding: 6px; border-radius: 8px; }
    .lobby-slot-col-A .lobby-slot-header { background: rgba(63,167,255,0.25); color: #8fd0ff; }
    .lobby-slot-col-B .lobby-slot-header { background: rgba(255,92,92,0.25); color: #ff9c9c; }
    .lobby-team-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lobby-team-name-edit { background: transparent; border: none; color: inherit; cursor: pointer; font-size: 13px; opacity: 0.7; padding: 0; line-height: 1; }
    .lobby-team-name-edit:hover { opacity: 1; }
    .lobby-team-name-input { width: 110px; font-size: 15px; font-weight: 700; text-align: center; border-radius: 4px; border: 1px solid rgba(255,255,255,0.4); background: rgba(0,0,0,0.3); color: inherit; padding: 2px 4px; }
    .lobby-slot-card { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 10px 12px; border-radius: 8px; min-height: 20px; font-size: 15px; box-sizing: border-box; }
    @keyframes lobby-slot-pop { 0% { transform: scale(0.82); opacity: 0.35; } 55% { transform: scale(1.05); opacity: 1; } 100% { transform: scale(1); opacity: 1; } }
    .lobby-slot-card-anim { animation: lobby-slot-pop 260ms ease; }
    .lobby-slot-filled { background: rgba(255,255,255,0.1); font-weight: 600; }
    .lobby-slot-col-A .lobby-slot-filled { border-left: 3px solid var(--spike-blue, #3fa7ff); }
    .lobby-slot-col-B .lobby-slot-filled { border-left: 3px solid var(--spike-red, #ff5c5c); }
    .lobby-slot-self { background: rgba(63,167,255,0.28); outline: 2px solid rgba(255,255,255,0.5); }
    .lobby-slot-empty { border: 2px dashed rgba(255,255,255,0.3); color: rgba(255,246,232,0.55); justify-content: center; cursor: pointer; transition: border-color 120ms, color 120ms, background 120ms, transform 120ms; }
    .lobby-slot-empty:hover { border-color: var(--spike-orange, #ff8a2a); color: #fff; background: rgba(255,138,42,0.12); transform: translateY(-1px); }
    .lobby-slot-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lobby-slot-badges { display: flex; gap: 4px; flex-shrink: 0; }
    .lobby-badge { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 999px; }
    .lobby-badge-host { background: #ffcf5c; color: #3a2a00; }
    .lobby-badge-captain { background: #b28cff; color: #1a0f33; }
    .lobby-badge-you { background: var(--spike-blue, #3fa7ff); color: #04121f; }
    .lobby-map-label { color: rgba(255,246,232,0.7); font-size: 13px; margin-top: 4px; }
    .lobby-map-picker { display: flex; gap: 10px; }
    .lobby-map-card { padding: 8px 20px; border-radius: 8px; border: 2px solid rgba(255,255,255,0.25); background: rgba(255,255,255,0.06); color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; }
    .lobby-map-card:disabled { cursor: default; }
    .lobby-map-card-selected { border-color: #ffcf5c; background: rgba(255,207,92,0.18); color: #ffcf5c; }
    .lobby-hint { color: rgba(255,246,232,0.6); font-size: 13px; min-height: 16px; }
    .lobby-final-score { font-size: 40px; font-weight: 900; color: var(--spike-cream, #fff6e8); }

    /* §5 — practice "進入練習場…" transition card */
    .lobby-transition-card { text-align: center; padding: clamp(28px, 4vw, 44px) clamp(40px, 6vw, 72px); }
    .lobby-transition-title { font-size: clamp(24px, 3.5vw, 38px); font-weight: 900; font-style: italic; color: var(--spike-orange, #ff8a2a); letter-spacing: 0.02em; }
    .lobby-transition-sub { margin-top: 8px; font-size: 14px; letter-spacing: 0.22em; color: rgba(255,246,232,0.6); }
  `;
  document.head.appendChild(style);
}
