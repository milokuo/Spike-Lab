// M2.9 §3/§6 — title-menu CSS, injected once. Kept out of menuScreen.ts (mirrors
// hudStyles.ts / lobbyStyles.ts) and is the single definition point for the
// SPIKE LAB palette custom properties, declared on :root so the reskinned
// WAITING / GAMEOVER glass cards (lobbyStyles.ts) share the exact same tokens.
//
// Design direction (spec §3): competitive-arcade × broadcast. Left-deep /
// right-transparent scrim over the live orbiting 3D court, gradient skewed
// title, skewed parallelogram mode cards, a "player nameplate" input row. Motion
// is transform/opacity only, 150–300ms, and fully disabled under
// prefers-reduced-motion.
let stylesInjected = false;

export function injectMenuStyles(): void {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --spike-navy: #0b1026;
      --spike-blue: #3fa7ff;
      --spike-red: #ff5c5c;
      --spike-orange: #ff8a2a;
      --spike-cream: #fff6e8;
    }

    /* §3 — left-deep, right-transparent diagonal scrim + soft vignette so the
       orbiting court (§4) reads through the right/lower area behind the menu. */
    .lobby-menu {
      justify-content: stretch;
      align-items: stretch;
      gap: 0;
      padding: clamp(20px, 4vw, 56px);
      box-sizing: border-box;
      background:
        radial-gradient(130% 120% at 14% 26%, rgba(3,5,14,0) 42%, rgba(3,5,14,0.66) 100%),
        linear-gradient(103deg, rgba(4,6,18,0.94) 0%, rgba(6,9,24,0.74) 46%, rgba(8,12,30,0.34) 100%);
    }
    .menu-stage {
      position: relative;
      flex: 1 1 auto;
      display: grid;
      grid-template-rows: auto 1fr auto;
      gap: clamp(18px, 3vh, 40px);
      min-height: 0;
    }

    /* ---- brand block (top-left biased) ---- */
    .menu-brand { display: flex; align-items: center; gap: clamp(12px, 1.6vw, 22px); }
    .menu-logo { display: inline-flex; width: clamp(46px, 6vw, 84px); color: var(--spike-orange); filter: drop-shadow(0 4px 12px rgba(255,138,42,0.35)); }
    .menu-logo svg { width: 100%; height: auto; animation: menu-logo-spin 18s linear infinite; }
    .menu-brand-text { display: flex; flex-direction: column; gap: 8px; }
    .menu-title {
      margin: 0;
      font-size: clamp(48px, 9vw, 110px);
      font-weight: 900;
      font-style: italic;
      line-height: 0.92;
      letter-spacing: -0.01em;
      transform: skew(-6deg);
      background: linear-gradient(96deg, var(--spike-orange) 0%, #ffd166 55%, #fff2b0 100%);
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      -webkit-text-fill-color: transparent;
      filter: drop-shadow(0 6px 18px rgba(0,0,0,0.45));
    }
    .menu-subtitle {
      align-self: flex-start;
      transform: skew(-6deg);
      background: rgba(255,138,42,0.16);
      border: 1px solid rgba(255,138,42,0.5);
      color: var(--spike-cream);
      font-size: clamp(13px, 1.5vw, 17px);
      font-weight: 800;
      letter-spacing: 0.28em;
      padding: 4px 14px 4px 18px;
      border-radius: 4px;
    }

    /* ---- mode cards (skewed parallelograms, staggered entrance) ---- */
    .menu-cards { grid-row: 2; grid-column: 1; align-self: center; justify-self: start; display: flex; gap: clamp(16px, 2.2vw, 30px); flex-wrap: wrap; max-width: 100%; }
    .menu-card {
      position: relative;
      width: clamp(230px, 24vw, 320px);
      padding: clamp(20px, 2vw, 30px) clamp(24px, 2.4vw, 38px);
      text-align: left;
      color: var(--spike-cream);
      background: linear-gradient(135deg, rgba(16,22,48,0.92), rgba(10,14,34,0.86));
      border: 1px solid rgba(255,255,255,0.14);
      border-left: 4px solid var(--spike-orange);
      clip-path: polygon(7% 0, 100% 0, 93% 100%, 0 100%);
      cursor: pointer;
      overflow: hidden;
      opacity: 0;
      transform: translateX(-26px) skewX(-3deg);
      animation: menu-card-in 320ms cubic-bezier(0.16,1,0.3,1) forwards;
      transition: transform 180ms cubic-bezier(0.16,1,0.3,1), box-shadow 180ms ease, border-color 180ms ease;
    }
    .menu-card-practice { --card-accent: var(--spike-orange); animation-delay: 60ms; }
    .menu-card-versus { --card-accent: var(--spike-blue); border-left-color: var(--spike-blue); animation-delay: 150ms; }
    .menu-card:hover, .menu-card:focus-visible {
      transform: translate(0, -4px) skewX(-3deg);
      border-color: var(--card-accent);
      box-shadow: 0 18px 40px rgba(0,0,0,0.5), 0 0 0 1px var(--card-accent), 0 0 22px -4px var(--card-accent);
      outline: none;
    }
    .menu-card:active { transform: translate(0, -1px) scale(0.985) skewX(-3deg); }
    .menu-card-kicker { font-size: 12px; font-weight: 900; letter-spacing: 0.32em; color: var(--card-accent); }
    .menu-card-title { margin: 8px 0 6px; font-size: clamp(24px, 2.4vw, 34px); font-weight: 900; font-style: italic; }
    .menu-card-desc { font-size: clamp(12px, 1.1vw, 14px); line-height: 1.5; color: rgba(255,246,232,0.72); }
    .menu-card-arrow {
      position: absolute; right: 20px; bottom: 16px;
      font-size: 26px; font-weight: 900; color: var(--card-accent);
      transform: translateX(-8px); opacity: 0;
      transition: transform 180ms cubic-bezier(0.16,1,0.3,1), opacity 180ms ease;
    }
    .menu-card:hover .menu-card-arrow, .menu-card:focus-visible .menu-card-arrow { transform: translateX(0); opacity: 1; }

    /* ---- nameplate input row ---- */
    .menu-namebar { justify-self: start; display: flex; align-items: center; gap: 12px; }
    .menu-namebar-label { font-size: 11px; font-weight: 900; letter-spacing: 0.22em; color: rgba(255,246,232,0.6); }
    .menu-name-input {
      width: clamp(180px, 22vw, 260px);
      padding: 9px 16px;
      font-size: 16px; font-weight: 700; font-style: italic;
      color: var(--spike-cream);
      background: linear-gradient(120deg, rgba(255,255,255,0.09), rgba(255,255,255,0.04));
      border: 1px solid rgba(255,255,255,0.22);
      border-left: 3px solid var(--spike-orange);
      border-radius: 4px;
      transform: skewX(-6deg);
    }
    .menu-name-input::placeholder { color: rgba(255,246,232,0.4); }
    .menu-name-input:focus { outline: none; border-color: var(--spike-orange); box-shadow: 0 0 0 1px var(--spike-orange); }

    /* ---- multiplayer sub-panel (slides into the cards row; brand + nameplate
       stay put and reachable) ---- */
    .menu-panel {
      grid-row: 2; grid-column: 1; align-self: center; justify-self: start;
      display: none; flex-direction: column; align-items: flex-start; justify-content: center;
      gap: 16px;
    }
    .menu-panel.menu-panel-open { display: flex; animation: menu-panel-in 220ms cubic-bezier(0.16,1,0.3,1); }
    .menu-back {
      display: inline-flex; align-items: center; gap: 8px;
      background: none; border: none; color: rgba(255,246,232,0.75);
      font-size: 15px; font-weight: 800; cursor: pointer; padding: 4px 0;
    }
    .menu-back:hover { color: var(--spike-orange); }
    .menu-panel-card {
      display: flex; flex-direction: column; gap: 14px;
      width: clamp(280px, 34vw, 420px);
      padding: clamp(22px, 2.4vw, 32px);
      background: rgba(11,16,38,0.7);
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 16px;
      box-shadow: 0 24px 60px rgba(0,0,0,0.5);
      backdrop-filter: blur(12px) saturate(140%);
      -webkit-backdrop-filter: blur(12px) saturate(140%);
    }
    .menu-btn {
      padding: 12px 22px; font-size: 16px; font-weight: 800; font-style: italic;
      border: none; border-radius: 6px; cursor: pointer;
      color: var(--spike-cream); background: rgba(255,255,255,0.14);
      transform: skewX(-6deg);
      transition: transform 160ms cubic-bezier(0.16,1,0.3,1), background 160ms ease, box-shadow 160ms ease;
    }
    .menu-btn > span { display: inline-block; transform: skewX(6deg); }
    .menu-btn:hover { transform: skewX(-6deg) translateY(-2px); }
    .menu-btn-primary { background: linear-gradient(96deg, var(--spike-orange), #ffab4d); color: var(--spike-navy); box-shadow: 0 10px 26px -8px var(--spike-orange); }
    .menu-btn-primary:hover { box-shadow: 0 16px 34px -8px var(--spike-orange); }
    .menu-panel-divider { display: flex; align-items: center; gap: 10px; color: rgba(255,246,232,0.5); font-size: 12px; letter-spacing: 0.08em; }
    .menu-panel-divider::before, .menu-panel-divider::after { content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.16); }
    .menu-join-row { display: flex; gap: 10px; }
    .menu-code-input {
      flex: 1; min-width: 0; padding: 11px 14px;
      font-size: 16px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase;
      color: var(--spike-cream);
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.2); border-radius: 6px;
    }
    .menu-code-input::placeholder { color: rgba(255,246,232,0.4); text-transform: none; letter-spacing: normal; }
    .menu-code-input:focus { outline: none; border-color: var(--spike-blue); box-shadow: 0 0 0 1px var(--spike-blue); }
    .menu-error { color: var(--spike-red); font-size: 14px; min-height: 18px; font-weight: 700; }

    @keyframes menu-logo-spin { to { transform: rotate(360deg); } }
    @keyframes menu-card-in { to { opacity: 1; transform: translateX(0) skewX(-3deg); } }
    @keyframes menu-panel-in { from { opacity: 0; transform: translateX(18px); } to { opacity: 1; transform: translateX(0); } }

    @media (prefers-reduced-motion: reduce) {
      .menu-logo svg { animation: none; }
      .menu-card { opacity: 1; transform: skewX(-3deg); animation: none; }
      .menu-panel.menu-panel-open { animation: none; }
      .menu-card, .menu-card-arrow, .menu-btn { transition: none; }
    }
  `;
  document.head.appendChild(style);
}
