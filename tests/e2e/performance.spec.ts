import { expect, test } from '@playwright/test';
import { play, snapshot } from './helpers';

test('per-frame CPU cost and draw calls stay within budget', async ({ page }) => {
  await page.goto('/?perf=1');
  await page.waitForFunction(() => !!window.__MINI_GTA, null, { timeout: 45_000 });
  await play(page);
  // Let the render loop warm up (first frames upload textures to the GPU).
  await page.waitForFunction(() => window.__MINI_GTA!.frameCount() > 40, null, { timeout: 90_000 });
  await page.waitForTimeout(2000);
  const perf = await page.evaluate(() => {
    const p = (window as unknown as { __MINI_GTA_PERF?: { latest: { updateMs: number; renderMs: number; drawCalls: number; triangles: number } } }).__MINI_GTA_PERF;
    return p ? p.latest : null;
  });
  expect(perf).not.toBeNull();
  // CPU budgets (GPU time is measured separately on real hardware; SwiftShader is not representative).
  expect(perf!.updateMs).toBeLessThan(8);
  expect(perf!.drawCalls).toBeLessThan(220);
  expect(perf!.triangles).toBeLessThan(300_000);
  const s = await snapshot(page);
  expect(s.drawCalls).toBeLessThan(220);
});
