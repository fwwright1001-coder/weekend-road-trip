// ============================================================
// gta/peds.js — ambient civilian pedestrians
// ------------------------------------------------------------
// Populates the city with ~ (16 * pedDensity) original low-poly civilians that
// stroll the sidewalks/streets, pause, and — crucially — REACT to violence:
// gunfire, kills, and a high wanted level make them flee or scatter in panic.
// Each civilian is a hittable target combat.js can shoot; downing one drops a
// body, raises heat, and (sometimes) a cash pickup. Population self-heals: a
// downed/despawned civ is replaced elsewhere so the city always feels alive.
//
// Pure decoupled system: builds its own meshes into ctx.scene, talks to the rest
// of the layer only through GTA.bus + ctx.systems.*.api, and guards every cross-
// system call (load order varies, hosts differ). All art generated in code.
//
// Coordinate convention: right-handed, Y up. Peds move on XZ, feet at Y=0.
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
const BASE_COUNT = 16;          // scaled by ctx.config.pedDensity
const HARD_CAP = 64;            // absolute ceiling regardless of density
const PED_RADIUS = 0.5;         // hittable radius (registry)
const PED_HEIGHT = 1.7;         // hittable height (registry)
const PED_HEALTH = 30;          // civilians are fragile

const WALK_SPEED = 1.5;         // strolling
const FLEE_SPEED = 4.8;         // running from a threat
const PANIC_SPEED = 5.6;        // scatter at high wanted
const ARRIVE_DIST = 1.4;        // how close before picking a new target
const SPACING = 1.1;            // soft separation between peds

const FLEE_RADIUS = 22;         // crime/kill scares peds within this range
const AIM_FLEE_RADIUS = 8;      // player aiming a gun this close scares peds
const FLEE_TIME = 5.5;          // seconds a scared ped keeps fleeing
const PANIC_TIME = 7.0;         // seconds peds keep scattering at high wanted
const IDLE_CHANCE = 0.25;       // odds of pausing when a wander target is reached
const IDLE_MIN = 1.2, IDLE_MAX = 3.5;

const RESPAWN_DELAY = 4.0;      // seconds before a downed/lost civ is replaced
const SPAWN_FAR = 26;           // don't respawn a civ right on top of the player
const DESPAWN_FAR = 200;        // recycle civs that somehow get very far away
const FADE_TIME = 2.2;          // body fade-out duration after death (then despawn)

// ---- palettes (original, varied) -------------------------------------------
const SKIN_COLS = [0xf1c9a5, 0xe0ac84, 0xc68642, 0x8d5524, 0xffdbac, 0xa56b46];
const SHIRT_COLS = [0x3b6ea5, 0xb5523a, 0x4f8a4f, 0xb89b3a, 0x6a4f8a, 0x4a4f57,
  0xc06aa0, 0x2f8f8f, 0xcf7a3a, 0x7a7f86];
const PANTS_COLS = [0x2b2b33, 0x394150, 0x4a3b2a, 0x5a5a5a, 0x2f3a2f, 0x3a2f3a];
const HAIR_COLS = [0x2a1a0e, 0x4a2f1a, 0x5a5a5a, 0x111111, 0x7a5a2a, 0x8a8a8a, 0x6a3a1a];

// ---- module-scope scratch (NO per-frame allocation) ------------------------
let _V0 = null, _V1 = null;   // THREE.Vector3, lazily made in init
const _tmpRoad = { x: 0, z: 0, dir: 0 };

// ---- state -----------------------------------------------------------------
let pedsList = [];              // active ped records
let respawnQueue = [];          // { t } countdown entries; length = pending civs
let group = null;              // parent THREE.Group for all ped meshes
let rng = null;                // sub-stream RNG (deterministic)
let unsubs = [];               // bus unsubscribers
let panicTimer = 0;            // global panic clock (high wanted)

