/**
 * PLAYER — on-foot third-person character controller + procedural low-poly avatar.
 * Owned by: Agent 2 (W-2). Implements `PlayerController` from src/contracts.ts.
 *
 * Movement model
 *  - Camera-relative: cameraYaw 0 => camera sits at +Z looking towards −Z, so
 *    "forward" = (−sin(yaw), −cos(yaw)) and "right" = (cos(yaw), −sin(yaw)).
 *  - Input axes are normalised (diagonal input isn't faster).
 *  - Walk 4.2 m/s, sprint 8.0 m/s with smooth linear accel/decel.
 *  - Jump velocity 7.2 m/s under −26 m/s² gravity; kerbs are stepped up seamlessly.
 *
 * Collision model
 *  - Body = circle of radius 0.42 pushed out by `world.resolveCircle`.
 *  - Movement integrates X and Z separately → the body slides along walls and
 *    never ends a step inside a collider.
 *  - Hard clamp to `world.inBounds(x, z, margin)`.
 *
 * The class never touches `document`, so it runs headless in Vitest.
 */

import * as THREE from 'three';
import type { CollisionService, InputFrame, PlayerController } from '../contracts';
import { clamp, damp, dampAngle } from '../core/utils';

/* -------------------------------------------------------------------------- */
/* Tuning constants (exported so the Lead can review the feel)                 */
/* -------------------------------------------------------------------------- */

export const PLAYER_TUNING = {
  /** Body collider radius (m) */
  radius: 0.42,
  /** Walk speed (m/s) */
  walkSpeed: 4.2,
  /** Sprint speed (m/s) */
  runSpeed: 8.0,
  /** Linear acceleration when speeding up (m/s²) */
  groundAccel: 34,
  /** Linear deceleration when stopping or reversing direction (m/s²) */
  groundDecel: 42,
  /** Reduced control while airborne (m/s²) */
  airAccel: 10,
  /** Gravity (m/s², negative = down) */
  gravity: -26,
  /** Initial upward velocity of a jump (m/s) */
  jumpVelocity: 7.2,
  /** How fast the avatar turns towards its move direction (1/s) */
  turnLambda: 14,
  /** Max height the body steps up onto without jumping (m) */
  stepHeight: 0.45,
  /** Safety margin used by the world-bounds clamp (m) */
  boundsMargin: 0.6,
  /** Collision resolve passes per axis move */
  resolvePasses: 2,
  /** Avatar total height (m) */
  height: 1.75,
} as const;

/** Pelvis height (m) above the feet. */
const HIP_Y = 0.985; // hip height: thigh 0.46 + shin 0.4 + shoe/sole 0.125
/** Stride frequency at walk / sprint speed (cycles per second). */
const WALK_CYCLE = 1.55;
const RUN_CYCLE = 1.9;
const TAU = Math.PI * 2;

/** Street palette — fixed so every run looks identical. */
const PALETTE = {
  jacket: 0x25406b,
  jacketTrim: 0x162a4a,
  shirt: 0xd9dde6,
  jeans: 0x38476b,
  jeansCuff: 0x2b3752,
  sneaker: 0xb8323f,
  sole: 0xeeeeee,
  skin: 0xc98d63,
  hair: 0x2a1d16,
  cap: 0xc0392b,
  eye: 0x101418,
  bag: 0x4a4f57,
} as const;

/** Animated limb pivot group. */
interface Limb {
  pivot: THREE.Group;
}

/**
 * Build the procedural ~1.75 m avatar. Origin = feet, faces −Z in local space.
 *
 *   root            (placed at feet, rotated by yaw)
 *    └ rig          (bob / breathing offset)
 *       └ hips      (y = 0.9)
 *          ├ legL / legR  (pivot) ├ thigh, knee → shin, shoe
 *          └ torso
 *             ├ armL / armR (pivot) → upper arm, elbow → forearm, hand
 *             └ head (cap, brim, face)
 */
