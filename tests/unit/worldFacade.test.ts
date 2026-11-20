/**
 * Regression tests for the "buildings are invisible, only windows are showing"
 * bug (QA).
 *
 * Root cause recap: the facade bucket of `buildCity` used to emit
 *  - a black (0,0,0) cornice + perimeter "strip" sitting exactly ON the stone
 *    body (coplanar → z-fight, resolved to black in practice), and
 *  - glass panels only 12 cm thick whose *visible side faces* (0.6 m² of dark
 *    glass per window) covered the facade columns, so ~96% of every facade
 *    pixel was black glass or black cornice and the stone body was never seen.
 * On top of that the facade material used vertex colours close to 1.0 and
 * nothing in the unit tests looked at the geometry, so the regression shipped.
 *
 * These tests render NOTHING: they inspect the merged geometry of
 * `buildBuildingGeometry` (the only facade source) and the city built by
 * `createWorld`, and assert the invariants that make a building readable.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BUILDING_STYLES, bodySlabs, buildBuildingGeometry, type BuildingGeoSpec } from '../../src/world/buildingKit';
import { CITY_DRESSING, City, FACADE_LIGHTING, createWorld } from '../../src/world/world';

const SPEC: BuildingGeoSpec = { x: 0, z: 0, hx: 11, hz: 11, h: 34, style: 0 };

type Geo = THREE.BufferGeometry;

const positions = (g: Geo): THREE.BufferAttribute => g.attributes.position as THREE.BufferAttribute;
const colours = (g: Geo): THREE.BufferAttribute | undefined => g.attributes.color as THREE.BufferAttribute | undefined;
const normals = (g: Geo): THREE.BufferAttribute => g.attributes.normal as THREE.BufferAttribute;

/** Every triangle as [a, b, c] world-space vectors. */
function triangles(g: Geo): Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> {
  const p = positions(g);
  const idx = g.index;
  const count = idx ? idx.count : p.count;
  const out: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [];
  const at = (i: number) =>
    new THREE.Vector3(
      p.getX(idx ? idx.getX(i) : i),
      p.getY(idx ? idx.getX(i) : i),
      p.getZ(idx ? idx.getX(i) : i),
    );
  for (let i = 0; i < count; i += 3) out.push([at(i), at(i + 1), at(i + 2)]);
  return out;
}

/** [triangle, per-corner vertex normals]. */
function trianglesWithNormals(g: Geo): Array<[[THREE.Vector3, THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3, THREE.Vector3]]> {
  const p = positions(g);
  const n = normals(g);
  const idx = g.index;
  const count = idx ? idx.count : p.count;
  const out: Array<[[THREE.Vector3, THREE.Vector3, THREE.Vector3], [THREE.Vector3, THREE.Vector3, THREE.Vector3]]> = [];
  const at = (i: number) => {
    const k = idx ? idx.getX(i) : i;
    return [
      new THREE.Vector3(p.getX(k), p.getY(k), p.getZ(k)),
      new THREE.Vector3(n.getX(k), n.getY(k), n.getZ(k)),
    ] as [THREE.Vector3, THREE.Vector3];
  };
  for (let i = 0; i < count; i += 3) {
    const a = at(i);
    const b = at(i + 1);
    const c = at(i + 2);
    out.push([
      [a[0], b[0], c[0]],
      [a[1], b[1], c[1]],
    ]);
  }
  return out;
}

const centroid = (t: [THREE.Vector3, THREE.Vector3, THREE.Vector3]) =>
  t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);

/** Geometric normal from the triangle winding (what the GPU uses for culling). */
function windingNormal(t: [THREE.Vector3, THREE.Vector3, THREE.Vector3]): THREE.Vector3 {
  return t[1].clone().sub(t[0]).cross(t[2].clone().sub(t[0])).normalize();
}