// ============================================================
// MESH FACTORY — original low-poly "person", same rig the host animates
// (userData.legL/legR/armL/armR + a walk phase). Built once per pool slot;
// recolored on (re)spawn so we never allocate geometry per civilian.
// ============================================================
function buildPerson(THREE) {
  const g = new THREE.Group();
  const mk = (geo, col) => {
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  };
  // geometries are unique per part so transparency/fade is per-mesh
  const legL = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), 0x2b2b33); legL.position.set(-0.16, 0.4, 0);
  const legR = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), 0x2b2b33); legR.position.set(0.16, 0.4, 0);
  const torso = mk(new THREE.BoxGeometry(0.62, 0.72, 0.36), 0x3b6ea5); torso.position.set(0, 1.16, 0);
  const armL = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), 0x3b6ea5); armL.position.set(-0.42, 1.18, 0);
  const armR = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), 0x3b6ea5); armR.position.set(0.42, 1.18, 0);
  const head = mk(new THREE.BoxGeometry(0.34, 0.36, 0.34), 0xf1c9a5); head.position.set(0, 1.72, 0);
  const hair = mk(new THREE.BoxGeometry(0.36, 0.14, 0.36), 0x2a1a0e); hair.position.set(0, 1.94, 0);
  g.add(legL, legR, torso, armL, armR, head, hair);
  g.userData.legL = legL; g.userData.legR = legR;
  g.userData.armL = armL; g.userData.armR = armR;
  // pivot the limbs from the top (shoulder/hip) so rotation swings the free end
  for (const part of [legL, legR]) part.geometry.translate(0, -0.4, 0);
  legL.position.y = 0.8; legR.position.y = 0.8;
  for (const part of [armL, armR]) part.geometry.translate(0, 0.33, 0);
  armL.position.y = 1.51; armR.position.y = 1.51;
  const mats = { skin: head.material, shirt: torso.material, pants: legL.material, hair: hair.material };
  // share shirt material across torso+arms, pants across both legs, for recolor
  armL.material = torso.material; armR.material = torso.material;
  legR.material = legL.material;
  g.userData._mats = [head.material, torso.material, legL.material, hair.material];
  g.userData._parts = [legL, legR, torso, armL, armR, head, hair];
  g.userData.matMap = mats;
  return g;
}

// recolor + reset a pooled mesh for a fresh civilian
function dressPerson(p) {
  const m = p.mesh, mm = m.userData.matMap;
  mm.skin.color.setHex(GU.pick(rng, SKIN_COLS));
  mm.shirt.color.setHex(GU.pick(rng, SHIRT_COLS));
  mm.pants.color.setHex(GU.pick(rng, PANTS_COLS));
  mm.hair.color.setHex(GU.pick(rng, HAIR_COLS));
  for (const mat of m.userData._mats) { mat.transparent = false; mat.opacity = 1; mat.needsUpdate = true; }
  const u = m.userData;
  u.legL.rotation.set(0, 0, 0); u.legR.rotation.set(0, 0, 0);
  u.armL.rotation.set(0, 0, 0); u.armR.rotation.set(0, 0, 0);
  m.rotation.set(0, 0, 0);
  m.visible = true;
}

// the host's walk anim, adapted: swing legs + arms by a phase
function animateWalk(p, moving, dt, sp) {
  const u = p.mesh.userData;
  p.walkPhase = (p.walkPhase || 0) + (moving ? sp * dt * 2.2 : 0);
  const s = moving ? Math.sin(p.walkPhase) * 0.55 : 0;
  if (u.legL) { u.legL.rotation.x = s; u.legR.rotation.x = -s; }
  if (u.armL) { u.armL.rotation.x = -s; u.armR.rotation.x = s; }
}

// ============================================================
// SPAWN / DESPAWN
// ============================================================
function worldApi(ctx) { return ctx.systems && ctx.systems.world && ctx.systems.world.api ? ctx.systems.world.api : (ctx.world || null); }

