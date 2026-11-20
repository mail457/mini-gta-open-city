import { expect, test } from '@playwright/test';
import { boot, collectErrors, driveToWaypoint, enterCar, goToWaypoint, play, reachMissionPhase, snapshot, waitFor } from './helpers';

test('THE DELIVERY RUN can be completed end to end and rewards the player', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await play(page);

  let s = await snapshot(page);
  expect(s.mission.phase).toBe('meet');
  expect(s.mission.title).toMatch(/delivery/i);
  expect(s.mission.waypoint).not.toBeNull();

  // 1) Meet the courier on foot.
  await goToWaypoint(page);
  await waitFor(page, () => window.__MINI_GTA!.snapshot().player.z > -80.5).catch(() => {});
  await reachMissionPhase(page, 'getVehicle');

  // 2) Get into a vehicle.
  await enterCar(page);
  await reachMissionPhase(page, 'deliver');
  s = await snapshot(page);
  expect(s.mission.timeLeft).toBeGreaterThan(0);
  expect(s.mission.waypoint).not.toBeNull();

  // 3) Deliver.
  const moneyBefore = s.money;
  await driveToWaypoint(page);
  await waitFor(page, () => window.__MINI_GTA!.status() === 'missionResult');
  s = await snapshot(page);
  expect(s.mission.phase).toBe('complete');
  expect(s.mission.reward).toBeGreaterThan(0);
  expect(s.money).toBeGreaterThan(moneyBefore);

  const overlay = page.getByTestId('mission-result');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(/complete/i);
  await expect(overlay).toContainText('$');

  // 4) Continue free-roam.
  await page.getByTestId('continue-button').click();
  await waitFor(page, () => window.__MINI_GTA!.status() === 'playing');

  // 5) Restart keeps the money and re-arms the mission.
  await page.keyboard.press('KeyR');
  await reachMissionPhase(page, 'meet');
  await waitFor(page, () => window.__MINI_GTA!.status() === 'playing');
  s = await snapshot(page);
  expect(s.money).toBeGreaterThan(moneyBefore);

  expect(errors).toEqual([]);
});
