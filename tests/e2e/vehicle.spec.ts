import { expect, test } from '@playwright/test';
import { boot, collectErrors, enterCar, play, snapshot, waitFor } from './helpers';

test('enter a car, accelerate with W, handbrake with Space, exit beside the car', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await play(page);

  await enterCar(page);
  let s = await snapshot(page);
  expect(s.playerInVehicle).toBe(true);
  expect(s.vehicle).not.toBeNull();
  expect(['sedan', 'sport', 'van']).toContain(s.vehicle!.type);

  // Accelerate.
  await page.keyboard.down('KeyW');
  await waitFor(page, () => window.__MINI_GTA!.snapshot().vehicle!.speed > 2);
  const moving = await snapshot(page);
  const start = { x: moving.vehicle!.x, z: moving.vehicle!.z };
  await page.waitForTimeout(1500);
  const later = await snapshot(page);
  expect(Math.hypot(later.vehicle!.x - start.x, later.vehicle!.z - start.z)).toBeGreaterThan(0.3);
  expect(later.vehicle!.speed).toBeLessThanOrEqual(60);

  // Handbrake -> slows hard.
  await page.keyboard.up('KeyW');
  await page.keyboard.down('Space');
  await waitFor(page, () => Math.abs(window.__MINI_GTA!.snapshot().vehicle!.speed) < Math.abs(2));
  await page.keyboard.up('Space');

  // Exit: on foot, close to the car, in the same place.
  const car = (await snapshot(page)).vehicle!;
  await page.keyboard.press('KeyE');
  await waitFor(page, () => !window.__MINI_GTA!.snapshot().playerInVehicle);
  s = await snapshot(page);
  const dist = Math.hypot(s.player.x - car.x, s.player.z - car.z);
  expect(dist).toBeGreaterThan(0.8);
  expect(dist).toBeLessThan(4);
  expect(s.status).toBe('playing');

  // The car we left keeps its last known position (snapshot.vehicle is null on foot).
  expect(s.vehicle).toBeNull();
  expect(Number.isFinite(car.x) && Number.isFinite(car.z)).toBe(true);

  expect(errors).toEqual([]);
});