function pickWanderPoint(ctx, near, out) {
  const w = worldApi(ctx);
  if (w && w.randomSpawn) {
    try { return w.randomSpawn(rng, 0.7, out); } catch (e) { /* fall through */ }
  }
  // fallback: random point in a reasonable box
  const b = (w && w.bound) || 110;
  out.set(GU.rand(rng, -b + 4, b - 4), 0, GU.rand(rng, -b + 4, b - 4));
  return out;
}

function spawnPoint(ctx, out) {
  const w = worldApi(ctx);
  const player = ctx.player;
  for (let tries = 0; tries < 12; tries++) {
    pickWanderPoint(ctx, null, out);
    if (!player || GU.dist2D(out.x, out.z, player.pos.x, player.pos.z) > SPAWN_FAR) return out;
  }
  return out; // give up after several tries — better a near spawn than none
}

function createPed(ctx) {
  if (pedsList.length >= HARD_CAP) return null;
  const THREE = ctx.THREE;
  const mesh = buildPerson(THREE);
  GTA.shadowize(mesh, true, true);
  group.add(mesh);

  const p = {
    mesh,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    target: new THREE.Vector3(),
    state: 'wander',
    t: 0,                 // generic state timer
    fleeT: 0,             // remaining flee time
    dead: false,
    health: PED_HEALTH,
    walkPhase: rng() * Math.PI * 2,
    fadeT: 0,             // death fade countdown
    facing: 0,
    entry: null,          // its ctx.targets entry
    speedJitter: GU.rand(rng, 0.85, 1.18),
  };

  spawnPoint(ctx, p.pos);
  p.mesh.position.copy(p.pos);
  pickWanderPoint(ctx, null, p.target);
  dressPerson(p);

  // hittable registry entry — combat.js raycasts against this
  const entry = {
    pos: p.pos,                 // shared reference; updated as ped moves
    height: PED_HEIGHT,
    radius: PED_RADIUS,
    kind: 'ped',
    dead: false,
    onHit: (amount, srcKind, hitPos) => hurtPed(ctx, p, amount, srcKind, hitPos),
  };
  p.entry = entry;
  if (ctx.targets && ctx.targets.push) ctx.targets.push(entry);

  pedsList.push(p);
  return p;
}

function removePedEntry(ctx, p) {
  if (!p.entry) return;
  const arr = ctx.targets;
  if (arr && arr.indexOf) {
    const i = arr.indexOf(p.entry);
    if (i >= 0) arr.splice(i, 1);
  }
  p.entry = null;
}

// fully recycle a ped record (mesh back to pool-ish hidden, entry removed)
function despawnPed(ctx, p, queueReplacement) {
  removePedEntry(ctx, p);
  if (p.mesh) p.mesh.visible = false;
  const i = pedsList.indexOf(p);
  if (i >= 0) pedsList.splice(i, 1);
  // keep the mesh in the scene graph but hidden; we rebuild a fresh ped on
  // respawn (cheap enough at this scale and avoids a parallel free-list bug).
  if (p.mesh && group) { try { group.remove(p.mesh); disposePed(p); } catch (e) { /* ignore */ } }
  if (queueReplacement) respawnQueue.push({ t: RESPAWN_DELAY });
}

function disposePed(p) {
  const u = p.mesh && p.mesh.userData;
  if (!u || !u._parts) return;
  for (const part of u._parts) {
    if (part.geometry && part.geometry.dispose) part.geometry.dispose();
  }
  if (u._mats) for (const m of u._mats) { if (m && m.dispose) m.dispose(); }
}

// ============================================================
// DAMAGE / DEATH
// ============================================================
function hurtPed(ctx, p, amount, srcKind, hitPos) {
  if (p.dead) return;
  p.health -= (amount || 0);
  // any attack scares this ped and nearby ones
  scareNear(ctx, p.pos, FLEE_RADIUS * 0.6);
  if (p.fleeT < FLEE_TIME) { p.fleeT = FLEE_TIME; p.state = 'flee'; }

  if (p.health <= 0) killPed(ctx, p, srcKind, hitPos);
}

