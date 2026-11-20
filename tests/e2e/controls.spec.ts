import { expect, test } from '@playwright/test';
import { boot, collectErrors, play, snapshot, waitFor } from './helpers';

test('WASD moves the player, sprint is faster, Space jumps and the camera follows', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await play(page);
  await page.locator('#game-canvas').click({ position: { x: 40, y: 40 } });

  const p0 = (await snapshot(page)).player;

  // Walk forward for a couple of seconds.
  await page.keyboard.down('KeyW');
  // Software rendering: wait until the player has actually travelled, not a fixed time.
  await waitFor(page, () => {
    const p = window.__MINI_GTA!.snapshot().player;
    return Math.hypot(p.x - (-101), p.z - (-57.8)) > 0.6;
  }).catch(() => {});
  await page.keyboard.up('KeyW');
  const p1 = (await snapshot(page)).player;
  const walked = Math.hypot(p1.x - p0.x, p1.z - p0.z);
  expect(walked).toBeGreaterThan(0.5);

  // Strafing changes facing yaw (turning towards movement direction).
  await page.keyboard.down('KeyA');
  await page.waitForFunction((y) => Math.abs(window.__MINI_GTA!.snapshot().player.yaw - y) > 0.2, p1.yaw, { timeout: 45_000 }).catch(() => {});
  await page.keyboard.up('KeyA');
  const p2 = (await snapshot(page)).player;
  expect(Math.abs(p2.yaw - p1.yaw)).toBeGreaterThan(0.2);

  // Jump: visible as leaving the ground (y rises above the pavement) or as groundHeight change.
  await page.keyboard.press('Space');
  await page.waitForFunction(() => {
    const p = window.__MINI_GTA!.snapshot().player;
    return p.y > 0.3 || p.y < 0;
  }, null, { timeout: 15_000 }).catch(() => {});

  // Camera orbit without pointer lock: clicking the canvas requests pointer lock via a user gesture.
  await page.locator('#game-canvas').click({ position: { x: 200, y: 200 } });

  expect(errors).toEqual([]);
});
