/**
 * Extrude a side profile along X with a 45° chamfer on both long edges of each
 * flank. A chamfer rounds the rim exactly like a small bevel but costs one band
 * of quads per ring instead of ExtrudeGeometry's bevel grids (~8–24 triangles
 * per rim ring) — that is how a smooth-looking car stays inside a small
 * triangle budget. The chamfer band is emitted PROVISIONALLY as a square box
 * corner; the barrel pass in `barrelSolid` then bends it and the straight flank
 * into one continuous rounded surface, so only the final shape matters.
 *
 * Rings per flank (+X, then −X), N = contour points:
 *   0 top rim edge   (x = ±halfZ,        y = contour)
 *   1 band corner    (x = ±(halfZ − c),  y = contour)   ← provisional corner
 *   2 flank mid      (x = ±(halfZ − c),  y = ringY(p))  ← barrelled
 *   3 band corner    (x = ±(halfZ − c),  y = contour)   ← provisional corner
 *   4 bottom rim edge(x = ±halfZ,        y = contour)
 * plus two ear-clipped end caps.
 */
function extrudeChamfered(
  shape: THREE.Shape,
  width: number,
  chamfer: number,
  ringY: (p: THREE.Vector2) => number,
): THREE.BufferGeometry {
  const pts = shape.getPoints(12);
  const contour = THREE.ShapeUtils.isClockWise(pts) ? pts : pts.slice().reverse();
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  const N = contour.length;
  const halfZ = width / 2;
  const xFlank = Math.max(halfZ - chamfer, halfZ * 0.35);
  const pos: number[] = [];
  for (const sgn of [1, -1] as const) {
    for (const p of contour) pos.push(sgn * halfZ, p.y, p.z); // 0
    for (const p of contour) pos.push(sgn * xFlank, p.y, p.z); // 1
    for (const p of contour) pos.push(sgn * xFlank, ringY(p), p.z); // 2
    for (const p of contour) pos.push(sgn * xFlank, p.y, p.z); // 3
    for (const p of contour) pos.push(sgn * halfZ, p.y, p.z); // 4
  }
  const idx: number[] = [];
  // Side quads between consecutive rings of the same flank.
  for (const flank of [0, 1]) {
    const base = flank * 5 * N;
    for (let r = 0; r < 4; r++) {
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N;
        const a = base + r * N + i;
        const b = base + r * N + j;
        const c = base + (r + 1) * N + j;
        const d = base + (r + 1) * N + i;
        idx.push(a, b, c, a, c, d);
      }
    }
  }
  // End caps (at ±halfZ, in contour coordinates) — cap +X, cap −X.
  const capA = 10 * N;
  const capB = capA + N;
  for (const p of contour) pos.push(halfZ, p.y, p.z);
  for (const p of contour) pos.push(-halfZ, p.y, p.z);
  for (const t of tris) {
    idx.push(capA + t[0], capA + t[1], capA + t[2]);
    idx.push(capB + t[0], capB + t[1], capB + t[2]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  orientOutward(geo);
  return geo;
}

/** Flip any face whose normal points towards the solid's centroid. */
function orientOutward(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const index = geo.getIndex() as THREE.BufferAttribute;
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const d = new THREE.Vector3();
  const n = new THREE.Vector3();
  const mid = new THREE.Vector3();
  for (let f = 0; f < index.count; f += 3) {
    const i0 = index.getX(f);
    const i1 = index.getX(f + 1);
    const i2 = index.getX(f + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    d.fromBufferAttribute(pos, i2);
    n.subVectors(b, a).cross(d.clone().sub(a));
    mid.copy(a).add(b).add(d).divideScalar(3).sub(c);
    if (n.dot(mid) < 0) {
      index.setX(f + 1, i2);
      index.setX(f + 2, i1);
    }
  }
  index.needsUpdate = true;
}
