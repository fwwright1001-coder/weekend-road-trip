// ============================================================
// gta/tools/onfoot-smoke.mjs — headless alpha test of the GTA systems bridge.
// Stubs onfoot3d's internals (window.ONFOOT.internals) + the DOM + a renderer,
// uses REAL three.js for scene/Vector3 math, imports the real bridge, then
// boots + ticks ~240 frames while firing, killing peds, and taking damage.
// Any console.error or thrown frame fails the run.
//   npm install   (once)   &&   node gta/tools/onfoot-smoke.mjs
// ============================================================
const errors = [];
const realErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); realErr('  [captured]', ...a); };

const noop = () => {};
function ctx2d() {
  return new Proxy({}, { get(t, p) {
    if (p === 'canvas') return { width: 220, height: 220 };
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: noop });
    if (p === 'measureText') return () => ({ width: 8 });
    if (p in t) return t[p];
    return typeof p === 'string' ? noop : undefined;
  }, set(t, p, v) { t[p] = v; return true; } });
}
function styleProxy() { return new Proxy({}, { get: (t, p) => (p === 'setProperty' || p === 'removeProperty') ? noop : t[p], set: (t, p, v) => { t[p] = v; return true; } }); }
function fakeEl(id) {
  const ch = [];
  return { id, width: 220, height: 220, clientWidth: 960, clientHeight: 540, textContent: '', innerHTML: '', style: styleProxy(), children: ch,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
    appendChild(c) { ch.push(c); return c; }, removeChild(c) { const i = ch.indexOf(c); if (i >= 0) ch.splice(i, 1); return c; },
    setAttribute: noop, getContext: () => ctx2d(), getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), addEventListener: noop, querySelector: () => null, querySelectorAll: () => [] };
}
const elCache = new Map();
globalThis.window = globalThis;
globalThis.document = { readyState: 'complete', pointerLockElement: null, body: fakeEl('body'),
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, fakeEl(id)); return elCache.get(id); },
  createElement: (t) => fakeEl('c-' + t), addEventListener: noop, exitPointerLock: noop, querySelector: () => null };
globalThis.localStorage = (() => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = () => 0; globalThis.cancelAnimationFrame = noop;
globalThis.addEventListener = noop; globalThis.devicePixelRatio = 1; globalThis.AudioContext = function () { return new Proxy({}, { get: () => noop }); };

const THREE = await import('three');

// ---- stub onfoot3d internals ----
const aabbs = [];
for (let gx = -2; gx <= 2; gx++) for (let gz = -2; gz <= 2; gz++) {
  if (gx === 0 && gz === 0) continue;
  const cx = gx * 24, cz = gz * 24;
  aabbs.push({ minX: cx - 5, maxX: cx + 5, minZ: cz - 5, maxZ: cz + 5 });
}
const BOUND = 58;
function insideBuilding(x, z, pad) { for (const a of aabbs) if (x > a.minX - pad && x < a.maxX + pad && z > a.minZ - pad && z < a.maxZ + pad) return a; return null; }
function resolveCollision(pos, pad) {
  for (const a of aabbs) if (pos.x > a.minX - pad && pos.x < a.maxX + pad && pos.z > a.minZ - pad && pos.z < a.maxZ + pad) {
    const dl = pos.x - (a.minX - pad), dr = (a.maxX + pad) - pos.x, db = pos.z - (a.minZ - pad), df = (a.maxZ + pad) - pos.z;
    const m = Math.min(dl, dr, db, df);
    if (m === dl) pos.x = a.minX - pad; else if (m === dr) pos.x = a.maxX + pad; else if (m === db) pos.z = a.minZ - pad; else pos.z = a.maxZ + pad;
  }
  pos.x = Math.max(-BOUND, Math.min(BOUND, pos.x)); pos.z = Math.max(-BOUND, Math.min(BOUND, pos.z));
}
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 1200);
camera.position.set(2.4, 1.6, 12); camera.lookAt(2.4, 1, -20);
const peds = [];
for (let i = 0; i < 16; i++) peds.push({ pos: new THREE.Vector3((Math.random() * 2 - 1) * 40, 0, (Math.random() * 2 - 1) * 40), dead: false, mats: [], mesh: new THREE.Group(), state: 'wander' });
const vehicles = [];
for (let i = 0; i < 6; i++) vehicles.push({ pos: new THREE.Vector3((Math.random() * 2 - 1) * 30, 0, (Math.random() * 2 - 1) * 30), heading: 0, speed: 0, occupied: false, mesh: new THREE.Group(), wheels: [], steerPivots: [] });
let playerVehicleRef = null;

