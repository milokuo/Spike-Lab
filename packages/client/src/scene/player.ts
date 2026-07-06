// M2.5 §2 — the player character was reworked from a single tinted capsule into
// a small module set under scene/character/ (body + cartoon head/face + two
// procedurally-posed arms + billboard nametag). This file is the barrel so
// call sites keep a stable `scene/player` import path.
export { PlayerCharacter, type CharacterFrame } from './character/playerCharacter';
export { MODE_TINT } from './character/characterConstants';
