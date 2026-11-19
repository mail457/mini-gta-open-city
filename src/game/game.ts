/**
 * MINI GTA — OPEN CITY — game orchestration (Lead-owned).
 *
 * Owns the state machine (menu → playing ⇄ paused → missionResult), wires the
 * four engineering modules together, and drives one fixed simulation step.
 * Everything crosses module boundaries through src/contracts.ts.
 */
import * as THREE from 'three';
import type {
  AudioBus,
  DebugApi,
  DebugSnapshot,
  GameStatus,
  HudApi,
  HudData,
  InputFrame,
  MissionApi,
  MissionResultView,
  MissionState,
  NPCSystemApi,
  PlayerController,
  Vehicle,
  VehiclePhysicsApi,
  XZ,
} from '../contracts';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import { ThirdPersonCamera } from '../core/camera';
import { AUDIO } from '../core/audioRef';
import { createSky } from './sky';
import { PERF } from '../core/probe';
import { createWorld } from '../world/world';
import { Player } from '../entities/player';
import { VehicleSystem } from '../entities/vehicles';
import { createNPCSystem } from '../gameplay/npcs';
import { createMission } from '../gameplay/mission';
import { GameState } from '../gameplay/gameState';
import { nsX, ewZ, streetHalfWidth } from '../world/layout';
import { blockRect } from '../world/cityLayout';
import type { VehicleTypeId } from '../contracts';

export interface GameDeps {
  /** Builders injected by main.ts (keeps this file free of UI import cycles). */
  createHud: (root: HTMLElement) => HudApi & { setVisible(b: boolean): void; dispose(): void };
  createScreens: (root: HTMLElement, cb: ScreenCallbacks) => ScreensApi;
  root: HTMLElement;
}

export interface ScreenCallbacks {
  onPlay(): void;
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onToggleMute(): void;
  onShowControls(): void;
}

export interface ScreensApi {
  show(status: GameStatus): void;
  showMissionResult(
    v: MissionResultView,
    onContinue: () => void,
    onRestart: () => void,
  ): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

const EMPTY_MISSION: MissionState = {
  phase: 'idle',
  title: '',
  objective: '',
  waypoint: null,
  waypointRadius: 0,
  timeLeft: null,
  reward: 0,
};

export class Game implements DebugApi {
  readonly engine: Engine;
  readonly input: Input;
  readonly cameraRig: ThirdPersonCamera;
  private gameStatus: GameStatus = 'loading';
  private world = createWorld();
  private player: Player;
  private vehicles: VehicleSystem;
  private npcs: NPCSystemApi;
  private mission: MissionApi;
  private state: GameState;
  private hud: ReturnType<GameDeps['createHud']>;
  private screens: ScreensApi;
  private audio: AudioBus = AUDIO;
  private elapsed = 0;
  private interactCooldown = 0;
  private frameInput: InputFrame = {
    moveX: 0, moveY: 0, sprint: false, jump: false, interact: false,
    pauseToggle: false, handbrake: false, lookX: 0, lookY: 0,
  };
  private frameEdges = { restart: false, mute: false, perf: false };
  private pendingInput: InputFrame = { ...this.frameInput };
  /** True once until the next per-frame input pump (first sub-step of a frame). */
  private pendingFirst = false;
  private lastFpsWarn = 0;
  private muted = false;
  private sky: ReturnType<typeof createSky>;
  private activeVehicle: Vehicle | null = null;
  private hoverCamYaw = 0;
  private vehicleOwnership: 'world' | 'npc' = 'world';
  private frame = 0;
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpVec2 = new THREE.Vector3();
  private ready = false;

