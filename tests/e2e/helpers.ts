/**
 * Shared Playwright helpers for the MINI GTA e2e suite.
 *
 * Rules encoded here (see docs/QA_REPORT.md):
 *  - Every gameplay assertion waits on the `window.__MINI_GTA` debug state via
 *    `page.waitForFunction(...)`. No fixed `waitForTimeout` is ever used to assert
 *    gameplay — software WebGL (SwiftShader) runs at 2–15 FPS, so wall-clock
 *    sleeps are meaningless.
 *  - Console errors / page errors / failed same-origin requests are collected on
 *    every page; `assertNoErrors()` fails the test with the exact messages.
 *  - Tests never call `__MINI_GTA.start()` directly: the real PLAY button is
 *    clicked so the shipped user path is what gets verified.
 */
import { expect, type ConsoleMessage, type Page, type Request } from '@playwright/test';
import type { DebugApi, DebugSnapshot, GameStatus } from '../../src/contracts';

export type { DebugApi, DebugSnapshot, GameStatus };

/** The only Chromium flags the QA environment is allowed to use (software GL). */
export const CHROMIUM_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
] as const;

export const TESTIDS = {
  startScreen: 'start-screen',
  playButton: 'play-button',
  controlsButton: 'controls-button',
  controlsScreen: 'controls-screen',
  backButton: 'back-button',
  pauseScreen: 'pause-screen',
  resumeButton: 'resume-button',
  restartButton: 'restart-button',
  muteButton: 'mute-button',
  quitButton: 'quit-button',
  missionResult: 'mission-result',
  continueButton: 'continue-button',
  hud: 'hud',
  money: 'money',
  health: 'health',
  missionPanel: 'mission-panel',
  minimap: 'minimap',
  speedo: 'speedo',
  toasts: 'toasts',
  compass: 'compass',
} as const;

/** A known safe spot beside the parking-lot cars (proven by the Lead's manual pass). */
export const PARKED_CAR_SPOT = { x: -40, z: -78 } as const;

export interface ErrorLog {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
}

declare global {
  interface Window {
    __MINI_GTA_PERF?: {
      enabled: boolean;
      latest: { fps: number; frameMs: number; updateMs: number; renderMs: number; drawCalls: number; triangles: number };
    };
    __qa?: { canvasClickErrors: string[] };
  }
}

/* -------------------------------------------------------------------------- */
/* Page instrumentation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Attach listeners BEFORE navigation. Returns a mutable log the test asserts on.
 * `console.error` from the app, uncaught exceptions, and failed same-origin HTTP
 * requests (4xx/5xx, network resets) are all recorded.
 */
