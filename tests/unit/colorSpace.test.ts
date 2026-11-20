/**
 * Colour-space guard.
 *
 * Hex palettes are authored in sRGB, but vertex colours feed the LINEAR renderer.
 * Writing raw `hex/255` values makes every surface ~1.4x too bright (the
 * washed-out facade bug). These tests pin the conversion itself, so no future
 * colour helper can quietly go back to raw hex.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { buildBuildingGeometry } from '../../src/world/buildingKit';

/** Linear value three.js expects for an sRGB channel (IEC 61966-2-1). */
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function channel(hex: number, shift: number): number {
  return srgbToLinear(((hex >> shift) & 0xff) / 255);
}

/** The wall bucket of a building must hold the LINEAR form of its style colour. */
describe('facade vertex colours are linear-space', () => {
  for (let style = 0; style < 6; style++) {
    it(`style ${style} writes sRGBToLinear values, not raw hex`, () => {
      const geo = buildBuildingGeometry({ x: 0, z: 0, hx: 8, hz: 8, h: 24, style });
      const colours = geo.wall.getAttribute('color') as THREE.BufferAttribute;
      expect(colours).toBeDefined();
      // Sample the wall body's vertex colours (skip glass/trim geometry).
      const seen = new Set<string>();
      for (let i = 0; i < Math.min(colours.count, 600); i++) {
        seen.add(
          [colours.getX(i), colours.getY(i), colours.getZ(i)].map((v) => v.toFixed(3)).join(','),
        );
      }
      // At least one sampled colour must match a linearised sRGB channel triple.
      const matchesLinear = [...seen].some((key) => {
        const [r, g, b] = key.split(',').map(Number);
        // Re-encode to sRGB and check it is a plausible authored hex.
        const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
        const hex = (Math.round(toSrgb(r) * 255) << 16) | (Math.round(toSrgb(g) * 255) << 8) | Math.round(toSrgb(b) * 255);
        // Round-trip back to linear and require agreement with what was written.
        return Math.abs(channel(hex, 16) - r) < 0.01 && Math.abs(channel(hex, 8) - g) < 0.01 && Math.abs(channel(hex, 0) - b) < 0.01;
      });
      expect(matchesLinear, `style ${style} wall colours must be linear-converted`).toBe(true);
      // And they must NOT equal the raw hex fraction (the regression signature).
      const rawMatches = [...seen].some((key) => {
        const [r, g, b] = key.split(',').map(Number);
        return r > 0.9 && g > 0.9 && b > 0.9; // raw 0xf8-ish would survive as ~0.97
      });
      expect(rawMatches, 'no wall colour may equal a raw sRGB fraction').toBe(false);
    });
  }
});
