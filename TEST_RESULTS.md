# TEST RESULTS — MINI GTA — OPEN CITY v1.0.0

Recorded 2026-11-20 · macOS (Apple silicon) · Node 24.22.3 · npm 11.19.1

## Summary

| Gate | Command | Result | Evidence |
|---|---|---|---|
| TypeScript (strict) | `npm run typecheck` | ✅ PASS — 0 errors | whole `src/` + `tests/` |
| Unit tests | `npm test` (Vitest 5) | ✅ PASS — **31 / 31** (3 files) | physics, mission, NPC bounds |
| Production build | `npm run build` | ✅ PASS — `dist/` ≈ 562 kB (three 545 kB + app 14 kB + css 19 kB) | |
| E2E — Chromium | `npx playwright test --project=chromium` | ✅ PASS — **9 / 9** | |
| E2E — WebKit (Safari engine) | `npx playwright test --project=webkit` | ✅ PASS — **9 / 9** | |
| E2E — both | `npx playwright test` | ✅ PASS — **18 / 18** | see table below |
| Production build served | `npm run build && npm run preview`, Playwright `production.spec.ts` | ✅ PASS | assets 200 + correct MIME, boots clean |
| Distribution ZIP | `npm run package` → extracted to a clean folder, served with `python3 -m http.server` | ✅ PASS — plays in Chromium **and** WebKit, 0 errors | `release/MINI-GTA-OPEN-CITY-v1.0.0.zip` (336 KB, 81 files) |
| Firefox | Playwright Firefox 159, real GPU | ✅ PASS — 120 FPS, 0 console errors, mission step OK | |
| Live HTTPS URL | anonymous-host deploys | ❌ **BLOCKED** — see "Deployment status" | requires user's hosting account |

## End-to-end tests (Playwright)

Each spec runs against the **production build** (`build:fast` + `preview`) in Chromium with SwiftShader and in WebKit (the Safari engine). Gameplay assertions poll `window.__MINI_GTA` state, never fixed sleeps.

| Spec | Verifies | Chromium | WebKit |
|---|---|---|---|
| `boot.spec.ts` | page loads, WebGL2 context, canvas sized, start screen + PLAY, 21 buildings, 16 vehicles, 14 peds, draw calls < 220, **no page/console errors** | ✅ 6.6 s | ✅ 0.9 s |
| `menu.spec.ts` | PLAY → playing · HOW TO PLAY → controls → BACK → menu · Esc → pause → RESUME · pause → QUIT TO MENU | ✅ 4.8 s | ✅ 0.9 s |
| `hud.spec.ts` | HUD visible, money `$`, mission panel text, **minimap canvas actually painted**, speedometer appears when driving and shows km/h | ✅ 4.4 s | ✅ 0.8 s |
| `controls.spec.ts` | W moves the player > 0.5 m, A/D changes facing yaw, Space jumps, canvas click requests pointer lock | ✅ 20.6 s | ✅ 16.0 s |
| `vehicle.spec.ts` | E enters the nearest car, W accelerates (speed > 2 m/s), position advances, top speed sane, **kerb stops the car** (no climbing pavements), Space handbrake stops it, E exits beside the car (0.8 m < d < 4 m) | ✅ 8.6 s | ✅ 4.3 s |
| `mission.spec.ts` | **full mission**: meet → getVehicle → deliver (timeLeft ≈ 90) → complete → reward > 0 & money credited → result overlay with `$` → CONTINUE → R restart (money kept) | ✅ 5.3 s | ✅ 0.8 s |
| `pause-restart.spec.ts` | paused simulation clock does not advance; resume continues; R restarts and keeps money | ✅ 7.3 s | ✅ 4.2 s |
| `performance.spec.ts` | `updateMs < 8`, draw calls < 220, triangles < 300 k | ✅ 6.3 s | ✅ 3.1 s |
| `production.spec.ts` | index + every referenced asset 200 with correct content type, no `localhost` baked into the bundle, game boots from the shipped bundle with 0 errors | ✅ 2.6 s | ✅ 0.5 s |

## Unit tests (Vitest)

