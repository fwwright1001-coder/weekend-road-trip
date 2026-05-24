/*
 * Indy 500 — Weekend Road Trip
 * Three.js 3D racing build. ENGR 5513, Lipscomb MSAI, Summer 2026.
 *
 * Phases of the build (matches task list 3D-1 → 3D-6):
 *   1) Scaffold: Three.js scene + HTML overlay state machine (this file)
 *   2) Speedway scene: oval track, grandstands, infield
 *   3) IndyCar model + chase camera
 *   4) Driving physics + lap detection
 *   5) HUD wiring
 *   6) Visual polish
 */

import * as THREE from 'three';

// ============================================================
// CONFIG
// ============================================================
const STORAGE_KEY = 'wrt.highscores.v1';
const MAX_SCORES = 5;
const LAPS_TO_WIN = 5;
const FUEL_MAX = 100;

const SCREEN = {
  TITLE: 'title',
  PLAYING: 'playing',
  PAUSED: 'paused',
  GAMEOVER: 'gameover',
  WIN: 'win',
  INITIALS: 'initials',
  SCORES: 'scores',
  HELP: 'help'
};

// ============================================================
// STATE
// ============================================================
const state = {
  screen: SCREEN.TITLE,
  prevScreen: SCREEN.TITLE,
  keys: new Set(),
  // gameplay state — populated when a run starts
  lap: 1,
  lapStartTime: 0,
  lastLapTime: 0,
  bestLapTime: Infinity,
  score: 0,
  fuel: FUEL_MAX,
  speed: 0,
  // initials entry
  initials: ['A', 'A', 'A'],
  initialsIdx: 0,
  pendingScore: 0,
  // scores
  scores: [],
  // animation
  clock: null
};

// ============================================================
// STORAGE
// ============================================================
function loadScores() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.slice(0, MAX_SCORES) : [];
  } catch (e) {
    return [];
  }
}

function saveScores(scores) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores.slice(0, MAX_SCORES)));
  } catch (e) {
    // localStorage unavailable — skip
  }
}

function qualifies(score) {
  if (state.scores.length < MAX_SCORES) return true;
  return score > state.scores[state.scores.length - 1].score;
}

function insertScore(initials, score) {
  state.scores.push({
    initials: initials.join(''),
    score: Math.floor(score),
    date: new Date().toISOString().slice(0, 10)
  });
  state.scores.sort((a, b) => b.score - a.score);
  state.scores = state.scores.slice(0, MAX_SCORES);
  saveScores(state.scores);
}

// ============================================================
// THREE.JS SCENE
// ============================================================
const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x88b8d8);
scene.fog = new THREE.Fog(0xa8c4d4, 200, 800);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 2000);
// Establishing shot: broadcast-style — west end of front straight, slightly inside
// the track, elevated, looking east down the straight toward turn 1.
// Chase cam takes over in 3D-3.
camera.position.set(-160, 26, 70);
camera.lookAt(120, 6, 105);

// Lights
const ambient = new THREE.HemisphereLight(0xffffff, 0x445566, 0.6);
scene.add(ambient);

