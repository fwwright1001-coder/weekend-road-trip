// ============================================================
// gta/boot.js — STANDALONE host harness for the crime-sandbox layer
// ------------------------------------------------------------
// This file is what makes the gta/ folder runnable on its own in Chrome. It
// stands in for everything onfoot3d.js provides when the layer is bolted onto
// the real game:
//   * builds a Three.js scene/renderer/camera + a player avatar
//   * owns the input system (keys, pointer-lock look, per-frame "just pressed")
//   * runs the on-foot character controller (WASD + jump + collision)
//   * drives the frame loop and calls GTA.tick(dt, ctx)
//   * owns the chase camera (third-person on foot; behind-car when driving)
//   * handles the WASTED / BUSTED → respawn sequence
//
// On INTEGRATION (see INTEGRATION.md) this file is NOT shipped. Instead a thin
// ~40-line adapter inside onfoot3d.js builds the same `ctx`, reuses onfoot3d's
// player + input + camera, and calls GTA.boot/GTA.tick. The systems don't know
// or care which host they run under — they only see `ctx`.
// ============================================================
import * as THREE from 'three';
import { GTA, GU } from './core.js';

// Import every system so it self-registers. Order here = init/update order
// (world first; HUD last so it reads finalised state).
import './world.js';
import './economy.js';
import './wanted.js';
import './peds.js';
import './vehicles.js';
import './combat.js';
import './police.js';
import './missions.js';
import './hud-radar.js';

// ---- tunables --------------------------------------------------------------
const WALK = 4.6, RUN = 8.0, GRAV = 24, JUMP_V = 8.6;
const PLAYER_R = 0.45, EYE = 1.55;
const CAM_DIST = 5.8, CAM_DIST_CAR = 9.5;
const MOUSE_SENS = 0.0022, PITCH_MIN = -0.95, PITCH_MAX = 0.55;

// ============================================================
// INPUT SYSTEM
// ============================================================
const input = {
  keys: new Set(),
  pointerLocked: false,
  mouseDown: false,
  _just: new Set(),         // codes pressed this frame
  _mouseJust: new Set(),    // mouse buttons pressed this frame
  pressed(code) { return this._just.has(code); },
  consume(code) { const h = this._just.has(code); this._just.delete(code); return h; },
  mouseJust(btn = 0) { return this._mouseJust.has(btn); },
  consumeMouse(btn = 0) { const h = this._mouseJust.has(btn); this._mouseJust.delete(btn); return h; },
  held(code) { return this.keys.has(code); },
  endFrame() { this._just.clear(); this._mouseJust.clear(); },
};

let canvas, renderer, scene, camera;
let yaw = Math.PI, pitch = -0.12;
let recoil = 0;

const player = {
  pos: new THREE.Vector3(BlockCenterX(), 0, 14),
  vel: new THREE.Vector3(),
  vy: 0,
  grounded: true,
  yaw, pitch, facing: Math.PI,
  health: 100, maxHealth: 100, armor: 0, money: 0,
  inVehicle: false, vehicle: null,
  weapon: null,
  mesh: null,
  alive: true,
};

function BlockCenterX() { return 0; }

// ============================================================
// PLAYER AVATAR (demo stand-in; onfoot3d owns this on integration)
// ============================================================
function buildPerson(colors, armed) {
  const g = new THREE.Group();
  const mk = (geo, col) => {
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 }));
    m.castShadow = true; m.receiveShadow = true; return m;
  };
  const legL = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), colors.pants); legL.position.set(-0.16, 0.4, 0);
  const legR = mk(new THREE.BoxGeometry(0.26, 0.8, 0.28), colors.pants); legR.position.set(0.16, 0.4, 0);
  const torso = mk(new THREE.BoxGeometry(0.62, 0.72, 0.36), colors.shirt); torso.position.set(0, 1.16, 0);
  const armL = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), colors.shirt); armL.position.set(-0.42, 1.18, 0);
  const armR = mk(new THREE.BoxGeometry(0.18, 0.66, 0.2), colors.shirt); armR.position.set(0.42, 1.18, 0);
  const head = mk(new THREE.BoxGeometry(0.34, 0.36, 0.34), colors.skin); head.position.set(0, 1.72, 0);
  const cap = mk(new THREE.BoxGeometry(0.36, 0.14, 0.36), colors.hair); cap.position.set(0, 1.94, 0);
  g.add(legL, legR, torso, armL, armR, head, cap);
  g.userData.armL = armL; g.userData.armR = armR; g.userData.legL = legL; g.userData.legR = legR;
  if (armed) {
    armR.position.set(0.42, 1.34, 0.18); armR.rotation.x = -1.35;
    const muzzle = new THREE.Object3D(); muzzle.position.set(0.42, 1.32, 0.72); g.add(muzzle);
    g.userData.muzzle = muzzle;
  }
  return g;
}