  constructor(canvas: HTMLCanvasElement, deps: GameDeps) {
    this.engine = new Engine(canvas);
    const scene = this.engine.scene;

    this.sky = createSky(scene);
    scene.add(this.world.group);

    this.cameraRig = new ThirdPersonCamera(this.engine.camera);
    this.input = new Input(canvas);

    this.player = new Player(scene, this.world);
    this.vehicleOwnership = 'world';
    this.vehicles = new VehicleSystem(scene);
    this.spawnParkedCars();

    this.npcs = createNPCSystem(scene, this.world);
    this.mission = createMission(this.world);
    scene.add(this.mission.group);

    this.state = new GameState();

    this.hud = deps.createHud(deps.root);
    this.screens = deps.createScreens(deps.root, {
      onPlay: () => this.start(),
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onQuitToMenu: () => this.quitToMenu(),
      onToggleMute: () => this.toggleMute(),
      onShowControls: () => this.setStatus('controls'),
    });

    // Place player at the spawn POI facing north up the street.
    const spawn = this.world.pois.spawn ?? { x: -120, z: 0 };
    this.player.setPosition(spawn.x, spawn.z, Math.PI * 0.5);
    this.cameraRig.yaw = -this.player.yaw + Math.PI;
    this.cameraRig.snapTo(this.player.position);

    this.input.onPointerLockLost = () => {
      if (this.gameStatus === 'playing') this.pause();
    };

    this.setStatus('menu');
    this.hud.setVisible(false);
    this.ready = true;

    // Input is sampled once per rendered frame — NOT per fixed simulation
    // sub-step — because keyboard edges (E, Esc, R) only exist for one frame.
    this.engine.perFrameInput = () => {
      this.frameEdges = { restart: this.input.wasPressed('KeyR'), mute: this.input.wasPressed('KeyM'), perf: this.input.wasPressed('F3') };
      this.pendingInput = this.input.consume();
      this.pendingFirst = true;
      return this.pendingInput;
    };

    this.engine.start({
      update: (dt) => {
        if (!PERF.enabled) {
          this.fixedUpdate(dt);
          return;
        }
        const t0 = performance.now();
        this.fixedUpdate(dt);
        PERF.addUpdate(performance.now() - t0);
      },
      render: () => {
        if (!PERF.enabled) {
          this.render();
          return;
        }
        const t0 = performance.now();
        this.render();
        const info = this.engine.renderer.info.render;
        PERF.addRender(performance.now() - t0, info.calls, info.triangles);
        PERF.frame(this.engine.fps);
      },
      resize: () => {},
    });

    window.__MINI_GTA = this;
    // Read-only performance telemetry for automated tests (?perf=1).
    Object.defineProperty(window, '__MINI_GTA_PERF', { value: PERF, configurable: true });
  }

  /* ------------------------------------------------------------------ */
  /* Public debug/test surface (implements DebugApi)                     */
  /* ------------------------------------------------------------------ */

  get isReady(): boolean {
    return this.ready;
  }

  status(): GameStatus {
    return this.gameStatus;
  }

  /** Same path as clicking PLAY. */
  start(): void {
    this.audio.play('ui');
    this.setStatus('playing');
    // Note: the pointer lock is acquired from the canvas' own click handler
    // (see main.ts) so it is always tied to a user gesture.
    this.audio.play('missionStart');
    this.elapsed = 0;
    this.hud.toast('THE DELIVERY RUN — meet the courier', 'info', 4);
    this.mission.start(this.missionEnv());
  }

  teleport(x: number, z: number): void {
    // Test convenience: teleporting while driving moves the CAR (so a test can
    // drive straight to a drop-off instead of simulating a whole route).
    if (this.activeVehicle) {
      const v = this.activeVehicle;
      v.position.set(x, this.world.groundHeight(x, z), z);
      v.speed = 0.5;
      return;
    }
    // Land on walkable ground: cars/pavements are fine, building interiors are not.
    const safe = this.world.resolveCircle(x, z, 0.5);
    x = safe.x;
    z = safe.z;
    if (this.activeVehicle) this.exitVehicle();
    this.player.setPosition(x, z, this.player.yaw);
    this.cameraRig.snapTo(this.player.position);
  }

  /** Ask the browser for the mouse pointer lock (call from a user gesture). */
  requestPointerLock(): void {
    if (this.gameStatus === 'playing') this.input.requestLock();
  }

  setSimSpeed(multiplier: number): void {
    this.engine.simSpeed = Math.max(0.1, Math.min(8, multiplier));
  }

  frameCount(): number {
    return this.frame;
  }

  snapshot(): DebugSnapshot {
    const v = this.activeVehicle;
    const p = this.player.position;
    return {
      status: this.gameStatus,
      player: { x: p.x, y: p.y, z: p.z, yaw: this.player.yaw },
      playerInVehicle: !!v,
      vehicle: v ? { x: v.position.x, z: v.position.z, speed: v.speed, type: v.spec.id } : null,
      mission: { ...this.mission.state, waypoint: this.mission.state.waypoint ? { ...this.mission.state.waypoint } : null },
      money: this.state.money,
      health: this.state.health,
      elapsed: this.elapsed,
      npcCount: this.npcs.minimapData().peds.length,
      vehicleCount: this.allVehicles().length,
      buildings: this.world.stats().buildings,
      drawCalls: this.engine.renderer.info.render.calls,
      fps: this.engine.fps,
    };
  }