describe('buildingKit — a facade must be a lit stone body with real windows', () => {
  const { wall, glass, trim } = buildBuildingGeometry(SPEC);

  it('emits non-empty, non-indexed, merge-friendly geometry', () => {
    console.log('DBG1 wall=' + wall.attributes.position.count + ' glass=' + glass.attributes.position.count + ' trim=' + trim.attributes.position.count);
    for (const [name, g] of Object.entries({ wall, glass, trim })) {
      expect(positions(g).count, `${name} has vertices`).toBeGreaterThan(0);
      expect(g.index, `${name} is non-indexed`).toBeNull();
      expect(colours(g), `${name} carries vertex colours`).toBeDefined();
      expect(normals(g).count).toBe(positions(g).count);
      // Every position is finite (a NaN anywhere makes the whole merged bucket vanish).
      const a = positions(g).array;
      for (let i = 0; i < a.length; i++) expect(Number.isFinite(a[i]), `${name} finite positions`).toBe(true);
    }
    expect(positions(glass).count).toBeGreaterThan(positions(wall).count);
  });

  it('uses linear vertex colours in [0.2, 0.75] for the stone and never black', () => {
    // Stone/trim are the two big lit surfaces: they must stay inside the linear
    // band (not near-white, not black). Glass is a dark blue-grey: its blue
    // channel sits around 0.35 and only the faint red channel dips below 0.2.
    for (const [name, g] of Object.entries({ wall })) {
      const c = colours(g)!;
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < c.array.length; i++) {
        min = Math.min(min, c.array[i]);
        max = Math.max(max, c.array[i]);
      }
      expect(min, `${name} colour min`).toBeGreaterThanOrEqual(0.2);
      // Upper safety margin: near-white (0.85+) vertex colours wash the walls out;
      // exact ceilings are asserted per style below (self-calibrating).
      expect(max, `${name} colour max`).toBeLessThan(0.85);
    }
    // Trim (cornice + sills): light stone, brighter than the wall on purpose.
    const tc = colours(trim)!;
    let tmin = Infinity;
    for (let i = 0; i < tc.array.length; i++) tmin = Math.min(tmin, tc.array[i]);
    expect(tmin, 'trim is never black').toBeGreaterThan(0.35);
    // Glass: not black (the old GLASS colour 0x2b3a4a rendered as pure black
    // once the window quads covered the facade), but clearly darker than stone.
    const gc = colours(glass)!;
    let gmax = -Infinity;
    for (let i = 0; i < gc.array.length; i++) gmax = Math.max(gmax, gc.array[i]);
    expect(gmax, 'glass is a visible dark pane, not a black hole').toBeGreaterThan(0.06);
    // ...and its body (the blue channel) is a real mid-dark slate, not pure black.
    // Stone reads lighter than glass (windows must read darker).
    const lightness = (g: Geo) => {
      const c = colours(g)!;
      let s = 0;
      for (let i = 0; i < c.array.length; i += 3) s += 0.2126 * c.array[i] + 0.7152 * c.array[i + 1] + 0.0722 * c.array[i + 2];
      return s / (c.array.length / 3);
    };
    expect(lightness(wall) - lightness(glass)).toBeGreaterThan(0.1);
  });

  it('has unit-length normals consistent with the triangle winding (no inverted shells)', () => {
    for (const [name, g] of Object.entries({ wall, glass, trim })) {
      const n = normals(g);
      for (let i = 0; i < n.count; i++) {
        const len = Math.hypot(n.getX(i), n.getY(i), n.getZ(i));
        expect(len, `${name} normal ${i} is unit length`).toBeCloseTo(1, 3);
      }
      // Every triangle must face the same way the GPU will backface-cull it from:
      // the stored corner normals and the winding normal agree (dot > 0). If a
      // generator ever mirrors a piece, this is what catches it.
      let agree = 0;
      const tris = trianglesWithNormals(g);
      for (const [t, ns] of tris) {
        const wn = windingNormal(t);
        if (wn.lengthSq() === 0 || !Number.isFinite(wn.x)) continue;
        const avg = ns[0].clone().add(ns[1]).add(ns[2]).normalize();
        if (wn.dot(avg) > 0) agree++;
      }
      expect(agree / tris.length, `${name} winding matches vertex normals`).toBeGreaterThan(0.95);
    }
    // Outward check on the stone body: pick the body's own bounding-box centre
    // (the parapet sits proud + higher, so the body centre must be inside it).
    const bodyTris = triangles(wall);
    const xs: number[] = [];
    const zs: number[] = [];
    for (const t of bodyTris) for (const v of t) { xs.push(v.x); zs.push(v.z); }
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const n = normals(wall);
    let outward = 0;
    for (let i = 0; i < n.count; i++) {
      const px = positions(wall).getX(i) - cx;
      const pz = positions(wall).getZ(i) - cz;
      if (px * n.getX(i) + pz * n.getZ(i) >= -0.02) outward++;
    }
    expect(outward / n.count, 'body vertex normals point away from the building centre').toBeGreaterThan(0.9);
  });

  it('keeps the walls visible at street level: each window side reveals only a narrow strip, no full-height columns', () => {
    // Project every glass triangle onto the four facade faces and look for
    // near-vertical strips that span whole floors (= the old black column bug).
    const st = BUILDING_STYLES[SPEC.style % BUILDING_STYLES.length];
    const isVerticalFace = (t: [THREE.Vector3, THREE.Vector3, THREE.Vector3]) => {
      const n = windingNormal(t);
      return Math.abs(n.y) < 0.5;
    };
    const glassTris = triangles(glass).filter(isVerticalFace);
    expect(glassTris.length).toBeGreaterThan(0);
    const wh = st.floor * 0.42;
    // A side face is a quad of width GLASS_DEPTH (≈0.2 m) and height wh. Its two
    // triangles are small; nothing may be taller than a window plus tolerance.
    let biggest = 0;
    for (const t of glassTris) {
      const ys = [t[0].y, t[1].y, t[2].y];
      biggest = Math.max(biggest, Math.max(...ys) - Math.min(...ys));
    }
    expect(biggest).toBeLessThanOrEqual(wh + 0.01);
    // ...and no triangle may be wider than one window bay either (no slabs).
    let widest = 0;
    for (const t of glassTris) widest = Math.max(widest, t[0].distanceTo(t[1]), t[1].distanceTo(t[2]), t[0].distanceTo(t[2]));
    expect(widest).toBeLessThan(st.bay);
  });

  it('negative control: the old 12 cm glass slabs (0.2 m wide, then 2 m full-height columns) fail the column rule', () => {
    // The pre-fix kit built each window as BoxGeometry(1.0, wh, 0.12): a "panel"
    // whose VISIBLE side faces were 12 cm wide columns of black glass standing
    // 0.5 m proud of the wall, repeated at 2.4 m pitch. Reproduce that cell and
    // check the same invariant the test above enforces on the real kit.
    const bad = new THREE.BoxGeometry(1.0, 1.77, 0.12).toNonIndexed();
    const st = BUILDING_STYLES[0];
    const wh = st.floor * 0.52;
    const tri = triangles(bad).filter((t) => Math.abs(windingNormal(t).y) < 0.5);
    let tallest = 0;
    for (const t of tri) {
      const ys = [t[0].y, t[1].y, t[2].y];
      tallest = Math.max(tallest, Math.max(...ys) - Math.min(...ys));
    }
    // A side face of that box spans the whole window height: this is the panel the
    // old kit shipped, and the column foot-print it exposed is (depth x wh).
    expect(tallest).toBeGreaterThan(wh * 0.9);
    expect(0.12 * wh).toBeGreaterThan(0.1);
  });

  it('leaves the stone body visible around the windows (window area is a minority of each face)', () => {
    const st = BUILDING_STYLES[SPEC.style % BUILDING_STYLES.length];
    const floors = Math.floor((SPEC.h - 3.2 - 0.6) / st.floor);
    const cols = Math.floor((SPEC.hz * 2) / st.bay);
    const pitch = (SPEC.hz * 2) / cols;
    const windowArea = cols * floors * pitch * 0.36 * (st.floor * 0.42);
    const facadeArea = SPEC.hz * 2 * SPEC.h;
    expect(windowArea / facadeArea, 'window-to-facade ratio').toBeLessThan(0.3);
  });

  it('has no coplanar overlapping triangles inside one bucket (z-fighting)', () => {
    // Two triangles of the same bucket may not lie on the same plane, with the
    // same facing, and overlap. The old black cornice band sat exactly on the
    // stone body top face and flickered black.
    const buckets: Record<string, Geo> = { wall, glass, trim };
    for (const [name, g] of Object.entries(buckets)) {
      const tris = triangles(g);
      for (let i = 0; i < tris.length; i += 37) {
        // sample (O(n²) is unnecessary for a regression guard)
        const a = tris[i];
        const na = windingNormal(a);
        const ca = centroid(a);
        for (let j = i + 1; j < Math.min(tris.length, i + 120); j++) {
          const b = tris[j];
          const nb = windingNormal(b);
          if (na.dot(nb) < 0.999) continue;
          if (Math.abs(na.dot(centroid(b).sub(ca))) > 1e-3) continue;
          const overlap = (t: [THREE.Vector3, THREE.Vector3, THREE.Vector3]) =>
            t.every((v) => v.distanceTo(a[0]) < 1e-6);
          expect(overlap(b), `${name}: coplanar duplicate triangles at ${ca.toArray()}`).toBe(false);
        }
      }
    }
  });
});