function buildAvatar(materials: THREE.Material[]) {
  const mat = (color: number, extra?: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.04, ...extra });
    materials.push(m);
    return m;
  };
  const jacket = mat(PALETTE.jacket, { roughness: 0.7 });
  const jacketTrim = mat(PALETTE.jacketTrim, { roughness: 0.75 });
  const shirt = mat(PALETTE.shirt, { roughness: 0.9 });
  const jeans = mat(PALETTE.jeans, { roughness: 0.95 });
  const jeansCuff = mat(PALETTE.jeansCuff, { roughness: 0.95 });
  const sneaker = mat(PALETTE.sneaker, { roughness: 0.6 });
  const sole = mat(PALETTE.sole, { roughness: 0.8 });
  const skin = mat(PALETTE.skin, { roughness: 0.7 });
  const hair = mat(PALETTE.hair, { roughness: 0.95 });
  const cap = mat(PALETTE.cap, { roughness: 0.6 });
  const eye = mat(PALETTE.eye, { roughness: 0.35, metalness: 0.1 });
  const bag = mat(PALETTE.bag, { roughness: 0.85 });

  const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
  const mesh = (geo: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  const root = new THREE.Group();
  root.name = 'player';
  const rig = new THREE.Group();
  rig.name = 'playerRig';
  root.add(rig);

  // Hip pivot sits at the leg tops; legs hang down from it.
  const hips = new THREE.Group();
  hips.position.y = HIP_Y;
  rig.add(hips);

  /* ------------------------------- legs ------------------------------- */
  const makeLeg = (side: -1 | 1): { limb: Limb; knee: THREE.Group } => {
    const pivot = new THREE.Group();
    pivot.position.set(0.13 * side, 0, 0);
    hips.add(pivot);
    pivot.add(mesh(box(0.19, 0.46, 0.22), jeans, 0, -0.23, 0)); // thigh
    const knee = new THREE.Group();
    knee.position.y = -0.44;
    pivot.add(knee);
    knee.add(mesh(box(0.17, 0.4, 0.19), jeans, 0, -0.2, 0)); // shin
    knee.add(mesh(box(0.18, 0.05, 0.2), jeansCuff, 0, -0.4, 0)); // cuff
    knee.add(mesh(box(0.19, 0.1, 0.3), sneaker, 0, -0.47, -0.06)); // shoe, toe to −Z
    knee.add(mesh(box(0.2, 0.04, 0.31), sole, 0, -0.535, -0.06)); // sole
    return { limb: { pivot }, knee };
  };
  const L = makeLeg(-1);
  const R = makeLeg(1);

  /* ------------------------------- torso ------------------------------ */
  const torso = new THREE.Group();
  hips.add(torso);
  torso.add(mesh(box(0.46, 0.5, 0.28), jacket, 0, 0.27, 0)); // chest
  torso.add(mesh(box(0.48, 0.12, 0.3), jacketTrim, 0, 0.02, 0)); // hem
  torso.add(mesh(box(0.1, 0.44, 0.02), shirt, 0, 0.27, -0.145)); // open jacket → shirt
  torso.add(mesh(box(0.3, 0.06, 0.24), jacketTrim, 0, 0.53, 0)); // collar
  torso.add(mesh(box(0.26, 0.2, 0.1), bag, 0.22, 0.06, 0.06)); // messenger bag
  const strap = mesh(box(0.05, 0.5, 0.02), bag, 0.02, 0.33, -0.15);
  strap.rotation.z = -0.55;
  torso.add(strap);

  /* ------------------------------- arms ------------------------------- */
  const makeArm = (side: -1 | 1): { limb: Limb; elbow: THREE.Group } => {
    const pivot = new THREE.Group();
    pivot.position.set(0.29 * side, 0.48, 0); // shoulder
    torso.add(pivot);
    pivot.add(mesh(box(0.13, 0.34, 0.15), jacket, 0, -0.16, 0)); // upper arm
    const elbow = new THREE.Group();
    elbow.position.y = -0.33;
    pivot.add(elbow);
    elbow.add(mesh(box(0.115, 0.3, 0.13), jacket, 0, -0.15, 0)); // forearm
    elbow.add(mesh(box(0.11, 0.11, 0.12), skin, 0, -0.34, 0)); // hand
    return { limb: { pivot }, elbow };
  };
  const AL = makeArm(-1);
  const AR = makeArm(1);

  /* ------------------------------- head ------------------------------- */
  const head = new THREE.Group();
  // Neck base sits on the collar (torso-local 0.53). Skull top ≈ 1.63 m,
  // cap top ≈ 1.75 m — total avatar height (feet → cap) = 1.75 m.
  // (Torso-local 0.48 keeps the cap clear of the shoulder-line rotation.)
  head.position.y = 0.48;
  torso.add(head);
  head.add(mesh(box(0.12, 0.1, 0.12), skin, 0, 0.02, 0)); // neck
  head.add(mesh(box(0.24, 0.26, 0.23), skin, 0, 0.19, 0)); // skull
  const eyeGeo = new THREE.BoxGeometry(0.035, 0.035, 0.02);
  head.add(mesh(eyeGeo, eye, -0.055, 0.21, -0.12));
  head.add(mesh(eyeGeo, eye, 0.055, 0.21, -0.12));
  head.add(mesh(box(0.04, 0.05, 0.04), skin, 0, 0.16, -0.13)); // nose
  head.add(mesh(box(0.06, 0.05, 0.06), hair, 0, 0.24, 0.1)); // hair tuft
  head.add(mesh(new THREE.CylinderGeometry(0.135, 0.1, 0.11, 10), cap, 0, 0.355, 0)); // crown
  head.add(mesh(box(0.22, 0.025, 0.15), cap, 0, 0.305, -0.16)); // brim
  head.add(mesh(new THREE.SphereGeometry(0.02, 6, 4), cap, 0, 0.412, 0)); // button

  return {
    root,
    rig,
    hips,
    torso,
    head,
    legL: L.limb,
    legR: R.limb,
    armL: AL.limb,
    armR: AR.limb,
    kneeL: L.knee,
    kneeR: R.knee,
    elbowL: AL.elbow,
    elbowR: AR.elbow,
  };
}

