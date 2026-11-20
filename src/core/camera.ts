import * as THREE from 'three';
import type { XZ } from '../contracts';
import { clamp, damp } from './utils';

/**
 * Third-person follow camera with orbit (mouse), auto-align while driving,
 * and collision-free soft offsets. Owned by: Lead (Agent 2 consumes it).
 */
export class ThirdPersonCamera {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = 0.28;
  private distance = 6.2;
  private targetDistance = 6.2;
  private height = 1.6;
  private targetHeight = 1.6;
  private lookHeight = 1.5;
  private targetLookHeight = 1.5;
  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private followPos = new THREE.Vector3();
  private shakeAmp = 0;
  private shakeTime = 0;
  /** Driving mode: camera trails behind the vehicle yaw. */
  mode: 'foot' | 'car' = 'foot';
  private baseFov = 62;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  look(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, 0.02, 1.2);
  }

  shake(amount: number): void {
    // Audio-thread safety: never let a NaN reach the matrix (it kills the WebAudio renderer).
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.shakeAmp = Math.min(0.4, this.shakeAmp + amount);
  }

  setMode(mode: 'foot' | 'car'): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.targetDistance = mode === 'car' ? 9.5 : 6.2;
    this.targetHeight = mode === 'car' ? 3.4 : 1.6;
    this.targetLookHeight = mode === 'car' ? 1.3 : 1.5;
  }

  snapTo(pos: THREE.Vector3): void {
    this.followPos.copy(pos);
    this.computeDesired(pos);
    this.camera.position.copy(this.desired);
    this.lookAt.set(pos.x, pos.y + this.lookHeight, pos.z);
    this.camera.lookAt(this.lookAt);
  }

  private computeDesired(anchor: THREE.Vector3): void {
    const cp = Math.cos(this.pitch);
    const dist = this.distance;
    this.desired.set(
      anchor.x + Math.sin(this.yaw) * cp * dist,
      anchor.y + this.height + Math.sin(this.pitch) * dist,
      anchor.z + Math.cos(this.yaw) * cp * dist,
    );
    if (this.desired.y < 0.6) this.desired.y = 0.6;
  }

  /**
   * @param anchor focus point (player head or vehicle body)
   * @param dt delta seconds
   * @param speedRatio 0..1 used to widen FOV + pull back while fast
   * @param autoYaw when driving and no mouse input recently, trail the car heading
   */
  update(anchor: THREE.Vector3, dt: number, speedRatio: number, autoYaw: number | null, obstacles: XZ[] = []): void {
    // Auto-trail: keep the camera behind the subject while driving / when idle,
    // turning at a limited, smooth rate so it never snaps around.
    if (autoYaw !== null) {
      let d = autoYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      const maxTurn = (this.mode === 'car' ? 2.6 : 1.6) * dt; // rad/s
      const want = d * (1 - Math.exp(-3.2 * dt));
      this.yaw += clamp(want, -maxTurn, maxTurn);
    }
    // Smooth the boom length/height.
    this.distance = damp(this.distance, Math.min(this.targetDistance + speedRatio * 1.8, 1.35 / Math.sin(Math.max(this.pitch, 0.02))), 4, dt);
    this.height = damp(this.height, this.targetHeight, 4, dt);
    this.lookHeight = damp(this.lookHeight, this.targetLookHeight, 5, dt);
    // Position smoothing: snappier while driving so the car stays centred.
    const posL = this.mode === 'car' ? 26 : 16;
    this.followPos.x = damp(this.followPos.x, anchor.x, posL, dt);
    this.followPos.y = damp(this.followPos.y, anchor.y, 9, dt);
    this.followPos.z = damp(this.followPos.z, anchor.z, posL, dt);
    this.computeDesired(this.followPos);

    // Wall avoidance: pull the camera in if the boom would clip a building.
    let blocked = 0;
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      const dx = this.desired.x - o.x;
      const dz = this.desired.z - o.z;
      if (dx * dx + dz * dz < 4) blocked++;
    }
    if (blocked > 0) {
      const t = 1 - Math.min(0.45, blocked * 0.2);
      this.desired.x = this.followPos.x + (this.desired.x - this.followPos.x) * t;
      this.desired.z = this.followPos.z + (this.desired.z - this.followPos.z) * t;
      this.desired.y += 0.6;
    }

    this.camera.position.lerp(this.desired, 1 - Math.exp(-18 * dt));
    this.lookAt.set(this.followPos.x, this.followPos.y + this.lookHeight, this.followPos.z);

    // Crash shake.
    if (this.shakeAmp > 0.001) {
      this.shakeTime += dt * 40;
      const s = this.shakeAmp;
      this.camera.position.x += Math.sin(this.shakeTime * 1.7) * s;
      this.camera.position.y += Math.cos(this.shakeTime * 2.3) * s;
      this.shakeAmp = Math.max(0, this.shakeAmp - dt * 1.4);
    }
    this.camera.lookAt(this.lookAt);

    const fov = this.baseFov + speedRatio * 12;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, fov, 5, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
