import { expect, test } from '@playwright/test';

// Runs only when LIVE_URL is provided: verifies the published site itself.
declare const process: { env: Record<string, string | undefined> };

const LIVE = process.env.LIVE_URL;

test.skip(!LIVE, 'set LIVE_URL to check the deployed site');
test('live URL boots and plays', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(LIVE!, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(() => !!window.__MINI_GTA, null, { timeout: 90_000 });
  await page.getByTestId('play-button').click();
  await page.waitForFunction(() => window.__MINI_GTA!.status() === 'playing', null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MINI_GTA!.frameCount() > 20, null, { timeout: 120_000 });
  const s = await page.evaluate(() => window.__MINI_GTA!.snapshot());
  expect(s.buildings).toBeGreaterThan(10);
  expect(s.vehicleCount).toBeGreaterThan(4);
  console.log('LIVE snapshot:', JSON.stringify({ status: s.status, phase: s.mission.phase, buildings: s.buildings, cars: s.vehicleCount, peds: s.npcCount, drawCalls: s.drawCalls }));
  expect(errors).toEqual([]);
});
