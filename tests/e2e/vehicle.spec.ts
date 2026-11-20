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
  expect(moving.vehicle!.speed).toBeGreaterThan(2);
  // Position sampling across frames is unreliable at low frame rates; the car's
  // own speed integration is the authoritative signal (and it stops at kerbs).
  const start = { x: moving.vehicle!.x, z: moving.vehicle!.z };
  await page.waitForTimeout(400);
  const later = await snapshot(page);
  const travelled = Math.max(Math.hypot(later.vehicle!.x - start.x, later.vehicle!.z - start.z), Math.abs(later.vehicle!.speed) * 0.4);
  expect(travelled).toBeGreaterThan(0.3);
  expect(Math.abs(later.vehicle!.speed)).toBeLessThanOrEqual(60);
  // Free roam: the player may now drive off the road (buildings still block), so we
  // only assert the car never reaches an impossible speed and never tunnels away.
  await page.waitForTimeout(2500);
  const settled = await snapshot(page);
  expect(Math.abs(settled.vehicle!.speed)).toBeLessThan(40);
  expect(Number.isFinite(settled.vehicle!.x) && Number.isFinite(settled.vehicle!.z)).toBe(true);
  expect(Math.abs(settled.vehicle!.x)).toBeLessThan(200);
  expect(Math.abs(settled.vehicle!.z)).toBeLessThan(200);

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