/* -------------------------------------------------------------------------- */
/* Player controller                                                          */
/* -------------------------------------------------------------------------- */

export class Player implements PlayerController {
  readonly object: THREE.Group;
  readonly position: THREE.Vector3;
  onFoot = true;

  private _yaw: number;
  private _speed = 0;
  private _grounded = true;
  private _walkPhase = 0;
  private _didJump = false;

  /** Horizontal velocity (m/s): x → world X, y → world Z. */
  private readonly vel = new THREE.Vector2();
  private vy = 0;
  /** Cached walkable bounds (probed once) so bounds checks stay O(1). */
  private bMinX = Number.NaN;
  private bMaxX = Number.NaN;
  private bMinZ = Number.NaN;
  private bMaxZ = Number.NaN;

  private readonly world: CollisionService;
  private readonly materials: THREE.Material[] = [];
  private readonly rig: THREE.Group;
  private readonly hips: THREE.Group;
  private readonly torso: THREE.Group;
  private readonly head: THREE.Group;
  private readonly legL: Limb;
  private readonly legR: Limb;
  private readonly armL: Limb;
  private readonly armR: Limb;
  private readonly kneeL: THREE.Group;
  private readonly kneeR: THREE.Group;
  private readonly elbowL: THREE.Group;
  private readonly elbowR: THREE.Group;

  // Animation smoothing state.
  private animSpeed = 0;
  private animBlend = 0;
  private airBlend = 0;
  private breathe = 0;

  constructor(scene: THREE.Scene, world: CollisionService, x = 0, z = 0, yaw = 0) {
    this.world = world;
    const avatar = buildAvatar(this.materials);
    this.object = avatar.root;
    this.rig = avatar.rig;
    this.hips = avatar.hips;
    this.torso = avatar.torso;
    this.head = avatar.head;
    this.legL = avatar.legL;
    this.legR = avatar.legR;
    this.armL = avatar.armL;
    this.armR = avatar.armR;
    this.kneeL = avatar.kneeL;
    this.kneeR = avatar.kneeR;
    this.elbowL = avatar.elbowL;
    this.elbowR = avatar.elbowR;
    this._yaw = yaw;

    this.position = new THREE.Vector3();
    scene.add(this.object);
    this.setPosition(x, z, yaw);
  }

  /* ---------------------------- contract getters --------------------------- */

  get yaw(): number {
    return this._yaw;
  }
  get speed(): number {
    return this._speed;
  }
  get isGrounded(): boolean {
    return this._grounded;
  }
  get walkPhase(): number {
    return this._walkPhase;
  }
  get didJump(): boolean {
    return this._didJump;
  }

  /* ------------------------------- placing -------------------------------- */