const sun = new THREE.DirectionalLight(0xfff4dc, 1.3);
sun.position.set(80, 140, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -200;
sun.shadow.camera.right = 200;
sun.shadow.camera.top = 200;
sun.shadow.camera.bottom = -200;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 500;
scene.add(sun);

// ============================================================
// SPEEDWAY GEOMETRY (3D-2)
// ============================================================
// Scaled-down Indianapolis Motor Speedway oval.
// Coordinates: XZ plane is the ground, Y is up.
// Race direction is counter-clockwise viewed from above (standard for IMS).

const TRACK = {
  STRAIGHT_HALF: 200,   // half-length of straights (so each straight is 400 long)
  TURN_RADIUS: 120,     // outer turn radius
  WIDTH: 14,            // track surface width
  WALL_HEIGHT: 1.4,     // SAFER barrier height
  PIT_OFFSET: 18        // pit lane offset from front straight inner edge
};
const OUTER_R = TRACK.TURN_RADIUS;
const INNER_R = TRACK.TURN_RADIUS - TRACK.WIDTH;

// Helper — append a stadium-shaped path to a Shape/Path.
function buildStadiumPath(path, halfX, radius) {
  // Start at top-right of upper straight, go counter-clockwise (positive arc).
  // CCW order is required for the outer outline; reverse it for holes.
  path.moveTo(halfX, radius);
  path.lineTo(-halfX, radius);
  path.absarc(-halfX, 0, radius, Math.PI / 2, -Math.PI / 2, true); // left arc
  path.lineTo(halfX, -radius);
  path.absarc(halfX, 0, radius, -Math.PI / 2, Math.PI / 2, true);  // right arc
  return path;
}

// ---- Track surface (asphalt ring) ----
{
  const outer = new THREE.Shape();
  buildStadiumPath(outer, TRACK.STRAIGHT_HALF, OUTER_R);
  const hole = new THREE.Path();
  buildStadiumPath(hole, TRACK.STRAIGHT_HALF, INNER_R);
  outer.holes.push(hole);

  const geom = new THREE.ShapeGeometry(outer, 96);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2a2a2e,
    roughness: 0.85,
    metalness: 0.05
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---- Infield grass ----
{
  const grass = new THREE.Shape();
  buildStadiumPath(grass, TRACK.STRAIGHT_HALF, INNER_R - 0.05);
  const geom = new THREE.ShapeGeometry(grass, 64);
  const mat = new THREE.MeshStandardMaterial({ color: 0x4a8a3a, roughness: 0.98 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.0;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---- Surrounding ground (outside the track) ----
{
  const huge = new THREE.PlaneGeometry(4000, 4000);
  const mat = new THREE.MeshStandardMaterial({ color: 0x3a6b3a, roughness: 0.98 });
  const mesh = new THREE.Mesh(huge, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -0.05;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---- Yard of bricks (start/finish line) ----
{
  // Generate a brick-pattern canvas texture.
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const cx = c.getContext('2d');
  cx.fillStyle = '#7a4a30';
  cx.fillRect(0, 0, c.width, c.height);
  cx.fillStyle = '#5a3318';
  for (let row = 0; row < 4; row++) {
    const offset = (row % 2) * 32;
    for (let col = 0; col < 9; col++) {
      const x = col * 32 + offset - 8;
      const y = row * 16 + 1;
      cx.fillRect(x, y, 28, 14);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;

  // Position: middle of front straight (front straight is at +Z direction = high Z in our coords).
  // Actually our straights are at z = ±OUTER_R. Pick z = +OUTER_R - WIDTH/2 as front straight center.
  const w = TRACK.WIDTH;
  const geom = new THREE.PlaneGeometry(8, w);
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, 0.03, OUTER_R - w / 2);
  scene.add(mesh);
}

// ---- White lane markers along the straights ----
{
  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xeeeeee });
  // Outer edge stripes
  const outerLen = TRACK.STRAIGHT_HALF * 2;
  const stripeGeo = new THREE.PlaneGeometry(outerLen, 0.3);
  for (const sign of [1, -1]) {
    // Outer line of straight
    const outerLine = new THREE.Mesh(stripeGeo, stripeMat);
    outerLine.rotation.x = -Math.PI / 2;
    outerLine.position.set(0, 0.025, sign * OUTER_R);
    scene.add(outerLine);
    // Inner line of straight
    const innerLine = new THREE.Mesh(stripeGeo, stripeMat);
    innerLine.rotation.x = -Math.PI / 2;
    innerLine.position.set(0, 0.025, sign * INNER_R);
    scene.add(innerLine);
  }
}

// ---- SAFER walls (outer track barrier) ----
{
  // Build a wall as a ribbon along the outer stadium path, at height TRACK.WALL_HEIGHT.
  const pts = [];
  const segments = 96;
  // upper straight
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const x = -TRACK.STRAIGHT_HALF + t * 2 * TRACK.STRAIGHT_HALF;
    pts.push(new THREE.Vector2(x, OUTER_R));
  }
  // right arc
  for (let i = 1; i <= segments / 2; i++) {
    const a = Math.PI / 2 - (i / (segments / 2)) * Math.PI;
    pts.push(new THREE.Vector2(TRACK.STRAIGHT_HALF + Math.cos(a) * OUTER_R, Math.sin(a) * OUTER_R));
  }
  // lower straight (reverse direction)
  for (let i = 1; i <= 20; i++) {
    const t = i / 20;
    const x = TRACK.STRAIGHT_HALF - t * 2 * TRACK.STRAIGHT_HALF;
    pts.push(new THREE.Vector2(x, -OUTER_R));
  }
  // left arc
  for (let i = 1; i <= segments / 2; i++) {
    const a = -Math.PI / 2 - (i / (segments / 2)) * Math.PI;
    pts.push(new THREE.Vector2(-TRACK.STRAIGHT_HALF + Math.cos(a) * OUTER_R, Math.sin(a) * OUTER_R));
  }
  // close
  pts.push(pts[0].clone());

  const wallGroup = new THREE.Group();
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.8 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xd63a3a, roughness: 0.7 });

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.y - a.y;
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const cx = (a.x + b.x) / 2;
    const cz = (a.y + b.y) / 2;
    const angle = Math.atan2(dz, dx);

    const segGeo = new THREE.BoxGeometry(len * 1.02, TRACK.WALL_HEIGHT, 0.4);
    const mesh = new THREE.Mesh(segGeo, wallMat);
    mesh.position.set(cx, TRACK.WALL_HEIGHT / 2, cz);
    mesh.rotation.y = -angle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    wallGroup.add(mesh);

    // Red top trim
    const trimGeo = new THREE.BoxGeometry(len * 1.02, 0.15, 0.42);
    const trimMesh = new THREE.Mesh(trimGeo, trim);
    trimMesh.position.set(cx, TRACK.WALL_HEIGHT + 0.05, cz);
    trimMesh.rotation.y = -angle;
    wallGroup.add(trimMesh);
  }
  scene.add(wallGroup);
}

// ---- Catch fence (semi-transparent above the wall) ----
{
  const fenceGroup = new THREE.Group();
  const fenceMat = new THREE.MeshBasicMaterial({
    color: 0xaaaaaa,
    transparent: true,
    opacity: 0.25,
    side: THREE.DoubleSide
  });
  // single ring sized slightly outside the wall
  const fenceHeight = 6;
  const segments = 128;
  for (let i = 0; i < segments; i++) {
    const t0 = i / segments;
    const t1 = (i + 1) / segments;
    const p0 = pointOnOuterPath(t0, 0.6);
    const p1 = pointOnOuterPath(t1, 0.6);
    const dx = p1.x - p0.x;
    const dz = p1.z - p0.z;
    const len = Math.hypot(dx, dz);
    const cx = (p0.x + p1.x) / 2;
    const cz = (p0.z + p1.z) / 2;
    const angle = Math.atan2(dz, dx);

    const geo = new THREE.PlaneGeometry(len, fenceHeight);
    const m = new THREE.Mesh(geo, fenceMat);
    m.position.set(cx, fenceHeight / 2 + TRACK.WALL_HEIGHT, cz);
    m.rotation.y = -angle + Math.PI / 2;
    fenceGroup.add(m);
  }
  scene.add(fenceGroup);
}

// ---- Grandstands (continuous tiered ribbon) ----
{
  const standsGroup = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b8c2, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a4a58, roughness: 0.6, metalness: 0.2 });
  const crowdTex = makeCrowdTexture();
  const crowdMat = new THREE.MeshStandardMaterial({
    map: crowdTex,
    roughness: 0.95,
    side: THREE.DoubleSide
  });

  const standOffset = 12;
  const tierDepth = 3.0;
  const tierHeight = 1.6;
  const tiers = 6;
  const segments = 192; // higher count for smoothness

  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const tNext = (i + 1) / segments;
    const p = pointOnOuterPath(t, standOffset);
    const pNext = pointOnOuterPath(tNext, standOffset);
    const dx = pNext.x - p.x;
    const dz = pNext.z - p.z;
    const segLen = Math.hypot(dx, dz) * 1.04; // slight overlap to close gaps
    const cx = (p.x + pNext.x) / 2;
    const cz = (p.z + pNext.z) / 2;
    const angle = Math.atan2(dz, dx);

    // Crowd panel — single tall sloped panel using the crowd texture
    const panelHeight = tiers * tierHeight;
    const panelDepth = tiers * tierDepth;
    const slope = Math.atan2(panelHeight, panelDepth);

    // Concrete base (a low solid wall right against the SAFER wall)
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(segLen, 1.2, 1.0),
      concrete
    );
    base.position.set(cx, 0.6, cz);
    base.rotation.y = -angle + Math.PI / 2;
    base.castShadow = true;
    base.receiveShadow = true;
    standsGroup.add(base);

    // Crowd slope (tilted plane with crowd texture)
    const crowdPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(segLen, Math.hypot(panelHeight, panelDepth)),
      crowdMat
    );
    // position center of the slope
    const slopeMidOut = panelDepth / 2;
    const slopeMidY = 1.2 + panelHeight / 2;
    const outwardX = Math.cos(angle - Math.PI / 2) * slopeMidOut;
    const outwardZ = Math.sin(angle - Math.PI / 2) * slopeMidOut;
    crowdPlane.position.set(cx + outwardX, slopeMidY, cz + outwardZ);
    // rotate to face inward+up
    crowdPlane.rotation.y = -angle + Math.PI / 2;
    crowdPlane.rotation.x = -(Math.PI / 2 - slope);
    crowdPlane.receiveShadow = true;
    standsGroup.add(crowdPlane);

    // Roof beam (back-edge cap)
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(segLen, 0.6, 1.4),
      roofMat
    );
    const beamOutOut = panelDepth + 0.5;
    beam.position.set(
      cx + Math.cos(angle - Math.PI / 2) * beamOutOut,
      panelHeight + 1.2,
      cz + Math.sin(angle - Math.PI / 2) * beamOutOut
    );
    beam.rotation.y = -angle + Math.PI / 2;
    beam.castShadow = true;
    standsGroup.add(beam);
  }
  scene.add(standsGroup);
}

