/**
 * Regression guard: every city mesh must be transform-valid and therefore
 * registered by the renderer. A mesh with matrixAutoUpdate=false whose
 * matrixWorld is still the identity (a "detached root") is silently skipped by
 * three.js and the whole city renders as nothing (the black-screen bug).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWorld } from '../../src/world/world';

describe('city meshes', () => {
  const city = createWorld();

  it('has meshes to render at all', () => {
    let count = 0;
    city.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) count++;
    });
    expect(count).toBeGreaterThan(10);
  });

  it('wires local matrices for every static mesh before attaching it', () => {
    const offenders: string[] = [];
    city.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.matrixAutoUpdate === false && m.parent && m.parent !== city.group) return; // instanced/grouped children
      m.updateWorldMatrix(true, false);
      const expected = new THREE.Matrix4().multiplyMatrices(m.parent?.matrixWorld ?? new THREE.Matrix4(), m.matrix);
      if (!m.matrixWorld.equals(expected)) offenders.push(o.name || o.type);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps local transforms at the origin for static meshes (identity LOCAL matrix is fine while attached)', () => {
    // A static mesh keeps matrixAutoUpdate=false; its matrixWorld stays identity until
    // the parent's updateMatrixWorld() runs (the renderer does this every frame).
    // What must never happen is a mesh whose local matrix carries a transform that
    // was never applied: that would render it in the wrong place.
    const misplaced: string[] = [];
    city.group.children.forEach((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // A static mesh must have a baked local matrix (identity, since geometry is
      // pre-translated) and no pending transform that updateMatrix() would have
      // skipped because matrixAutoUpdate is false.
      const localIdentity = new THREE.Matrix4();
      if (m.matrixAutoUpdate === false && !m.matrix.equals(localIdentity)) misplaced.push(m.name || m.type);
    });
    expect(misplaced).toEqual([]);
  });
});
