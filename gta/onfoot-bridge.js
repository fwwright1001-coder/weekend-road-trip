// ============================================================
// gta/onfoot-bridge.js — wires the crime-sandbox SYSTEMS layer onto the
// existing on-foot mode (onfoot3d.js), turning the "walk + shoot" easter egg
// into a full GTA-style loop: wanted stars, police that spawn/chase/shoot and
// can be shot back, player health + armor + Wasted/Busted, a money economy,
// bounty missions, and a rotating minimap/radar.
// ------------------------------------------------------------
// DESIGN: onfoot3d.js stays the HOST. It owns the scene, camera, renderer,
// player controller, town, pedestrians, pistol, and driving. This bridge only
// READS its internals (window.ONFOOT.internals) and reacts through the optional
// hooks it exposes (onEnter/onTick/onFire/onKill/onJack/onExit). It registers
// my reviewed systems (wanted/economy/missions/police/hud-radar) plus three thin
// SHIMS that adapt my systems' world/combat/vehicles contracts onto onfoot3d's
// town. Everything is null-guarded and per-system isolated by core.js, so a bug
// here can never brick the base on-foot mode.
//
// Reuses (unchanged): gta/core.js, wanted.js, economy.js, missions.js,
//   police.js, hud-radar.js. Does NOT import combat.js or vehicles.js (onfoot3d
//   owns shooting + cars); a combat/vehicles SHIM provides the api those modules
//   expect.
// ============================================================
import { GTA, GU } from './core.js';
import './wanted.js';
import './economy.js';
import './missions.js';
import './police.js';
import './hud-radar.js';

// ---- handles (resolved at enter time; internals don't exist until ensureInit) ----
let I = null;            // window.ONFOOT.internals
let ctx = null;
let booted = false;
let active = false;
const pedMirrors = [];   // ctx.targets blip entries mirroring onfoot3d's peds
const vehMirrors = [];   // ctx.targets blip entries mirroring onfoot3d's vehicles
const _scratchDir = { x: 0, y: 0, z: 0 };
let _aimDir = null;                                   // reused Vector3 for the cop aim ray
let _lastPx = null, _lastPy = null, _lastPz = null;   // prior player pos, for deriving velocity
let _shakeMag = 0, _flashEl = null;                   // screen-shake + hit-flash feedback

