// ============================================================
// tools/headless-smoke.mjs — run the whole gameplay layer headless in Node
// ------------------------------------------------------------
// Stubs the browser (DOM, canvas 2D ctx, localStorage, audio, RAF) and the
// WebGL renderer, but uses the REAL Three.js for scene/camera/Vector3 math.
// Then boots every system and ticks ~240 frames while simulating input
// (move, shoot, raise heat so police spawn, drive a car, start a mission).
// Any console.error from a system, or any thrown frame, fails the run.
//
//   npm install   (once)
//   npm run smoke
// ============================================================

// ---------- capture errors ----------
const errors = [];
const origErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); origErr('  [captured]', ...a); };
const warns = [];
const origWarn = console.warn;
console.warn = (...a) => { warns.push(a.map(String).join(' ')); };

// ---------- browser stubs (set BEFORE importing modules) ----------
function noop() {}
function ctx2d() {
  return new Proxy({}, {
    get(t, p) {
      if (p === 'canvas') return { width: 220, height: 220 };
      if (p === 'createLinearGradient' || p === 'createRadialGradient' || p === 'createPattern')
        return () => ({ addColorStop: noop });
      if (p === 'measureText') return () => ({ width: 8 });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (p in t) return t[p];
      return typeof p === 'string' ? noop : undefined;
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
function fakeStyle() {
  return new Proxy({}, { get: (t, p) => (p === 'setProperty' || p === 'removeProperty') ? noop : t[p], set: (t, p, v) => { t[p] = v; return true; } });
}
function fakeEl(id) {
  const children = [];
  const el = {
    id, tagName: 'DIV', width: 220, height: 220, clientWidth: 960, clientHeight: 540,
    textContent: '', innerHTML: '', value: '',
    style: fakeStyle(), dataset: {}, children,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, toggle(c, f) { const on = f === undefined ? !this._s.has(c) : f; on ? this._s.add(c) : this._s.delete(c); return on; }, contains(c) { return this._s.has(c); } },
    appendChild(c) { children.push(c); return c; }, removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
    setAttribute: noop, removeAttribute: noop, getAttribute: () => null,
    addEventListener: noop, removeEventListener: noop,
    getContext: () => ctx2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540, right: 960, bottom: 540 }),
    querySelector: () => null, querySelectorAll: () => [],
    requestPointerLock: noop,
    focus: noop, remove: noop,
  };
  return el;
}
const elCache = new Map();
const documentStub = {
  readyState: 'complete', pointerLockElement: null, body: fakeEl('body'),
  getElementById: (id) => { if (!elCache.has(id)) elCache.set(id, fakeEl(id)); return elCache.get(id); },
  querySelector: () => null, querySelectorAll: () => [],
  createElement: (t) => fakeEl('created-' + t), createElementNS: () => fakeEl('svg'),
  addEventListener: noop, removeEventListener: noop, exitPointerLock: noop,
};
const localStorageStub = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; })();
const audioStub = () => new Proxy({ currentTime: 0, sampleRate: 44100, destination: {} }, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'createBuffer') return () => ({ getChannelData: () => new Float32Array(1024) });
    if (p === 'createBufferSource') return () => ({ buffer: null, connect: () => ({ connect: noop }), start: noop, stop: noop });
    if (p === 'createGain') return () => ({ gain: { setValueAtTime: noop, exponentialRampToValueAtTime: noop, linearRampToValueAtTime: noop }, connect: () => ({ connect: noop }) });
    if (p === 'createOscillator') return () => ({ type: '', frequency: { setValueAtTime: noop, exponentialRampToValueAtTime: noop }, connect: () => ({ connect: noop }), start: noop, stop: noop });
    return noop;
  },
});

globalThis.window = globalThis;
globalThis.document = documentStub;
globalThis.localStorage = localStorageStub;
globalThis.performance = globalThis.performance || { now: () => 0 };
globalThis.requestAnimationFrame = (fn) => 0;
globalThis.cancelAnimationFrame = noop;
globalThis.addEventListener = noop;
globalThis.removeEventListener = noop;
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 960; globalThis.innerHeight = 540;
globalThis.AudioContext = audioStub; globalThis.webkitAudioContext = audioStub;
globalThis.MutationObserver = class { observe() {} disconnect() {} };

