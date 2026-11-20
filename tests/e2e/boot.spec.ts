import { expect, test } from '@playwright/test';
import { boot, collectErrors, snapshot } from './helpers';

test('boots into the start screen with a live WebGL scene and no errors', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);

  // Canvas + WebGL
  const canvas = page.locator('#game-canvas');
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box!.width).toBeGreaterThan(300);
  const webgl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return gl ? gl.getParameter(gl.VERSION) : null;
  });
  expect(webgl).toBeTruthy();

  // Debug API is live and the start screen is showing. (The render loop is
  // verified while actually playing: headless engines can throttle rAF for a
  // fully static, occluded menu frame, so asserting frames in menu mode is flaky.)
  await expect(page.getByTestId('start-screen')).toBeVisible();

  const s = await snapshot(page);
  expect(s.status).toBe('menu');
  expect(s.buildings).toBeGreaterThanOrEqual(16);
  expect(s.vehicleCount).toBeGreaterThanOrEqual(5);
  expect(s.npcCount).toBeGreaterThanOrEqual(5);
  expect(s.drawCalls).toBeGreaterThan(10);
  expect(s.drawCalls).toBeLessThan(220);

  await expect(page.getByTestId('start-screen')).toBeVisible();
  await expect(page.getByTestId('play-button')).toBeVisible();
  await expect(page.locator('body')).toContainText(/mini\s*gta/i);

  await page.screenshot({ path: 'test-results/boot-start-screen.png' });
  expect(errors).toEqual([]);
});
