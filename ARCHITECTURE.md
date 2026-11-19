# MINI GTA — OPEN CITY — Architecture

Third-person open-city arcade game. TypeScript + Three.js + Vite. 100% client-side; the production build is static files.

## Stack decisions

| Concern | Decision | Why |
|---|---|---|
| Renderer | Three.js `WebGLRenderer` (WebGL2, WebGL1 fallback) | Standards-based → works in Safari + Chrome |
| Build | Vite 8, `base: './'` | Relative asset URLs → deploy anywhere (GitHub Pages, itch.io, S3, plain folder) |
| Language | TypeScript 5.9, `strict` | Interfaces frozen in `src/contracts.ts` |
| Physics | Custom 2.5D (circle + AABB) | Arcade feel, zero deps, deterministic, testable |
| Models | Procedural low-poly, merged geometry | No external asset downloads, tiny bundle |
| Audio | WebAudio synthesis | No audio files |
| Tests | Vitest (pure logic) + Playwright (real browser) | |
| Deploy | GitHub Pages via `gh-pages` branch | Already-authenticated `gh` CLI → real HTTPS URL |

## Module map & file ownership

```
src/
  contracts.ts        LEAD   Frozen interfaces (single source of truth)
  main.ts             LEAD   Bootstrap: engine, game, debug API
  core/
    engine.ts         LEAD   Renderer, adaptive pixel ratio, fixed-step loop
    input.ts          LEAD   Keyboard + pointer-lock mouse → InputFrame
    camera.ts         LEAD   Third-person orbit/follow camera
    audio.ts          LEAD   WebAudio SFX + engine drone
    utils.ts          LEAD   math / rng helpers
  world/
    world.ts          W-1    CityWorld: geometry, colliders, road graph, POIs
    cityLayout.ts     W-1    Grid constants + road graph builder (pure, unit-tested)
  entities/
    player.ts         W-2    PlayerController (walk/run/jump, collisions)
    vehicles.ts       W-2    Vehicle specs, meshes, VehicleSystem
    vehiclePhysics.ts W-2    stepDriven: accel/brake/steer/drift/collision
    vehicleModels.ts  W-2    Procedural vehicle meshes
  gameplay/
    npcs.ts           W-3    Pedestrians + traffic AI (NPCSystemApi)
    mission.ts        W-3    "The Delivery Run" (MissionApi)
    gameState.ts      W-3    Money, health, mission orchestration glue
  ui/
    hud.ts            W-4    HUD, minimap, toasts, mission result (HudApi)
    menu.ts           W-4    Start / controls / pause screens
    styles.css        W-4    All UI styling
  game/
    game.ts           LEAD   Game state machine + integration of all systems
tests/
  unit/*.test.ts      W-4    Vitest pure-logic tests
  e2e/*.spec.ts       W-4    Playwright browser tests
scripts/package-release.sh   W-4   ZIP release
```

**Disjoint file ownership** ⇒ zero write conflicts between the four parallel workers.

## Runtime data flow (one fixed step)

```
Input.consume() ──► game.update(dt, input)
   ├─ player.onFoot ? player.update(dt,input,cameraYaw) : vehiclePhysics.stepDriven(...)
   ├─ npcs.update(dt, playerPos, drivenVehicle)
   ├─ mission.update(dt, env) ──► MissionState
   ├─ world.update(dt, elapsed)
   └─ hud.update(HudData)          ── per frame:
                                     camera.update(anchor, dt, speed, autoYaw)
                                     audio.setEngine(rpm)
                                     renderer.render(scene,camera)
```

## Fixed contracts
See `src/contracts.ts`. Key invariants:
- World is flat: ground `y = 0`; `groundHeight()` may return kerb heights but the player controller uses `max(0, kerb)`.
- `CollisionService.resolveCircle` pushes a circle out of **static** colliders (buildings, lamps, trees, park fences).
- Vehicle-vs-vehicle collisions are resolved by `VehicleSystem`/`stepDriven` using vehicle AABBs supplied by Agent 2.
- Traffic never leaves road lanes; pedestrians never leave sidewalk/plaza walkways.
- Mission waypoints always map to drivable road or walkable ground.