const internals = {
  THREE, scene, camera, renderer: { render: noop, setSize: noop, setPixelRatio: noop, shadowMap: {}, domElement: fakeEl('gamefoot') }, canvas: fakeEl('gamefoot'),
  player: { pos: new THREE.Vector3(2.4, 0, 6), vy: 0, grounded: true, mesh: new THREE.Group(), muzzle: new THREE.Object3D(), ammo: 12, facing: 0 },
  keys: new Set(), yaw: Math.PI, pitch: -0.1, locked: true, mode: 'foot', playerVehicle: null, bound: BOUND,
  peds, vehicles, aabbs, resolveCollision, insideBuilding,
  spawnVehicle: (x, z, h, c) => { const v = { pos: new THREE.Vector3(x, 0, z), heading: h, speed: 0, occupied: false, mesh: new THREE.Group(), wheels: [], steerPivots: [] }; vehicles.push(v); return v; },
  nearestVehicle: (d) => { let b = null, bd = d; for (const v of vehicles) { if (v.occupied) continue; const dist = Math.hypot(v.pos.x - internals.player.pos.x, v.pos.z - internals.player.pos.z); if (dist < bd) { bd = dist; b = v; } } return b; },
  enterVehicle: (v) => { internals.mode = 'drive'; internals.playerVehicle = v; v.occupied = true; if (window.ONFOOT.onJack) window.ONFOOT.onJack(v); },
  exitVehicle: () => { internals.mode = 'foot'; if (internals.playerVehicle) internals.playerVehicle.occupied = false; internals.playerVehicle = null; },
};
window.ONFOOT = { active: true, ready: true, unlocked: () => true, enter: noop, exit: noop, internals };

// ---- import the real bridge + core (installs hooks, boots on import since active) ----
const { GTA } = await import('../core.js');
await import('../onfoot-bridge.js');

const OF = window.ONFOOT;
const peak = { stars: 0, cops: 0, minHealth: 100, copKills: 0, wasted: false, money0: 0 };
GTA.bus.on('entityKilled', (e) => { if (e && e.kind === 'cop') peak.copKills++; });
GTA.bus.on('playerWasted', () => { peak.wasted = true; });

let threw = null;
try {
  const S = GTA.systems;
  for (let n = 0; n < 240; n++) {
    // fire every 5 frames (raises heat, raycasts cops)
    if (n % 5 === 0 && OF.onFire) OF.onFire(140);
    // kill a civilian occasionally
    if (n % 30 === 14) { const live = peds.find(p => !p.dead); if (live) { live.dead = true; if (OF.onKill) OF.onKill(live); } }
    if (OF.onTick) OF.onTick(1 / 60);
    if (S.wanted) peak.stars = Math.max(peak.stars, S.wanted.api.stars());
    if (S.police) peak.cops = Math.max(peak.cops, S.police.api.copCount());
    peak.minHealth = Math.min(peak.minHealth, GTA.ctx.player.health);
  }
  peak.money0 = GTA.ctx.player.money;
  // force a Wasted and confirm respawn doesn't throw
  GTA.bus.emit('damage', { target: 'player', amount: 999, kind: 'bullet', pos: GTA.ctx.player.pos, source: 'cop' });
  for (let n = 0; n < 20; n++) { if (OF.onTick) OF.onTick(1 / 60); }
  // carjack + drive a few frames + exit
  internals.enterVehicle(vehicles[0]);
  for (let n = 0; n < 15; n++) { if (OF.onTick) OF.onTick(1 / 60); }
  internals.exitVehicle();
  for (let n = 0; n < 10; n++) { if (OF.onTick) OF.onTick(1 / 60); }
  // re-enter path
  if (OF.onExit) OF.onExit();
  if (OF.onEnter) OF.onEnter();
  for (let n = 0; n < 10; n++) { if (OF.onTick) OF.onTick(1 / 60); }
} catch (e) { threw = e; }

const S = GTA.systems;
const snap = {
  systems: Object.keys(GTA.systems),
  peak,
  finalHealth: GTA.ctx ? GTA.ctx.player.health : '?',
  alive: GTA.ctx ? GTA.ctx.player.alive : '?',
  money: GTA.ctx ? GTA.ctx.player.money : '?',
  copCountNow: S.police ? S.police.api.copCount() : '?',
  targets: GTA.ctx ? GTA.ctx.targets.length : '?',
  copTargets: GTA.ctx ? GTA.ctx.targets.filter(t => t.kind === 'cop').length : '?',
  pedMirrors: GTA.ctx ? GTA.ctx.targets.filter(t => t._mirror && t.kind === 'ped').length : '?',
};
console.log('\n===== ONFOOT SYSTEMS SMOKE =====');
console.log(JSON.stringify(snap, null, 2));
if (threw) console.log('\nFATAL THROW:\n', threw && threw.stack || threw);
if (errors.length) { console.log('\nCAPTURED console.error (' + errors.length + '):'); for (const e of errors.slice(0, 30)) console.log('  - ' + e); }
const ok = !threw && errors.length === 0;
console.log('\n' + (ok ? 'PASS ✅' : 'FAIL ❌') + '  (peak ' + peak.stars + '★, ' + peak.cops + ' cops, minHP ' + peak.minHealth + ', copKills ' + peak.copKills + ', wasted=' + peak.wasted + ')');
process.exit(ok ? 0 : 1);