// ---- Advertising banners on the inside catch-fence ----
{
  const bannerColors = [0xd63a3a, 0x3a8ec8, 0xf5d76e, 0x7ee27e, 0xe85a1a, 0xffffff];
  const segments = 64;
  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    if (t > 0.4 && t < 0.6) continue; // gap for pit area
    const p = pointOnOuterPath(t, -1.5); // just inside the wall
    const pNext = pointOnOuterPath((i + 1) / segments, -1.5);
    const dx = pNext.x - p.x;
    const dz = pNext.z - p.z;
    const segLen = Math.hypot(dx, dz);
    const cx = (p.x + pNext.x) / 2;
    const cz = (p.z + pNext.z) / 2;
    const angle = Math.atan2(dz, dx);

    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(segLen * 0.92, 0.7),
      new THREE.MeshBasicMaterial({ color: bannerColors[i % bannerColors.length] })
    );
    banner.position.set(cx, 0.5, cz);
    banner.rotation.y = -angle + Math.PI / 2;
    standsGroup_addBanner(banner);
  }
}
function standsGroup_addBanner(mesh) { scene.add(mesh); }

// Generate a crowd texture procedurally — densely packed colored speckle pattern.
function makeCrowdTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 256;
  const cx = c.getContext('2d');
  cx.fillStyle = '#7a7a8a';
  cx.fillRect(0, 0, c.width, c.height);
  const palette = ['#d63a3a', '#f5d76e', '#3a8ec8', '#7ee27e', '#e85a1a', '#b070d8', '#eeeeee', '#aa5533', '#f0a0a0', '#a0c8e8', '#ffcc33'];
  // Dense crowd: ~25000 packed colored rectangles
  for (let i = 0; i < 25000; i++) {
    cx.fillStyle = palette[Math.floor(Math.random() * palette.length)];
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    cx.fillRect(x, y, 5, 6);
  }
  // Row shadows to imply seating tiers
  cx.fillStyle = 'rgba(0,0,0,0.12)';
  for (let r = 0; r < 12; r++) {
    cx.fillRect(0, r * 22 + 18, c.width, 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---- Pagoda tower (signature IMS structure, inside front straight) ----
{
  const pagoda = new THREE.Group();
  const tower = new THREE.Mesh(
    new THREE.BoxGeometry(8, 36, 8),
    new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.55, metalness: 0.1 })
  );
  tower.position.y = 18;
  tower.castShadow = true;
  pagoda.add(tower);

  // Tiered glass sections
  for (let i = 0; i < 4; i++) {
    const tier = new THREE.Mesh(
      new THREE.BoxGeometry(10 - i * 1.2, 1.2, 10 - i * 1.2),
      new THREE.MeshStandardMaterial({ color: 0x3a8ec8, roughness: 0.2, metalness: 0.5 })
    );
    tier.position.y = 8 + i * 7;
    pagoda.add(tier);
  }

  // Roof spike
  const spike = new THREE.Mesh(
    new THREE.ConeGeometry(2, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xd63a3a, roughness: 0.5 })
  );
  spike.position.y = 40;
  pagoda.add(spike);

  // Place on the infield, in front of start/finish
  pagoda.position.set(0, 0, INNER_R - 20);
  scene.add(pagoda);
}