function killPed(ctx, p, srcKind, hitPos) {
  if (p.dead) return;
  p.dead = true;
  p.state = 'dead';
  p.fadeT = FADE_TIME;
  if (p.entry) p.entry.dead = true;
  const byPlayer = srcKind === 'player';

  // tip-over: lay the body flat (animated over fadeT in update)
  p.mesh.userData._fallDir = GU.rand(rng, -1, 1) < 0 ? -1 : 1;
  // make all materials fade-capable
  const u = p.mesh.userData;
  if (u._mats) for (const m of u._mats) { m.transparent = true; m.needsUpdate = true; }

  // events: a downed civ is a killing + an assault crime; gunfire already raised
  // heat, but a corpse adds to it.
  try {
    ctx.bus.emit('entityKilled', { entity: p, kind: 'ped', pos: p.pos.clone(), byPlayer });
  } catch (e) { /* ignore */ }
  try {
    ctx.bus.emit('crime', { kind: 'assault', pos: p.pos.clone(), severity: 2, source: byPlayer ? 'player' : srcKind });
  } catch (e) { /* ignore */ }

  // chance of a cash drop the player can collect
  if (GU.chance(rng, 0.4)) {
    try {
      ctx.bus.emit('spawnPickup', { kind: 'cash', value: 20 + (rng() * 60 | 0), pos: p.pos.clone() });
    } catch (e) { /* ignore */ }
  }

  // a fresh civ will arrive shortly to keep the city populated
  // (the dead body lingers/fades then despawns in update)
}

// ============================================================
// THREAT / REACTION HELPERS
// ============================================================
function scareNear(ctx, pos, radius) {
  const r2 = radius;
  for (let i = 0; i < pedsList.length; i++) {
    const p = pedsList[i];
    if (p.dead) continue;
    if (GU.dist2D(p.pos.x, p.pos.z, pos.x, pos.z) <= r2) {
      p.fleeT = FLEE_TIME;
      if (p.state !== 'panic') p.state = 'flee';
    }
  }
}

function startPanic(ctx, secs) {
  panicTimer = Math.max(panicTimer, secs);
  for (let i = 0; i < pedsList.length; i++) {
    const p = pedsList[i];
    if (p.dead) continue;
    p.state = 'panic';
    p.fleeT = Math.max(p.fleeT, secs);
  }
}

// flee/panic move direction: away from the player (or threat), with a little
// perpendicular jitter so crowds don't collapse into one line.
function fleeDirection(ctx, p, out) {
  const player = ctx.player;
  const tx = player ? player.pos.x : 0;
  const tz = player ? player.pos.z : 0;
  let dx = p.pos.x - tx, dz = p.pos.z - tz;
  const d = Math.hypot(dx, dz) || 1;
  dx /= d; dz /= d;
  // perpendicular wobble keyed on the ped's phase
  const wob = Math.sin(p.walkPhase * 0.7) * 0.4;
  out.set(dx - dz * wob, 0, dz + dx * wob);
  const l = Math.hypot(out.x, out.z) || 1;
  out.x /= l; out.z /= l;
  return out;
}

// soft separation so peds don't perfectly overlap
function applySeparation(p, ax) {
  for (let i = 0; i < pedsList.length; i++) {
    const o = pedsList[i];
    if (o === p || o.dead) continue;
    const dx = p.pos.x - o.pos.x, dz = p.pos.z - o.pos.z;
    const d = dx * dx + dz * dz;
    if (d > 0.0001 && d < SPACING * SPACING) {
      const inv = 1 / Math.sqrt(d);
      ax.x += dx * inv * 0.5; ax.z += dz * inv * 0.5;
    }
  }
}