// ---------- import THREE + the systems ----------
const THREE = await import('three');
const { GTA, GU } = await import('../gta/core.js');
// order matters (world first; hud last) — same as boot.js
await import('../gta/world.js');
await import('../gta/economy.js');
await import('../gta/wanted.js');
await import('../gta/peds.js');
await import('../gta/vehicles.js');
await import('../gta/combat.js');
await import('../gta/police.js');
await import('../gta/missions.js');
await import('../gta/hud-radar.js');

// ---------- build a headless ctx ----------
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 2000);
camera.position.set(0, 2, 14); camera.lookAt(0, 1.4, 0);
const renderer = { render: noop, setSize: noop, setPixelRatio: noop, outputColorSpace: '', shadowMap: { enabled: false, type: 0 }, domElement: fakeEl('canvas') };

const keys = new Set();
let pointerLocked = true;
const justK = new Set(), justM = new Set();
const input = {
  keys, get pointerLocked() { return pointerLocked; }, mouseDown: false,
  held: (c) => keys.has(c), pressed: (c) => justK.has(c),
  consume: (c) => { const h = justK.has(c); justK.delete(c); return h; },
  mouseJust: (b = 0) => justM.has(b), consumeMouse: (b = 0) => { const h = justM.has(b); justM.delete(b); return h; },
};

let recoil = 0;
GTA.host = {
  addRecoil: (a) => { recoil += a; },
  cameraDir: (out) => camera.getWorldDirection(out || new THREE.Vector3()),
  yaw: () => 0, pitch: () => 0,
};

const ctx = {
  THREE, scene, camera, renderer, input,
  player: {
    pos: new THREE.Vector3(0, 0, 14), vel: new THREE.Vector3(), vy: 0, grounded: true,
    yaw: 0, pitch: 0, facing: 0, health: 100, maxHealth: 100, armor: 0, money: 0,
    inVehicle: false, vehicle: null, weapon: 'pistol', mesh: new THREE.Group(), alive: true,
  },
  world: null, targets: [], time: { t: 0, dt: 0 }, rng: GU.makeRng(0xC0FFEE),
  config: { difficulty: 1, pedDensity: 1, persist: true, mode: 'standalone' },
};
ctx.player.mesh.userData.muzzle = new THREE.Object3D();
ctx.player.mesh.add(ctx.player.mesh.userData.muzzle);

// ---------- boot ----------
const registered = Object.keys(GTA.systems);
GTA.boot(ctx, { mode: 'standalone' });
if (ctx.systems.combat) ctx.systems.combat.api.giveWeapon('pistol', true);
if (ctx.systems.economy) ctx.systems.economy.api.add(500, 'start');

// helpers to simulate one frame of input
function frame(n) {
  justK.clear(); justM.clear();
  // walk forward most frames
  keys.add('KeyW');
  // shoot every 6 frames
  if (n % 6 === 0) { input.mouseDown = true; justM.add(0); } else input.mouseDown = false;
  // raise heat early so police spawn; push to ~4 stars
  if (n === 10 || n === 14 || n === 18 || n === 22 || n === 26 || n === 30) ctx.systems.wanted && ctx.systems.wanted.api.add('assault');
  // try to enter a car around frame 60 (press F)
  if (n === 60) {
    const v = ctx.systems.vehicles && ctx.systems.vehicles.api.count() ? ctx.systems.vehicles.api : null;
    if (ctx.systems.vehicles) {
      const veh = ctx.systems.vehicles.api.nearestEnterable(ctx.player.pos);
      if (veh && veh.pos) ctx.player.pos.copy(veh.pos);   // teleport next to a car
    }
    justK.add('KeyF');
  }
  if (n === 64) keys.add('KeyW');     // drive forward
  if (n === 120) justK.add('KeyF');   // exit car
  // start a mission mid-run
  if (n === 130 && ctx.systems.missions) {
    const ids = ['repo', 'sweep', 'courier'];
    for (const id of ids) { try { ctx.systems.missions.api.start(id); break; } catch (e) {} }
  }
  // reload + weapon switches
  if (n === 40) justK.add('KeyR');
  if (n === 70) justK.add('Digit2');
  if (n === 80) justK.add('Tab');
}