// ---- Pit lane wall (small wall paralleling the front straight, on the infield side) ----
{
  const len = TRACK.STRAIGHT_HALF * 1.6;
  const pitWall = new THREE.Mesh(
    new THREE.BoxGeometry(len, 0.8, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xe8e8e8 })
  );
  pitWall.position.set(0, 0.4, INNER_R - TRACK.PIT_OFFSET);
  scene.add(pitWall);

  // Pit boxes (numbered slots, just decorative geometry)
  const boxMat = new THREE.MeshStandardMaterial({ color: 0x3a3a4a });
  for (let i = -5; i <= 5; i++) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(8, 0.05, 6), boxMat);
    box.position.set(i * 14, 0.025, INNER_R - TRACK.PIT_OFFSET - 4);
    scene.add(box);
  }
}

// ============================================================
// SCENE HELPERS
// ============================================================
function pointOnOuterPath(t, offset = 0) {
  // t in [0, 1) traces the outer track CCW starting at front-straight center going right.
  // Returns world-space (x, z) on the outer line (radius OUTER_R + offset).
  const r = OUTER_R + offset;
  // Track perimeter pieces:
  // [0..A]: front straight, x: 0 → STRAIGHT_HALF
  // [A..B]: right arc (turn 1+2)
  // [B..C]: back straight, x: STRAIGHT_HALF → -STRAIGHT_HALF
  // [C..D]: left arc (turn 3+4)
  // [D..1]: front straight, x: -STRAIGHT_HALF → 0
  const straightLen = TRACK.STRAIGHT_HALF * 2;
  const arcLen = Math.PI * r;
  const total = straightLen * 2 + arcLen * 2;
  const A = TRACK.STRAIGHT_HALF / total;
  const B = (TRACK.STRAIGHT_HALF + arcLen) / total;
  const C = (TRACK.STRAIGHT_HALF + arcLen + straightLen) / total;
  const D = (TRACK.STRAIGHT_HALF + arcLen + straightLen + arcLen) / total;

  if (t < A) {
    const u = t / A;
    return { x: u * TRACK.STRAIGHT_HALF, z: r };
  } else if (t < B) {
    const u = (t - A) / (B - A);
    const angle = Math.PI / 2 - u * Math.PI;
    return { x: TRACK.STRAIGHT_HALF + Math.cos(angle) * r, z: Math.sin(angle) * r };
  } else if (t < C) {
    const u = (t - B) / (C - B);
    return { x: TRACK.STRAIGHT_HALF - u * straightLen, z: -r };
  } else if (t < D) {
    const u = (t - C) / (D - C);
    const angle = -Math.PI / 2 - u * Math.PI;
    return { x: -TRACK.STRAIGHT_HALF + Math.cos(angle) * r, z: Math.sin(angle) * r };
  } else {
    const u = (t - D) / (1 - D);
    return { x: -TRACK.STRAIGHT_HALF + u * TRACK.STRAIGHT_HALF, z: r };
  }
}