// is the player aiming a (non-melee) gun near this ped?
function playerAimingNear(ctx, p) {
  const player = ctx.player;
  if (!player || player.inVehicle) return false;
  const wid = player.weapon;
  if (!wid || wid === 'fists') return false;
  // only react when the player is actually close (you "see" the muzzle)
  return GU.dist2D(p.pos.x, p.pos.z, player.pos.x, player.pos.z) <= AIM_FLEE_RADIUS;
}

// ============================================================
// PER-PED UPDATE
// ============================================================
function updatePed(ctx, p, dt) {
  const w = worldApi(ctx);

  // ---- dead bodies: tip over, fade, then despawn (queues a replacement) ----
  if (p.dead) {
    p.fadeT -= dt;
    const k = 1 - GU.clamp(p.fadeT / FADE_TIME, 0, 1);   // 0..1 progress
    // tip over in the first ~40% of fade
    const fall = GU.clamp(k / 0.4, 0, 1) * (Math.PI / 2);
    p.mesh.rotation.z = fall * (p.mesh.userData._fallDir || 1);
    p.mesh.position.copy(p.pos);
    p.mesh.position.y = 0; // body stays on the ground
    // fade in the last ~50%
    const op = 1 - GU.clamp((k - 0.5) / 0.5, 0, 1);
    const u = p.mesh.userData;
    if (u._mats) for (const m of u._mats) m.opacity = op;
    if (p.fadeT <= 0) despawnPed(ctx, p, true);
    return;
  }

  // ---- recycle strays very far from the player ----
  const player = ctx.player;
  if (player && GU.dist2D(p.pos.x, p.pos.z, player.pos.x, player.pos.z) > DESPAWN_FAR) {
    despawnPed(ctx, p, true);
    return;
  }

  // ---- state transitions ----
  if (p.fleeT > 0) p.fleeT -= dt;

  if (panicTimer > 0) {
    if (p.state !== 'panic') p.state = 'panic';
  } else if (p.state === 'panic') {
    p.state = p.fleeT > 0 ? 'flee' : 'wander';
  }

  if (p.state === 'flee' && p.fleeT <= 0) p.state = 'wander';

  // aiming a gun nearby triggers fresh fear
  if (p.state !== 'panic' && playerAimingNear(ctx, p)) {
    p.state = 'flee';
    if (p.fleeT < 2.5) p.fleeT = 2.5;
  }

  // ---- choose a movement vector by state ----
  let speed = 0, moving = false;
  const dir = _V0, sep = _V1;
  dir.set(0, 0, 0); sep.set(0, 0, 0);

  if (p.state === 'idle') {
    p.t -= dt;
    if (p.t <= 0) { p.state = 'wander'; pickWanderPoint(ctx, p.pos, p.target); }
    moving = false;
  } else if (p.state === 'flee' || p.state === 'panic') {
    fleeDirection(ctx, p, dir);
    speed = (p.state === 'panic' ? PANIC_SPEED : FLEE_SPEED) * p.speedJitter;
    moving = true;
    // panic: occasionally re-roll a far destination so they don't beeline a wall
    p.t -= dt;
    if (p.t <= 0) { p.t = GU.rand(rng, 0.6, 1.4); }
  } else {
    // wander: steer toward target
    const dx = p.target.x - p.pos.x, dz = p.target.z - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < ARRIVE_DIST) {
      if (GU.chance(rng, IDLE_CHANCE)) { p.state = 'idle'; p.t = GU.rand(rng, IDLE_MIN, IDLE_MAX); }
      else pickWanderPoint(ctx, p.pos, p.target);
      moving = false;
    } else {
      dir.set(dx / d, 0, dz / d);
      speed = WALK_SPEED * p.speedJitter;
      moving = true;
    }
  }

  // ---- integrate motion ----
  if (moving) {
    applySeparation(p, sep);
    let vx = dir.x * speed + sep.x;
    let vz = dir.z * speed + sep.z;
    p.pos.x += vx * dt;
    p.pos.z += vz * dt;
    // face travel direction
    if (Math.abs(vx) + Math.abs(vz) > 0.0001) {
      const want = Math.atan2(vx, vz);
      p.facing = GU.lerpAngle(p.facing, want, 1 - Math.exp(-10 * dt));
    }
  }

  // ---- collide with the world (push out of buildings, clamp to bounds) ----
  if (w && w.resolve) {
    try { w.resolve(p.pos, 0.45); } catch (e) { /* ignore */ }
  } else {
    const b = (w && w.bound) || 118;
    p.pos.x = GU.clamp(p.pos.x, -b, b);
    p.pos.z = GU.clamp(p.pos.z, -b, b);
  }

  // ---- if a fleeing ped got pinned against a wall, re-pick an escape lane ----
  if ((p.state === 'flee' || p.state === 'panic') && moving) {
    // small chance to snap toward a road so crowds spill into the streets
    if (w && w.nearestRoad && GU.chance(rng, 0.01)) {
      try { w.nearestRoad(p.pos.x, p.pos.z, _tmpRoad); } catch (e) { /* ignore */ }
    }
  }

  // ---- apply transform + walk animation ----
  p.mesh.position.copy(p.pos);
  p.mesh.position.y = 0;
  p.mesh.rotation.y = p.facing;
  animateWalk(p, moving, dt, speed);
}