  /* ------------------------------------------------------------------ */
  /* State machine                                                       */
  /* ------------------------------------------------------------------ */

  private setStatus(next: GameStatus): void {
    if (this.gameStatus === next) return;
    this.gameStatus = next;
    this.screens.show(next);
    const showHud = next === 'playing' || next === 'missionResult';
    this.hud.setVisible(showHud);
    // Pause the simulation only for non-playing statuses; the menu still renders
    // (camera + world update) so the start screen has a living city behind it.
    this.engine.paused = next !== 'playing';
    this.input.active = next === 'playing';
    if (next !== 'playing') {
      this.audio.setEngine(0, false);
      if (next === 'paused' || next === 'missionResult' || next === 'menu') this.input.releaseLock();
    }
  }

  private pause(): void {
    if (this.gameStatus !== 'playing') return;
    // Real browsers expect Escape to release the pointer lock itself.
    this.input.releaseLock();
    this.audio.play('ui');
    this.setStatus('paused');
  }

  private resume(): void {
    this.audio.play('ui');
    this.setStatus('playing');
  }

  private quitToMenu(): void {
    this.audio.play('ui');
    this.setStatus('menu');
    this.hud.setVisible(false);
    this.hud.clearMissionResult();
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    this.screens.setMuted(this.muted);
    this.hud.toast(this.muted ? 'Sound muted' : 'Sound on', 'info', 1.4);
  }

  /** Full mission + world restart, keeping money. */
  restart(): void {
    this.previousMoney = this.state.money;
    this.audio.play('ui');
    this.hud.clearMissionResult();
    this.mission.dispose();
    this.engine.scene.remove(this.mission.group);
    // Remove all vehicles and NPCs, respawn them.
    this.disposeVehicleSystems();
    this.mission = createMission(this.world);
    this.engine.scene.add(this.mission.group);
    this.vehicles = new VehicleSystem(this.engine.scene);
    this.spawnParkedCars();
    this.vehicleOwnership = 'world';
    this.npcs = createNPCSystem(this.engine.scene, this.world);
    this.activeVehicle = null;
    this.player.onFoot = true;
    this.player.object.visible = true;
    this.cameraRig.setMode('foot');
    const spawn = this.world.pois.spawn ?? { x: -120, z: 0 };
    this.player.setPosition(spawn.x, spawn.z, Math.PI * 0.5);
    this.cameraRig.snapTo(this.player.position);
    this.elapsed = 0;
    this.state.reset();
    this.state.money = this.previousMoney;
    this.setStatus('playing');
    this.mission.start(this.missionEnv());
    this.hud.toast('RESTARTED — delivery run active', 'info', 2.5);
  }

  private disposeVehicleSystems(): void {
    this.vehicles.dispose();
    this.npcs.dispose();
    this.engine.scene.remove(this.npcs.group);
  }

  /* ------------------------------------------------------------------ */
  /* Simulation                                                          */
  /* ------------------------------------------------------------------ */

  private missionEnv() {
    return {
      world: this.world,
      player: this.player,
      getActiveVehicle: () => this.activeVehicle,
      audio: this.audio,
      hud: this.hud,
    };
  }

  private allVehicles(): Vehicle[] {
    return [...this.vehicles.vehicles, ...this.npcs.trafficVehicles];
  }

  private fixedUpdate(dt: number): void {
    this.frame++;
    // Copy the frame's input into this sub-step. Edge flags (jump, interact,
    // pause, mouse delta) are delivered exactly once per rendered frame; they are
    // cleared on the first sub-step so a single tap can never fire twice.
    const pending = this.pendingInput;
    const input: InputFrame = this.frameInput;
    input.moveX = pending.moveX;
    input.moveY = pending.moveY;
    input.sprint = pending.sprint;
    input.handbrake = pending.handbrake;
    input.jump = pending.jump;
    const now = performance.now();
    if (pending.interact) this.interactLatchedUntil = now + 140;
    if (pending.pauseToggle) this.pauseLatchedUntil = now + 140;
    input.interact = pending.interact || now < this.interactLatchedUntil;
    input.pauseToggle = pending.pauseToggle || now < this.pauseLatchedUntil;
    input.lookX = pending.lookX;
    input.lookY = pending.lookY;
    pending.jump = false;
    pending.interact = false;
    pending.pauseToggle = false;
    pending.lookX = 0;
    pending.lookY = 0;
    const inputEdges = this.frameEdges;
    const isFirstStep = this.pendingFirst;
    this.pendingFirst = false;
    this.input.age(dt);
    if (this.gameStatus === 'playing') this.elapsed += dt;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);

