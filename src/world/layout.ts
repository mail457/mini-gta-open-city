/**
 * SHARED CITY LAYOUT CONSTANTS — Lead-owned (this is a contract, not an implementation).
 *
 * Grid of streets. All coordinates in metres. The playable area is a square.
 *   x = X_OFFSET + i * BLOCK     for i in 0..STREETS-1   (N-S streets)
 *   z = Z_OFFSET + j * BLOCK     for j in 0..STREETS-1   (E-W streets)
 * BLOCK = 68 → 5 x 68 = 272 m between the outer street centrelines.
 *
 * Agent 1 MUST build the world from these numbers and MUST expose the POIs below.
 */

export const STREETS = 5;
export const BLOCK = 68;
export const X_OFFSET = -136; // west-most N-S street centre
export const Z_OFFSET = -136; // north-most E-W street centre

/** Full half width of street i (i = 0 or 4 => arterial, wider). */
export function streetHalfWidth(i: number): number {
  return i === 0 || i === STREETS - 1 ? 10 : 8;
}

export const SIDEWALK_WIDTH = 4.5;

/** Centre line of N-S street i (constant x). */
export const nsX = (i: number): number => X_OFFSET + i * BLOCK;
/** Centre line of E-W street j (constant z). */
export const ewZ = (j: number): number => Z_OFFSET + j * BLOCK;

/** Outer edge of the outermost pavements — also the world boundary for play. */
export const WORLD_MIN = X_OFFSET - streetHalfWidth(0) - SIDEWALK_WIDTH; // -150.5
export const WORLD_MAX = X_OFFSET + (STREETS - 1) * BLOCK + streetHalfWidth(STREETS - 1) + SIDEWALK_WIDTH; // 150.5

/** Height of pavements/kerbs (cars ride over them, players walk up). */
export const KERB_HEIGHT = 0.16;

/**
 * Sidewalk corridor radius used for on-foot navigation and pedestrian paths:
 * a ring corridor around each block. Agents may use point queries from
 * `CityWorld.isRoad()` / `groundHeight()` instead of hard-coding.
 */
export const SIDEWALK_CORRIDOR = 2.2;

/** Named points of interest that MUST exist in `CityWorld.pois`. */
export const POI_SPAWN_PLAYER = 'spawn';
/** Mission start marker — on a pavement, reachable on foot from spawn. */
export const POI_MISSION_START = 'missionStart';
/** Mission drop-off — on the road beside the destination building. */
export const POI_MISSION_DROP = 'missionDrop';
/** Alsace Park — the plaza / green space in block (2,2). */
export const POI_PARK = 'park';
/** Alley parking lot where parked cars are staged (block (3,1)). */
export const POI_PARKING = 'parking';
