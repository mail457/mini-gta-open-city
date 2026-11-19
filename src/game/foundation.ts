/**
 * MILESTONE M1 — Minimal playable foundation (Lead-owned fallback scene).
 *
 * Proves: dev server boots, WebGL renders, a player moves, the camera orbits,
 * no fatal console errors. Replaced by the integrated game in game.ts.
 */
import * as THREE from 'three';
import type { InputFrame } from '../contracts';
import { Engine } from '../core/engine';
import { Input } from '../core/input';
import { ThirdPersonCamera } from '../core/camera';
import { clamp } from '../core/utils';

export class Foundation {
  readonly engine: Engine;
  readonly camera: ThirdPersonCamera;
  private player: THREE.Mesh;
  private pos = new THREE.Vector3(0, 0.9, 8);
  private vel = new THREE.Vector3();
  private yaw = 0;
  private input: Input;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas);
    const scene = this.engine.scene;
    scene.background = new THREE.Color(0x8fc4ea);
    scene.fog = new THREE.Fog(0x8fc4ea, 60, 220);
    const hemi = new THREE.HemisphereLight(0xbfd8f5, 0x4a5540, 1.1);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
    sun.position.set(40, 60, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const c = sun.shadow.camera as THREE.OrthographicCamera;
    c.left = -40;
    c.right = 40;
    c.top = 40;
    c.bottom = -40;
    scene.add(sun);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x3d7a3a, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);

    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 200),
      new THREE.MeshStandardMaterial({ color: 0x2c2f36, roughness: 0.95 }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.01;
    road.receiveShadow = true;
    scene.add(road);

    for (let i = -3; i <= 3; i++) {
      const b = new THREE.Mesh(
        new THREE.BoxGeometry(8, 10 + (i % 2) * 6, 8),
        new THREE.MeshStandardMaterial({ color: 0xc9c2b2, roughness: 0.8 }),
      );
      b.position.set(i * 22 + (i > 0 ? 10 : -10), 5, -14);
      b.castShadow = true;
      b.receiveShadow = true;
      scene.add(b);
    }

    this.player = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.4, 0.9, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x2f6de0 }),
    );
    this.player.castShadow = true;
    scene.add(this.player);

    this.camera = new ThirdPersonCamera(this.engine.camera);
    this.camera.snapTo(this.pos);
    this.input = new Input(canvas);
    this.input.active = true;

    this.engine.start({
      update: (dt) => this.update(dt),
      render: () => this.engine.renderer.render(this.engine.scene, this.engine.camera),
      resize: () => {},
    });

    window.__MINI_GTA = {
      status: () => 'playing',
      start: () => {},
      teleport: (x, z) => this.pos.set(x, 0.9, z),
      snapshot: () => ({
        status: 'playing',
        player: { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw },
        playerInVehicle: false,
        vehicle: null,
        mission: { phase: 'idle', title: '', objective: '', waypoint: null, waypointRadius: 0, timeLeft: null, reward: 0 },
        money: 0,
        npcCount: 0,
        vehicleCount: 0,
        buildings: 7,
        drawCalls: this.engine.renderer.info.render.calls,
        fps: this.engine.fps,
      }),
      setSimSpeed: (m) => {
        this.engine.simSpeed = m;
      },
      frameCount: () => this.engine.currentFrame,
    };
  }

  private update(dt: number): void {
    const input: InputFrame = this.input.consume();
    this.camera.look(input.lookX, input.lookY);
    const speed = input.sprint ? 9 : 5;
    const fx = -Math.sin(this.camera.yaw);
    const fz = -Math.cos(this.camera.yaw);
    const rx = Math.cos(this.camera.yaw);
    const rz = -Math.sin(this.camera.yaw);
    let dx = fx * input.moveY + rx * input.moveX;
    let dz = fz * input.moveY + rz * input.moveX;
    const len = Math.hypot(dx, dz);
    if (len > 0.001) {
      dx /= len;
      dz /= len;
      this.yaw = Math.atan2(dx, dz);
    }
    this.vel.x = dx * speed;
    this.vel.z = dz * speed;
    this.pos.x = clamp(this.pos.x + this.vel.x * dt, -90, 90);
    this.pos.z = clamp(this.pos.z + this.vel.z * dt, -90, 90);
    this.player.position.copy(this.pos);
    this.player.rotation.y = this.yaw;
    this.camera.update(this.pos, dt, len > 0 ? (input.sprint ? 1 : 0.5) : 0, null);
  }
}