- **Player controller (10):** camera-relative movement (forward = −Z at yaw 0), diagonal normalisation, sprint speed, no pass-through of building colliders, jump arc + landing, kerb step-up, world-bound clamping, onFoot=false no-op, setPosition snap, avatar height ~1.8 m.
- **Vehicle physics (7):** acceleration curve, top-speed clamp, braking and reverse cap, **no tunnelling** through a wall at ~46 m/s, handbrake deceleration, exit-side distance, steering.
- **Mission (13):** start → `meet`, on-foot marker → `getVehicle`, driving to marker → `deliver`, clock starts at 90 s, delivery reward `1000 + floor(timeLeft·5)`, failure on timeout, restart from any terminal state, deterministic under garbage input, clock formatting.
- **NPC system (6):** crowd/traffic spawn, **every pedestrian on walkable ground clear of buildings**, no NaN/out-of-bounds over 600 steps, traffic cars stay on the road, cars brake behind the player, ped→traffic takeover.
- **GameState (1):** money / damage / heal / reset.

## Performance

Measured with the in-game probe (`?perf=1`, F3):

| Environment | FPS | CPU update | CPU render call | Draw calls | Triangles |
|---|---|---|---|---|---|
| Firefox 159 on the host GPU (real hardware) | **120** (vsync cap) | < 0.5 ms | ~2 ms | 155 on foot / 145 driving | ~46 k |
| Chromium + SwiftShader (software rasteriser) | 12–30 | 0.2–0.3 ms | ~1 ms | 139–155 | ~46 k |

Software rendering is GPU-bound (the JS side costs ~2 ms/frame); on real hardware the game is far below the frame budget. Adaptive pixel ratio (0.8–2.0) protects slower GPUs.

## Bugs found and fixed during QA (selected)

| Severity | Symptom | Fix |
|---|---|---|
| Blocker | Key taps (E / Esc) lost between input reads → cars could not be entered reliably | Edge-event **queue** in `Input`; taps latched ~140 ms; one press = one action |
| Blocker | Player teleport/unjam locked when the world edge reported "out of bounds" | Project back onto bounds instead of freezing (`player.ts`) |
| High | Blocks had a 4.5 m pavement but buildings at the kerb → some markers inside buildings | 6 m walkable plazas around every building; POIs re-validated |
| High | Cars drove onto pavements at 90° corners | Kerb rule: cars never enter non-road ground |
| High | BACK on the controls screen did nothing | Explicit `onBack` → return to previous screen |
| High | Money reset on restart | Preserve money across restart |
| Med | Jacking a traffic car crashed (`getVehicleMeshData`) | Swap in the detailed vehicle model instead of reparenting |
| Med | Mission result time always 0:00 | Mission reports delivery-phase time |
| Med | Shadow type removed in three r187 | `PCFShadowMap` |
| Med | Catch-up frames after start teleported the player | Clamp per-substep physics dt; engine dt guards |
| Low | NPC cars were shadow+texture heavy | Ped shadows off, 30 Hz NPC AI, instanced windows (30 k quads → 1 draw) |

## Deployment status

Anonymous deploy attempts (no account ownership) produce HTTPS URLs but the sites are **password-protected until claimed** (Netlify drop) or require login (surge). A GitHub **public** repository could not be created because this session's `gh` token has only `repo` scope (private repositories). Therefore **no public live URL exists yet**; `docs/DEPLOYMENT.md` documents five one-step hosting options and the ready-made `dist/` and ZIP are verified to run from any static server.

## Known limitations (not release blockers)

- **One mission** (The Delivery Run). Free roam afterwards; replay with R.
- No combat, wanted level, police, saves or progression — money is a session score.
- Collision is 2.5D: axis-aligned boxes and circles; no slopes, stacked floors or vehicle deformation.
- Traffic is scripted lane-following (right-hand traffic, turn arcs), not a full pathfinding AI; cars stop at kerbs.
- Crowd and traffic are static in count (14 pedestrians, 9 traffic cars) — no spawning stream.
- Keyboard + mouse only: no gamepad or touch controls; pointer lock may need a click on some browsers (the game remains playable without it).
- Audio uses the WebAudio synthesiser and only starts after the first click (browser autoplay policy).
- Headless Chromium throttles its render loop for a fully occluded static menu frame — a headless-engine quirk; real browsers render the menu normally (verified in Firefox at 120 FPS).
- Visual polish is GPU/device dependent; the adaptive resolution may render at 0.8× on old GPUs.

## Not verified

- **Native Safari.app**: WebKit (Safari's own engine) is verified end-to-end, but the standalone Safari application itself was not driven — run the manual checklist (`docs/QA_MANUAL_CHECKLIST.md`) on the Mac.
- Real-GPU FPS in Chrome/Safari (Firefox 120 FPS is the hardware data point; Chromium tests run on SwiftShader).
- Actual mobile/touch devices (out of scope).
- The live HTTPS deployment (blocked as described above).
