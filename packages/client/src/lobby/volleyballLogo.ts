// M2.9 §3 — inline stroke-style volleyball logo shown beside the SPIKE LAB
// title. Pure static markup (no external asset / font / CDN, per the round's
// zero-asset rule); `stroke="currentColor"` lets menuStyles tint it with the
// orange accent and the wrapper class drives the slow idle spin (disabled under
// prefers-reduced-motion). Extracted from menuScreen.ts (spec §6 threshold).
export function createVolleyballLogo(): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'menu-logo';
  wrap.setAttribute('aria-hidden', 'true');
  // Circle + three crossing seams — reads as a paneled volleyball at any size.
  wrap.innerHTML = `
    <svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4"
         stroke-linecap="round" stroke-linejoin="round">
      <circle cx="50" cy="50" r="44" stroke-width="5" />
      <path d="M50 6 C 30 34 30 62 46 94" />
      <path d="M94 40 C 62 44 40 60 20 88" />
      <path d="M8 46 C 40 52 66 46 92 66" />
    </svg>`;
  return wrap;
}
