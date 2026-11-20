/**
 * MINI GTA — OPEN CITY
 * =====================
 * FROZEN INTERFACE CONTRACT shared by all development agents.
 *
 * Every module in the project talks to the rest of the game exclusively through
 * the types declared in this file. Do not change an existing exported signature
 * without notifying the Lead Director (the Lead owns this file).
 *
 * Units: metres, seconds, radians. World axes: +X east, +Z south, +Y up.
 */

import type * as THREE from 'three';

/* -------------------------------------------------------------------------- */
/* Shared math helpers (Vector3-compatible, JSON-serialisable)                 */
/* -------------------------------------------------------------------------- */

/** Axis-aligned bounding box in the XZ ground plane (used by collision). */
export interface Rect {
  /** Centre X */
  x: number;
  /** Centre Z */
  z: number;
  /** Half extent along X */
  hx: number;
  /** Half extent along Z */
  hz: number;
  /** Optional: collision height. Defaults to `Infinity` (blocks walking & cars). */
  height?: number;
  /** 'ground' = walkable ramp, no blocking (steps/kerbs only change groundHeight). */
  kind?: 'building' | 'prop' | 'ground';
}

export interface XZ {
  x: number;
  z: number;
}

/* -------------------------------------------------------------------------- */
/* Keyboard / mouse input (owned by src/core/input.ts)                        */
/* -------------------------------------------------------------------------- */

export interface InputFrame {
  /** Movement axis X: -1 (left/A) .. +1 (right/D) */
  moveX: number;
  /** Movement axis Y: -1 (back/S) .. +1 (forward/W) */
  moveY: number;
  sprint: boolean;
  jump: boolean;
  /** E pressed this frame (edge triggered) */
  interact: boolean;
  /** Escape or P pressed this frame (edge triggered) */
  pauseToggle: boolean;
  handbrake: boolean;
  /** Accumulated mouse delta since previous frame, in pixels */
  lookX: number;
  lookY: number;
}

export interface InputState extends InputFrame {
  /** True while the game input should be consumed (pointer locked / playing) */
  active: boolean;
}

/* -------------------------------------------------------------------------- */
/* Audio (owned by src/core/audio.ts)                                          */
/* -------------------------------------------------------------------------- */

export type SoundName = 'step' | 'jump' | 'coin' | 'enterCar' | 'exitCar' | 'crash' | 'horn' | 'missionStart' | 'missionComplete' | 'ui';