export function trackErrors(page: Page): ErrorLog {
  const log: ErrorLog = { consoleErrors: [], pageErrors: [], failedRequests: [] };
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') log.consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err: Error) => {
    log.pageErrors.push(err.message);
  });
  page.on('requestfailed', (req: Request) => {
    const url = req.url();
    // Media/audio probes legitimately abort in headless; only care about our assets.
    if (url.startsWith('http://127.0.0.1:4173/')) {
      log.failedRequests.push(`${req.method()} ${url} — ${req.failure()?.errorText ?? 'failed'}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 400 && url.startsWith('http://127.0.0.1:4173/')) {
      log.failedRequests.push(`${res.status()} ${url}`);
    }
  });
  return log;
}

/** Serialise the log into a readable, detailed failure message. */
export function formatErrors(log: ErrorLog): string {
  const parts: string[] = [];
  if (log.pageErrors.length) parts.push(`pageerrors: ${JSON.stringify(log.pageErrors)}`);
  if (log.consoleErrors.length) parts.push(`console errors: ${JSON.stringify(log.consoleErrors)}`);
  if (log.failedRequests.length) parts.push(`failed requests: ${JSON.stringify(log.failedRequests)}`);
  return parts.join('\n');
}

/** Fails when the browser reported any error since page load. */
export function assertNoErrors(log: ErrorLog): void {
  expect(
    { pageErrors: log.pageErrors, consoleErrors: log.consoleErrors, failedRequests: log.failedRequests },
    `Browser reported errors:\n${formatErrors(log)}`,
  ).toEqual({ pageErrors: [], consoleErrors: [], failedRequests: [] });
}

/* -------------------------------------------------------------------------- */
/* Navigation & boot                                                          */
/* -------------------------------------------------------------------------- */

/** Default boot wait: the game instance exists and has left 'loading'. */
export const BOOT_PREDICATE = () =>
  !!window.__MINI_GTA && window.__MINI_GTA.status() !== 'loading';

/**
 * Open the game and wait until the debug API reports the menu.
 * @param query e.g. '?perf=1'
 */
export async function openGame(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' });
  await waitForDebug(page);
}

/** Wait for `window.__MINI_GTA` and for `status() !== 'loading'`. */
export async function waitForDebug(page: Page, timeout = 45_000): Promise<void> {
  await page.waitForFunction(BOOT_PREDICATE, null, { timeout });
}

/** Click the real PLAY button and wait for the playing state. */
export async function clickPlay(page: Page): Promise<void> {
  await expect(page.getByTestId(TESTIDS.playButton)).toBeVisible();
  await page.getByTestId(TESTIDS.playButton).click();
  await waitForStatus(page, 'playing');
}

/** Boot → menu → PLAY → playing. Used by most gameplay specs. */
export async function bootAndPlay(page: Page, query = ''): Promise<void> {
  await openGame(page, query);
  await expect(page.getByTestId(TESTIDS.startScreen)).toBeVisible();
  await clickPlay(page);
}

/** Wait until `status()` equals `expected`. */
export async function waitForStatus(page: Page, expected: GameStatus, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (want) => window.__MINI_GTA?.status() === want,
    expected,
    { timeout },
  );
}

/** Wait until `status()` is NOT one of `excluded` (e.g. not 'loading'/'menu'). */
export async function waitForStatusNot(page: Page, excluded: GameStatus[], timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    (want) => {
      const s = window.__MINI_GTA?.status();
      return !!s && !want.includes(s);
    },
    excluded,
    { timeout },
  );
}

/* -------------------------------------------------------------------------- */
/* Debug-state access                                                         */
/* -------------------------------------------------------------------------- */

export async function snapshot(page: Page): Promise<DebugSnapshot> {
  return page.evaluate(() => window.__MINI_GTA!.snapshot());
}

export async function frameCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__MINI_GTA!.frameCount());
}

/**
 * Poll `snapshot()` until `predicate` returns true; resolves with that snapshot
 * (handy for reading the state that satisfied the condition).
 */
export async function waitForSnapshot(
  page: Page,
  predicate: (s: DebugSnapshot) => boolean,
  timeout = 30_000,
): Promise<DebugSnapshot> {
  const handle = await page.waitForFunction(
    (src) => {
      const s = window.__MINI_GTA?.snapshot();
      if (!s) return null;
      // eslint-disable-next-line no-new-func
      const fn = new Function('s', `return (${src})(s);`) as (x: DebugSnapshot) => boolean;
      return fn(s) ? s : null;
    },
    predicate.toString(),
    { timeout },
  );
  return (await handle.jsonValue()) as DebugSnapshot;
}

/** Wait until the mission leaves `phase`. */
export async function waitForMissionPhase(page: Page, phase: string, timeout = 30_000): Promise<DebugSnapshot> {
  return waitForSnapshot(page, (s) => s.mission.phase === phase, timeout);
}

/** Wait until frameCount advances by at least `n` frames. */
export async function waitForFrames(page: Page, n = 1, timeout = 30_000): Promise<number> {
  const start = await frameCount(page);
  await page.waitForFunction(
    (args) => (window.__MINI_GTA?.frameCount() ?? 0) >= args.start + args.n,
    { start, n },
    { timeout },
  );
  return start;
}

/** Click the game canvas (focuses keyboard input and, in-game, requests pointer lock). */
export async function focusCanvas(page: Page): Promise<void> {
  // Click the viewport's top-centre HUD-free strip, which always belongs to the canvas.
  await page.locator('#game-canvas').click({ position: { x: 20, y: 300 } });
}

/**
 * Press `key` and wait for at least `waitFrames` rendered frames to consume the
 * edge (the game only samples key edges on the first simulation step of a frame).
 */
export async function pressAndSettle(page: Page, key: string, waitFrames = 3): Promise<void> {
  await page.keyboard.press(key);
  await waitForFrames(page, waitFrames);
}

/**
 * Hold a movement key for `ms`, then release. Only used to create sustained input
 * (never as an assertion): the caller then waits on the debug state.
 */
export async function holdKey(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/* -------------------------------------------------------------------------- */
/* Gameplay actions (each waits on debug state)                               */
/* -------------------------------------------------------------------------- */

/** Teleport the player to (x,z) and wait until the snapshot reflects it. */
export async function teleport(page: Page, x: number, z: number): Promise<DebugSnapshot> {
  await page.evaluate(
    (args) => window.__MINI_GTA!.teleport(args.x, args.z),
    { x, z },
  );
  const within = 6;
  return waitForSnapshot(
    page,
    (s) => Math.hypot(s.player.x - x, s.player.z - z) <= within || Math.hypot((s.vehicle?.x ?? 1e9) - x, (s.vehicle?.z ?? 1e9) - z) <= within,
  );
}

/**
 * Walk the mission forward to the 'getVehicle' phase by visiting the courier
 * marker on foot. Returns the snapshot at the transition.
 */
export async function reachCourier(page: Page): Promise<DebugSnapshot> {
  await waitForMissionPhase(page, 'meet');
  const s = await snapshot(page);
  const wp = s.mission.waypoint;
  expect(wp, 'meet phase must expose a waypoint').toBeTruthy();
  await teleport(page, wp!.x, wp!.z - 2);
  return waitForMissionPhase(page, 'getVehicle');
}

/** Walk to the known parked car and press E; waits until the player is inside. */
export async function enterParkedCar(page: Page): Promise<DebugSnapshot> {
  await teleport(page, PARKED_CAR_SPOT.x, PARKED_CAR_SPOT.z);
  await focusCanvas(page);
  await pressAndSettle(page, 'KeyE');
  return waitForSnapshot(page, (s) => s.playerInVehicle === true, 30_000);
}

/* -------------------------------------------------------------------------- */
/* Screens                                                                     */
/* -------------------------------------------------------------------------- */

/** Path under test-results/ for a screenshot of this test. */
export function shotPath(testInfo: { outputPath: (name: string) => string }, name: string): string {
  return testInfo.outputPath(name);
}

/** The typed debug API for compile-time reference (keeps contracts.ts in sync). */
export type GameApi = DebugApi;
