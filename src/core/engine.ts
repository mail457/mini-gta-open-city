import * as THREE from 'three';

/** Adaptive renderer + fixed-ish timestep loop. Owned by: Lead. */

export interface EngineHooks {
  /** Called once per fixed sub-step. max 1/30 s. */
  update(dt: number, elapsed: number): void;
  /** Called once per rendered frame (after update). */
  render(): void;
  resize(width: number, height: number): void;
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private hooks: EngineHooks | null = null;
  private running = false;
  private raf = 0;
  private last = 0;
  private elapsed = 0;
  private accumulator = 0;
  private frame = 0;
  private fpsSamples: number[] = [];
  frameMsAvg = 16.6;
  fps = 60;
  /** Debug/test hook: multiply simulation time. */
  simSpeed = 1;
  paused = false;
  private pixelRatioCap = 2;
  private currentPixelRatio = 1;
  private lowFpsTime = 0;
  private highFpsTime = 0;
  private readonly fixedStep = 1 / 60;
  onFpsSample: ((fps: number) => void) | null = null;
  /** Optional per-frame input pump, called once before the fixed sub-steps. */
  perFrameInput: (() => unknown) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
        stencil: false,
        failIfMajorPerformanceCaveat: false,
      });
    } catch (err) {
      throw new Error(`WebGL unavailable: ${String(err)}`);
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // ACES keeps the low-poly palette from clipping under bright sun.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.matrixWorldAutoUpdate = false;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
    this.camera.position.set(0, 6, 12);
    this.camera.matrixWorldAutoUpdate = false;
    this.camera.layers.enableAll();

    this.resize();
    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
  }

  get currentFrame(): number {
    return this.frame;
  }

  get time(): number {
    return this.elapsed;
  }

  private isMobileLike(): boolean {
    return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 600;
  }

  private onResize = () => this.resize();

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const dprCap = this.isMobileLike() ? 1.75 : this.pixelRatioCap;
    this.currentPixelRatio = Math.min(window.devicePixelRatio || 1, dprCap);
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.hooks?.resize(w, h);
  }

  /** Dynamic resolution: drop pixel ratio if we can't hold ~45fps, raise it when we can. */
  private adaptQuality(dt: number): void {
    const lowTarget = 1 / 45;
    const highTarget = 1 / 58;
    if (dt > lowTarget) {
      this.lowFpsTime += dt;
      this.highFpsTime = 0;
    } else if (dt < highTarget) {
      this.highFpsTime += dt;
      this.lowFpsTime = 0;
    }
    if (this.lowFpsTime > 2 && this.currentPixelRatio > 0.85) {
      this.currentPixelRatio = Math.max(0.8, this.currentPixelRatio - 0.25);
      this.renderer.setPixelRatio(this.currentPixelRatio);
      this.resize();
      this.lowFpsTime = 0;
    } else if (this.highFpsTime > 6 && this.currentPixelRatio < Math.min(window.devicePixelRatio || 1, this.pixelRatioCap)) {
      this.currentPixelRatio = Math.min(this.pixelRatioCap, this.currentPixelRatio + 0.25);
      this.renderer.setPixelRatio(this.currentPixelRatio);
      this.resize();
      this.highFpsTime = 0;
    }
  }

  start(hooks: EngineHooks): void {
    this.hooks = hooks;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      let dt = (now - this.last) / 1000;
      this.last = now;
      // Tab-switch / long stall guard.
      if (dt > 0.25) dt = 0.25;
      this.frame++;
      this.fpsSamples.push(dt);
      if (this.fpsSamples.length > 30) this.fpsSamples.shift();
      const avg = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
      this.frameMsAvg = avg * 1000;
      this.fps = 1 / Math.max(avg, 0.001);
      if (this.frame % 60 === 0) {
        this.adaptQuality(this.fps / 60 > 1 ? 1 / 60 : 1 / Math.max(this.fps, 1));
        this.onFpsSample?.(this.fps);
      }

      // Pump input once per rendered frame; the game copies it into each sub-step.
      this.perFrameInput?.();
      if (!this.paused) {
        const simDt = dt * this.simSpeed;
        this.accumulator += simDt;
        // Cap sub-steps: at most 4 per frame (protects against spiral of death).
        let steps = 0;
        const maxSteps = this.simSpeed > 1 ? 8 : 4;
        while (this.accumulator >= this.fixedStep && steps < maxSteps) {
          this.elapsed += this.fixedStep;
          this.hooks?.update(this.fixedStep, this.elapsed);
          this.accumulator -= this.fixedStep;
          steps++;
        }
        if (steps >= maxSteps) this.accumulator = 0;
      }
      // The world is static between frames: update matrices once per frame and
      // keep the renderer from re-walking the whole graph on every draw.
      this.scene.updateMatrixWorld(true);
      this.camera.updateMatrixWorld(true);
      this.hooks?.render();
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    this.renderer.dispose();
  }
}