    // Hotkeys apply to the first simulation step of each frame.
    if (isFirstStep) {
      if (inputEdges.restart && this.gameStatus !== 'menu') {
        this.restart();
        return;
      }
      if (inputEdges.mute) this.toggleMute();
      if (inputEdges.perf) this.hud.toast(PERF.toggle() ? 'Performance overlay ON' : 'Performance overlay OFF', 'info', 1.2);
    }
    if (input.pauseToggle) {
      if (this.gameStatus === 'playing') {
        this.pause();
        return;
      }
    }

    // Camera orbit input (mouse).
    this.cameraRig.look(input.lookX, input.lookY);

    // --- Enter / exit vehicles -----------------------------------------
    if (input.interact && this.interactCooldown <= 0) {
      this.interactCooldown = 0.25;
      if (this.activeVehicle) this.exitVehicle();
      else this.tryEnterVehicle();
    }

    // --- Locomotion -----------------------------------------------------
    let speedRatio = 0;
    if (this.activeVehicle) {
      const v = this.activeVehicle;
      const impact = this.vehicles.stepDriven(v, input, this.world, dt);
      const vImpact = this.vehicles.resolveVehicleCollisions(v, this.allVehicles());
      this.vehicles.updateVisuals(v, dt, input);
      const hit = Math.max(impact, vImpact);
      if (hit > 4) {
        this.cameraRig.shake(Math.min(0.3, hit * 0.012));
        if (hit > 9) this.audio.play('crash', 0.8);
        this.state.damage(Math.min(12, hit * 0.35));
      }
      v.mesh.position.copy(v.position);
      v.mesh.rotation.y = v.yaw;
      speedRatio = Math.min(1, Math.abs(v.speed) / v.spec.maxSpeed);
      this.aoPoi = null;
    } else {
      this.player.update(dt, input, this.cameraRig.yaw);
      if (this.player.didJump) this.audio.play('jump', 0.6);
      speedRatio = Math.min(1, this.player.speed / 8);
      this.tickFootsteps(dt);
    }

    // --- NPCs, mission, world -------------------------------------------
    this.npcs.update(dt, this.player.position, this.activeVehicle);
    this.mission.update(dt, this.missionEnv());
    this.world.update(dt, this.elapsed);
    this.sky.update(dt);

    // Mission events.
    const ev = this.mission.state.event;
    if (ev === 'completed') {
      this.state.addMoney(this.mission.state.reward);
      this.mission.state.event = null;
      this.completeMission();
    } else if (ev === 'failed') {
      this.mission.state.event = null;
      this.failMission();
    }

    // Player health depleted → soft respawn at spawn (never a hard fail screen).
    if (this.state.health <= 0) {
      this.state.health = this.state.maxHealth;
      const spawn = this.world.pois.spawn ?? { x: -120, z: 0 };
      if (this.activeVehicle) this.exitVehicle();
      this.player.setPosition(spawn.x, spawn.z);
      this.cameraRig.snapTo(this.player.position);
      this.hud.toast('WASTED — recovered at the spawn point', 'bad', 3);
    }

    if (this.state.money !== this.lastMoney) {
      if (this.state.money > this.lastMoney) this.audio.play('coin');
      this.lastMoney = this.state.money;
    }

    // Sun shadow frustum follows the player so shadows stay crisp.
    const anchor = this.activeVehicle ? this.activeVehicle.position : this.player.position;
    this.sky.sun.target.position.set(anchor.x, 0, anchor.z);

    this.lastSpeedRatio = speedRatio;
    this.cameraRig.setMode(this.activeVehicle ? 'car' : 'foot');
  }

  private lastMoney = 0;
  private previousMoney = 0;
  // Taps are latched briefly: an edge that was queued during any stalled or
  // resumed-indicator frame is still honoured on the next live simulation step.
  private interactLatchedUntil = 0;
  private pauseLatchedUntil = 0;
  private lastSpeedRatio = 0;
  private aoPoi: XZ | null = null;
  private lastStepSound = 0;