// ============================================================
// SHIM 1 — WORLD: adapt onfoot3d's town (aabbs + BOUND + resolveCollision)
// onto the world.api my police/missions/hud-radar expect.
// ============================================================
const BLOCK = 24;        // onfoot3d's CELL grid spacing
const ROAD_OFFSET = 12;  // real cross-streets run at k*24 + 12 (between building-block centres)
const ROAD_HALF = 5;     // approximate street half-width
function makeWorldShim() {
  const THREE = I.THREE;
  const bound = I.bound;
  let landmarks = null;
  const buildLandmarks = () => {
    // a handful of named anchors for missions: the spawn plaza + a few block centres
    const out = [{ name: 'plaza', pos: { x: 0, z: 8 }, district: 'downtown' }];
    const a = I.aabbs;
    for (let i = 0; i < a.length; i += Math.max(1, (a.length / 6) | 0)) {
      const b = a[i];
      out.push({ name: 'block_' + i, pos: { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 }, district: 'downtown' });
    }
    return out;
  };
  const api = {
    bound, blockSize: BLOCK, roadHalf: ROAD_HALF, roadOffset: ROAD_OFFSET,
    isInside: (x, z, pad = 0) => I.insideBuilding(x, z, pad),
    resolve: (pos, pad = 0.4) => { I.resolveCollision(pos, pad); return pos; },
    onRoad: (x, z) => !I.insideBuilding(x, z, 0) && Math.abs(x) <= bound && Math.abs(z) <= bound,
    nearestRoad(x, z, out = {}) {
      const sx = Math.round((x - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      const sz = Math.round((z - ROAD_OFFSET) / BLOCK) * BLOCK + ROAD_OFFSET;
      if (Math.abs(x - sx) < Math.abs(z - sz)) { out.x = GU.clamp(sx, -bound, bound); out.z = GU.clamp(z, -bound, bound); out.dir = 0; }
      else { out.x = GU.clamp(x, -bound, bound); out.z = GU.clamp(sz, -bound, bound); out.dir = Math.PI / 2; }
      return out;
    },
    randomSpawn(rng, pad = 0.6, out) {
      const r = rng || Math.random;
      let x, z, tries = 0;
      do { x = (r() * 2 - 1) * (bound - 4); z = (r() * 2 - 1) * (bound - 4); tries++; }
      while (I.insideBuilding(x, z, pad) && tries < 50);
      if (out) { out.set(x, 0, z); return out; }
      return new THREE.Vector3(x, 0, z);
    },
    randomRoadSpawn(rng, out = {}) {
      const r = rng || Math.random;
      const k = Math.round((r() * 2 - 1) * (bound / BLOCK) - 0.5);   // street index (lines at k*24+12)
      const line = GU.clamp(k * BLOCK + ROAD_OFFSET, -bound, bound);
      const along = (r() * 2 - 1) * (bound - 6);
      if (r() < 0.5) { out.x = line; out.z = along; out.dir = 0; }
      else { out.x = along; out.z = line; out.dir = Math.PI / 2; }
      return out;
    },
    district: () => 'downtown',
    landmarks: () => (landmarks || (landmarks = buildLandmarks())),
    randomLandmark: (rng) => GU.pick(rng, (landmarks || (landmarks = buildLandmarks()))),
  };
  return {
    name: 'world', deps: [],
    aabbs: I.aabbs,
    api,
    init(c) { c.world = api; this.aabbs = I.aabbs; },
    update() {},
    reset() {},
  };
}

// ============================================================
// SHIM 2 — COMBAT/HEALTH: onfoot3d owns the pistol + firing; this shim only
// owns the PLAYER's health/armor and exposes the small combat api my economy /
// hud-radar / police expect (currentWeapon, damagePlayer, heal, addArmor...).
// ============================================================
function makeCombatShim() {
  const sys = {
    name: 'combat', deps: [],
    init(c) {
      const p = c.player;
      if (p.maxHealth == null) p.maxHealth = 100;
      if (p.health == null) p.health = p.maxHealth;
      if (p.armor == null) p.armor = 0;
      p.weapon = 'pistol';
      c.bus.on('damage', (e) => { if (e && e.target === 'player') this.api.damagePlayer(e.amount, e.source || e.kind, e.pos); });
    },
    update() {},
    reset(c) { const p = c.player; p.health = p.maxHealth; p.armor = 0; p.alive = true; },
    api: {
      currentWeapon() {
        const ammo = I && I.player ? I.player.ammo : 0;
        // onfoot3d's pistol reloads to full for free, so reserve is effectively
        // unlimited; the HUD needs a NUMBER (it coerces non-numbers to 0), so
        // report a comfortably large reserve rather than a glyph.
        return { id: 'pistol', name: 'PISTOL', clip: ammo, reserve: 240, melee: false };
      },
      damagePlayer(amount, src, pos) {
        const p = ctx.player;
        if (!p.alive) return;
        let dmg = Math.max(0, amount || 0);
        if (p.armor > 0) { const soak = Math.min(p.armor, dmg * 0.66); p.armor -= soak; dmg -= soak; }
        p.health = Math.max(0, p.health - dmg);
        ctx.bus.emit('playerHurt', { amount, health: p.health, armor: p.armor, source: src });
        if (p.health <= 0) { p.alive = false; ctx.bus.emit('playerWasted', { pos: pos || p.pos, cause: src || 'wasted' }); }
      },
      heal(n) { const p = ctx.player; p.health = Math.min(p.maxHealth, p.health + (n || 0)); },
      addArmor(n) { const p = ctx.player; p.armor = Math.min(100, p.armor + (n || 0)); },
      addAmmo(id, n) { if (I && I.player) I.player.ammo = Math.min(12, (I.player.ammo || 0) + (n || 0)); },
      giveWeapon() {}, select() {},
    },
  };
  return sys;
}

// ============================================================
// SHIM 3 — VEHICLES: onfoot3d owns driving; this shim exposes the small api
// missions/hud expect (count / nearestEnterable / spawnAt / playerVehicle).
// ============================================================
function makeVehiclesShim() {
  return {
    name: 'vehicles', deps: [],
    init() {}, update() {}, reset() {},
    api: {
      count: () => (I && I.vehicles ? I.vehicles.length : 0),
      playerVehicle: () => (I ? I.playerVehicle : null),
      nearestEnterable(pos) {
        if (!I || !I.vehicles) return null;
        let best = null, bd = Infinity;
        for (const v of I.vehicles) { if (v.occupied) continue; const d = Math.hypot(v.pos.x - pos.x, v.pos.z - pos.z); if (d < bd) { bd = d; best = v; } }
        return best;
      },
      spawnAt(x, z, opts) {
        if (!I || !I.spawnVehicle) return null;
        const heading = (opts && opts.heading) || 0;
        const color = (opts && opts.color) || 0x394150;
        try { return I.spawnVehicle(x, z, heading, color); } catch (e) { return null; }
      },
      forceExit() { try { if (I && I.mode === 'drive' && I.exitVehicle) I.exitVehicle(); } catch (e) {} },
    },
  };
}

// ============================================================
// CONTEXT — built from onfoot3d's internals at enter time
// ============================================================
function buildCtx() {
  const THREE = I.THREE;
  const player = {
    pos: I.player.pos,                 // shared Vector3 — both sides see the same position
    vel: new THREE.Vector3(),
    get vy() { return I.player.vy; }, set vy(v) { I.player.vy = v; },
    get grounded() { return I.player.grounded; },
    yaw: I.yaw, pitch: I.pitch, facing: I.player.facing,
    health: 100, maxHealth: 100, armor: 0, money: 0,
    inVehicle: false, vehicle: null,
    weapon: 'pistol',
    mesh: I.player.mesh,
    alive: true,
  };
  ctx = {
    THREE,
    get scene() { return I.scene; }, get camera() { return I.camera; }, get renderer() { return I.renderer; },
    player,
    input: {
      keys: I.keys,
      get pointerLocked() { return I.locked; },
      get mouseDown() { return false; },
      held: (c) => I.keys.has(c), pressed: () => false, consume: () => false,
      mouseJust: () => false, consumeMouse: () => false,
    },
    world: null,
    targets: [],
    time: { t: 0, dt: 0 },
    rng: GU.makeRng(0x6CED2A11),
    config: { difficulty: 0.9, pedDensity: 1, persist: true, mode: 'onfoot' },
  };
  return ctx;
}

// GTA.host shim — my reused systems read camera forward + recoil through this.
function wireHost() {
  GTA.host = {
    addRecoil() {},
    cameraDir(out) { const o = out || _scratchDir; if (I && I.camera) I.camera.getWorldDirection(o); return o; },
    yaw: () => (I ? I.yaw : 0), pitch: () => (I ? I.pitch : 0),
  };
}

// ============================================================
// ctx.targets — keep mirror blip entries for onfoot3d's peds + vehicles so they
// appear on the radar. Police pushes/splices its own 'cop' entries; we never
// touch those. Mirrors are created once (ped/vehicle arrays are stable) and just
// have their .pos/.dead refreshed each tick.
// ============================================================
function buildMirrors() {
  pedMirrors.length = 0; vehMirrors.length = 0;
  for (const p of (I.peds || [])) {
    const m = { pos: p.pos, height: 1.7, radius: 0.5, kind: 'ped', dead: false, _mirror: true, _src: p, onHit() {} };
    pedMirrors.push(m); ctx.targets.push(m);
  }
  for (const v of (I.vehicles || [])) {
    const m = { pos: v.pos, height: 1.4, radius: 1.4, kind: 'vehicle', dead: false, _mirror: true, _src: v, onHit() {} };
    vehMirrors.push(m); ctx.targets.push(m);
  }
}
function refreshMirrors() {
  // reconcile: cars spawned after boot (mission spawnAt -> I.spawnVehicle) grow I.vehicles
  // past the snapshot; append a mirror per new tail vehicle so it gets a radar blip.
  if (I && I.vehicles && vehMirrors.length < I.vehicles.length) {
    for (let i = vehMirrors.length; i < I.vehicles.length; i++) {
      const v = I.vehicles[i];
      const m = { pos: v.pos, height: 1.4, radius: 1.4, kind: 'vehicle', dead: false, _mirror: true, _src: v, onHit() {} };
      vehMirrors.push(m); ctx.targets.push(m);
    }
  }
  for (const m of pedMirrors) { m.pos = m._src.pos; m.dead = !!m._src.dead; }
  for (const m of vehMirrors) { m.pos = m._src.pos; }
}

// ============================================================
// CRIME / EVENT EMITTERS (the wanted-level feed)
// ============================================================
function emitCrime(kind, pos, severity) {
  GTA.bus.emit('crime', { kind, pos: pos || ctx.player.pos, severity: severity == null ? 1 : severity, source: 'player' });
}

// raycast onfoot3d's aim ray against police cops (kind:'cop') and damage the
// nearest one closer than the pedestrian their own fire() already hit.
function shootCops(pedDist) {
  if (!I.camera) return false;
  const origin = I.camera.position;
  if (!_aimDir) _aimDir = new I.THREE.Vector3();
  const dir = I.camera.getWorldDirection(_aimDir);
  let best = null, bestT = Math.min(pedDist == null ? 140 : pedDist, 140);
  const ax = origin.x, ay = origin.y, az = origin.z;
  for (const e of ctx.targets) {
    if (e.kind !== 'cop' || e.dead || !e.pos) continue;
    const cx = e.pos.x - ax, cy = (e.pos.y + (e.height || 1.6) * 0.6) - ay, cz = e.pos.z - az;
    const t = cx * dir.x + cy * dir.y + cz * dir.z;     // projection onto ray
    if (t < 0 || t > bestT) continue;
    const px = ax + dir.x * t, py = ay + dir.y * t, pz = az + dir.z * t;
    const d = Math.hypot(e.pos.x - px, (e.pos.y + (e.height || 1.6) * 0.6) - py, e.pos.z - pz);
    if (d < (e.radius || 1) + 0.4) { best = e; bestT = t; }
  }
  if (best) { try { best.onHit(34, 'player', best.pos); } catch (e) {} return true; }
  return false;
}

// ============================================================
// WASTED / BUSTED — respawn in the town; never leaves on-foot mode
// ============================================================
function wireOutcomes() {
  GTA.bus.on('playerWasted', () => respawn('wasted'));
  GTA.bus.on('playerBusted', () => respawn('busted'));
}
function respawn(cause) {
  try {
    if (I.mode === 'drive' && I.exitVehicle) I.exitVehicle();
    const lm = ctx.world ? ctx.world.randomLandmark(ctx.rng) : { pos: { x: 0, z: 8 } };
    I.player.pos.set(lm.pos.x, 0, lm.pos.z + 4);
    I.player.vy = 0;
    ctx.player.health = ctx.player.maxHealth; ctx.player.armor = 0; ctx.player.alive = true;
    if (cause === 'busted' && ctx.systems.economy) ctx.systems.economy.api.add(-Math.floor((ctx.player.money || 0) * 0.1), 'bail');
    GTA.bus.emit('toast', { html: cause === 'busted' ? '<b>BUSTED</b> — the cops haul you in. Wanted level cleared.' : '<b>WASTED</b> — you respawn in town.', ms: 4000 });
    _lastPx = _lastPy = _lastPz = null;                                    // avoid a teleport velocity spike
    GTA.bus.emit('playerRespawn', { pos: I.player.pos.clone(), cause });   // police clear, missions abort, stats
    GTA.reset(ctx);                                                        // authoritative full reset (incl. wanted)
  } catch (e) { console.error('[GTA bridge] respawn failed', e); }
}

// ============================================================
// FEEDBACK — screen-shake + hit-flash, DOM-only (never touches onfoot3d's camera)
// ============================================================
function wireFeedback() {
  GTA.bus.on('shake', (p) => { _shakeMag = Math.min(1.4, _shakeMag + ((p && p.amount) || 0)); });
  GTA.bus.on('playerHurt', () => {
    ensureFlash();
    if (!_flashEl) return;
    _flashEl.style.transition = 'none'; _flashEl.style.opacity = '0.42';
    requestAnimationFrame(() => { if (_flashEl) { _flashEl.style.transition = 'opacity .5s ease-out'; _flashEl.style.opacity = '0'; } });
  });
}
function ensureFlash() {
  if (_flashEl) return;
  const frame = document.getElementById('frame') || document.body;
  _flashEl = document.createElement('div');
  _flashEl.id = 'gta-hitflash';
  _flashEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:21;opacity:0;background:radial-gradient(circle at 50% 60%, rgba(190,20,20,0) 38%, rgba(190,20,20,0.6) 100%);';
  frame.appendChild(_flashEl);
}
function applyShake(dt) {
  if (_shakeMag <= 0 || !I || !I.canvas) return;
  _shakeMag = Math.max(0, _shakeMag - dt * 4);
  if (_shakeMag === 0) { I.canvas.style.transform = ''; return; }
  const k = _shakeMag * 5;
  const ox = (ctx.rng() * 2 - 1) * k, oy = (ctx.rng() * 2 - 1) * k;
  I.canvas.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px)`;
}

// ============================================================
// HOOKS — assigned onto window.ONFOOT; onfoot3d calls them when present
// ============================================================
function onEnter() {
  try {
    const OF = window.ONFOOT;
    I = OF && OF.internals;
    if (!I || !I.scene) { console.warn('[GTA bridge] ONFOOT.internals not ready'); return; }
    if (!booted) {
      buildCtx();
      wireHost();
      if (!GTA.systems.world) GTA.register(makeWorldShim());      // idempotent: a failed-then-retried
      if (!GTA.systems.combat) GTA.register(makeCombatShim());    // boot must not re-register/re-subscribe
      if (!GTA.systems.vehicles) GTA.register(makeVehiclesShim());
      wireOutcomes();
      wireFeedback();
      GTA.boot(ctx, { mode: 'onfoot' });
      booted = true;             // record success right after boot, BEFORE buildMirrors can throw
      buildMirrors();
    } else {
      // re-entry: clear transient state, keep money
      _lastPx = _lastPy = _lastPz = null;
      ctx.player.health = ctx.player.maxHealth; ctx.player.armor = 0; ctx.player.alive = true;
      GTA.reset(ctx);
    }
    active = true;
    document.getElementById('gta-hud')?.classList.remove('hidden');
    document.body.classList.add('gta-active');   // CSS hides the legacy #foot-stats-foot for the whole session
    GTA.bus.emit('toast', { html: 'The city has rules now. <b>Shoot</b> to draw heat — the stars climb and the cops come. Lose them, or get Wasted.', ms: 7000 });
  } catch (e) { console.error('[GTA bridge] onEnter failed; base on-foot mode unaffected', e); }
}

function onExit() {
  try {
    active = false;
    document.getElementById('gta-hud')?.classList.add('hidden');
    document.body.classList.remove('gta-active');
    if (I && I.canvas) I.canvas.style.transform = '';
    if (_flashEl) _flashEl.style.opacity = '0';
    _shakeMag = 0;
  } catch (e) { console.error('[GTA bridge] onExit failed', e); }
}

function onTick(dt) {
  if (!active || !booted) return;
  try {
    // sync player look + body facing from onfoot3d (car heading while driving)
    const driving = I.mode === 'drive' && I.playerVehicle;
    ctx.player.yaw = driving ? I.playerVehicle.heading : I.yaw;
    ctx.player.pitch = I.pitch;
    ctx.player.facing = I.player.facing;
    ctx.player.inVehicle = !!driving;
    ctx.player.vehicle = driving ? I.playerVehicle : null;
    // derive player velocity from the host's position delta — the host integrates
    // pos directly and exposes no velocity, but police's arrest 'stillness' gate
    // (and ram knockback) read ctx.player.vel. pos IS the shared ref, so snapshot.
    const pp = I.player.pos;
    if (_lastPx !== null && dt > 0) {
      let vx = (pp.x - _lastPx) / dt, vz = (pp.z - _lastPz) / dt;
      if (Math.hypot(vx, vz) > 40) { vx = 0; vz = 0; }   // reject teleport spikes (respawn/exit-car)
      ctx.player.vel.set(vx, 0, vz);
    } else ctx.player.vel.set(0, 0, 0);
    _lastPx = pp.x; _lastPy = pp.y; _lastPz = pp.z;
    refreshMirrors();
    GTA.tick(dt, ctx);
    applyShake(dt);
  } catch (e) { console.error('[GTA bridge] onTick failed', e); }
}

function onFire(pedDist) {
  if (!active) return false;
  // returns true if a cop closer than the pedestrian claimed the shot (so the host
  // skips its own ped kill — one bullet, one target).
  try { emitCrime('gunfire', ctx.player.pos, 0.6); return shootCops(pedDist) === true; } catch (e) { return false; }
}

function onKill(ped) {
  if (!active || !ped) return;
  try {
    GTA.bus.emit('entityKilled', { entity: ped, kind: 'ped', pos: ped.pos, byPlayer: true });
    emitCrime('assault', ped.pos, 1);
    if (GU.chance(ctx.rng, 0.45)) GTA.bus.emit('spawnPickup', { kind: 'cash', value: 20 + Math.floor(ctx.rng() * 60), pos: { x: ped.pos.x, y: 0, z: ped.pos.z } });
  } catch (e) {}
}

function onJack(v) {
  if (!active) return;
  // stealing an empty parked car is a minor offence — a flicker of heat, not a manhunt
  try { GTA.bus.emit('vehicle:jacked', { vehicle: v }); emitCrime('propertyDamage', v && v.pos, 0.3); } catch (e) {}
}

// ============================================================
// INSTALL hooks onto window.ONFOOT (it may load before or after us)
// ============================================================
function install() {
  const OF = window.ONFOOT;
  if (!OF) return false;
  OF.onEnter = onEnter; OF.onExit = onExit; OF.onTick = onTick;
  OF.onFire = onFire; OF.onKill = onKill; OF.onJack = onJack;
  // if onfoot mode is already active (e.g. #gta auto-enter fired first), boot now
  if (OF.active && !booted) onEnter();
  return true;
}
if (!install()) {
  // onfoot3d.js not parsed yet — retry on next frames until ONFOOT exists
  let tries = 0;
  const iv = setInterval(() => { if (install() || ++tries > 120) clearInterval(iv); }, 16);
}

export default { onEnter, onExit, onTick };