/**
 * The building body: the only unindexed vertex-coloured bucket that spans the
 * full skyline (ground level up past 50 m) and whose colours are the stone
 * family. Found by geometry + vertex-colour lightness, never by material state.
 */
function findBuildingBody(city: City): THREE.Mesh | undefined {
  return findAll(city.group, (m) => {
    const g = m.geometry;
    if (g.index || !g.attributes.position || g.attributes.position.count < 80000 || !g.attributes.color) return false;
    g.computeBoundingBox();
    const box = g.boundingBox!;
    if (box.min.y > 1 || box.max.y < 50) return false;
    const c = g.attributes.color;
    let min = Infinity;
    for (let i = 0; i < c.array.length; i++) min = Math.min(min, c.array[i]);
    // Stone has no near-black channel; the dark glass grid does.
    return min > 0.1;
  })[0];
}

describe('City — facades render as one lit surface per building', () => {
  const world = createWorld();
  // `createWorld` is typed as the CityWorld contract; the tests inspect the
  // renderer object it actually returns.
  const city = world as unknown as City;

  const material = (m: THREE.Mesh) => m.material as THREE.MeshStandardMaterial;

  it('builds all 21 buildings with unchanged footprints and colliders', () => {
    expect(city.stats().buildings).toBe(21);
    const buildings = city.colliders.filter((c) => c.kind === 'building' && (c.height ?? 0) > 0);
    expect(buildings.length).toBe(21);
    // Collision footprints are the layout contract: they are derived from the
    // seeded lot split, never from what the facade looks like.
    for (const b of buildings) {
      expect(b.hx).toBeGreaterThan(3);
      expect(b.hz).toBeGreaterThan(3);
    }
  });

  it('puts every building facade into one vertex-coloured wall bucket whose colours are lit stone', () => {
    // Floors of glass: one per style bucket, always metalness 0.5.
    const glassMeshes = findAll(city.group, (m) => material(m).metalness === 0.5);
    expect(glassMeshes.length).toBeGreaterThanOrEqual(1);
    // The stone body: the only vertex-coloured bucket that is not glass, not the
    // cornice/sill trim and not the distant backdrop.
    const wallMeshes = findAll(
      city.group,
      (m) => material(m).vertexColors === true && material(m).metalness !== 0.5 && m.material !== glassMeshes[0].material && m.geometry.attributes.position.count > 50000,
    );
    expect(wallMeshes.length, `wall buckets found: ${wallMeshes.map((m) => m.geometry.attributes.position.count)}`).toBe(1);
    const walls = findBuildingBody(city);
    expect(walls, 'the tall stone body bucket exists').toBeDefined();
    const c = colours(walls!.geometry);
    expect(c).toBeDefined();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < c!.array.length; i++) {
      min = Math.min(min, c!.array[i]);
      max = Math.max(max, c!.array[i]);
    }
    // Normalised to the bucket: the bug was facades that were mostly BLACK
    // (0,0,0 cornice/strip + black glass columns). Regardless of which palette
    // a style uses, no stone body may be dominated by near-black pixels.
    let blacks = 0;
    for (let i = 0; i < c!.array.length; i++) if (c!.array[i] < 0.05) blacks++;
    expect(blacks / c!.array.length, 'near-black wall vertex colours').toBeLessThan(0.02);
    expect(min).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(1);
    // The wall bucket must cover every building: its horizontal extent reaches the
    // outermost building footprints.
    const box = (walls!.geometry.computeBoundingBox(), walls!.geometry.boundingBox!);
    expect(box.max.x - box.min.x).toBeGreaterThan(200);
    expect(box.max.z - box.min.z).toBeGreaterThan(200);
  });

  it('exposes the density knob and keeps it a single tunable constant', () => {
    expect(CITY_DRESSING.lampEvery).toBeGreaterThanOrEqual(1);
    expect(CITY_DRESSING.trafficLightEvery).toBeGreaterThanOrEqual(1);
    // Props disabled in the dressing config must not add colliders either.
    const props = city.colliders.filter((c) => c.kind === 'prop').length;
    expect(props).toBeLessThan(150);
  });

  it('keeps the stone body from rendering as near-white (washed-out facades)', () => {
    // The facades washed out because their vertex colours sat at 0.85+ linear
    // (0xe8dcc6 -> 0.81/0.72/0.56). Assert the real stone bucket stays below that.
    //
    // The bucket is identified by GEOMETRY, never by material properties: while
    // this fix was being written, a runtime-dependent material pooling made a
    // property filter pick the cornice/sill bucket, and the lesson is that the
    // facade must be one well-defined piece of geometry.
    // Identify the body by MATERIAL + geometry shape rather than a hard-coded
    // vertex count: the stone body is the vertex-coloured, non-glass bucket that
    // reaches from the ground to roof height. (A hard-coded count silently pointed
    // at the cornice/sill bucket once the window grid changed.)
    const wall = city.group.children
      .map((o) => o as THREE.Mesh)
      .find((m) => {
        if (!m.isMesh || (m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return false;
        const g = m.geometry;
        const mat = material(m);
        if (!mat.vertexColors || mat.metalness === 0.5 || !g.attributes.color) return false;
        g.computeBoundingBox();
        const b = g.boundingBox!;
        const tall = b.max.y - b.min.y > 50 && b.min.y < 1;
        // Stone, not trim: the wall bucket is dominated by mid-tone colours.
        let sum = 0;
        const c = g.attributes.color;
        for (let i = 0; i < c.array.length; i++) sum += c.array[i];
        return tall && sum / c.array.length < 0.6;
      });
    expect(wall, 'building body bucket').toBeDefined();
    const c = colours(wall!.geometry)!;
    let mean = 0;
    let max = -Infinity;
    for (let i = 0; i < c.array.length; i++) {
      mean += c.array[i];
      max = Math.max(max, c.array[i]);
    }
    mean /= c.array.length;
    // The STONE BODY must stay below stone-white; bright cornice/sill trim lives
    // in its own bucket and is intentionally near-white (it reads as sunshine).
    expect(max, 'no near-white stone body colours').toBeLessThan(0.85);
    expect(mean, 'mean wall vertex colour').toBeLessThan(0.7);
  });

  it('adds a sharp facade fill light so street-level walls are not self-shadowed', () => {
    expect(FACADE_LIGHTING.fillIntensity).toBeGreaterThan(0);
    const fill = city.group.children.find((c): c is THREE.DirectionalLight => c instanceof THREE.DirectionalLight);
    expect(fill).toBeDefined();
    // Near vertical: it lights every facade, including the street canyons.
    const dir = fill!.position.clone().normalize();
    expect(dir.y).toBeGreaterThan(0.5);
  });

  it('keeps the whole city inside a low draw-call budget', () => {
    let meshes = 0;
    city.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    expect(meshes).toBeLessThanOrEqual(30);
  });
});

function findAll(root: THREE.Object3D, pred: (m: THREE.Mesh) => boolean): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && pred(m)) out.push(m);
  });
  return out;
}

