/**
 * Lightweight, opt-in performance probe (no-op unless the player enables it).
 * Toggle with `?perf=1` or by pressing F3 in-game; the result feeds the HUD's
 * small FPS chip and is exposed on `window.__MINI_GTA_PERF` for automated tests.
 */
export interface PerfSample {
  fps: number;
  frameMs: number;
  updateMs: number;
  renderMs: number;
  drawCalls: number;
  triangles: number;
}

export class PerfProbe {
  enabled = false;
  private accum = { frames: 0, update: 0, render: 0 };
  latest: PerfSample = { fps: 0, frameMs: 0, updateMs: 0, renderMs: 0, drawCalls: 0, triangles: 0 };
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

  addRender(ms: number, drawCalls: number, triangles: number): void {
    if (!this.enabled) return;
    this.accum.render += ms;
    this.accum.frames++;
    const s = this.accum;
    this.latest = {
      fps: 0,
      frameMs: 0,
      updateMs: +s.update.toFixed(2),
      renderMs: +s.render.toFixed(2),
      drawCalls,
      triangles,
    };
  }

  frame(fps: number): void {
    if (!this.enabled) return;
    this.latest.fps = +fps.toFixed(1);
    this.latest.frameMs = +(1000 / Math.max(fps, 1)).toFixed(1);
    for (const fn of this.listeners) fn(this.latest);
    this.accum = { frames: 0, update: 0, render: 0 };
  }
}

export const PERF = new PerfProbe();
