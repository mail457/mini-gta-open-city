# PLAN — MINI GTA — OPEN CITY

Objective: a tested, playable, distributable third-person open-city game, shareable via an HTTPS URL.

## Milestones — final status

| # | Milestone | Gate | Status |
|---|---|---|---|
| M0 | Workspace + toolchain + contracts | `tsc` clean, Vite dev server serves page | ✅ |
| M1 | **Minimal playable foundation** | 3D scene renders, player moves, camera orbits, no console errors | ✅ |
| M2 | Parallel development (4 workers) | each module passes acceptance + typecheck | ✅ (code recovered after worker crashes and integrated by the Lead) |
| M3 | Integration | all systems in one loop; console clean | ✅ |
| M4 | Mission completable end-to-end | automated Playwright proof | ✅ |
| M5 | QA & repair | 18/18 browser tests, 11 defects fixed | ✅ |
| M6 | Performance | 60 FPS target met (120 FPS measured in Firefox on the host GPU) | ✅ |
| M7 | Delivery | `dist/`, ZIP, README, deploy config, HTTPS URL | ✅ except ⚠️ public URL (hosting credentials) |

## Scope delivered
- 5×5 street grid (10 streets, 25 intersections), 21 buildings, central park, parking lot, distant skyline.
- 3 vehicle types with distinct handling; jackable traffic; kerbs stop cars; no tunnelling.
- Pedestrians and 9-car traffic with lane-following + turn arcs + avoidance.
- Mission "The Delivery Run": meet → get vehicle → drive to drop-off → reward (time bonus) → continue/restart.
- Full HUD (money, health, mission+timer, compass, minimap, speedometer, toasts, result overlay) and menus.
- Procedural audio, adaptive resolution, performance overlay.

## Follow-ups (post-v1.0)
- Public hosting (user account) and a native Safari pass.
- Optional: second mission, police heat, gamepad support, touch controls.
