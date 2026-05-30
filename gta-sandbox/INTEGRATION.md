# Integrating the crime-sandbox layer into the on-foot mode

This layer was built **outside** the live `experiment/onfoot-gta` worktree on
purpose — so it never collides with whoever is editing `onfoot3d.js`. When the
on-foot foundation is ready, integration is a folder copy + ~6 small, clearly
marked edits to `onfoot3d.js`. The systems themselves never change.

> **The whole layer is fail-safe.** Every system is wrapped by `GTA.tick`, and
> the adapter's `boot()/tick()` are try/caught. If any of it throws, the base
> on-foot mode keeps running exactly as before. You can integrate incrementally.

---

## 1. Copy the files

Copy these from `weekend-road-trip-gta/gta/` into the worktree next to
`onfoot3d.js` (e.g. into a `gta/` subfolder there):

```
core.js  world.js  economy.js  wanted.js  peds.js  vehicles.js
combat.js  police.js  missions.js  hud-radar.js  onfoot-adapter.js
```

**Do NOT copy** `boot.js` or `bridge-stub.js` — those are the *standalone*
host. In the real game, `onfoot3d.js` is the host and `onfoot-adapter.js` is
the bridge.

Also copy the HUD DOM + CSS:
- Add the HUD markup block from `index.html` (the `#gta-hud`, `#gta-radar`,
  `#gta-crosshair`, `#gta-weapon-wheel` nodes) into the game's `index.html`
  inside `#frame`.
- Append `styles.css`'s `/* crime-sandbox HUD */` rules to the game's
  `styles.css` (they're all `#gta-*` / `.gta-*` scoped, so no collisions).

Add one script tag to the game's `index.html`, **after** `onfoot3d.js`:
```html
<script type="module" src="gta/onfoot-adapter.js"></script>
```

---

## 2. The ~6 edits to `onfoot3d.js`

All edits are additive and reversible. Line numbers will drift as that file
evolves, so they're described by symbol/behavior.

**(a) Expose internals** — next to the `const OF = { ... }` definition, add:
```js
OF.internals = {
  get scene()    { return scene; },
  get camera()   { return camera; },
  get renderer() { return renderer; },
  player,                                   // {pos:Vector3, vy, grounded, mesh, muzzle}
  keys,                                     // the Set onfoot3d already maintains
  get yaw()    { return yaw; },
  get pitch()  { return pitch; },
  get locked() { return locked; },
};
```
(If `player.mesh`/`player.muzzle` aren't already fields, point them at the
player group + its `userData.muzzle`.)

**(b) Boot the layer on enter** — at the end of `enter()` (after `ensureInit()`):
```js
window.GTA_ONFOOT && window.GTA_ONFOOT.boot();
```

**(c) Tick the layer each frame** — in `update(dt)` (or `loop`), **after** the
player's position has been updated this frame and **before** `renderer.render`:
```js
window.GTA_ONFOOT && window.GTA_ONFOOT.tick(dt);
```

**(d) Hand movement to the car while driving** — at the very top of the on-foot
movement block in `update(dt)`:
```js
if (window.GTA_ONFOOT && window.GTA_ONFOOT.inVehicle()) {
  // the vehicles system owns the player position while driving
} else {
  // ...existing WASD/jump/gravity movement...
}
```

**(e) Disable onfoot3d's built-in pistol** — our `combat.js` owns shooting,
ammo, reload, and the full arsenal. In `onMouseDown`/`fire`, early-return when
the layer is active:
```js
if (window.GTA_ONFOOT && window.GTA_ONFOOT.ctx()) return;   // GTA combat owns firing
```

**(f) Disable onfoot3d's built-in pedestrian spawner** — our `peds.js` owns the
crowd (so deaths feed the wanted/economy systems). Guard the `spawnPed` loop in
`ensureInit()` (or simply skip it when integrating):
```js
const GTA_OWNS_PEDS = true;
if (!GTA_OWNS_PEDS) { for (let i = 0; i < NPC_COUNT; i++) spawnPed(rng, true); }
```

That's the whole integration surface.

---

## 3. The world: ours vs. onfoot3d's town

Our systems depend on `world.js`'s collision + road-network + spawn API. Two
options:

- **Recommended — let `gta/world.js` own the city.** It builds a full road grid,
  districts, and landmarks that traffic + police actually navigate. When
  integrating, skip onfoot3d's town generation (its building grid + parked car)
  and let `world.js` add the city to the shared scene. You keep onfoot3d's
  renderer, camera, lights, and player controller; the city comes from our layer.
- **Alternative — keep onfoot3d's town.** Then don't import `world.js`; instead
  write a ~30-line `world` shim that exposes the same API
  (`resolve/isInside/onRoad/nearestRoad/randomSpawn/randomRoadSpawn/landmarks`)
  over onfoot3d's `aabbs` + `BOUND`. Traffic/police nav will be cruder without a
  real road graph. (Stub provided in the comments at the bottom of `world.js`'s
  header if you go this route.)

Pick one so two systems aren't both drawing a city into the same scene.

---

## 4. Contract recap (what the adapter wires)

| Layer needs (`ctx.*`) | Comes from onfoot3d via `OF.internals` |
|---|---|
| `ctx.scene/camera/renderer` | the same Three.js objects |
| `ctx.player.pos` | `internals.player.pos` (shared `Vector3` — stays in sync) |
| `ctx.player.yaw/pitch` | `internals.yaw/pitch` (synced each tick) |
| `ctx.input` | wraps `internals.keys` + adapter's own mouse listeners |
| `GTA.host.cameraDir/yaw/pitch` | `internals.camera` / `yaw` / `pitch` |
| `ctx.targets` | created by the adapter, filled by peds/police/vehicles |

The adapter owns: just-pressed key diffing, mouse buttons, the recoil kick, and
the wasted/busted → soft-respawn. Everything else lives in the systems.

---

## 5. Gating (don't leak into the driving game)

The on-foot mode only runs after a finished trip. The adapter's `boot()` is
called from `enter()`, so the layer is dormant until then — matching
onfoot3d's existing gate (`wrt.onfoot.unlocked`). When `exit()` is called you
can optionally stop ticking (the adapter no-ops if `tick` isn't called).

---

## 6. Verifying the merge

1. Open the game, finish a trip, press **F** to step out.
2. Confirm: radar + stars + vitals HUD appear; pedestrians wander; you can draw
   a weapon and fire; firing raises the wanted stars; cops spawn and chase;
   walk to a car and press **F** to drive; a mission marker can be triggered.
3. Throw a deliberate error in one system's `update` and confirm the base
   on-foot mode keeps running (fail-safe check).