const FRAMES = 240, DT = 1 / 60;
let threw = null;
const peak = { stars: 0, cops: 0, minHealth: 100, jacked: false, missionStarted: false, drove: false, entityKills: 0 };
GTA.bus.on('vehicle:jacked', () => { peak.jacked = true; });
GTA.bus.on('mission:start', () => { peak.missionStarted = true; });
GTA.bus.on('entityKilled', () => { peak.entityKills++; });
try {
  for (let n = 0; n < FRAMES; n++) {
    frame(n);
    GTA.tick(DT, ctx);
    recoil = Math.max(0, recoil - DT * 0.6);
    if (ctx.systems.wanted) peak.stars = Math.max(peak.stars, ctx.systems.wanted.api.stars());
    if (ctx.systems.police) peak.cops = Math.max(peak.cops, ctx.systems.police.api.copCount());
    peak.minHealth = Math.min(peak.minHealth, ctx.player.health);
    if (ctx.player.inVehicle) peak.drove = true;
  }
  // --- explicit carjack + drive + exit check (the core mechanic) ---
  if (ctx.systems.vehicles) {
    keys.clear();
    ctx.player.pos.set(0, 0, 8);                                    // back to downtown
    const va = ctx.systems.vehicles.api;
    const veh = (va.spawnAt && va.spawnAt(2, 8)) || va.nearestEnterable(ctx.player.pos);
    peak.spawnAtOk = !!(veh && veh.pos);
    if (veh && veh.pos) {
      ctx.player.pos.copy(veh.pos);
      for (let k = 0; k < 4 && !ctx.player.inVehicle; k++) { justK.clear(); justM.clear(); keys.delete('KeyW'); justK.add('KeyF'); GTA.tick(DT, ctx); }
      peak.enteredCar = ctx.player.inVehicle;
      if (ctx.player.inVehicle) {
        const before = ctx.player.pos.clone();
        keys.add('KeyW');
        for (let k = 0; k < 30; k++) { justK.clear(); GTA.tick(DT, ctx); }
        peak.droveDist = +ctx.player.pos.distanceTo(before).toFixed(2);
        keys.delete('KeyW'); justK.clear(); justK.add('KeyF'); GTA.tick(DT, ctx);
        peak.exitedCar = !ctx.player.inVehicle;
      }
    }
  }
  // exercise mission start via the spawnAt path (repo)
  if (ctx.systems.missions) { try { ctx.systems.missions.api.start('repo'); peak.repoStarted = ctx.systems.missions.api.active(); ctx.systems.missions.api.abort(); } catch (e) {} }

  // exercise reset/respawn
  GTA.bus.emit('playerRespawn', { pos: ctx.player.pos.clone(), cause: 'wasted' });
  GTA.reset(ctx);
  for (let n = 0; n < 30; n++) { frame(1000 + n); GTA.tick(DT, ctx); }
} catch (e) { threw = e; }

// ---------- report ----------
const S = ctx.systems;
const snap = {
  registered,
  systemsBooted: registered.length,
  stars: S.wanted ? S.wanted.api.stars() : 'n/a',
  heat: S.wanted ? +S.wanted.api.heat().toFixed(2) : 'n/a',
  money: ctx.player.money,
  pedCount: S.peds ? S.peds.api.count() : 'n/a',
  copCount: S.police ? S.police.api.copCount() : 'n/a',
  vehicleCount: S.vehicles ? S.vehicles.api.count() : 'n/a',
  targets: ctx.targets.length,
  playerHealth: ctx.player.health,
  inVehicle: ctx.player.inVehicle,
  missionActive: S.missions ? S.missions.api.active() : 'n/a',
  sceneChildren: scene.children.length,
  peak,
};
console.log('\n===== HEADLESS SMOKE RESULT =====');
console.log(JSON.stringify(snap, null, 2));
console.log('warnings:', warns.length);
if (threw) { console.log('\nFATAL THROW:\n', threw && threw.stack || threw); }
if (errors.length) { console.log('\nCAPTURED console.error (' + errors.length + '):'); for (const e of errors.slice(0, 40)) console.log('  - ' + e); }
const ok = !threw && errors.length === 0;
console.log('\n' + (ok ? 'PASS ✅  no throws, no system errors across ' + FRAMES + ' frames' : 'FAIL ❌  see above'));
process.exit(ok ? 0 : 1);
