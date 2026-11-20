import { expect, test } from '@playwright/test';
import { boot, collectErrors, play, waitFor } from './helpers';

test('start, controls, pause, resume and quit-to-menu flows work', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);

  await expect(page.getByTestId('start-screen')).toBeVisible();

  // HOW TO PLAY → controls → back
  await page.getByTestId('start-screen').getByTestId('controls-button').click();
  await page.waitForFunction(() => window.__MINI_GTA!.status() === 'controls');
  await expect(page.getByTestId('controls-screen')).toBeVisible();
  await expect(page.getByTestId('controls-screen')).toContainText(/W\s*A\s*S\s*D|WASD|Walk/i);
  await page.getByTestId('controls-screen').getByTestId('back-button').click();
  await page.waitForFunction(() => window.__MINI_GTA!.status() === 'menu');
  await expect(page.getByTestId('start-screen')).toBeVisible();

  // PLAY
  await play(page);
  await expect(page.getByTestId('start-screen')).toBeHidden();
  await expect(page.getByTestId('hud')).toBeVisible();

  // Escape → pause → resume
  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__MINI_GTA!.status() === 'paused');
  await expect(page.getByTestId('pause-screen')).toBeVisible();
  await page.getByTestId('resume-button').click();
  await waitFor(page, () => window.__MINI_GTA!.status() === 'playing');

  // Escape → quit to menu
  await page.keyboard.press('Escape');
  await waitFor(page, () => window.__MINI_GTA!.status() === 'paused');
  await page.getByTestId('quit-button').click();
  await waitFor(page, () => window.__MINI_GTA!.status() === 'menu');
  await expect(page.getByTestId('start-screen')).toBeVisible();

  expect(errors).toEqual([]);
});