function randomCrowdColor() {
  const palette = [0xd63a3a, 0xf5d76e, 0x3a8ec8, 0x7ee27e, 0xe85a1a, 0xb070d8, 0xeeeeee, 0x222222];
  return palette[Math.floor(Math.random() * palette.length)];
}

state.clock = new THREE.Clock();

// ============================================================
// INPUT
// ============================================================
const KEYMAP = {
  throttle: ['Space', 'KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  boost: ['ShiftLeft', 'ShiftRight'],
  pause: ['KeyP', 'Escape'],
  help: ['Slash'],
  confirm: ['Enter']
};

function isAction(action, code) {
  return KEYMAP[action] && KEYMAP[action].includes(code);
}

window.addEventListener('keydown', (e) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
    e.preventDefault();
  }
  state.keys.add(e.code);
  handleKey(e.code);
});

window.addEventListener('keyup', (e) => {
  state.keys.delete(e.code);
});

function handleKey(code) {
  switch (state.screen) {
    case SCREEN.TITLE:
      if (isAction('confirm', code)) startRun();
      else if (code === 'KeyH') show(SCREEN.SCORES);
      else if (isAction('help', code)) showHelp();
      break;
    case SCREEN.PLAYING:
      if (isAction('pause', code)) show(SCREEN.PAUSED);
      else if (isAction('help', code)) showHelp();
      break;
    case SCREEN.PAUSED:
      if (isAction('pause', code) || isAction('confirm', code)) show(SCREEN.PLAYING);
      else if (code === 'KeyQ') show(SCREEN.TITLE);
      break;
    case SCREEN.GAMEOVER:
    case SCREEN.WIN:
      if (isAction('confirm', code)) afterRun();
      break;
    case SCREEN.INITIALS:
      handleInitialsKey(code);
      break;
    case SCREEN.SCORES:
      if (isAction('confirm', code) || code === 'KeyR') show(SCREEN.TITLE);
      break;
    case SCREEN.HELP:
      if (isAction('help', code) || isAction('confirm', code) || isAction('pause', code)) {
        show(state.prevScreen);
      }
      break;
  }
}