  /** Place the player safely: pushed out of colliders, snapped to the ground. */
  setPosition(x: number, z: number, yaw?: number): void {
    const T = PLAYER_TUNING;
    const p = this.world.resolveCircle(x, z, T.radius);
    this.position.x = p.x;
    this.position.z = p.z;
    this.position.y = this.world.groundHeight(this.position.x, this.position.z);
    this.vel.set(0, 0);
    this.vy = 0;
    this._speed = 0;
    this._grounded = true;
    this._didJump = false;
    if (yaw !== undefined && Number.isFinite(yaw)) this._yaw = yaw;
    this.syncTransform();
    this.animate(0); // pose now, avoids a T-pose on the first frame
  }

  /* --------------------------------- step --------------------------------- */

  update(dt: number, input: InputFrame, cameraYaw: number): void {
    this._didJump = false;
    if (!this.onFoot) {
      // Hidden while driving. Keep the transform in sync; no simulation.
      this._speed = 0;
      this.syncTransform();
      return;
    }
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const T = PLAYER_TUNING;

    /* ---- input → world-space direction (camera relative) ---- */
    const cy = Math.cos(cameraYaw);
    const sy = Math.sin(cameraYaw);
    // forward = (−sin, −cos), right = (cos, −sin)
    let dx = -sy * input.moveY + cy * input.moveX;
    let dz = -cy * input.moveY - sy * input.moveX;
    const inLen = Math.hypot(dx, dz);
    // Ignore stick drift / tiny diagonals.
    const hasInput = inLen > 0.02;
    if (hasInput) {
      dx /= inLen;
      dz /= inLen;
    } else {
      dx = 0;
      dz = 0;
    }

    const targetSpeed = hasInput ? (input.sprint ? T.runSpeed : T.walkSpeed) : 0;
    const targetX = dx * targetSpeed;
    const targetZ = dz * targetSpeed;

    /* ---- horizontal acceleration ---- */
    const sameDir = this.vel.x * targetX + this.vel.y * targetZ > 0;
    let accel: number;
    if (!this._grounded) accel = T.airAccel;
    else if (hasInput && sameDir) accel = T.groundAccel;
    else accel = T.groundDecel;
    const maxDelta = accel * dt;
    this.vel.x = moveTowards(this.vel.x, targetX, maxDelta);
    this.vel.y = moveTowards(this.vel.y, targetZ, maxDelta);

    /* ---- jumping & gravity ---- */
    if (input.jump && this._grounded) {
      this.vy = T.jumpVelocity;
      this._grounded = false;
      this._didJump = true;
    }
    if (!this._grounded) this.vy += T.gravity * dt;

    /* ---- integrate + collide (X and Z separately → wall sliding) ---- */
    const prevX = this.position.x;
    const prevZ = this.position.z;
    this.moveHorizontal(this.vel.x * dt, 0);
    this.moveHorizontal(0, this.vel.y * dt);

    /* ---- vertical resolution ---- */
    const ground = this.world.groundHeight(this.position.x, this.position.z);
    if (this._grounded) {
      const target = ground;
      const rise = target - this.position.y;
      const fall = this.position.y - target;
      if (fall > 0.002) {
        // Ground dropped away beneath us (kerb down): start falling from here.
        this._grounded = false;
      } else if (rise <= T.stepHeight) {
        this.position.y = target; // step up onto a kerb seamlessly
      } else {
        // A tall ledge appeared: refuse to climb it, fall instead.
        this._grounded = false;
      }
    }
    if (!this._grounded) {
      this.position.y += this.vy * dt;
      const floor = this.world.groundHeight(this.position.x, this.position.z);
      if (this.position.y <= floor && this.vy <= 0) {
        this.position.y = floor;
        this.vy = 0;
        this._grounded = true;
      } else if (this.position.y < -0.5) {
        // Failsafe: never drop out of the world.
        this.position.y = floor;
        this.vy = 0;
        this._grounded = true;
      }
    }

    /* ---- facing ---- */
    if (hasInput) {
      // Game convention: forward = (−sin yaw, −cos yaw) ⇒ yaw = atan2(−dx, −dz).
      const desiredYaw = Math.atan2(-dx, -dz);
      this._yaw = dampAngle(this._yaw, desiredYaw, T.turnLambda, dt);
    }

    /* ---- bookkeeping ---- */
    this._speed = Math.hypot(this.position.x - prevX, this.position.z - prevZ) / dt;
    if (!Number.isFinite(this.position.x) || !Number.isFinite(this.position.y) || !Number.isFinite(this.position.z)) {
      // Paranoia: never leave the character in a NaN state.
      this.setPosition(prevX, prevZ);
      return;
    }

    this.syncTransform();
    this.animate(dt);
  }