  private tickFootsteps(dt: number): void {
    const p = this.player;
    if (!p.isGrounded || p.speed < 0.5) return;
    this.lastStepSound += dt;
    const interval = p.speed > 6 ? 0.28 : 0.42;
    if (this.lastStepSound >= interval) {
      this.lastStepSound = 0;
      this.audio.play('step', 0.5);
    }
  }

  private render(): void {
    const anchor = this.activeVehicle ? this.activeVehicle.position : this.player.position;
    const facingYaw = this.activeVehicle ? this.activeVehicle.yaw : this.player.yaw;
    const anchorPos = this.activeVehicle ? anchor : this.tmpVec.copy(anchor) ;
    const lookHeight = this.activeVehicle ? 1.5 : 0;
    anchorPos.y += lookHeight;
    const autoYaw = this.activeVehicle ? facingYaw + Math.PI : null;
    // Slow idle orbit behind the menu so the start screen is alive.
    if (this.gameStatus !== 'playing') this.cameraRig.yaw += 0.06 * (1 / 60);
    this.cameraRig.update(anchorPos, 1 / 60, this.gameStatus === 'playing' ? this.lastSpeedRatio : 0, this.gameStatus === 'playing' ? autoYaw : null);
    this.engine.renderer.render(this.engine.scene, this.engine.camera);
    this.updateHud();
  }

  private updateHud(): void {
    const v = this.activeVehicle;
    const mission = this.mission.state ?? EMPTY_MISSION;
    const wp = mission.waypoint;
    const playerPos = v ? v.position : this.player.position;
    const mini = this.npcs.minimapData();
    const data: HudData = {
      playerHealth: this.state.health,
      money: this.state.money,
      speedKmh: v ? Math.abs(v.speed) * 3.6 : 0,
      inVehicle: !!v,
      mission,
      distanceToWaypoint: wp ? Math.hypot(wp.x - playerPos.x, wp.z - playerPos.z) : null,
      minimap: {
        playerX: playerPos.x,
        playerZ: playerPos.z,
        playerYaw: v ? v.yaw : this.player.yaw,
        cars: [...this.allVehicles().map((c) => ({ x: c.position.x, z: c.position.z })), ...mini.cars],
        peds: mini.peds,
        waypoint: wp,
      },
      timeOfDayLabel: 'GOLDEN HOUR',
    };
    this.hud.update(data);
  }

  /* ------------------------------------------------------------------ */
  /* Vehicles: enter / exit                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Parked cars: a bay grid in the parking lot POI plus kerbside cars along
   * inner streets. Every spawn point is validated with the world collision
   * service so nothing overlaps a building or another car.
   */
  private spawnParkedCars(): void {
    // The start zone: a street with metres of pavement inside the block plazas
    // either side, so the player always starts and can always walk to a car.
    const startZ = ewZ(1) - streetHalfWidth(1) - 2.2;
    const startX = blockRect(1, 1).cx;
    const inner = streetHalfWidth(1);
    const curb = inner - 1.35;
    const parked: Array<[number, number, VehicleTypeId, number]> = [
      // [x offset from corridor centre, z, type, yaw]
      [-6, startZ, 'sedan', Math.PI / 2],
      [-1, startZ - 26, 'sport', Math.PI / 2],
      [-7, startZ - 52, 'van', Math.PI / 2],
      [14, startZ - 9, 'sedan', -Math.PI / 2],
      [18, startZ - 40, 'sport', -Math.PI / 2],
    ];
    for (const [dx, z, type, yaw] of parked) {
      const x = startX + dx;
      const onLane = Math.abs(dx) <= inner - 0.5;
      if (onLane) {
        // Parked in lane beside the kerb: two lanes each 8 m wide on inner streets.
        const laneCx = Math.sign(dx) * curb;
        const span = 8 - 3.4;
        const offset = Math.max(-span / 2, Math.min(span / 2, dx - laneCx));
        const px = startX + laneCx + offset;
        if (this.world.overlapsCircle(px, z, 1.5)) continue;
        this.vehicles.spawn(this.engine.scene, px, z, yaw, type, { role: 'parked' }, this.world);
      } else {
        if (this.world.overlapsCircle(x, z, 1.5)) continue;
        this.vehicles.spawn(this.engine.scene, x, z, yaw, type, { role: 'parked' }, this.world);
      }
    }
    // Parking lot bays (block (3,1) plaza ring).
    const lot = this.world.pois.parking;
    if (lot) {
      const types: VehicleTypeId[] = ['sport', 'van', 'sedan'];
      for (let i = 0; i < types.length; i++) {
        const x = lot.x + (i - 1) * 6;
        const z = lot.z + 12;
        if (this.world.overlapsCircle(x, z, 1.6)) continue;
        this.vehicles.spawn(this.engine.scene, x, z, 0, types[i], { role: 'parked' }, this.world);
      }
    }
  }