// ============================================================
// POPULATION MAINTENANCE
// ============================================================
function targetCount(ctx) {
  const dens = (ctx.config && ctx.config.pedDensity != null) ? ctx.config.pedDensity : 1;
  return GU.clamp(Math.round(BASE_COUNT * dens), 0, HARD_CAP);
}

function livingCount() {
  let n = 0;
  for (let i = 0; i < pedsList.length; i++) if (!pedsList[i].dead) n++;
  return n;
}

function maintainPopulation(ctx, dt) {
  // tick down respawn timers; each that fires spawns one fresh civ
  if (respawnQueue.length) {
    for (let i = respawnQueue.length - 1; i >= 0; i--) {
      respawnQueue[i].t -= dt;
      if (respawnQueue[i].t <= 0) {
        respawnQueue.splice(i, 1);
        if (livingCount() < targetCount(ctx)) createPed(ctx);
      }
    }
  }
  // top up if we're somehow under target with no pending queue (e.g. density up)
  const want = targetCount(ctx);
  const have = livingCount();
  if (have < want && respawnQueue.length < (want - have)) {
    // stagger a couple per call so a density change doesn't pop a crowd at once
    const deficit = want - have - respawnQueue.length;
    const add = Math.min(deficit, 2);
    for (let i = 0; i < add; i++) respawnQueue.push({ t: GU.rand(rng, 0.2, RESPAWN_DELAY) });
  }
}

