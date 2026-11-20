import { expect, type Page } from '@playwright/test';
import type { DebugSnapshot } from '../../src/contracts';

/** Software rendering is slow: every gameplay assertion polls game state. */
export const SLOW = 45_000;

export async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__MINI_GTA, null, { timeout: SLOW });
  await page.waitForFunction(() => window.__MINI_GTA!.status() === 'menu', null, { timeout: SLOW });
}

export async function snapshot(page: Page): Promise<DebugSnapshot> {
  return page.evaluate(() => window.__MINI_GTA!.snapshot());
}

export async function play(page: Page): Promise<void> {
  await page.getByTestId('play-button').click();
  await page.waitForFunction(() => window.__MINI_GTA!.status() === 'playing', null, { timeout: SLOW });
  // Headless engines can hold the first frames back for ~2 s: let the loop get
  // going so scripted teleports/taps land on live simulation frames.
  await page
    .waitForFunction(() => window.__MINI_GTA!.frameCount() > 12, null, { timeout: SLOW })
    .catch(() => {});
}

export async function waitFor(page: Page, fn: () => boolean, timeout = SLOW): Promise<void> {
  await page.waitForFunction(fn, null, { timeout });
}

export async function reachMissionPhase(page: Page, phase: string): Promise<void> {
  await page.waitForFunction(
    (p) => window.__MINI_GTA!.snapshot().mission.phase === p,
    phase,
    { timeout: SLOW },
  );
}

/** Walk to the current mission waypoint (on foot). */
export async function goToWaypoint(page: Page, dz = -2): Promise<void> {
  const s = await snapshot(page);
  const wp = s.mission.waypoint;
  expect(wp).not.toBeNull();
  await page.evaluate(([x, z]) => window.__MINI_GTA!.teleport(x, z), [wp!.x, wp!.z + dz]);
}

/** Standing spot beside the first parked car on the start street. */
export const PARKED_CAR_SPOT: [number, number] = [-40, -78];

export async function enterCar(page: Page): Promise<void> {
  await page.evaluate(([x, z]) => window.__MINI_GTA!.teleport(x, z), PARKED_CAR_SPOT);
  await waitFor(page, () => Math.abs(window.__MINI_GTA!.snapshot().player.z - -78) < 1);
  await page.keyboard.press('KeyE');
  try {
    await waitFor(page, () => window.__MINI_GTA!.snapshot().playerInVehicle, 15_000);
  } catch {
    // A tap can land between engine frames: press again once the loop is live.
    await page.keyboard.press('KeyE');
    await waitFor(page, () => window.__MINI_GTA!.snapshot().playerInVehicle);
  }
}

/** Drive the car to the current mission waypoint by teleport (keeps it a state test). */
export async function driveToWaypoint(page: Page): Promise<void> {
  const s = await snapshot(page);
  const wp = s.mission.waypoint;
  expect(wp).not.toBeNull();
  await page.evaluate(([x, z]) => window.__MINI_GTA!.teleport(x, z), [wp!.x, wp!.z]);
}

export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}