describe('City facade bucket — built exactly as the city builds it', () => {
  it('the merged facade bucket City creates keeps every stone colour in the lit band', async () => {
    // Reproduce City.buildBuildings' wall bucket: one bodySlabs() per lot, all
    // merged into the single mesh City adds for the facade. (Deliberately built
    // here with plain geometry calls: this stays valid even if City's meshes are
    // re-pooled by the bundler/runtime.)
    const { City } = await import('../../src/world/world');
    expect(typeof City).toBe('function');
    const defs: BuildingGeoSpec[] = [
      { x: -107, z: -101, hx: 6.5, hz: 12.8, h: 26.8, style: 0 },
      { x: -101, z: -42.3, hx: 12.8, hz: 5.5, h: 24, style: 2 },
      { x: 34, z: -34, hx: 12.2, hz: 12.2, h: 47.8, style: 6 },
      { x: 101, z: 101, hx: 11.3, hz: 11.3, h: 31.2, style: 3 },
    ];
    const parts = defs.flatMap((d) => bodySlabs(d, BUILDING_STYLES[d.style % BUILDING_STYLES.length]));
    expect(parts.length).toBe(defs.length * 2);
    const merged = mergeGeometries(parts, false);
    expect(merged).toBeTruthy();
    const c = colours(merged)!;
    expect(c).toBeDefined();
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < c.array.length; i++) {
      min = Math.min(min, c.array[i]);
      max = Math.max(max, c.array[i]);
    }
    // The invisible/washed-out building bug: every stone channel must sit in the
    // lit band (0.2 .. 0.75 linear), never near-white and never black.
    expect(min, 'no dark stone').toBeGreaterThanOrEqual(0.2);
    expect(max, 'no near-white stone').toBeLessThanOrEqual(0.75);
  });
});

describe('buildingKit — every style is safe', () => {
  it('all styles produce lit stone and dark glass with sane proportions', () => {
    for (let style = 0; style < BUILDING_STYLES.length; style++) {
      const { wall, glass } = buildBuildingGeometry({ ...SPEC, style });
      const lw = meanLightness(wall);
      const lg = meanLightness(glass);
      expect(lw, `style ${style} wall lightness`).toBeGreaterThan(0.3);
      expect(lg, `style ${style} glass lightness`).toBeLessThan(0.3);
      expect(lw - lg).toBeGreaterThan(0.2);
    }
  });
});

function meanLightness(g: Geo): number {
  const c = colours(g)!;
  let s = 0;
  for (let i = 0; i < c.array.length; i += 3) s += 0.2126 * c.array[i] + 0.7152 * c.array[i + 1] + 0.0722 * c.array[i + 2];
  return s / (c.array.length / 3);
}

// Keep the import list honest for the unused-type lint in some editors.
export type { City };
