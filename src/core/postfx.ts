/**
 * Rendering quality layer (Lead-owned).
 *
 * - ACES tone mapping, MSAA when rendering to the post-processing target.
 * - Sky lighting: a procedural gradient environment map gives every PBR material
 *   realistic sky/bounce light without loading an HDR file.
 * - Optional bloom on emissive surfaces (windows, lamps, headlights, brake lights),
 *   off automatically on slow devices.
 * - A gentle colour grade + vignette that sells the "golden hour" look.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type Quality = 'high' | 'low';

export const SKY_TOP = 0x2a63a8;
export const SKY_MID = 0x7fb2e0;
export const SKY_HORIZON = 0xffc98a;
export const SUN_DIR = new THREE.Vector3(0.55, 0.62, 0.42).normalize();

/**
 * Procedural sky dome. The horizon glow is aimed at the sun direction so the sun
 * disk, the warm haze and the lighting all agree with the shadow direction.
 */
export function createSkyDome(radius = 480): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      topColor: { value: new THREE.Color(SKY_TOP) },
      midColor: { value: new THREE.Color(SKY_MID) },
      horizonColor: { value: new THREE.Color(SKY_HORIZON) },
      sunDir: { value: SUN_DIR.clone() },
      sunColor: { value: new THREE.Color(0xfff2d0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDir;
      uniform vec3 sunColor;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -0.15, 1.0);
        // Vertical gradient: warm horizon -> light blue -> deep blue zenith.
        vec3 col = mix(horizonColor, midColor, smoothstep(0.0, 0.32, h));
        col = mix(col, topColor, smoothstep(0.28, 0.95, h));
        // Sun glow + disk.
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        col += sunColor * pow(sd, 220.0) * 1.6;
        col += sunColor * pow(sd, 12.0) * 0.22;
        // A touch of warm haze along the horizon band.
        float haze = exp(-abs(d.y) * 9.0);
        col = mix(col, horizonColor * 1.05, haze * 0.28);
        // Below the horizon fades to a muted ground tone.
        col = mix(col, vec3(0.42, 0.40, 0.37), smoothstep(0.0, -0.12, d.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'skyDome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return mesh;
}

/** Procedural environment map: sky gradient + warm ground bounce. */
export function createSkyEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const size = 128;
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const canvas = document.createElement('canvas');
  canvas.width = size * 2;
  canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0.0, '#3b74b8');
  grad.addColorStop(0.42, '#9cc4e8');
  grad.addColorStop(0.5, '#f6cf9a');
  grad.addColorStop(0.56, '#b9a58a');
  grad.addColorStop(1.0, '#4a453c');
  g.fillStyle = grad;
  g.fillRect(0, 0, size * 2, size);
  // Sun blob so specular highlights read as sunlight.
  const sunX = size + Math.atan2(SUN_DIR.x, -SUN_DIR.z) * 0;
  const sunY = size * 0.5 - SUN_DIR.y * size * 0.5;
  const glow = g.createRadialGradient(sunX, sunY, 1, sunX, sunY, size * 0.32);
  glow.addColorStop(0, 'rgba(255,248,225,1)');
  glow.addColorStop(0.25, 'rgba(255,225,170,0.55)');
  glow.addColorStop(1, 'rgba(255,220,160,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, size * 2, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  const env = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  pmrem.dispose();
  return env;
}

/** Final-grade shader: saturation, warm highlights, cool shadows, vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    saturation: { value: 1.26 },
    warmth: { value: 0.05 },
    contrast: { value: 1.1 },
    vignette: { value: 0.3 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    uniform float warmth;
    uniform float contrast;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = c.rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, saturation);
      col += vec3(warmth, warmth * 0.45, -warmth) * smoothstep(0.45, 0.95, l);
      col = (col - 0.5) * contrast + 0.5;
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.25, length(d));
      col *= mix(1.0 - vignette, 1.0, v);
      gl_FragColor = vec4(max(col, 0.0), c.a);
    }
  `,
};

export interface PostFX {
  readonly quality: Quality;
  setSize(width: number, height: number, pixelRatio: number): void;
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export function createPostFX(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: Quality): PostFX {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, {
    type: THREE.HalfFloatType,
    samples: quality === 'high' ? 4 : 0,
  });

  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  // strength 0.3 on a 0.5 radius reads as a glow on bright windows/lamps without
  // smearing the whole image.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), quality === 'high' ? 0.32 : 0.0, 0.5, 0.82);
  composer.addPass(bloom);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  composer.addPass(new OutputPass());
  composer.setPixelRatio(pr);
  composer.setSize(size.x, size.y);

  return {
    quality,
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
      bloom.resolution.set(width, height);
    },
    render(s: THREE.Scene, c: THREE.Camera) {
      composer.render();
      void s;
      void c;
    },
    setQuality(q) {
      bloom.strength = q === 'high' ? 0.32 : 0.0;
      // MSAA cannot change without rebuilding the target; softening bloom is enough.
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
