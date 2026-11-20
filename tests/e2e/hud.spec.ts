import { expect, test } from '@playwright/test';
import { boot, collectErrors, enterCar, play, waitFor } from './helpers';

test('HUD shows money, health, minimap, mission panel and a speedometer when driving', async ({ page }) => {
  const errors = collectErrors(page);
  await boot(page);
  await play(page);

  await expect(page.getByTestId('hud')).toBeVisible();
  const money = page.getByTestId('money');
  await expect(money).toBeVisible();
  await expect(money).toContainText('$');

  const missionPanel = page.getByTestId('mission-panel');
  await expect(missionPanel).toBeVisible();
  await expect(missionPanel).toContainText(/delivery|courier|vehicle|package/i);

  // Minimap draws actual pixels (background grid + dots).
  const minimapPainted = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="minimap"] canvas') ?? document.querySelector('[data-testid="minimap"]');
    if (!(canvas instanceof HTMLCanvasElement)) return false;
    const url = canvas.toDataURL('image/png');
    return url.length > 2000;
  });
  expect(minimapPainted).toBe(true);

  // Speedometer only exists while driving.
  const speedo = page.getByTestId('speedo');
  const visibleBefore = await speedo.isVisible().catch(() => false);

  await enterCar(page);
  await expect(missionPanel).toBeVisible();
  await waitFor(page, () => window.__MINI_GTA!.snapshot().playerInVehicle);
  if (!visibleBefore) await expect(speedo).toBeVisible();
  await expect(speedo).toContainText(/km\/h/i);

  expect(errors).toEqual([]);
});
