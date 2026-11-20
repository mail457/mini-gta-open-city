/**
 * Performance probe (opt-in, zero overhead when off).
 *
 * Enable with `?perf=1` or F3. Two data sources:
 * - `latest.renderMs` — GPU-synchronised render time measured by the engine every
 *   frame (real cost, including post-processing).
 * - `fps` — frames counted over a 1 s window (overtime rAF callbacks cannot inflate it).
 */

export interface PerfSample {
  fps: number;
  frameMs: number;
  updateMs: number;
  renderMs: number;
  submitMs: number;
  drawCalls: number;
  triangles: number;
}

export class PerfProbe {
  enabled = false;
  private accum = { frames: 0, update: 0 };
  private lastSampleAt = 0;
  private framesSinceSample = 0;
  latest: PerfSample = { fps: 0, frameMs: 0, updateMs: 0, renderMs: 0, submitMs: 0, drawCalls: 0, triangles: 0 };
  private listeners: Array<(s: PerfSample) => void> = [];

  constructor() {
    try {
      this.enabled = new URLSearchParams(location.search).has('perf');
    } catch {
      this.enabled = false;
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  onSample(fn: (s: PerfSample) => void): void {
    this.listeners.push(fn);
  }

  addUpdate(ms: number): void {
    if (this.enabled) this.accum.update += ms;
  }

  /** Called once per rendered frame with GPU-synchronised timings. */
  addRender(renderMs: number, submitMs: number, drawCalls: number, triangles: number): void {
    if (!this.enabled) return;
    this.accum.frames++;
    this.framesSinceSample++;
    this.latest.updateMs = +(this.accum.update / Math.max(1, this.accum.frames)).toFixed(2);
    this.latest.renderMs = +renderMs.toFixed(2);
    this.latest.submitMs = +submitMs.toFixed(2);
    this.latest.drawCalls = drawCalls;
    this.latest.triangles = triangles;
  }

  /** Count one frame; recompute FPS over ~1 s wall-clock windows. */
  frame(): void {
    if (!this.enabled) return;
    const now = performance.now();
    if (!this.lastSampleAt) {
      this.lastSampleAt = now;
      this.framesSinceSample = 0;
      return;
    }
    this.framesSinceSample++;
    const dt = now - this.lastSampleAt;
    // Guard against stale sample windows (e.g. after a tab was hidden).
    if (dt < 1000) return;
    {
      this.latest.fps = +((this.framesSinceSample * 1000) / dt).toFixed(1);
      this.latest.frameMs = +(dt / Math.max(1, this.framesSinceSample)).toFixed(1);
      this.lastSampleAt = now;
      this.framesSinceSample = 0;
      this.accum.update = 0;
      this.accum.frames = 0;
      for (const fn of this.listeners) fn(this.latest);
    }
  }
}

export const PERF = new PerfProbe();