export interface AudioBus {
  play(name: SoundName, volume?: number): void;
  /** Engine drone parameters. rpm in [0,1]. */
  setEngine(rpm: number, playing: boolean): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Collision world (implemented by Agent 1 World module)                       */
/* -------------------------------------------------------------------------- */

/** A spatial query service the world exposes. Character + vehicle physics use it. */
export interface CollisionService {
  /** All colliders as {x,z,hx,hz}. Used by broad-phase only if spatial index unavailable. */
  readonly colliders: readonly Rect[];
  /** Push a circle (radius r at cx,cz) out of all static colliders. Mutates/returns corrected centre. */
  resolveCircle(cx: number, cz: number, r: number): XZ;
  /** True if the circle overlaps any collider (used for spawn validation). */
  overlapsCircle(cx: number, cz: number, r: number): boolean;
  /** True if (x,z) is inside walkable ground (within world bounds). */
  inBounds(x: number, z: number, margin?: number): boolean;
  /** Ground height at a point (flat city => 0, but park kerbs etc. may vary). */
  groundHeight(x: number, z: number): number;
  /**
   * Returns true when the point lies on drivable road surface.
   * Used by traffic AI and the mission to keep waypoints sane.
   */
  isRoad(x: number, z: number): boolean;
}

/* -------------------------------------------------------------------------- */
/* World description (Agent 1 output consumed by everyone)                     */
/* -------------------------------------------------------------------------- */

export interface WorldStats {
  buildings: number;
  colliders: number;
  drawCalls: number;
  triangles: number;
}

export interface CityWorld extends CollisionService {
  /** Root group added to the scene once. */
  readonly group: THREE.Group;
  /** New THREE.Vector3(minX, 0, minZ) .. max — the playable square. */
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /**
   * Road network graph for traffic + checks. Nodes are lane waypoints.
   * Agent 1 builds it; Agent 3 consumes it to drive traffic.
   */
  readonly roadGraph: RoadGraph;
  /** Named points of interest (spawn, mission start, mission drop-off, park ...). */
  readonly pois: Record<string, XZ>;
  /** Ground height sampler + world update (e.g. animated light flicker). Keep cheap. */
  update(dt: number, elapsed: number): void;
  stats(): WorldStats;
  dispose(): void;
}

export interface RoadGraphNode {
  id: number;
  x: number;
  z: number;
}

export interface RoadGraphEdge {
  from: number;
  to: number;
  length: number;
}

/** Directed lane graph. Right-hand traffic: each direction has its own lane offset. */
export interface RoadGraph {
  nodes: RoadGraphNode[];
  /** Outgoing edges per node (lane waypoint) id. Every node has >= 1 outgoing edge. */
  edges: Map<number, RoadGraphEdge[]>;
  /** Find the nearest node (by XZ distance) usable as a lane point. */
  nearestNode(x: number, z: number): number;
  /** Half width of a lane offset from the road centreline, in metres. */
  laneWidth: number;
  /**
   * Follow the lane graph from `node`, continuing straight through intersections
   * when possible and otherwise turning randomly. Returns every waypoint the
   * vehicle passes, INCLUDING rounded corner points so traffic doesn't cut sharp
   * 90° corners. Must always terminate (no infinite loops).
   */
  pathFrom(node: number, stopDistance: number, rng: () => number): XZ[];
}

/* -------------------------------------------------------------------------- */
/* Physics bodies & shared character/vehicle interface (Agent 2)              */
/* -------------------------------------------------------------------------- */

export interface PlayerController {
  readonly object: THREE.Object3D;
  readonly position: THREE.Vector3;
  /** Facing yaw in radians. */
  readonly yaw: number;
  readonly speed: number;
  readonly isGrounded: boolean;
  onFoot: boolean;
  /** Walk cycle phase in [0, 2π), used by the game for footstep sounds. */
  readonly walkPhase: number;
  /** True on the fixed step where the player jumped (edge). */
  readonly didJump: boolean;
  update(dt: number, input: InputFrame, cameraYaw: number): void;
  setPosition(x: number, z: number, yaw?: number): void;
  /** Avatar root (mesh hierarchy). Game adds/removes it from the scene when entering/exiting cars. */
  dispose(): void;
}

export type VehicleTypeId = 'sedan' | 'sport' | 'van';

export interface VehicleSpec {
  id: VehicleTypeId;
  label: string;
  /** Max forward speed m/s */
  maxSpeed: number;
  /** Reverse max speed m/s (positive number) */
  maxReverse: number;
  accel: number; // m/s^2
  brake: number;
  /** Steering rate at low speed (rad/s) */
  steerRate: number;
  /** Lateral grip: higher = less drift (0..1) */
  grip: number;
  /** Body dimensions used for collision (metres) */
  length: number;
  width: number;
  height: number;
  /** Render colour */
  color: number;
}

export interface Vehicle {
  spec: VehicleSpec;
  position: THREE.Vector3;
  yaw: number;
  /** Signed speed along forward axis, m/s */
  speed: number;
  /** Signed lateral (sideways) speed, m/s. Used for drift visuals + tyres. */
  lateralSpeed: number;
  mesh: THREE.Object3D;
  /** True while the player is driving. */
  driven: boolean;
  /** 'parked' = static until entered; 'traffic' = AI driven; 'player' = player driven. */
  role: 'parked' | 'traffic' | 'player';
  /**
   * Which collision model the vehicle uses with the player-driven physics:
   * 'car' = 3-circle capsule (default), 'traffic' = 2-circle (NPC meshes are shorter).
   */
  shape?: 'car' | 'traffic';
  /** World-space exit point beside the car, pushed out of walls by the caller if needed. */
  exitSide(driverSide: 'left' | 'right'): XZ;
}

/* -------------------------------------------------------------------------- */
/* Player-driven vehicle physics step (implemented by Agent 2)                */
/* -------------------------------------------------------------------------- */

export interface VehiclePhysicsApi {
  /**
   * Integrate one vehicle for dt with the player's input and the world colliders.
   * Must clamp to ground, resolve vehicle-vs-world collisions, and never tunnel.
   * Returns the impact speed (m/s, 0 when no collision) so the game can shake
   * the camera and play a crash sound.
   */
  stepDriven(v: Vehicle, input: InputFrame, world: CollisionService, dt: number): number;
  /**
   * Called every frame for a player-driven vehicle: wheels turn, body pitches/rolls,
   * brake lights, plus any dust/drift effect.
   */
  updateVisuals(v: Vehicle, dt: number, input: InputFrame): void;
  /**
   * Resolve player-driven vehicle vs every other vehicle. Called by the game
   * after stepDriven. Should push this vehicle out (and nudge the other slightly).
   */
  resolveVehicleCollisions(v: Vehicle, others: readonly Vehicle[]): number;
}

/* -------------------------------------------------------------------------- */
/* NPCs & traffic (Agent 3)                                                    */
/* -------------------------------------------------------------------------- */

export interface NPCSystemApi {
  group: THREE.Group;
  /** Make every pedestrian / traffic vehicle avoid the player-driven car within radius. */
  update(dt: number, playerPos: XZ, drivenVehicle: Vehicle | null): void;
  /** Downsampled positions for the minimap (max ~60 entries each). */
  minimapData(): { cars: XZ[]; peds: XZ[] };
  /** Vehicle meshes created for traffic so the player can also enter them. */
  readonly trafficVehicles: readonly Vehicle[];
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* Mission (Agent 3)                                                           */
/* -------------------------------------------------------------------------- */

export type MissionPhase =
  | 'idle'          // no mission running
  | 'meet'          // go to mission start marker on foot
  | 'getVehicle'    // enter any vehicle
  | 'deliver'       // drive to drop-off
  | 'complete'
  | 'failed';

export interface MissionState {
  phase: MissionPhase;
  title: string;
  objective: string;
  /** World-space waypoint to show on HUD + in-world marker; null = none. */
  waypoint: XZ | null;
  /** World-space radius of the waypoint marker. */
  waypointRadius: number;
  /** Time limit remaining in seconds, or null for none. */
  timeLeft: number | null;
  reward: number;
  /** Optional progress text like "Time: 0:42". */
  detail?: string;
  /** Set for one tick when the mission just completed / failed (game reacts once). */
  event?: 'completed' | 'failed' | null;
}

export interface MissionEnv {
  world: CityWorld;
  player: PlayerController;
  getActiveVehicle(): Vehicle | null;
  audio: AudioBus;
  hud: HudApi;
}

export interface MissionApi {
  readonly state: MissionState;
  /** Seconds spent in the delivery phase (for the mission-result screen). */
  readonly deliveryTime: number;
  /** Attach in-world marker meshes to this group. */
  group: THREE.Group;
  start(env: MissionEnv): void;
  update(dt: number, env: MissionEnv): void;
  restart(env: MissionEnv): void;
  dispose(): void;
}

/* -------------------------------------------------------------------------- */
/* HUD / UI (Agent 4)                                                          */
/* -------------------------------------------------------------------------- */

export interface HudData {
  playerHealth: number;
  money: number;
  speedKmh: number;
  inVehicle: boolean;
  mission: MissionState;
  /** Distance in metres to the current waypoint, or null when there is none. */
  distanceToWaypoint: number | null;
  /** Points the minimap needs: player pos/yaw, vehicles, npcs, waypoint. */
  minimap: {
    playerX: number;
    playerZ: number;
    playerYaw: number;
    cars: XZ[];
    peds: XZ[];
    waypoint: XZ | null;
  };
  timeOfDayLabel: string;
  /**
   * Context action shown next to the player ("Press E to enter the sedan").
   * Rendered as a prominent key prompt above the crosshair area.
   */
  prompt?: { key: string; text: string } | null;
  /** One-line objective help, rendered directly under the mission panel. */
  hint?: string | null;
}

export interface MissionResultView {
  success: boolean;
  title: string;
  subtitle: string;
  reward: number;
  timeSeconds: number;
}

export interface HudApi {
  /** Update every frame with authoritative game data. */
  update(data: HudData): void;
  /** Show a transient toast ("MISSION COMPLETE", "+$500", hazards). */
  toast(text: string, kind?: 'info' | 'good' | 'bad', duration?: number): void;
  /**
   * Show the full-screen mission complete / failed panel.
   * `actions` wires the overlay's CONTINUE / RESTART buttons (and Enter / R).
   */
  showMissionResult(result: MissionResultView, actions?: { onContinue?: () => void; onRestart?: () => void }): void;
  clearMissionResult(): void;
}

/* -------------------------------------------------------------------------- */
/* Game state machine (Lead owns src/game/game.ts)                             */
/* -------------------------------------------------------------------------- */

export type GameStatus = 'loading' | 'menu' | 'controls' | 'playing' | 'paused' | 'missionResult';

/* -------------------------------------------------------------------------- */
/* Test / debug hooks exposed on window.__MINI_GTA for Playwright             */
/* -------------------------------------------------------------------------- */

export interface DebugSnapshot {
  status: GameStatus;
  player: { x: number; y: number; z: number; yaw: number };
  playerInVehicle: boolean;
  vehicle: { x: number; z: number; speed: number; type: string } | null;
  mission: MissionState;
  money: number;
  health: number;
  elapsed: number;
  npcCount: number;
  vehicleCount: number;
  buildings: number;
  drawCalls: number;
  fps: number;
}

export interface DebugApi {
  status(): GameStatus;
  /** Same code path as clicking the Play button. */
  start(): void;
  teleport(x: number, z: number): void;
  snapshot(): DebugSnapshot;
  /** Slow-motion / fast-forward hook for automated mission tests. */
  setSimSpeed(multiplier: number): void;
  frameCount(): number;
}

declare global {
  interface Window {
    __MINI_GTA?: DebugApi;
  }
}
