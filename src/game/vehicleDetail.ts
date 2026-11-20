/**
 * Runtime detail dressing for vehicle meshes: soft contact shadows, headlight
 * glows and a front number plate. Lead-owned; keeps vehicle materials close to
 * the rest of the scene's lighting.
 *
 * The car models already carry their own soft contact blob (see
 * src/entities/vehicleModels.ts), so `addContactShadow` is a light extra AO
 * ring that only deepens the shadow directly under the sills.
 */
import * as THREE from 'three';
import type { Vehicle } from '../contracts';

/** A soft dark ellipse under the car (cheap fake AO). */
export function addContactShadow(v: Vehicle): void {
  const { length, width } = v.spec;
  const geo = new THREE.CircleGeometry(0.5, 18);
  geo.rotateX(-Math.PI / 2);
  // Scale the UNIT disc: 0.5 radius → width·0.62 / length·0.5 semi-axes.
  geo.scale(width * 1.24, 1, length * 1.0);
  // A shadow tinted by the car's own paint darkness: a bright cream van on dark
  // asphalt needs a stronger, softer contact shadow to look grounded, while a
  // black car already reads grounded. (Reported by vehicle QA: light cars floated.)
  const lum = new THREE.Color(v.spec.color).getHSL({ h: 0, s: 0, l: 0 }).l;
  const mat = new THREE.MeshBasicMaterial({
    color: 0x0a0b0d,
    transparent: true,
    opacity: 0.3 + 0.16 * lum,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const blob = new THREE.Mesh(geo, mat);
  // Just above the model's own blob (which sits at y = 0.02) and the road.
  blob.position.y = 0.028;
  blob.renderOrder = 1;
  blob.name = 'contact-shadow';
  v.mesh.add(blob);
}

/**
 * Two warm pools on the road ahead of the car so headlights read at a distance.
 * Cars face +Z in local space; the pools start at the nose, not in front of it.
 */
export function addHeadlightGlow(v: Vehicle): void {
  const geo = new THREE.PlaneGeometry(1.1, 4.0);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff0c9,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const noseZ = v.spec.length * 0.5;
  for (const side of [-1, 1]) {
    const pool = new THREE.Mesh(geo, mat);
    pool.position.set(side * v.spec.width * 0.28, 0.03, noseZ + 1.9);
    pool.renderOrder = 1;
    pool.name = 'headlight-pool';
    v.mesh.add(pool);
  }
}