// ============================================================
// SCENE SETUP
// ============================================================
function setup() {
  canvas = document.getElementById('gta-canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9fb8cf');
  scene.fog = new THREE.Fog('#9fb8cf', 90, 360);

  // sky dome
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { topColor: { value: new THREE.Color('#6f9fd0') }, horizonColor: { value: new THREE.Color('#cfe0ee') }, exponent: { value: 1.1 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vDir; uniform vec3 topColor; uniform vec3 horizonColor; uniform float exponent; void main(){ float t = pow(clamp(vDir.y,0.0,1.0), exponent); gl_FragColor = vec4(mix(horizonColor, topColor, t),1.0); }',
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1400, 32, 16), skyMat));

  scene.add(new THREE.HemisphereLight(0xffffff, 0x44484f, 0.85));
  const sun = new THREE.DirectionalLight(0xfff0cf, 1.7);
  sun.position.set(-60, 90, 40); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 320;
  sun.shadow.camera.left = -120; sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120; sun.shadow.camera.bottom = -120;
  sun.shadow.bias = -0.0004;
  scene.add(sun, sun.target);

  camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 2000);

  player.mesh = buildPerson({ skin: 0xd9a679, shirt: 0x2f6f8f, pants: 0x2b2b33, hair: 0x3a2a1a }, true);
  scene.add(player.mesh);

  resize();
  window.addEventListener('resize', resize);
}

// ============================================================
// THE CONTEXT — handed to every system
// ============================================================
let ctx;
function buildCtx() {
  ctx = {
    THREE, scene, camera, renderer,
    player, input,
    world: null,                  // world.api, filled by world.init
    // shared hittable registry: any system pushes its damageable entities here;
    // combat raycasts against it. Entry shape (see SPEC / combat.js):
    //   { pos:Vector3, height, radius, kind:'ped'|'cop'|'vehicle', dead?, onHit(dmg,srcKind,pos) }
    targets: [],
    time: { t: 0, dt: 0 },
    rng: GU.makeRng(0x1234ABCD),
    config: { difficulty: 1, pedDensity: 1, persist: true, mode: 'standalone' },
  };
  return ctx;
}

// ============================================================
// ON-FOOT CHARACTER CONTROLLER (skipped while driving)
// ============================================================
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _v = new THREE.Vector3();
function updateOnFoot(dt) {
  _fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
  _right.set(-Math.cos(yaw), 0, Math.sin(yaw));
  const speed = (input.held('ShiftLeft') || input.held('ShiftRight')) ? RUN : WALK;
  let mx = 0, mz = 0;
  if (input.held('KeyW') || input.held('ArrowUp')) { mx += _fwd.x; mz += _fwd.z; }
  if (input.held('KeyS') || input.held('ArrowDown')) { mx -= _fwd.x; mz -= _fwd.z; }
  if (input.held('KeyA') || input.held('ArrowLeft')) { mx -= _right.x; mz -= _right.z; }
  if (input.held('KeyD') || input.held('ArrowRight')) { mx += _right.x; mz += _right.z; }
  const ml = Math.hypot(mx, mz), moving = ml > 0.001;
  if (moving) { mx /= ml; mz /= ml; player.pos.x += mx * speed * dt; player.pos.z += mz * speed * dt; }

  player.vy -= GRAV * dt;
  player.pos.y += player.vy * dt;
  if (player.pos.y <= 0) { player.pos.y = 0; player.vy = 0; player.grounded = true; }

  if (ctx.world) ctx.world.resolve(player.pos, PLAYER_R);

  const targetFacing = (input.pointerLocked || !moving) ? yaw : Math.atan2(mx, mz);
  player.facing = GU.lerpAngle(player.facing, targetFacing, 0.25);
  player.mesh.visible = true;
  player.mesh.position.copy(player.pos);
  player.mesh.rotation.y = player.facing;
  animateWalk(player.mesh, moving, dt, speed);
}

function animateWalk(mesh, moving, dt, sp) {
  const u = mesh.userData;
  if (!u.legL) return;
  u.phase = (u.phase || 0) + (moving ? sp * dt * 1.9 : 0);
  const s = moving ? Math.sin(u.phase) * 0.5 : 0;
  u.legL.rotation.x = s; u.legR.rotation.x = -s;
  if (u.armL && !u.muzzle) { u.armL.rotation.x = -s; u.armR.rotation.x = s; }
}

// ============================================================
// CAMERA — third-person orbit on foot; pulled-back chase when driving
// ============================================================
const _dir = new THREE.Vector3();
function updateCamera(dt) {
  player.yaw = yaw; player.pitch = pitch;
  const cz = Math.cos(pitch);
  _dir.set(Math.sin(yaw) * cz, Math.sin(pitch), Math.cos(yaw) * cz);
  const dist = player.inVehicle ? CAM_DIST_CAR : CAM_DIST;
  const eyeY = player.inVehicle ? 2.2 : EYE;
  const head = _v.copy(player.pos).setY(eyeY);
  camera.position.copy(head).addScaledVector(_dir, -dist);
  camera.position.y += 0.5 + recoil * 2;
  if (camera.position.y < 0.6) camera.position.y = 0.6;
  camera.lookAt(head.x + _dir.x, head.y + _dir.y + recoil, head.z + _dir.z);
  recoil = Math.max(0, recoil - dt * 0.6);
}

