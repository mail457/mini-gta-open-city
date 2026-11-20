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
import { createWeaponState, refill, switchWeapon, WeaponSystem, type ShotTarget } from '../entities/weapon';
import { createWorld } from '../world/world';
import { Player } from '../entities/player';
import { VehicleSystem } from '../entities/vehicles';
import { createVehicleMesh } from '../entities/vehicleModels';
import { addContactShadow, addHeadlightGlow } from './vehicleDetail';
import { createNPCSystem } from '../gameplay/npcs';
import { createMission } from '../gameplay/mission';
import { GameState } from '../gameplay/gameState';
import { nsX, ewZ, streetHalfWidth } from '../world/layout';
import { blockRect } from '../world/cityLayout';
import type { VehicleTypeId, WeaponId } from '../contracts';

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
  /** Back from the controls screen to wherever it was opened from. */
  onBack(): void;
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
  private frameEdges = { restart: false, mute: false, perf: false, graphics: false, weapon: false, swap: false, restartRun: false, pistol: false, smg: false };
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

    this.weaponFx = new WeaponSystem(scene);
    this.sky = createSky(scene);
    scene.add(this.world.group);

    this.cameraRig = new ThirdPersonCamera(this.engine.camera);
    this.input = new Input(canvas);

    this.player = new Player(scene, this.world);
    this.vehicleOwnership = 'world';
    this.vehicles = new VehicleSystem(scene, this.world);
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
      onShowControls: () => {
        this.controlsReturnTo = this.gameStatus;
        this.setStatus('controls');
      },
      onBack: () => this.setStatus(this.controlsReturnTo),
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
    // The WebGL layer sits *under* the menu overlay, so one forced frame here is
    // wasteful — the first menu frame is rendered by the loop when it starts.
    (this as unknown as { engineStartedAt: number }).engineStartedAt = performance.now();

    // Input is sampled once per rendered frame — NOT per fixed simulation
    // sub-step — because keyboard edges (E, Esc, R) only exist for one frame.
    this.engine.perFrameInput = () => {
      this.frameEdges = {
        restart: this.input.wasPressed('KeyR'),
        mute: this.input.wasPressed('KeyM'),
        perf: this.input.wasPressed('F3'),
        graphics: this.input.wasPressed('KeyG'),
        weapon: this.input.wasPressed('KeyQ'),
        swap: this.input.wasPressed('Tab') || this.input.wasPressed('Digit2'),
        pistol: this.input.wasPressed('Digit1'),
        smg: this.input.wasPressed('Digit2'),
        restartRun: this.input.wasPressed('Backspace'),
      };
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
        this.render();
        if (!PERF.enabled) return;
        const st = this.engine.perfStats;
        PERF.addRender(st.render, st.submit, st.drawCalls, st.triangles);
        PERF.frame();
      },
      resize: () => {},
    });

    // Engine-side per-frame bookkeeping (runs after the real render + GPU sync).
    this.engine.onPostRender = () => {
      if (!PERF.enabled) return;
      const st = this.engine.perfStats;
      this.renderCount++;
      PERF.addRender(st.render, st.submit, st.drawCalls, st.triangles);
      PERF.frame();
    };

    // Shooting: hold the left mouse button (pointer lock) or click to fire.
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0 && this.gameStatus === 'playing') this.firing = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.firing = false;
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
    window.setTimeout(() => {
      if (this.gameStatus === 'playing') {
        this.hud.toast('Use W A S D to walk · mouse to look · follow the gold marker', 'info', 5);
      }
    }, 2500);
    this.mission.start(this.missionEnv());
  }

  teleport(x: number, z: number): void {
    // A fresh teleport must not re-enter the car the player just left.
    this.lastExited = null;
    // A teleport is a scripted jump: never let a tap from just before it fire here.
    this.interactLatchedUntil = 0;
    this.pauseLatchedUntil = 0;
    this.pendingInput.interact = false;
    this.pendingInput.pauseToggle = false;
    // Test convenience: teleporting while driving moves the CAR (so a test can
    // drive straight to a drop-off instead of simulating a whole route).
    if (this.activeVehicle) {
      const v = this.activeVehicle;
      // Any traffic car this car would land on top of is removed from traffic.
      for (const o of this.npcs.trafficVehicles) {
        if (o === v || o.role !== 'traffic') continue;
        if (Math.hypot(o.position.x - x, o.position.z - z) < 5) {
          (this.npcs as unknown as { takeOver(v: Vehicle): boolean }).takeOver(o);
          o.role = 'parked';
          o.speed = 0;
        }
      }
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

  /** Test/dev hook: select a weapon directly (same path as the number keys). */
  selectWeapon(id: 'pistol' | 'smg'): void {
    switchWeapon(this.weapon, id);
  }

  setSimSpeed(multiplier: number): void {
    this.engine.simSpeed = Math.max(0.1, Math.min(8, multiplier));
  }

  frameCount(): number {
    return this.engine.currentFrame;
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
      drawCalls: this.engine.lastDrawCalls || this.engine.perfStats.drawCalls,
      fps: this.engine.fps,
      weapon: { id: this.weapon.spec.id, mag: this.weapon.mag, reserve: this.weapon.reserve, armed: this.weapon.armed },
      shotsFired: this.weapon.shots,
      hits: this.weapon.hits,
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
    // The simulation only runs while playing. (The renderer needs frames too:
    // Safari does not service requestAnimationFrame for an occluded WebGL canvas.)
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

  /** Quality: 'high' (bloom + grade + MSAA) or 'low' (direct render, fastest). */
  setGraphics(q: 'high' | 'low'): void {
    this.engine.setQuality(q);
    this.hud.toast(q === 'high' ? 'Graphics: HIGH (bloom, MSAA, grade)' : 'Graphics: LOW (performance)', 'info', 1.6);
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
    this.vehicles = new VehicleSystem(this.engine.scene, this.world);
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
    // NOTE: `this.frame` counts simulation sub-steps; `frameCount()` below returns
    // the engine's rendered-frame counter, which is what tests expect.
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
    // Frames that arrive in bursts after the engine throttled rendering (software
    // rendering, first seconds after start) must not make the player teleport.
    const simDt = Math.min(dt, 1 / 25);
    // Sim clock: ignore the catch-up frames right after PLAY / RESUME.
    if (this.gameStatus === 'playing') {
      if (!this.simClockStarted) this.simClockSettle--;
      if (this.simClockSettle <= 0) this.simClockStarted = true;
    } else {
      this.simClockStarted = false;
      this.simClockSettle = 45;
    }
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);

    // Hotkeys apply to the first simulation step of each frame.
    if (isFirstStep) {
      // R reloads while armed on foot; the run restart moves to Backspace.
      if (inputEdges.restart && this.gameStatus === 'playing' && this.player.onFoot) {
        const before = this.weapon.mag;
        this.reload();
        this.hud.toast(this.weapon.mag > before ? 'Reloaded' : 'Magazine full', 'info', 0.9);
      }
      if (inputEdges.weapon) {
        this.weapon.armed = !this.weapon.armed;
        this.hud.toast(this.weapon.armed ? `${this.weapon.spec.label} out` : 'Holstered', 'info', 1);
      }
      if (inputEdges.pistol) {
        switchWeapon(this.weapon, 'pistol');
        this.hud.toast('Pistol selected', 'info', 1);
      }
      if (inputEdges.smg) {
        switchWeapon(this.weapon, 'smg');
        this.hud.toast('SMG selected', 'info', 1);
      }
      if (inputEdges.restartRun && this.gameStatus !== 'menu') {
        this.restart();
        return;
      }
      if (inputEdges.mute) this.toggleMute();
      if (inputEdges.perf) this.hud.toast(PERF.toggle() ? 'Performance overlay ON' : 'Performance overlay OFF', 'info', 1.2);
      if (inputEdges.graphics) this.setGraphics(this.engine.quality === 'high' ? 'low' : 'high');
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
      const impact = this.vehicles.stepDriven(v, input, this.world, simDt);
      const vImpact = this.vehicles.resolveVehicleCollisions(v, this.allVehicles());
      this.vehicles.updateVisuals(v, simDt, input);
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
      this.player.update(simDt, input, this.cameraRig.yaw);
      if (this.player.didJump) this.audio.play('jump', 0.6);
      speedRatio = Math.min(1, this.player.speed / 8);
      this.tickFootsteps(dt);
    }

    // --- Shooting -------------------------------------------------------
    this.updateShooting(dt, input, this.activeVehicle);

    // --- NPCs, mission, world -------------------------------------------
    // NPC AI runs at 30 Hz (every other fixed step): imperceptible, halves its cost.
    if (this.npcTick++ % 2 === 0) this.npcs.update(simDt * 2, this.player.position, this.activeVehicle);
    this.processHits();
    this.mission.update(simDt, this.missionEnv());
    this.world.update(simDt, this.elapsed);
    this.sky.update(simDt);

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
  private npcTick = 0;
  private weapon = createWeaponState('pistol');
  private weaponFx!: WeaponSystem;
  private firing = false;
  private npcHitPoints = new WeakMap<object, number>();
  private recoil = 0;
  /** Timestamp of the last mouse-look input (used by the chase camera). */
  private lastLookAt = 0;
  /** First-run coach: 'walk' → 'vehicle' → 'delivered' → 'done'. */
  private tutorialStep: 'walk' | 'vehicle' | 'delivered' | 'done' = 'walk';
  /**
   * Guidance is computed from the *effective* phase: the mission may still be in
   * 'meet' while the player is already sitting in a car, and the HUD must never
   * tell a driver to walk to a marker.
   */
  private effectivePhase(mission: MissionState, driving: Vehicle | null): MissionState['phase'] {
    const atStart = mission.waypoint
      ? Math.hypot(this.player.position.x - mission.waypoint.x, this.player.position.z - mission.waypoint.z) < 6
      : false;
    if (mission.phase === 'meet' && (driving || atStart)) return 'getVehicle';
    return mission.phase;
  }
  private renderCount = 0;
  private lastDrawCalls = 0;
  private lastTriangles = 0;
  /** Cleared on teleport; kept for scripted repositioning safety. */
  private lastExited: { vehicle: Vehicle; at: number } | null = null;
  private controlsReturnTo: GameStatus = 'menu';
  /** Frames to skip on the mission clock while the renderer catches up after start. */
  private simClockSettle = 0;
  private simClockStarted = false;
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
    // CHASE-CAMERA RULE (on foot and driving): when the mouse has not moved for
    // ~0.6 s the camera swings behind the direction of travel, so W always means
    // "forward" from the player's point of view. A recent mouse look overrides it.
    const playing = this.gameStatus === 'playing';
    const recentLook = playing && performance.now() - this.lastLookAt < 600;
    const autoYaw = this.activeVehicle ? facingYaw + Math.PI : null;
    // Slow idle orbit behind the menu so the start screen is alive.
    if (!playing) this.cameraRig.yaw += 0.06 * (1 / 60);
    this.cameraRig.update(anchorPos, 1 / 60, playing ? this.lastSpeedRatio : 0, autoYaw);
    // Draw directly unless the engine composer will present the frame (then it
    // draws right after this hook). Rendering here also keeps draw-call stats exact.
    if (!this.engine.postActive) this.engine.renderer.render(this.engine.scene, this.engine.camera);
    const inf = this.engine.renderer.info.render;
    // Only trust the counters right after OUR direct render.
    this.engine.lastDrawCalls = inf.calls;
    this.engine.lastTriangles = inf.triangles;
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
      speedKmh: v && v.driven ? Math.abs(v.speed) * 3.6 : 0,
      inVehicle: !!(v && v.driven),
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
      ammo: v ? null : { mag: this.weapon.mag, reserve: this.weapon.reserve, name: this.weapon.spec.label },
      prompt: this.promptFor(v, mission),
      hint: this.hintFor(mission, v),
    };
    this.hud.update(data);
  }

  /**
   * Fire the current weapon toward the point under the crosshair. Pedestrians and
   * traffic cars are the targets; every hit is queued and resolved after the NPC
   * update so the AI state stays consistent.
   */
  private pendingHits: Array<{ id: number; damage: number }> = [];

  private updateShooting(dt: number, input: InputFrame, driving: Vehicle | null): void {
    this.weapon.cooldown = Math.max(0, this.weapon.cooldown - dt);
    this.weaponFx.update(dt);
    const armed = !driving && this.weapon.armed;
    this.hud.setCrosshair(armed && this.gameStatus === 'playing', Math.min(1, this.recoil));
    this.recoil = Math.max(0, this.recoil - dt * 7);
    if (!armed || !this.firing || this.gameStatus !== 'playing') return;
    if (!this.weapon.spec.auto) this.firing = false; // pistol: one click = one shot

    const cam = this.engine.camera;
    const origin = new THREE.Vector3();
    cam.getWorldPosition(origin);
    // Aim through the screen centre (where the crosshair is).
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).normalize();
    // Muzzle starts slightly in front of the camera so tracers read well.
    const muzzle = origin.clone().addScaledVector(dir, 0.9).add(new THREE.Vector3(0, -0.12, 0));

    if (this.weapon.mag <= 0) {
      if (this.weapon.reserve > 0) this.reload();
      else {
        this.audio.play('ui', 0.4);
        this.hud.toast('Out of ammo — press R to reload', 'bad', 1.5);
        this.firing = false;
      }
      return;
    }

    const targets: ShotTarget[] = [];
    for (const ped of this.npcs.targetablePedestrians()) {
      targets.push({ id: ped.id, position: ped.position.clone(), radius: 0.55 });
    }
    for (const car of this.npcs.trafficVehicles) {
      if (car.role !== 'traffic' && car.role !== 'parked') continue;
      targets.push({
        id: 100000 + this.allVehicles().indexOf(car),
        position: car.position.clone().setY(0.9),
        radius: 1.3,
      });
    }
    const res = this.weaponFx.tryShoot(this.weapon, muzzle, dir, { colliders: this.world.colliders, targets });
    if (!res.fired) return;
    this.recoil = Math.min(1, this.recoil + 0.6);
    this.cameraRig.shake(this.weapon.spec.kick);
    this.audio.play('step', 0.25); // short click-ish report
    if (res.hitId >= 0) {
      this.pendingHits.push({ id: res.hitId, damage: res.damage });
      this.hud.pulseHitMarker();
    }
  }

  private reload(): void {
    const w = this.weapon;
    if (w.mag >= w.spec.magSize || w.reserve <= 0) return;
    const take = Math.min(w.spec.magSize - w.mag, w.reserve);
    w.mag += take;
    w.reserve -= take;
    this.audio.play('ui', 0.5);
    this.hud.toast('Reloaded', 'info', 0.8);
  }

  /** Apply queued bullet damage to pedestrians / traffic cars. */
  private processHits(): void {
    if (!this.pendingHits.length) return;
    for (const hit of this.pendingHits) {
      if (hit.id >= 100000) {
        const car = this.allVehicles()[hit.id - 100000];
        if (car && car.role !== 'player') {
          const hpKey = car as unknown as object;
          const hp = (this.npcHitPoints.get(hpKey) ?? 100) - hit.damage;
          this.npcHitPoints.set(hpKey, hp);
          if (hp <= 0) {
            (this.npcs as unknown as { takeOver(v: Vehicle): boolean }).takeOver(car);
            car.role = 'parked';
            car.speed = 0;
            this.hud.toast('Vehicle disabled', 'good', 1.2);
          }
        }
      } else {
        this.npcs.damagePedestrian(hit.id, hit.damage, this.player.position);
      }
    }
    this.pendingHits.length = 0;
  }

  /** What pressing E does right now, or a touch hint when nothing is close. */
  private promptFor(driving: Vehicle | null, mission: MissionState): { key: string; text: string } | null {
    if (driving) return { key: 'E', text: `Exit ${driving.spec.label}` };
    const car = this.nearbyVehicle();
    if (car) return { key: 'E', text: `Enter ${car.spec.label}${car.role === 'traffic' ? ' (jack it)' : ''}` };
    const phase = this.effectivePhase(mission, driving);
    if (this.gameStatus === 'playing' && phase === 'meet') {
      return { key: 'W', text: 'Hold W to walk — follow the gold marker' };
    }
    if (this.gameStatus === 'playing' && phase === 'getVehicle') {
      return { key: 'E', text: 'Get close to a car, then press E' };
    }
    return null;
  }

  /** One actionable sentence for the current objective. */
  private hintFor(mission: MissionState, driving: Vehicle | null): string | null {
    switch (this.effectivePhase(mission, driving)) {
      case 'meet':
        return 'Walk to the glowing gold marker. Use the compass at the top and the diamond on the minimap.';
      case 'getVehicle':
        return driving
          ? 'You are in a car — the drop-off is now marked in gold. Start driving when you are ready.'
          : 'Stand next to any car and press E to get in. One is parked just ahead of you; the gold marker shows other cars.';
      case 'deliver':
        return driving
          ? 'Drive to the gold drop-off. Stop inside the ring before the timer ends. W = accelerate, S = brake, A/D = steer, Space = handbrake.'
          : 'You are on foot — press E next to your car to get back in.';
      default:
        return null;
    }
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
        this.dress(this.vehicles.spawn(this.engine.scene, px, z, yaw, type, { role: 'parked' }, this.world));
      } else {
        if (this.world.overlapsCircle(x, z, 1.5)) continue;
        this.dress(this.vehicles.spawn(this.engine.scene, x, z, yaw, type, { role: 'parked' }, this.world));
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
        this.dress(this.vehicles.spawn(this.engine.scene, x, z, 0, types[i], { role: 'parked' }, this.world));
      }
    }
  }

  /** Contact shadow + headlight pools for a vehicle (cheap, one draw each). */
  private dress(v: Vehicle): void {
    addContactShadow(v);
    addHeadlightGlow(v);
  }

  /**
   * Put a freshly entered car onto the nearest asphalt point, rotated to face
   * along the street, unless it is already on the road.
   */
  private snapToRoad(v: Vehicle): void {
    const w = this.world;
    if (w.isRoad(v.position.x, v.position.z)) return;
    // At most 3.5 m: enough to reach the kerb, but never far enough to reach a
    // mission marker (that would silently skip the "get a vehicle" objective).
    const maxStep = 3.5;
    if (!w.isRoad) return;
    // Find the nearest road point by probing outward in 1 m steps.
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let r = 1; r <= maxStep; r += 1) {
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        const x = v.position.x + Math.cos(ang) * r;
        const z = v.position.z + Math.sin(ang) * r;
        if (!w.isRoad(x, z)) continue;
        if (w.overlapsCircle(x, z, 1.5)) continue;
        const d = r;
        if (d < bestD) {
          bestD = d;
          best = { x, z };
        }
      }
      if (best) break;
    }
    if (!best) return;
    v.position.x = best.x;
    v.position.z = best.z;
    v.mesh.position.copy(v.position);
    // Face along the nearest street axis (roads are axis-aligned), extended past
    // the car on BOTH sides; prefer the side with more road to drive into.
    const onStreet = (alongX: boolean, sign: number): boolean => {
      const px = alongX ? v.position.x + sign * 10 : v.position.x;
      const pz = alongX ? v.position.z : v.position.z + sign * 10;
      return w.isRoad(px, pz) && !w.overlapsCircle(px, pz, 1.5);
    };
    let yaw: number | null = null;
    if (onStreet(true, 1) || onStreet(true, -1)) yaw = onStreet(true, 1) ? -Math.PI / 2 : Math.PI / 2;
    else if (onStreet(false, 1) || onStreet(false, -1)) yaw = onStreet(false, 1) ? Math.PI : 0;
    if (yaw !== null) {
      v.yaw = yaw;
      v.mesh.rotation.y = yaw;
    }
    v.mesh.rotation.y = v.yaw;
  }

  /** The vehicle the player would enter if they pressed E right now (or null). */
  private nearbyVehicle(): Vehicle | null {
    const p = this.player.position;
    let best: Vehicle | null = null;
    let bestD = Infinity;
    for (const v of this.allVehicles()) {
      const d = Math.hypot(v.position.x - p.x, v.position.z - p.z);
      if (d < 4.2 && d < bestD) {
        best = v;
        bestD = d;
      }
    }
    return best;
  }

  private tryEnterVehicle(): void {
    if (!this.player.isGrounded) return;
    const p = this.player.position;
    // A car you just got out of stays "yours" for a moment: E hops straight back in
    // (it is often slightly farther than a car parked right against the kerb).
    let best: Vehicle | null = null;
    let bestD = Infinity;
    const now = performance.now();
    const last = this.lastExited;
    if (last && now - last.at < 4000 && Math.hypot(last.vehicle.position.x - p.x, last.vehicle.position.z - p.z) < 4.2) {
      best = last.vehicle;
      bestD = 0;
    }
    if (!best) {
      for (const v of this.allVehicles()) {
        const d = Math.hypot(v.position.x - p.x, v.position.z - p.z);
        // Pick the nearest car whose centre is within ~4 m (generous but not teleport-y).
        if (d < 4.2 && d < bestD) {
          best = v;
          bestD = d;
        }
      }
    }
    if (!best) return;
    if (best.role === 'traffic') {
      // "Jacking" a moving car in software rendering is all but impossible for the
      // automated tests and unfair in a real jam: throttle the car down as you grab
      // the handle (it rolls to a stop before it is yours).
      (this.npcs as unknown as { takeOver(v: Vehicle): boolean }).takeOver(best);
      best.speed = Math.min(Math.abs(best.speed), 1.5) * Math.sign(best.speed || 1);
      best.lateralSpeed = 0;
    }
    best.role = 'player';
    // Traffic meshes are lighter than the drivable models: swap in the full
    // model (with wheels, lights, shadow) the moment the player takes the car.
    if (best.shape === 'traffic') {
      best.mesh.parent?.remove(best.mesh);
      const detailed = createVehicleMesh(best.spec);
      detailed.position.copy(best.mesh.position);
      detailed.rotation.y = best.yaw;
      this.engine.scene.add(detailed);
      best.mesh = detailed;
      this.dress(best);
      // Visual state is keyed per Vehicle; clear it so wheels/lights re-bind
      // to the new mesh on the next update.
      this.vehicles.visualState.delete(best);
    }
    best.driven = true;
    this.activeVehicle = best;
    // Entering from the pavement: point the car along the street and walk it just
    // to the kerb (never far enough to scout a mission marker — that would skip
    // the on-foot "meet the courier" step).
    this.snapToRoad(best);
    if (this.tutorialStep === 'walk' || this.tutorialStep === 'vehicle') {
      this.tutorialStep = 'vehicle';
      this.hud.toast('In the car — hold W to drive. Follow the gold marker to the drop-off.', 'good', 4.5);
    }
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
    // Prefer a spot outside the car's own footprint (otherwise "get out" drops you
    // inside the collision shape and you cannot re-enter where you stand).
    const fx = -Math.sin(v.yaw);
    const fz = -Math.cos(v.yaw);
    const side = v.spec.width / 2 + 1.0;
    const cands = [
      v.exitSide('left'),
      v.exitSide('right'),
      { x: v.position.x + Math.cos(v.yaw) * side, z: v.position.z - Math.sin(v.yaw) * side },
      { x: v.position.x - Math.cos(v.yaw) * side, z: v.position.z + Math.sin(v.yaw) * side },
      { x: v.position.x - fx * (v.spec.length / 2 + 1.0), z: v.position.z - fz * (v.spec.length / 2 + 1.0) },
      { x: v.position.x + fx * (v.spec.length / 2 + 1.0), z: v.position.z + fz * (v.spec.length / 2 + 1.0) },
    ];
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
    // Mid-mission: the car you just left is the one the waypoint points at.
    const miss = this.mission.state;
    if (miss.waypoint && (miss.phase === 'getVehicle' || miss.phase === 'deliver')) {
      miss.waypoint = { x: v.position.x, z: v.position.z };
      miss.waypointRadius = Math.max(miss.waypointRadius || 0, 6);
    }
    this.activeVehicle = null;
    this.player.onFoot = true;
    this.player.object.visible = true;
    // Your car is the nearest vehicle from now on: point the mission at where you
    // are standing (radius covers the car), so the waypoint never drifts away.
    this.player.setPosition(spot.x, spot.z, v.yaw + Math.PI / 2);
    const miss2 = this.mission.state;
    if (miss2.waypoint && (miss2.phase === 'getVehicle' || miss2.phase === 'deliver')) {
      miss2.waypoint = { x: this.player.position.x, z: this.player.position.z };
      miss2.waypointRadius = 2.5;
    }
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
