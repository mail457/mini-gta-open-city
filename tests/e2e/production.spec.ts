import { expect, test } from '@playwright/test';

test('production build: index + every referenced asset is served correctly', async ({ page, request, baseURL }) => {
  const res = await request.get(`${baseURL}/`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('<canvas id="game-canvas"');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data:') && !u.startsWith('http'));
  expect(refs.length).toBeGreaterThanOrEqual(2);
  for (const ref of refs) {
    const url = new URL(ref, `${baseURL}/`).toString();
    const r = await request.get(url);
    expect(r.status(), `asset ${ref}`).toBe(200);
    const ct = r.headers()['content-type'] ?? '';
    expect(ct).toMatch(/javascript|css|html/);
  }
  // Relative base: no absolute localhost URLs baked into the bundle.
  const scripts = refs.filter((r) => r.endsWith('.js'));
  for (const s of scripts) {
    const body = await (await request.get(new URL(s, `${baseURL}/`).toString())).text();
    expect(body).not.toContain('http://localhost');
  }
  // And it actually boots from the production bundle.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.waitForFunction(() => !!window.__MINI_GTA, null, { timeout: 45_000 });
  expect(await page.evaluate(() => window.__MINI_GTA!.status())).toBe('menu');
  expect(errors).toEqual([]);
});
