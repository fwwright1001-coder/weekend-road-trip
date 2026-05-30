// ============================================================
// gta/onfoot-adapter.js — INTEGRATION host for the crime-sandbox layer
// ------------------------------------------------------------
// This is the bridge that lets the gta/ systems run *inside* the real game's
// on-foot mode (onfoot3d.js) instead of the standalone boot.js harness. It is
// the integration-time counterpart of boot.js: it builds the shared `ctx` from
// onfoot3d's own scene/camera/player/input, supplies GTA.host, and drives
// GTA.tick from onfoot3d's frame loop.
//
// It requires onfoot3d.js to expose a tiny internals object (a ~6-line edit,
// see INTEGRATION.md) and to call this adapter's boot()/tick() hooks. Nothing
// here edits onfoot3d's logic; it only READS onfoot3d's internals and runs the
// decoupled systems on top. If anything here throws it is swallowed so the base
// on-foot mode keeps working.
//
// USAGE (in onfoot3d.js — see INTEGRATION.md for exact insertion points):
//   1. expose:  OF.internals = { get scene(){return scene}, get camera(){return camera},
//                 get renderer(){return renderer}, player, keys,
//                 get yaw(){return yaw}, get pitch(){return pitch}, get locked(){return locked} };
//   2. in enter():  window.GTA_ONFOOT && window.GTA_ONFOOT.boot();
//   3. in the frame loop, AFTER the player has moved this frame:
//                   window.GTA_ONFOOT && window.GTA_ONFOOT.tick(dt);
//   4. gate onfoot3d's own movement while driving:
//        at the top of onfoot3d update():  if (window.GTA_ONFOOT && window.GTA_ONFOOT.inVehicle()) return;
//   5. disable onfoot3d's built-in pistol fire() + ped spawner (our combat/peds own them).
// ============================================================
import * as THREE from 'three';
import { GTA, GU } from './core.js';

// register all systems (world first; hud last)
import './world.js';
import './economy.js';
import './wanted.js';
import './peds.js';
import './vehicles.js';
import './combat.js';
import './police.js';
import './missions.js';
import './hud-radar.js';

let ctx = null, booted = false, recoil = 0;
let mouseDown = false;
const justKeys = new Set();      // pressed-this-tick (diffed from internals.keys)
const justMouse = new Set();
let prevKeys = new Set();

const ADAPTER = {
  boot, tick,
  inVehicle: () => !!(ctx && ctx.player && ctx.player.inVehicle),
  ctx: () => ctx,
};
if (typeof window !== 'undefined') window.GTA_ONFOOT = ADAPTER;

// ---- input adapter over onfoot3d's `keys` Set + our own mouse listeners ----
function makeInput(internals) {
  return {
    keys: internals.keys,
    get pointerLocked() { return !!internals.locked; },
    get mouseDown() { return mouseDown; },
    held(c) { return internals.keys.has(c); },
    pressed(c) { return justKeys.has(c); },
    consume(c) { const h = justKeys.has(c); justKeys.delete(c); return h; },
    mouseJust(b = 0) { return justMouse.has(b); },
    consumeMouse(b = 0) { const h = justMouse.has(b); justMouse.delete(b); return h; },
  };
}

// our combat reads the camera for aiming; onfoot3d owns the camera each frame,
// so we expose its forward + accumulate a recoil kick the adapter applies post-tick.
function wireHost(internals) {
  GTA.host = {
    addRecoil(a) { recoil += a; },
    cameraDir(out) { return internals.camera.getWorldDirection(out || new THREE.Vector3()); },
    yaw: () => internals.yaw,
    pitch: () => internals.pitch,
  };
}