// ============================================================
// THE SYSTEM OBJECT
// ============================================================
const sys = {
  name: 'peds',
  deps: ['world'],

  init(ctx) {
    const THREE = ctx.THREE;
    if (!THREE) return;

    // lazily allocate module scratch now that THREE exists
    if (!_V0) { _V0 = new THREE.Vector3(); _V1 = new THREE.Vector3(); }

    rng = GU.makeRng(0x9E3779B1 ^ ((ctx.config && ctx.config.pedDensity ? Math.round(ctx.config.pedDensity * 1000) : 1000)));

    // build (or reuse) the parent group
    if (!group) {
      group = new THREE.Group();
      group.name = 'gta-peds';
      if (ctx.scene) ctx.scene.add(group);
    }

    // clear any prior state (re-init safety)
    for (const p of pedsList.slice()) despawnPed(ctx, p, false);
    pedsList = [];
    respawnQueue = [];
    panicTimer = 0;

    // seed the initial crowd
    const n = targetCount(ctx);
    for (let i = 0; i < n; i++) createPed(ctx);

    // ---- bus subscriptions (store unsubs so reset/re-init can detach) ----
    for (const off of unsubs) { try { off(); } catch (e) { /* ignore */ } }
    unsubs = [];

    unsubs.push(ctx.bus.on('crime', (e) => {
      if (!e || !e.pos) return;
      if (e.kind === 'gunfire' || e.kind === 'assault' || e.kind === 'copKilled' ||
          e.kind === 'copAssault' || e.kind === 'propertyDamage') {
        scareNear(ctx, e.pos, FLEE_RADIUS);
      }
    }));

    unsubs.push(ctx.bus.on('entityKilled', (e) => {
      if (!e || !e.pos) return;
      // a death anywhere scares nearby witnesses (don't double-count the victim)
      scareNear(ctx, e.pos, FLEE_RADIUS);
    }));

    unsubs.push(ctx.bus.on('wanted:changed', (e) => {
      if (!e) return;
      const stars = e.level != null ? e.level : 0;
      if (stars >= 3) {
        startPanic(ctx, PANIC_TIME);
      } else {
        // wanted dropped below the panic threshold — end citywide panic now so
        // peds stop scattering in step with the HUD (no ~7s decay tail).
        panicTimer = 0;
      }
    }));

    // gunfire-as-shake is unrelated; we only care about the catalogued crimes
  },

  update(dt, ctx) {
    if (!group) return;
    // clamp dt defensively (host already clamps, but be safe)
    const d = dt > 0 ? (dt < 0.1 ? dt : 0.1) : 0;

    // global panic clock: keep refreshed while wanted stays high
    if (panicTimer > 0) {
      panicTimer -= d;
      const wantedApi = ctx.systems && ctx.systems.wanted && ctx.systems.wanted.api;
      if (wantedApi && wantedApi.stars) {
        try { if (wantedApi.stars() >= 3) panicTimer = Math.max(panicTimer, 1.0); }
        catch (e) { /* ignore */ }
      }
      if (panicTimer < 0) panicTimer = 0;
    }

    // update every ped (iterate over a stable snapshot length; despawns splice)
    for (let i = pedsList.length - 1; i >= 0; i--) {
      const p = pedsList[i];
      if (!p) continue;
      updatePed(ctx, p, d);
    }

    maintainPopulation(ctx, d);
  },

  reset(ctx) {
    // respawn / re-enter: clear fear states and re-scatter survivors WITHOUT
    // rebuilding meshes. Dead bodies are cleared so the player respawns into a
    // calm, populated city.
    panicTimer = 0;
    for (let i = pedsList.length - 1; i >= 0; i--) {
      const p = pedsList[i];
      if (p.dead) { despawnPed(ctx, p, true); continue; }
      p.state = 'wander';
      p.fleeT = 0;
      p.t = 0;
      // re-home survivors to a fresh walkable point near where they are
      pickWanderPoint(ctx, p.pos, p.target);
      p.mesh.rotation.z = 0;
      const u = p.mesh.userData;
      if (u._mats) for (const m of u._mats) { m.transparent = false; m.opacity = 1; m.needsUpdate = true; }
    }
    // ensure population is at target (queue any deficit)
    const want = targetCount(ctx);
    let have = livingCount();
    while (have + respawnQueue.length < want) { respawnQueue.push({ t: GU.rand(rng, 0.2, RESPAWN_DELAY) }); have++; }
  },

  // ============================================================
  // PUBLIC API
  // ============================================================
  api: {
    // number of living civilians
    count() { return livingCount(); },
    // spawn n fresh civilians immediately (clamped to the hard cap)
    spawn(n) {
      const ctx = GTA.ctx;
      if (!ctx || !group) return 0;
      let made = 0;
      const k = Math.max(0, n | 0);
      for (let i = 0; i < k; i++) {
        if (pedsList.length >= HARD_CAP) break;
        if (createPed(ctx)) made++;
      }
      return made;
    },
  },
};

GTA.register(sys);
export default sys;
