import { expect, test } from '@playwright/test';
import { boot, collectErrors, play, snapshot, waitFor } from './helpers';

test('pause freezes the simulation, resume continues, restart resets the run', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await play(page);
  await page.waitForTimeout(1500);
  const t0 = (await snapshot(page)).elapsed;
  expect(t0).toBeGreaterThan(0);

  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__MINI_GTA!.status() === 'paused');
  const tPaused = (await snapshot(page)).elapsed;
  await page.waitForTimeout(1200);
  const tPaused2 = (await snapshot(page)).elapsed;
  expect(tPaused2).toBeCloseTo(tPaused, 3);

  await page.getByTestId('resume-button').click();
  await waitFor(page, () => window.__MINI_GTA!.status() === 'playing');
  await waitFor(page, () => window.__MINI_GTA!.snapshot().elapsed > window.__MINI_GTA!.snapshot().elapsed * 0);
  await page.waitForTimeout(700);
  expect((await snapshot(page)).elapsed).toBeGreaterThan(tPaused2);

  await page.getByTestId('pause-screen').waitFor({ state: 'hidden' });
  await page.keyboard.press('KeyR');
  await waitFor(page, () => window.__MINI_GTA!.snapshot().mission.phase === 'meet' && window.__MINI_GTA!.status() === 'playing');
  const s = await snapshot(page);
  expect(s.status).toBe('playing');
  expect(s.playerInVehicle).toBe(false);

  expect(errors).toEqual([]);
});
