// Rally-point scoring (spec §9): a point every rally, first to 15, win by 2,
// hard cap at 21. Pure functions over an immutable ScoreState — no mutation.
import { RALLY_TARGET, WIN_BY, RALLY_CAP, type ScoreState, type Side } from '@spike/shared';

/** Apply one rally point to the scoring side, returning a NEW ScoreState. */
export function applyPoint(score: Readonly<ScoreState>, side: Side): ScoreState {
  return side === 'A' ? { A: score.A + 1, B: score.B } : { A: score.A, B: score.B + 1 };
}

/** Winner if the game is decided, else null (spec §9: 15, win-by-2, cap 21). */
export function winnerOf(score: Readonly<ScoreState>): Side | null {
  const { A, B } = score;
  const leader: Side = A >= B ? 'A' : 'B';
  const top = Math.max(A, B);
  const lead = Math.abs(A - B);

  if (top >= RALLY_CAP) return leader; // cap forces a decision even at 1-point lead
  if (top >= RALLY_TARGET && lead >= WIN_BY) return leader;
  return null;
}

export function isGameOver(score: Readonly<ScoreState>): boolean {
  return winnerOf(score) !== null;
}