  private tryEnterVehicle(): void {
    if (!this.player.isGrounded) return;
    const p = this.player.position;
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const v of this.allVehicles()) {
      const d = Math.hypot(v.position.x - p.x, v.position.z - p.z);
      // Pick the nearest car whose centre is within ~4 m (generous but not teleport-y).
      if (d < 4.2 && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    if (!best) return;
    if (best.role === 'traffic') {
      // The NPC system owns traffic AI; hand the car over so it stops driving itself.
      (this.npcs as unknown as { takeOver(v: Vehicle): boolean }).takeOver(best);
    }
    best.role = 'player';
    best.driven = true;
    this.activeVehicle = best;
    this.player.onFoot = false;
    this.player.object.visible = false;
    // Freeze the car briefly so you don't carry momentum from AI logic.
    best.speed *= 0.5;
    this.cameraRig.setMode('car');
    this.audio.play('enterCar');
    this.hud.toast(`Entered ${best.spec.label}`, 'info', 1.2);
  }

  private exitVehicle(): void {
    const v = this.activeVehicle;
    if (!v) return;
    // Try the left side first, then right; pick a spot outside walls.
    const cands = [v.exitSide('left'), v.exitSide('right')];
    let spot: XZ = this.world.resolveCircle(cands[0].x, cands[0].z, 0.55);
    for (const c of cands) {
      if (!this.world.inBounds(c.x, c.z, 0.6)) continue;
      if (this.world.overlapsCircle(c.x, c.z, 0.55)) continue;
      spot = c;
      break;
    }
    v.driven = false;
    v.role = 'parked';
    v.speed = 0;
    this.activeVehicle = null;
    this.player.onFoot = true;
    this.player.object.visible = true;
    this.player.setPosition(spot.x, spot.z, v.yaw + Math.PI / 2);
    this.cameraRig.setMode('foot');
    this.hoverCamYaw = this.cameraRig.yaw;
    this.audio.play('exitCar');
  }

  /* ------------------------------------------------------------------ */
  /* Mission result                                                      */
  /* ------------------------------------------------------------------ */

  private completeMission(): void {
    this.audio.play('missionComplete');
    const s = this.mission.state;
    this.setStatus('missionResult');
    const result: MissionResultView = {
      success: true,
      title: 'MISSION COMPLETE',
      subtitle: s.title || 'THE DELIVERY RUN',
      reward: s.reward,
      timeSeconds: this.mission.deliveryTime,
    };
    this.hud.showMissionResult(result, { onContinue: () => this.continueFreeRoam(), onRestart: () => this.restart() });
    this.screens.showMissionResult(result, () => this.continueFreeRoam(), () => this.restart());
  }

  private failMission(): void {
    this.audio.play('crash');
    const s = this.mission.state;
    this.setStatus('missionResult');
    const result: MissionResultView = {
      success: false,
      title: 'MISSION FAILED',
      subtitle: 'Out of time — the package never arrived.',
      reward: 0,
      timeSeconds: this.elapsed,
    };
    this.hud.showMissionResult(result, { onContinue: () => this.continueFreeRoam(), onRestart: () => this.restart() });
    this.screens.showMissionResult(result, () => this.continueFreeRoam(), () => this.restart());
  }

  private continueFreeRoam(): void {
    this.hud.clearMissionResult();
    this.setStatus('playing');
    this.hud.toast('FREE ROAM — explore the city', 'good', 3);
  }

  dispose(): void {
    this.engine.stop();
    this.input.dispose();
    this.screens.dispose();
    this.hud.dispose();
    this.disposeVehicleSystems();
    this.player.dispose();
    this.mission.dispose();
    this.world.dispose();
    this.sky.dispose();
    this.engine.dispose();
    this.audio.dispose();
  }
}