  /**
   * Move the body circle by (dx, dz) then push it out of static colliders.
   * Only X OR Z is non-zero per call, which gives clean wall sliding.
   * If the push-out cancels the motion, the matching velocity component stops.
   */
  private moveHorizontal(dx: number, dz: number): void {
    if (dx === 0 && dz === 0) return;
    const T = PLAYER_TUNING;
    let nx = this.position.x + dx;
    let nz = this.position.z + dz;
    for (let i = 0; i < T.resolvePasses; i++) {
      const p = this.world.resolveCircle(nx, nz, T.radius);
      if (p.x === nx && p.z === nz) break;
      nx = p.x;
      nz = p.z;
    }
    // Stop the axis if we were pushed back past where we started.
    if (dx > 0 ? nx < this.position.x : dx < 0 ? nx > this.position.x : false) this.vel.x = 0;
    if (dz > 0 ? nz < this.position.z : dz < 0 ? nz > this.position.z : false) this.vel.y = 0;
    this.position.x = nx;
    this.position.z = nz;

    // World bounds (hard clamp with margin).
    const m = T.boundsMargin;
    if (!this.world.inBounds(this.position.x, this.position.z, m)) {
      if (Number.isNaN(this.bMinX)) this.probeBounds();
      const cx = clamp(this.position.x, this.bMinX + m, this.bMaxX - m);
      const cz = clamp(this.position.z, this.bMinZ + m, this.bMaxZ - m);
      if (this.world.inBounds(cx, cz, m)) {
        if (cx !== this.position.x) this.vel.x = 0;
        if (cz !== this.position.z) this.vel.y = 0;
        this.position.x = cx;
        this.position.z = cz;
      } else {
        // Unknown edge: step back towards the previous (valid) position.
        this.position.x -= dx;
        this.position.z -= dz;
        if (dx !== 0) this.vel.x = 0;
        if (dz !== 0) this.vel.y = 0;
      }
    }
  }

  /** Binary-search the four walkable edges once and cache them. */
  private probeBounds(): void {
    const x = this.position.x;
    const z = this.position.z;
    const probe = (alongX: boolean, dir: -1 | 1): number => {
      const at = (d: number) => (alongX ? this.world.inBounds(x + d, z, 0) : this.world.inBounds(x, z + d, 0));
      if (!at(0)) return Number.NaN;
      let lo = 0;
      let hi = 0;
      for (let d = 4; d <= 600; d += 4) {
        if (!at(d * dir)) {
          lo = (d - 4) * dir;
          hi = d * dir;
          break;
        }
      }
      if (lo === hi && hi === 0) return dir > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      for (let i = 0; i < 10; i++) {
        const mid = (lo + hi) / 2;
        if (at(mid)) lo = mid;
        else hi = mid;
      }
      return (alongX ? x : z) + (lo + hi) / 2;
    };
    const minX = probe(true, -1);
    const maxX = probe(true, 1);
    const minZ = probe(false, -1);
    const maxZ = probe(false, 1);
    if (Number.isNaN(minX) || Number.isNaN(maxX) || Number.isNaN(minZ) || Number.isNaN(maxZ)) {
      // Point reported outside bounds: treat as unbounded; collision circle still protects us.
      this.bMinX = Number.NEGATIVE_INFINITY;
      this.bMaxX = Number.POSITIVE_INFINITY;
      this.bMinZ = Number.NEGATIVE_INFINITY;
      this.bMaxZ = Number.POSITIVE_INFINITY;
      return;
    }
    this.bMinX = minX;
    this.bMaxX = maxX;
    this.bMinZ = minZ;
    this.bMaxZ = maxZ;
  }

  private syncTransform(): void {
    this.object.position.copy(this.position);
    // Avatar is modelled facing −Z, which is exactly the game convention
    // (forward = (−sin yaw, −cos yaw)), so the mesh yaw equals the game yaw.
    this.object.rotation.y = this._yaw;
  }

