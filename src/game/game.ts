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
import { createWorld } from '../world/world';
import { Player } from '../entities/player';
import { VehicleSystem } from '../entities/vehicles';
import { createNPCSystem } from '../gameplay/npcs';
import { createMission } from '../gameplay/mission';
import { GameState } from '../gameplay/gameState';
import { nsX, ewZ, streetHalfWidth } from '../world/layout';
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

    this.engine.start({
      update: (dt) => this.fixedUpdate(dt),
      render: () => this.render(),
      resize: () => {},
    });

    window.__MINI_GTA = this;
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
    this.input.requestLock();
    this.audio.play('missionStart');
    this.hud.toast('THE DELIVERY RUN — meet the courier', 'info', 4);
    this.mission.start(this.missionEnv());
  }

  teleport(x: number, z: number): void {
    if (this.activeVehicle) this.exitVehicle();
    this.player.setPosition(x, z, this.player.yaw);
    this.cameraRig.snapTo(this.player.position);
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
      mission: { ...this.mission.state },
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
    this.engine.paused = next === 'playing';
    this.input.active = next === 'playing';
    if (next !== 'playing') {
      this.audio.setEngine(0, false);
      if (next === 'paused' || next === 'missionResult' || next === 'menu') this.input.releaseLock();
    }
  }

  private pause(): void {
    if (this.gameStatus !== 'playing') return;
    this.audio.play('ui');
    this.setStatus('paused');
  }

  private resume(): void {
    this.audio.play('ui');
    this.setStatus('playing');
    this.input.requestLock();
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
    this.setStatus('playing');
    this.input.requestLock();
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
    const input = this.input.consume();
    this.elapsed += dt;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);

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
      this.interactCooldown = 0.35;
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
    this.cameraRig.update(anchorPos, 1 / 60, this.lastSpeedRatio, autoYaw);
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
    const lot = this.world.pois.parking;
    if (lot) {
      const types: VehicleTypeId[] = ['sedan', 'sport', 'van', 'sedan', 'sport', 'sedan'];
      for (let i = 0; i < types.length; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = lot.x - 8 + col * 8;
        const z = lot.z - 6 + row * 11;
        if (this.world.overlapsCircle(x, z, 1.6)) continue;
        this.vehicles.spawn(this.engine.scene, x, z, row === 0 ? 0 : Math.PI, types[i], { role: 'parked' }, this.world);
      }
    }
    // Kerbside cars (inner streets only, offset into the outer parking lane).
    const kerbside: Array<[number, number, VehicleTypeId, number]> = [
      [1, 1, 'sport', 0.2],
      [3, 2, 'van', Math.PI],
      [2, 3, 'sedan', Math.PI * 0.5],
      [4, 4, 'sedan', Math.PI],
    ];
    for (const [ni, ei, type, yaw] of kerbside) {
      const half = streetHalfWidth(ni);
      const x = nsX(ni) + half - 2.2;
      const z = ewZ(ei) + 24;
      if (this.world.overlapsCircle(x, z, 1.6) || !this.world.isRoad(x, z)) continue;
      this.vehicles.spawn(this.engine.scene, x, z, yaw, type, { role: 'parked' }, this.world);
    }
    this.hoverCamYaw = 0;
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
      timeSeconds: this.elapsed,
    };
    this.hud.showMissionResult(result);
    this.screens.showMissionResult(
      result,
      () => this.continueFreeRoam(),
      () => this.restart(),
    );
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
    this.hud.showMissionResult(result);
    this.screens.showMissionResult(result, () => this.continueFreeRoam(), () => this.restart());
  }

  private continueFreeRoam(): void {
    this.hud.clearMissionResult();
    this.setStatus('playing');
    this.input.requestLock();
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
