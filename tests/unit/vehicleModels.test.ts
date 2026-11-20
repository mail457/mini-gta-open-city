/**
 * Vehicle model contract tests (src/entities/vehicleModels.ts).
 *
 * The game drives these meshes by name/number: VehicleSystem reads `wheels`,
 * `steerPivots`-style gates (`front`), `brakeLights`/`headlights` materials,
 * `body` for pitch/roll and `shadow` for the ground blob. These tests pin that
 * contract, the scene convention (+Z nose, +X left, y = 0 contact patch) and
 * the per-car rendering budget.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VehicleSpec, VehicleTypeId } from '../../src/contracts';
import {
  VEHICLE_MESH_BUDGET,
  VEHICLE_TRIANGLE_BUDGET,
  createVehicleMesh,
  disposeVehicleMesh,
  getVehicleMeshData,
  tintVehicleMesh,
  type VehicleMesh,
} from '../../src/entities/vehicleModels';

/** Mirrors VEHICLE_SPECS in src/entities/vehicles.ts (dims + colours). */
const SPECS: Record<VehicleTypeId, VehicleSpec> = {
  sedan: { id: 'sedan', label: 'Sedan', maxSpeed: 34, maxReverse: 9, accel: 12, brake: 24, steerRate: 1.55, grip: 0.86, length: 4.4, width: 1.9, height: 1.45, color: 0x2f6fb5 },
  sport: { id: 'sport', label: 'Sport', maxSpeed: 46, maxReverse: 9, accel: 19, brake: 26, steerRate: 1.75, grip: 0.8, length: 4.3, width: 1.9, height: 1.22, color: 0xd8402c },
  van: { id: 'van', label: 'Van', maxSpeed: 26, maxReverse: 7, accel: 8, brake: 30, steerRate: 1.25, grip: 0.93, length: 5.2, width: 2.1, height: 2.15, color: 0xe4e2da },
};

const TYPES = Object.keys(SPECS) as VehicleTypeId[];

/** Bounding box of the car itself (the contact blob is a ground decal). */
function carBounds(mesh: THREE.Object3D): THREE.Box3 {
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3();
  for (const child of mesh.children) {
    if (child.name === 'contact-blob') continue;
    box.expandByObject(child);
  }
  return box;
}

/** Triangles as the GPU counts them (non-indexed faces, × instances). */
function triangleCount(mesh: THREE.Object3D): number {
  let tris = 0;
  mesh.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    const faces = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const instances = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    tris += faces * instances;
  });
  return tris;
}