// expose recoil + camera dir so the combat system can kick the camera / aim
GTA.host = {
  addRecoil(a) { recoil += a; },
  cameraDir(out) { return camera.getWorldDirection(out); },
  yaw: () => yaw, pitch: () => pitch,
};

// ============================================================
// FRAME LOOP
// ============================================================
let lastT = 0, running = false;
function loop(time) {
  if (!running) return;
  const dt = Math.min(0.05, (time - lastT) / 1000 || 0);
  lastT = time;
  try {
    if (player.alive && !player.inVehicle) updateOnFoot(dt);
    GTA.tick(dt, ctx);          // all systems (vehicles moves player when driving)
    updateCamera(dt);
    renderer.render(scene, camera);
  } catch (e) {
    console.error('[GTA boot] frame failed', e);
  }
  input.endFrame();
  requestAnimationFrame(loop);
}

// ============================================================
// WASTED / BUSTED → RESPAWN
// ============================================================
function wireRespawn() {
  const handle = (cause) => {
    player.alive = false;
    showBigMessage(cause === 'busted' ? 'BUSTED' : 'WASTED', cause === 'busted' ? '#f5d76e' : '#d83a3a');
    setTimeout(() => respawn(cause), 2600);
  };
  GTA.bus.on('playerWasted', () => handle('wasted'));
  GTA.bus.on('playerBusted', () => handle('busted'));
}
function respawn(cause) {
  hideBigMessage();
  // drop the player at a hospital/police-ish landmark
  const lm = ctx.world ? ctx.world.randomLandmark(ctx.rng) : { pos: { x: 0, z: 14 } };
  if (player.inVehicle && ctx.systems.vehicles) ctx.systems.vehicles.api.forceExit();
  player.pos.set(lm.pos.x, 0, lm.pos.z + 6);
  player.vy = 0; player.grounded = true;
  player.health = player.maxHealth;
  player.armor = 0;                      // respawn always strips armor
  if (cause === 'busted' && ctx.systems.economy) ctx.systems.economy.api.add(-Math.floor(player.money * 0.1), 'bail');
  player.alive = true;
  GTA.bus.emit('playerRespawn', { pos: player.pos.clone(), cause });
  GTA.reset(ctx);
}

function showBigMessage(text, color) {
  let el = document.getElementById('gta-bigmsg');
  if (!el) { el = document.createElement('div'); el.id = 'gta-bigmsg'; document.getElementById('gta-frame').appendChild(el); }
  el.textContent = text; el.style.color = color; el.classList.add('show');
}
function hideBigMessage() {
  const el = document.getElementById('gta-bigmsg');
  if (el) el.classList.remove('show');
}

// ============================================================
// INPUT LISTENERS
// ============================================================
function wireInput() {
  window.addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (!input.keys.has(e.code)) input._just.add(e.code);
    input.keys.add(e.code);
    if (e.code === 'Space' && player.grounded && !player.inVehicle) { player.vy = JUMP_V; player.grounded = false; }
  });
  window.addEventListener('keyup', (e) => input.keys.delete(e.code));
  canvas.addEventListener('mousedown', (e) => {
    if (!input.pointerLocked) { canvas.requestPointerLock(); return; }
    input.mouseDown = e.button === 0 ? true : input.mouseDown;
    input._mouseJust.add(e.button);
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) input.mouseDown = false; });
  window.addEventListener('mousemove', (e) => {
    if (!input.pointerLocked) return;
    yaw -= e.movementX * MOUSE_SENS;
    pitch = GU.clamp(pitch - e.movementY * MOUSE_SENS, PITCH_MIN, PITCH_MAX);
  });
  document.addEventListener('pointerlockchange', () => { input.pointerLocked = document.pointerLockElement === canvas; });
}

// ============================================================
// BOOT
// ============================================================
function start() {
  setup();
  buildCtx();
  wireInput();
  wireRespawn();
  // camera shake requests (gunfire, explosions, collisions) map to a small kick
  GTA.bus.on('shake', (p = {}) => GTA.host.addRecoil(Math.min(0.12, (p.amount || 1) * 0.03)));
  GTA.boot(ctx, { mode: 'standalone' });
  // starter loadout
  if (ctx.systems.combat) ctx.systems.combat.api.giveWeapon('pistol', true);
  if (ctx.systems.economy) ctx.systems.economy.api.add(500, 'starting cash');
  GTA.bus.emit('toast', { html: 'Welcome to the sandbox. <b>Click</b> to look · <b>WASD</b> move · <b>F</b> enter cars · <b>Click</b> shoot · <b>Tab</b> weapons · <b>1-5</b> request stars (debug)', ms: 9000 });
  running = true; lastT = 0;
  requestAnimationFrame(loop);
}

function resize() {
  if (!renderer) return;
  const frame = document.getElementById('gta-frame');
  const w = frame.clientWidth, h = frame.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();

export { player, input, ctx };
