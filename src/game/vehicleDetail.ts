/**
 * Runtime detail dressing for vehicle meshes: soft contact shadows, headlight
 * glows and a front number plate. Lead-owned; keeps vehicle materials close to
 * the rest of the scene's lighting.
 */
import * as THREE from 'three';
import type { Vehicle } from '../contracts';

/** A soft dark ellipse under the car (cheap fake AO). */
export function addContactShadow(v: Vehicle): void {
  const { length, width } = v.spec;
  const geo = new THREE.CircleGeometry(1, 20);
  geo.rotateX(-Math.PI / 2);
  geo.scale(width * 0.62, 1, length * 0.5);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const blob = new THREE.Mesh(geo, mat);
  blob.position.y = 0.02;
  blob.renderOrder = 1;
  blob.name = 'contact-shadow';
  v.mesh.add(blob);
}

/** Two warm spot pools in front of the car so headlights read at a distance. */
export function addHeadlightGlow(v: Vehicle): void {
  const geo = new THREE.PlaneGeometry(1.2, 4.5);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff0c9,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  for (const side of [-1, 1]) {
    const pool = new THREE.Mesh(geo, mat);
    // Cars face +Z in local space.
    pool.position.set(side * v.spec.width * 0.3, 0.03, v.spec.length * 0.5 + 2.0);
    pool.renderOrder = 1;
    v.mesh.add(pool);
  }
}