function meshes(mesh: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  mesh.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

describe('createVehicleMesh — handle data contract', () => {
  it.each(TYPES)('%s exposes the full VehicleMeshData shape', (id) => {
    const spec = SPECS[id];
    const mesh = createVehicleMesh(spec);
    const data = getVehicleMeshData(mesh);

    expect(data.spec).toBe(spec);
    expect(data.body).toBeInstanceOf(THREE.Group);
    expect(data.body.parent).toBe(mesh);
    // 4 wheels in FL, FR, RL, RR order.
    expect(data.wheels).toHaveLength(4);
    for (const w of data.wheels) {
      expect(w.steer).toBeInstanceOf(THREE.Group);
      expect(w.spin).toBeInstanceOf(THREE.Group);
      expect(w.spin.parent).toBe(w.steer);
      expect(w.radius).toBeGreaterThan(0.2);
      expect(typeof w.front).toBe('boolean');
    }
    // Exactly the two front wheels steer (they sit on the nose, +Z).
    const front = data.wheels.filter((w) => w.front);
    expect(front).toHaveLength(2);
    for (const w of front) expect(w.steer.position.z).toBeGreaterThan(0);
    for (const w of data.wheels.filter((w) => !w.front)) expect(w.steer.position.z).toBeLessThan(0);
    // Wheel spin pivots roll at the right radius.
    for (const w of data.wheels) expect(w.steer.position.y).toBeCloseTo(w.radius, 6);

    expect(data.brakeLights.length).toBeGreaterThan(0);
    expect(data.headlights.length).toBeGreaterThan(0);
    for (const m of [...data.brakeLights, ...data.headlights]) {
      expect(m).toBeInstanceOf(THREE.MeshStandardMaterial);
      expect(m.emissive.getHex()).toBeGreaterThan(0); // emissive lenses
    }
    expect(data.shadow).toBeInstanceOf(THREE.Mesh);
    expect(data.shadow.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(data.paint).toBeInstanceOf(THREE.MeshStandardMaterial);

    disposeVehicleMesh(mesh);
  });

  it.each(TYPES)('%s keeps the scene convention: +Z nose, +X left, contact at y = 0', (id) => {
    const spec = SPECS[id];
    const mesh = createVehicleMesh(spec);
    const data = getVehicleMeshData(mesh);

    // +X flank of the FR wheel is at +X (car's left) and the front axle is +Z.
    const fr = data.wheels.find((w) => w.front && w.steer.position.x > 0);
    expect(fr).toBeDefined();
    expect(fr!.steer.position.x).toBeGreaterThan(0);
    expect(fr!.steer.position.z).toBeGreaterThan(0);

    // The tyres touch the road plane (y = 0) and the car grows upwards.
    const box = carBounds(mesh);
    expect(box.min.y).toBeLessThanOrEqual(0.02);
    expect(box.max.y).toBeGreaterThan(spec.height * 0.6);

    // The nose (+Z) carries the headlights and the tail (−Z) the brake lights.
    const head = mesh.getObjectByName('headlights') as THREE.Mesh;
    const tail = mesh.getObjectByName('taillights') as THREE.Mesh;
    expect(head).toBeDefined();
    expect(tail).toBeDefined();
    const headBox = new THREE.Box3().setFromBufferAttribute(head.geometry.attributes.position as THREE.BufferAttribute);
    const tailBox = new THREE.Box3().setFromBufferAttribute(tail.geometry.attributes.position as THREE.BufferAttribute);
    expect(headBox.max.z).toBeGreaterThan(0);
    expect(tailBox.min.z).toBeLessThan(0);
    expect(head.material).toBe(data.headlights[0]);
    expect(tail.material).toBe(data.brakeLights[0]);

    disposeVehicleMesh(mesh);
  });

  /**
   * The car's own bounds vs the spec box. The model is built so length and
   * height land within ±15% of the collision box (the bbox measures the whole
   * car, mirrors included) and the painted flanks cover most of the width.
   */
  it.each(TYPES)('%s bounding box matches the spec length / width / height (±15%)', (id) => {
    const spec = SPECS[id];
    const mesh = createVehicleMesh(spec);
    const size = carBounds(mesh).getSize(new THREE.Vector3());
    // Length: the profile is built so the finished car ≈ spec.length.
    expect(size.z).toBeGreaterThan(spec.length * 0.85);
    expect(size.z).toBeLessThan(spec.length * 1.15);
    // Width: spec.width includes the mirrors; the painted flanks cover ≥ 75%.
    expect(size.x).toBeGreaterThan(spec.width * 0.75);
    expect(size.x).toBeLessThan(spec.width * 1.2);
    // Height: roof ≈ spec.height (a few percent of bevel/rails allowed).
    expect(size.y).toBeGreaterThan(spec.height * 0.85);
    expect(size.y).toBeLessThan(spec.height * 1.15);
    disposeVehicleMesh(mesh);
  });

  it.each(TYPES)('%s stays inside the draw-call and triangle budget', (id) => {
    const mesh = createVehicleMesh(SPECS[id]);
    expect(meshes(mesh).length).toBeLessThanOrEqual(VEHICLE_MESH_BUDGET);
    expect(triangleCount(mesh)).toBeLessThanOrEqual(VEHICLE_TRIANGLE_BUDGET);
    disposeVehicleMesh(mesh);
  });

  it.each(TYPES)('%s keeps bodies casting shadows and lenses not casting', (id) => {
    const mesh = createVehicleMesh(SPECS[id]);
    const body = mesh.getObjectByName('body-paint') as THREE.Mesh;
    expect(body.castShadow).toBe(true);
    expect(body.receiveShadow).toBe(true);
    const tyres = mesh.getObjectByName('tyres') as THREE.Mesh;
    expect(tyres.castShadow).toBe(true); // wheels shade the ground, as before
    const head = mesh.getObjectByName('headlights') as THREE.Mesh;
    expect(head.castShadow).toBe(false);
    const glass = mesh.getObjectByName('cabin-glass') as THREE.Mesh;
    expect(glass.castShadow).toBe(false);
    disposeVehicleMesh(mesh);
  });

  it('three types are visually distinct (different silhouettes)', () => {
    const sizes = TYPES.map((id) => {
      const mesh = createVehicleMesh(SPECS[id]);
      const size = carBounds(mesh).getSize(new THREE.Vector3());
      disposeVehicleMesh(mesh);
      return `${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`;
    });
    expect(new Set(sizes).size).toBe(TYPES.length);
  });
});

describe('tintVehicleMesh / disposeVehicleMesh', () => {
  it('recolours the paint material in place without rebuilding', () => {
    const mesh = createVehicleMesh(SPECS.sedan);
    const data = getVehicleMeshData(mesh);
    const bodyBefore = mesh.getObjectByName('body-paint');
    const paint = data.paint;

    tintVehicleMesh(mesh, 0x00ff00);

    expect(data.paint).toBe(paint); // same material instance (the game holds it)
    expect(paint.color.getHex()).toBe(0x00ff00);
    expect(mesh.getObjectByName('body-paint')).toBe(bodyBefore);
    expect((bodyBefore as THREE.Mesh).material).toBe(paint);
    disposeVehicleMesh(mesh);
  });

  it('getVehicleMeshData rejects objects it did not build', () => {
    expect(() => getVehicleMeshData(new THREE.Group())).toThrow(/createVehicleMesh/);
  });

  it('disposeVehicleMesh disposes every geometry / material and detaches', () => {
    const scene = new THREE.Scene();
    const mesh: VehicleMesh = createVehicleMesh(SPECS.van);
    scene.add(mesh);
    // Patch `dispose` on every resource (works in Node: no WebGL listeners needed).
    let geometries = 0;
    let materials = 0;
    for (const m of meshes(mesh)) {
      const g = m.geometry;
      const mat = m.material as THREE.Material;
      const gDispose = g.dispose.bind(g);
      const mDispose = mat.dispose.bind(mat);
      g.dispose = () => {
        geometries += 1;
        gDispose();
      };
      mat.dispose = () => {
        materials += 1;
        mDispose();
      };
    }
    const total = meshes(mesh).length;
    disposeVehicleMesh(mesh);
    expect(mesh.parent).toBeNull();
    expect(scene.children).not.toContain(mesh);
    expect(geometries).toBe(total);
    expect(materials).toBe(total);
  });
});
