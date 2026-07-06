import type { MapId } from '@spike/shared';
import type { CourtHandle } from './court';
import type { EnvironmentTheme, SceneRenderer } from './renderer';

// M2.7 §4 — indoor vs outdoor environment: ground/backdrop/lighting only, the
// court lines + net stay identical (gameplay visuals unchanged).
interface MapTheme extends EnvironmentTheme {
  groundColor: number;
}

const INDOOR: MapTheme = {
  groundColor: 0x8a6a45, // wood-tone floor
  backgroundColor: 0x24262e, // gym wall/ceiling
  ambientColor: 0xdbe8ff,
  ambientIntensity: 0.75,
  directionalColor: 0xffffff, // cool white
  directionalIntensity: 0.85,
  directionalPos: [5, 12, 5],
};

const OUTDOOR: MapTheme = {
  groundColor: 0xd9c48b, // sand
  backgroundColor: 0x7ec8f0, // sky blue
  ambientColor: 0xfff0d8,
  ambientIntensity: 0.6,
  directionalColor: 0xffdca8, // warm sun
  directionalIntensity: 1.05,
  directionalPos: [8, 14, 3],
};

const THEMES: Record<MapId, MapTheme> = { indoor: INDOOR, outdoor: OUTDOOR };

// Applies the lobby's chosen map to both the renderer (background/lighting)
// and the court (ground tint). Called once per LobbyState broadcast — cheap,
// and only visually changes again if the host flips the map before the match
// starts (§4: clients keep whatever map was current when the match began).
export function applyMapEnvironment(scene: SceneRenderer, court: CourtHandle, map: MapId): void {
  const theme = THEMES[map];
  scene.applyEnvironment(theme);
  court.setGroundColor(theme.groundColor);
}