function handleInitialsKey(code) {
  if (code === 'ArrowLeft') {
    state.initialsIdx = (state.initialsIdx + 2) % 3;
  } else if (code === 'ArrowRight') {
    state.initialsIdx = (state.initialsIdx + 1) % 3;
  } else if (code === 'ArrowUp') {
    state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], +1);
  } else if (code === 'ArrowDown') {
    state.initials[state.initialsIdx] = cycleChar(state.initials[state.initialsIdx], -1);
  } else if (isAction('confirm', code)) {
    insertScore(state.initials, state.pendingScore);
    show(SCREEN.SCORES);
    return;
  } else if (/^Key[A-Z]$/.test(code)) {
    state.initials[state.initialsIdx] = code.slice(3);
    state.initialsIdx = Math.min(2, state.initialsIdx + 1);
  } else if (code === 'Backspace') {
    state.initialsIdx = Math.max(0, state.initialsIdx - 1);
    state.initials[state.initialsIdx] = 'A';
  }
  renderInitials();
}

function cycleChar(c, dir) {
  const code = c.charCodeAt(0);
  let next = code + dir;
  if (next > 90) next = 65;
  if (next < 65) next = 90;
  return String.fromCharCode(next);
}

// ============================================================
// SCREEN MACHINE — HTML overlay
// ============================================================
const overlayEl = document.getElementById('overlay');
const hudEl = document.getElementById('hud');
const screenEls = {
  [SCREEN.TITLE]: document.getElementById('screen-title'),
  [SCREEN.PAUSED]: document.getElementById('screen-paused'),
  [SCREEN.GAMEOVER]: document.getElementById('screen-gameover'),
  [SCREEN.WIN]: document.getElementById('screen-win'),
  [SCREEN.INITIALS]: document.getElementById('screen-initials'),
  [SCREEN.SCORES]: document.getElementById('screen-scores'),
  [SCREEN.HELP]: document.getElementById('screen-help')
};