  /* ------------------------------- visuals -------------------------------- */

  /** Pose the avatar. dt = 0 poses instantly (used by setPosition). */
  private animate(dt: number): void {
    const speed = this._speed;
    if (dt > 0) {
      this.animSpeed = damp(this.animSpeed, speed, 12, dt);
      this.animBlend = damp(this.animBlend, speed > 0.15 ? 1 : 0, 10, dt);
      this.airBlend = damp(this.airBlend, this._grounded ? 0 : 1, 14, dt);
      if (this._grounded && speed > 0.05) {
        const runness = clamp((speed - 3) / (PLAYER_TUNING.runSpeed - 3), 0, 1);
        const freq = WALK_CYCLE + (RUN_CYCLE - WALK_CYCLE) * runness;
        // Stride frequency ramps with speed so shuffling starts look natural.
        this._walkPhase = (this._walkPhase + TAU * freq * dt * clamp(speed / 2.5, 0.25, 1)) % TAU;
      }
      this.breathe += dt;
    }

    const w = this._walkPhase;
    const s = Math.sin(w);
    const c = Math.cos(w);
    const runness = clamp((this.animSpeed - 3) / (PLAYER_TUNING.runSpeed - 3), 0, 1);
    const g = this.animBlend * (1 - this.airBlend); // grounded locomotion weight
    const air = this.airBlend;
    const idle = Math.sin(this.breathe * 2.2) * (1 - this.animBlend);

    /* legs: opposite phase; knees bend on the back swing */
    const legSwing = 0.55 + 0.3 * runness;
    this.legL.pivot.rotation.x = s * legSwing * g - 0.8 * air;
    this.legR.pivot.rotation.x = -s * legSwing * g - 0.4 * air;
    this.kneeL.rotation.x = Math.max(0, -s) * (0.9 + 0.5 * runness) * g + 1.2 * air;
    this.kneeR.rotation.x = Math.max(0, s) * (0.9 + 0.5 * runness) * g + 0.95 * air;

    /* arms: counter-swing to the legs; elbows tuck when running; tuck when airborne */
    const armSwing = 0.5 + 0.4 * runness;
    this.armL.pivot.rotation.x = -s * armSwing * g - 0.6 * air + idle * 0.02;
    this.armR.pivot.rotation.x = s * armSwing * g - 0.6 * air + idle * 0.02;
    this.armL.pivot.rotation.z = -0.08 - 0.05 * runness - 0.45 * air;
    this.armR.pivot.rotation.z = 0.08 + 0.05 * runness + 0.45 * air;
    this.elbowL.rotation.x = -0.15 - 0.75 * runness - Math.max(0, s) * 0.3 * g - 0.7 * air;
    this.elbowR.rotation.x = -0.15 - 0.75 * runness - Math.max(0, -s) * 0.3 * g - 0.7 * air;

    /* torso lean / counter rotation + idle breathing */
    this.torso.rotation.x = 0.03 * g + 0.14 * runness * g + 0.1 * air;
    this.torso.rotation.y = -s * 0.18 * g;
    this.hips.rotation.y = s * 0.1 * g;
    // Keep the head level: cancel most of the torso lean so the cap stays upright.
    this.head.rotation.x = -this.torso.rotation.x * 0.9 + idle * 0.015;

    /* vertical bob: two bounces per stride + breathing */
    this.rig.position.y = Math.abs(c) * 0.045 * g * (1 - runness * 0.4) + idle * 0.006 + 0.04 * air;
  }

  /* ------------------------------- cleanup -------------------------------- */

  dispose(): void {
    this.object.parent?.remove(this.object);
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }
}

/** Move `v` towards `target` by at most `maxDelta`. */
function moveTowards(v: number, target: number, maxDelta: number): number {
  const d = target - v;
  if (d > maxDelta) return v + maxDelta;
  if (d < -maxDelta) return v - maxDelta;
  return target;
}

/**
 * Convenience factory matching the brief's `createPlayer(scene, world)`.
 * Adds the avatar to `scene` and returns the controller.
 */
export function createPlayer(scene: THREE.Scene, world: CollisionService, x = 0, z = 0, yaw = 0): Player {
  return new Player(scene, world, x, z, yaw);
}
