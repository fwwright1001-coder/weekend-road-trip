# Crime-sandbox gameplay layer

An open-world, third-person **crime-sandbox gameplay layer** — wanted level,
police pursuit, carjacking, an arsenal, health/armor, money, missions, traffic,
and a rotating radar — built as a **drop-in for the Weekend Road Trip on-foot
mode** (`onfoot3d.js`, the `experiment/onfoot-gta` branch). It runs in plain
Chrome with no build step (ES modules + Three.js via CDN, same as the host game).

It clones the *mechanics and feel* of the genre while originating all art and
naming. See **[LEGAL.md](LEGAL.md)** — mechanics aren't copyrightable; we use
zero third-party assets, names, or marks.

## Run the standalone demo
No build, no install. Serve the folder and open it in Chrome:
```powershell
# from weekend-road-trip-gta/
python -m http.server 8080
# then open http://localhost:8080/
```
(Needs an HTTP server, not `file://`, because ES-module imports + the Three.js
import map require it. Any static server works.)

**Controls:** Click to capture the mouse · **WASD** move · **Shift** run ·
**Space** jump · **Click** shoot · **R** reload · **1–5 / Tab** switch weapon ·
**F** enter/exit a car · walk into a glowing pillar to start a mission.

## What's here
| File | Role |
|---|---|
| `gta/core.js` | Namespace, event bus, system registry, shared `ctx`, math utils, the event catalog |
| `gta/world.js` | Procedural city: road grid, districts, buildings, collision + navigation API |
| `gta/wanted.js` | 0–5 star wanted level driven by crime "heat" + decay |
| `gta/police.js` | Police AI that scales with stars: seek → engage → arrest, cop cars |
| `gta/combat.js` | Arsenal (fists/pistol/SMG/shotgun/rifle), firing, health/armor, wasted/busted |
| `gta/vehicles.js` | Drivable + jackable cars, arcade driving, ambient traffic |
| `gta/peds.js` | Ambient civilians that wander and panic; hittable, drop cash |
| `gta/economy.js` | Money ledger + world pickups (cash/health/armor/ammo) + persistence |
| `gta/missions.js` | Objective framework (goto/eliminate/collect/deliver/survive/evade) + sample missions |
| `gta/hud-radar.js` | HUD (stars, vitals, weapon, cash, objective) + the rotating minimap |
| `gta/boot.js` | **Standalone** host: scene, player, input, loop (demo only) |
| `gta/onfoot-adapter.js` | **Integration** host: runs the systems inside `onfoot3d.js` |
| `gta/bridge-stub.js` | Stubs/documents the host-game bridges for standalone testing |
| `index.html`, `styles.css` | Standalone demo page + HUD styling |
| `INTEGRATION.md` | How to drop this into the live on-foot mode (folder copy + ~6 small edits) |
| `LEGAL.md` | The "as close as legally possible" posture |

## Architecture in one paragraph
Everything is a **decoupled system** with a uniform `{name, init, update, reset,
api}` shape, registered into a tiny core. Systems never call each other's
internals — they publish/consume **bus events** (`crime`, `wanted:changed`,
`damage`, `entityKilled`, `vehicle:jacked`, `spawnPickup`, …) and expose a small
`api`. Damage flows through one shared hittable registry (`ctx.targets`) that
`combat.js` raycasts against. That decoupling is why this could be built in
parallel and why any system can be swapped or disabled without breaking the
rest — including failing safe so a bug here can never brick the base game.

## Status
Foundation + all eight gameplay systems implemented and demo-runnable. The
integration into `onfoot3d.js` is documented and adapter-ready, to be performed
once the on-foot foundation (owned by another working branch) settles.