function show(target) {
  if (state.screen !== SCREEN.HELP) state.prevScreen = state.screen;
  state.screen = target;
  applyScreen();
}

function applyScreen() {
  const inGame = state.screen === SCREEN.PLAYING;
  const overlayVisible = !inGame;

  // hide every screen, then show the right one
  for (const key in screenEls) {
    screenEls[key].classList.add('hidden');
  }
  if (screenEls[state.screen]) {
    screenEls[state.screen].classList.remove('hidden');
  }

  // overlay backdrop
  overlayEl.style.display = overlayVisible ? 'grid' : 'none';
  // HUD only during gameplay (and paused, so player sees their stats)
  if (state.screen === SCREEN.PLAYING || state.screen === SCREEN.PAUSED) {
    hudEl.classList.remove('hidden');
  } else {
    hudEl.classList.add('hidden');
  }

  if (state.screen === SCREEN.SCORES) renderScoresList();
  if (state.screen === SCREEN.INITIALS) renderInitials();
}

function showHelp() {
  state.prevScreen = state.screen;
  state.screen = SCREEN.HELP;
  applyScreen();
}

// Button wiring (mouse/touch parity with keyboard)
document.querySelectorAll('[data-action]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    switch (action) {
      case 'start': startRun(); break;
      case 'scores': show(SCREEN.SCORES); break;
      case 'help': showHelp(); break;
      case 'resume': show(SCREEN.PLAYING); break;
      case 'quit': show(SCREEN.TITLE); break;
      case 'continue': afterRun(); break;
      case 'return': show(SCREEN.TITLE); break;
    }
  });
});

// ============================================================
// RUN LIFECYCLE
// ============================================================
function startRun() {
  state.lap = 1;
  state.lapStartTime = performance.now() / 1000;
  state.lastLapTime = 0;
  state.bestLapTime = Infinity;
  state.score = 0;
  state.fuel = FUEL_MAX;
  state.speed = 0;
  show(SCREEN.PLAYING);
}

function afterRun() {
  if (qualifies(state.pendingScore || state.score)) {
    state.pendingScore = state.pendingScore || state.score;
    state.initials = ['A', 'A', 'A'];
    state.initialsIdx = 0;
    show(SCREEN.INITIALS);
  } else {
    show(SCREEN.SCORES);
  }
}

function renderScoresList() {
  const ol = document.getElementById('scores-list');
  state.scores = loadScores();
  ol.innerHTML = '';
  if (state.scores.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.innerHTML = '<span class="empty">NO SCORES YET — HIT THE BRICKYARD.</span>';
    ol.appendChild(li);
    return;
  }
  state.scores.forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="rank">${i + 1}.</span>` +
      `<span class="initials">${s.initials}</span>` +
      `<span class="score">${pad(s.score, 6)}</span>` +
      `<span class="date">${s.date}</span>`;
    ol.appendChild(li);
  });
}

function renderInitials() {
  const el = document.getElementById('initials-display');
  el.innerHTML = state.initials.map((c, i) => {
    const cls = i === state.initialsIdx ? 'initial active' : 'initial';
    return `<span class="${cls}">${c}</span>`;
  }).join('');
  document.getElementById('initials-score').textContent = pad(state.pendingScore, 6);
}

function pad(n, w) {
  const s = String(Math.floor(n));
  return s.length >= w ? s : '0'.repeat(w - s.length) + s;
}

// ============================================================
// MAIN LOOP
// ============================================================
function tick() {
  const dt = Math.min(0.05, state.clock.getDelta());

  if (state.screen === SCREEN.PLAYING) {
    // Driving update will go here in 3D-4
  }

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// BOOT
// ============================================================
state.scores = loadScores();
applyScreen();
requestAnimationFrame(tick);