function buildCtx(internals) {
  const p = internals.player;            // onfoot3d's player {pos:Vector3, vy, grounded, mesh}
  const player = {
    // pos is the SAME Vector3 instance onfoot3d moves — keeps both in sync
    pos: p.pos,
    vel: new THREE.Vector3(),
    get vy() { return p.vy; }, set vy(v) { p.vy = v; },
    get grounded() { return p.grounded; }, set grounded(v) { p.grounded = v; },
    yaw: internals.yaw, pitch: internals.pitch, facing: 0,
    health: 100, maxHealth: 100, armor: 0, money: 0,
    inVehicle: false, vehicle: null,
    weapon: 'pistol',
    mesh: p.mesh,
    alive: true,
  };
  ctx = {
    THREE,
    scene: internals.scene, camera: internals.camera, renderer: internals.renderer,
    player, input: makeInput(internals),
    world: null,
    targets: [],
    time: { t: 0, dt: 0 },
    rng: GU.makeRng(0x0FF007ED),
    config: { difficulty: 1, pedDensity: 1, persist: true, mode: 'onfoot' },
    _internals: internals,
  };
  return ctx;
}

function readInternals() {
  const OF = window.ONFOOT;
  const intern = OF && OF.internals;
  if (!intern || !intern.scene || !intern.camera || !intern.player) return null;
  return intern;
}

function boot() {
  if (booted) { GTA.reset(ctx); return; }   // re-enter = soft reset
  const internals = readInternals();
  if (!internals) { console.warn('[GTA adapter] ONFOOT.internals not exposed — see INTEGRATION.md'); return; }
  try {
    buildCtx(internals);
    wireHost(internals);
    // our own mouse listeners (onfoot3d's fire() must be disabled to avoid double-fire)
    window.addEventListener('mousedown', (e) => { if (e.button === 0) { mouseDown = true; justMouse.add(0); } else justMouse.add(e.button); }, true);
    window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; }, true);
    GTA.bus.on('shake', (p = {}) => { recoil += Math.min(0.12, (p.amount || 1) * 0.03); });
    // wasted/busted: hand back to onfoot3d's own restart, or just clear wanted + heal
    GTA.bus.on('playerWasted', () => softRespawn('wasted'));
    GTA.bus.on('playerBusted', () => softRespawn('busted'));
    GTA.boot(ctx, { mode: 'onfoot' });
    if (ctx.systems.combat) ctx.systems.combat.api.giveWeapon('pistol', true);
    booted = true;
  } catch (e) {
    console.error('[GTA adapter] boot failed; base on-foot mode unaffected', e);
  }
}

function softRespawn(cause) {
  if (!ctx) return;
  const lm = ctx.world ? ctx.world.randomLandmark(ctx.rng) : { pos: { x: 0, z: 8 } };
  if (ctx.player.inVehicle && ctx.systems.vehicles) ctx.systems.vehicles.api.forceExit();
  ctx.player.pos.set(lm.pos.x, 0, lm.pos.z + 6);
  ctx.player.vy = 0; ctx.player.health = ctx.player.maxHealth; ctx.player.armor = 0;
  ctx.player.alive = true;
  GTA.bus.emit('playerRespawn', { pos: ctx.player.pos.clone(), cause });
  GTA.reset(ctx);
}

// called every frame from onfoot3d's loop AFTER the player has moved
function tick(dt) {
  if (!booted || !ctx) return;
  try {
    const internals = ctx._internals;
    // refresh just-pressed by diffing onfoot3d's key set
    justKeys.clear();
    for (const k of internals.keys) if (!prevKeys.has(k)) justKeys.add(k);
    prevKeys = new Set(internals.keys);
    // sync look + body facing from onfoot3d
    ctx.player.yaw = internals.yaw;
    ctx.player.pitch = internals.pitch;
    GTA.tick(dt, ctx);
    justMouse.clear();
    // apply a small recoil kick to onfoot3d's camera (optional flavor)
    if (recoil > 0.0001) { internals.camera.position.y += recoil * 0.6; recoil = Math.max(0, recoil - dt * 0.6); }
  } catch (e) {
    console.error('[GTA adapter] tick failed', e);
  }
}

export default ADAPTER;
