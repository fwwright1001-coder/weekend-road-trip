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
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xd8d0b8, 420, 1500);

// IBL — RoomEnvironment gives every MeshStandardMaterial plausible indirect
// lighting + cube reflections without us authoring HDRIs.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

// ============================================================
// POST-PROCESSING PIPELINE (G-13)
// ============================================================
// RenderPass → UnrealBloomPass (subtle, only highlights) → SMAA → Output
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
composer.setSize(window.innerWidth, window.innerHeight);

const renderPass = new RenderPass(scene, /* camera assigned after init */ null);
composer.addPass(renderPass);

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.18,  // strength — subtle glow, not a wash
  0.55,  // radius
  0.94   // threshold — only the brightest pixels (sun, beacon) bloom
);
composer.addPass(bloomPass);

const smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
composer.addPass(smaaPass);

const outputPass = new OutputPass();
composer.addPass(outputPass);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 3000);
// Wire the camera into the deferred RenderPass.
renderPass.camera = camera;
// Establishing shot: broadcast-style — west end of front straight, slightly inside
// the track, elevated, looking east down the straight toward turn 1.
// Chase cam takes over in 3D-3.
camera.position.set(-160, 26, 70);
camera.lookAt(120, 6, 105);

// Lights — softer ambient warmth, stronger directional sun
const ambient = new THREE.HemisphereLight(0xe8dfc8, 0x3a4858, 0.7);
scene.add(ambient);

const SUN_DIRECTION = new THREE.Vector3(0.45, 0.65, 0.35).normalize();
const sun = new THREE.DirectionalLight(0xfff0d0, 1.6);
sun.position.copy(SUN_DIRECTION).multiplyScalar(220);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -240;
sun.shadow.camera.right = 240;
sun.shadow.camera.top = 240;
sun.shadow.camera.bottom = -240;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 600;
sun.shadow.bias = -0.0005;
scene.add(sun);

// Gentle rim fill from the opposite side so shadowed surfaces still read.
const rimLight = new THREE.DirectionalLight(0xb8c8e0, 0.25);
rimLight.position.set(-100, 60, -80);
scene.add(rimLight);

// ============================================================
// SKY (G-1)
// ============================================================
// Vertical gradient skydome with a procedural sun glow.
const skyMaterial = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  depthWrite: false,
  uniforms: {
    uTop:     { value: new THREE.Color(0x2e6cb4) },
    uMid:     { value: new THREE.Color(0xa8c8e0) },
    uHorizon: { value: new THREE.Color(0xf4e3c0) },
    uGround:  { value: new THREE.Color(0xb8a888) },
    uSunDir:  { value: SUN_DIRECTION.clone() },
    uSunColor: { value: new THREE.Color(0xfff4dc) }
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vDir = normalize(wp.xyz - cameraPosition);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }
  `,
  fragmentShader: /* glsl */ `
    uniform vec3 uTop;
    uniform vec3 uMid;
    uniform vec3 uHorizon;
    uniform vec3 uGround;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 sky;
      if (h >= 0.0) {
        // Above horizon: blend horizon → mid → top
        float t1 = smoothstep(0.0, 0.18, h);
        float t2 = smoothstep(0.18, 0.7, h);
        sky = mix(uHorizon, uMid, t1);
        sky = mix(sky, uTop, t2);
      } else {
        sky = mix(uHorizon, uGround, smoothstep(0.0, -0.25, h));
      }
      // Sun + haze
      float cs = max(dot(d, normalize(uSunDir)), 0.0);
      float disk = smoothstep(0.9985, 0.9998, cs);
      float halo = pow(cs, 24.0) * 0.6;
      float wash = pow(cs, 6.0) * 0.15;
      sky = mix(sky, uSunColor, disk);
      sky += uSunColor * halo;
      sky += vec3(1.0, 0.85, 0.6) * wash;
      gl_FragColor = vec4(sky, 1.0);
    }
  `
});
{
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1800, 48, 32), skyMaterial);
  dome.renderOrder = -1;
  scene.add(dome);
}

// Procedural clouds — soft white blobs on flat planes at altitude.
{
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const cx = c.getContext('2d');
  const grad = cx.createRadialGradient(128, 64, 8, 128, 64, 100);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  // Build a few overlapping ellipses to break up the circular look
  const draw = (x, y, rx, ry, a) => {
    cx.save();
    cx.translate(x, y);
    cx.scale(rx, ry);
    cx.fillStyle = grad;
    cx.beginPath();
    cx.arc(0, 0, 50, 0, Math.PI * 2);
    cx.fill();
    cx.restore();
  };
  draw(110, 70, 0.9, 0.6);
  draw(160, 60, 1.0, 0.5);
  draw(80, 60, 0.7, 0.45);
  draw(130, 55, 0.8, 0.4);
  const cloudTex = new THREE.CanvasTexture(c);
  cloudTex.colorSpace = THREE.SRGBColorSpace;

  const cloudMat = new THREE.MeshBasicMaterial({
    map: cloudTex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    fog: false
  });

  const CLOUDS = 24;
  for (let i = 0; i < CLOUDS; i++) {
    const ang = (i / CLOUDS) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 700 + Math.random() * 500;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    const y = 140 + Math.random() * 180;
    const w = 280 + Math.random() * 280;
    const h = w * (0.32 + Math.random() * 0.2);
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(w, h), cloudMat);
    cloud.position.set(x, y, z);
    // Face roughly downward so they read as bottoms of clouds from below
    cloud.rotation.x = -Math.PI / 2 + (Math.random() - 0.5) * 0.5;
    cloud.rotation.z = Math.random() * Math.PI;
    cloud.renderOrder = -1;
    scene.add(cloud);
  }
}

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
    map: makeAsphaltTexture(),
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.06
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// Procedural asphalt — speckle + worn patches + a hint of a racing groove.
function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const cx = c.getContext('2d');
  // Base asphalt color
  cx.fillStyle = '#2c2c30';
  cx.fillRect(0, 0, c.width, c.height);
  // Aggregate (small lighter grains)
  for (let i = 0; i < 18000; i++) {
    const v = 36 + Math.floor(Math.random() * 28);
    cx.fillStyle = `rgb(${v},${v},${v + 2})`;
    cx.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  // Darker grains
  for (let i = 0; i < 6000; i++) {
    const v = 18 + Math.floor(Math.random() * 12);
    cx.fillStyle = `rgb(${v},${v},${v + 1})`;
    cx.fillRect(Math.random() * c.width, Math.random() * c.height, 1, 1);
  }
  // Worn patches (a few large faded areas)
  for (let i = 0; i < 28; i++) {
    const lighten = Math.random() < 0.5;
    cx.fillStyle = lighten ? 'rgba(180,180,180,0.06)' : 'rgba(0,0,0,0.08)';
    const x = Math.random() * c.width;
    const y = Math.random() * c.height;
    const r = 30 + Math.random() * 90;
    cx.beginPath();
    cx.arc(x, y, r, 0, Math.PI * 2);
    cx.fill();
  }
  // Subtle horizontal "racing line" darkening
  cx.fillStyle = 'rgba(0,0,0,0.18)';
  cx.fillRect(0, c.height * 0.45, c.width, c.height * 0.18);
  cx.fillStyle = 'rgba(255,255,255,0.04)';
  cx.fillRect(0, c.height * 0.78, c.width, c.height * 0.06); // marbles strip on outer edge

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(28, 6);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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

// ---- Grandstands (multi-deck: lower bowl + suite level + upper deck + roof) ----
{
  const standsGroup = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0xc4c0b4, roughness: 0.88 });
  const concreteDark = new THREE.MeshStandardMaterial({ color: 0x7c7a78, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x3e424a, roughness: 0.55, metalness: 0.25 });
  const trussMat = new THREE.MeshStandardMaterial({ color: 0xd4d4d4, roughness: 0.6, metalness: 0.5 });
  const suiteGlass = new THREE.MeshStandardMaterial({
    color: 0x223044, roughness: 0.18, metalness: 0.8,
    emissive: 0x0a1018, emissiveIntensity: 0.25
  });
  const crowdTex = makeCrowdTexture();
  const crowdMat = new THREE.MeshStandardMaterial({
    map: crowdTex, roughness: 0.95, side: THREE.DoubleSide
  });

  const standOffset = 12;       // distance from outer wall outward to stand base
  const segments = 192;

  // Geometry constants for the three decks ---------------------------------------
  // Lower bowl (main grandstand seating)
  const lower = { tiers: 7, tierH: 1.7, tierD: 2.8 };
  // Suite mezzanine (glass-front boxes)
  const suite = { height: 4.6, depth: 3.4 };
  // Upper deck (smaller capacity, set back)
  const upper = { tiers: 9, tierH: 1.5, tierD: 2.2, recess: 1.5 };
  // Roof
  const roof = { thickness: 1.0, overhang: 6 };

  const lowerH = lower.tiers * lower.tierH;       // 11.9
  const lowerD = lower.tiers * lower.tierD;       // 19.6
  const upperH = upper.tiers * upper.tierH;       // 13.5
  const upperD = upper.tiers * upper.tierD;       // 19.8
  const totalH = 1.2 + lowerH + suite.height + upperH + roof.thickness; // ~32m

  for (let i = 0; i < segments; i++) {
    const t = i / segments;
    const tNext = (i + 1) / segments;
    const p = pointOnOuterPath(t, standOffset);
    const pNext = pointOnOuterPath(tNext, standOffset);
    const dx = pNext.x - p.x;
    const dz = pNext.z - p.z;
    const segLen = Math.hypot(dx, dz) * 1.05;
    const cx = (p.x + pNext.x) / 2;
    const cz = (p.z + pNext.z) / 2;
    const angle = Math.atan2(dz, dx);
    const yawRot = -angle + Math.PI / 2;
    const outX = Math.cos(angle - Math.PI / 2);
    const outZ = Math.sin(angle - Math.PI / 2);

    const placeOutward = (mesh, outward, height) => {
      mesh.position.set(cx + outX * outward, height, cz + outZ * outward);
      mesh.rotation.y = yawRot;
    };

    // --- Concrete base wall (under the lower bowl) ---
    const base = new THREE.Mesh(new THREE.BoxGeometry(segLen, 1.2, 1.0), concrete);
    placeOutward(base, 0, 0.6);
    base.castShadow = true; base.receiveShadow = true;
    standsGroup.add(base);

    // --- Lower bowl crowd slope ---
    const lowerSlope = Math.atan2(lowerH, lowerD);
    const lowerPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(segLen, Math.hypot(lowerH, lowerD)),
      crowdMat
    );
    placeOutward(lowerPanel, lowerD / 2, 1.2 + lowerH / 2);
    lowerPanel.rotation.x = -(Math.PI / 2 - lowerSlope);
    lowerPanel.receiveShadow = true;
    standsGroup.add(lowerPanel);

    // --- Mezzanine concrete deck (between lower & suite level) ---
    const mezz = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.9, 4.5), concreteDark);
    placeOutward(mezz, lowerD + 1.5, 1.2 + lowerH + 0.45);
    mezz.castShadow = true; mezz.receiveShadow = true;
    standsGroup.add(mezz);

    // --- Suite level box: dark frame with glass front ---
    const suiteY = 1.2 + lowerH + 0.9 + suite.height / 2;
    // Glass front (face the track)
    const suiteGlassMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(segLen, suite.height),
      suiteGlass
    );
    placeOutward(suiteGlassMesh, lowerD - 0.5, suiteY);
    standsGroup.add(suiteGlassMesh);
    // Top + bottom suite frame (concrete)
    const frameTop = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.5, suite.depth), concreteDark);
    placeOutward(frameTop, lowerD + suite.depth / 2 - 1, suiteY + suite.height / 2 + 0.25);
    standsGroup.add(frameTop);
    const frameBot = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.35, suite.depth), concreteDark);
    placeOutward(frameBot, lowerD + suite.depth / 2 - 1, suiteY - suite.height / 2 - 0.18);
    standsGroup.add(frameBot);
    // Suite back wall
    const suiteBack = new THREE.Mesh(new THREE.BoxGeometry(segLen, suite.height, 0.3), concrete);
    placeOutward(suiteBack, lowerD + suite.depth - 1, suiteY);
    standsGroup.add(suiteBack);

    // --- Upper deck crowd slope (set back from suite by recess) ---
    const upperBaseY = 1.2 + lowerH + suite.height + 0.9;
    const upperOutBase = lowerD + suite.depth + upper.recess - 1;
    const upperSlope = Math.atan2(upperH, upperD);
    const upperPanel = new THREE.Mesh(
      new THREE.PlaneGeometry(segLen, Math.hypot(upperH, upperD)),
      crowdMat
    );
    placeOutward(upperPanel, upperOutBase + upperD / 2, upperBaseY + upperH / 2);
    upperPanel.rotation.x = -(Math.PI / 2 - upperSlope);
    upperPanel.receiveShadow = true;
    standsGroup.add(upperPanel);

    // --- Cantilever roof slab, extends FORWARD over the upper deck and partly over the suite ---
    const roofY = upperBaseY + upperH + roof.thickness / 2 + 0.4;
    const roofForward = upperOutBase + upperD - roof.overhang;
    const roofSlab = new THREE.Mesh(
      new THREE.BoxGeometry(segLen, roof.thickness, upperD + roof.overhang + 2),
      roofMat
    );
    placeOutward(roofSlab, roofForward + (upperD + roof.overhang + 2) / 2 - upperD - 1, roofY);
    roofSlab.castShadow = true;
    standsGroup.add(roofSlab);

    // --- Roof support trusses every few segments (vertical white pillars + diagonal struts) ---
    if (i % 6 === 0) {
      const pillarOut = upperOutBase + upperD + 0.5;
      const pillar = new THREE.Mesh(
        new THREE.BoxGeometry(0.4, totalH - 1, 0.4),
        trussMat
      );
      placeOutward(pillar, pillarOut, (totalH - 1) / 2);
      pillar.castShadow = true;
      standsGroup.add(pillar);

      // Diagonal strut from pillar top toward upper deck back
      const strutLen = Math.hypot(upperD * 0.4, upperH * 0.5);
      const strut = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, strutLen, 0.25),
        trussMat
      );
      placeOutward(strut, pillarOut - upperD * 0.2, totalH - strutLen / 2 - 1);
      const strutAngle = Math.atan2(upperH * 0.5, upperD * 0.4);
      strut.rotation.z = strutAngle;
      // Adjust position to align
      standsGroup.add(strut);
    }
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

// Generate a crowd texture procedurally — person-shaped silhouettes on tiered rows.
function makeCrowdTexture() {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 512;
  const cx = c.getContext('2d');
  // Base concrete row background
  cx.fillStyle = '#5a5862';
  cx.fillRect(0, 0, c.width, c.height);

  // Apparel palette — slightly muted so it doesn't blow out
  const palette = [
    '#c83a3a', '#d4733a', '#d4a83a', '#3a8ec8', '#3a5ec8',
    '#3aa83a', '#7a4ab8', '#222222', '#dcdcdc', '#8a5a3a',
    '#e8c895', '#a04050', '#3a8888', '#b86a30'
  ];
  // Skin palette — head dots
  const skin = ['#e8c39a', '#caa37a', '#8a5e3a', '#f2d4b0', '#a07650'];

  const rows = 18;
  const rowH = c.height / rows;
  const personW = 8;
  const headR = 2.4;

  // Each row is a tier of seats — alternating slightly darker bands suggest steps.
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    // Row floor shadow
    cx.fillStyle = 'rgba(0, 0, 0, 0.22)';
    cx.fillRect(0, y, c.width, 2);
    // Subtle row band tinting
    cx.fillStyle = r % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.05)';
    cx.fillRect(0, y + 2, c.width, rowH - 2);

    // Pack people across the row
    const peoplePerRow = Math.floor(c.width / (personW + 1));
    for (let i = 0; i < peoplePerRow; i++) {
      // 5% chance to leave a seat empty
      if (Math.random() < 0.05) continue;
      const px = i * (personW + 1) + Math.random() * 1.5;
      // Body
      const body = palette[Math.floor(Math.random() * palette.length)];
      const bodyH = rowH - 8;
      cx.fillStyle = body;
      cx.fillRect(px, y + 6, personW, bodyH);
      // Head
      cx.fillStyle = skin[Math.floor(Math.random() * skin.length)];
      cx.beginPath();
      cx.arc(px + personW / 2, y + 4, headR, 0, Math.PI * 2);
      cx.fill();
    }
  }

  // Slight overall darken so it doesn't look TOO bright
  cx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  cx.fillRect(0, 0, c.width, c.height);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---- Pagoda tower (signature IMS structure, inside front straight) ----
{
  const pagoda = new THREE.Group();
  const whiteMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.55, metalness: 0.1 });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x2a6a98, roughness: 0.15, metalness: 0.7, emissive: 0x081020, emissiveIntensity: 0.4
  });
  const accentRed = new THREE.MeshStandardMaterial({ color: 0xd63a3a, roughness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });

  // --- Wider base structure (architectural plinth) ---
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(14, 4, 14), whiteMat);
  plinth.position.y = 2;
  plinth.castShadow = true;
  plinth.receiveShadow = true;
  pagoda.add(plinth);

  // --- Main vertical shaft (slightly narrower than before so glass tiers stand out) ---
  const tower = new THREE.Mesh(new THREE.BoxGeometry(7, 34, 7), whiteMat);
  tower.position.y = 4 + 17;
  tower.castShadow = true;
  pagoda.add(tower);

  // --- Vertical window strips on the shaft, 4 sides ---
  for (const side of [0, 1, 2, 3]) {
    const strip = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 30),
      glassMat
    );
    strip.position.y = 4 + 17;
    strip.position.x = side === 0 ? 3.52 : side === 2 ? -3.52 : 0;
    strip.position.z = side === 1 ? 3.52 : side === 3 ? -3.52 : 0;
    strip.rotation.y = side === 0 ? Math.PI / 2 : side === 2 ? -Math.PI / 2 : side === 1 ? 0 : Math.PI;
    pagoda.add(strip);
  }

  // --- Stepped observation tiers (the layered "pagoda" look) ---
  for (let i = 0; i < 5; i++) {
    const size = 11 - i * 1.5;
    const tier = new THREE.Mesh(
      new THREE.BoxGeometry(size, 1.4, size),
      i === 4 ? accentRed : whiteMat
    );
    tier.position.y = 28 + i * 2.2;
    tier.castShadow = true;
    pagoda.add(tier);

    // Glass band on each tier
    if (i < 4) {
      const band = new THREE.Mesh(
        new THREE.BoxGeometry(size + 0.1, 0.7, size + 0.1),
        glassMat
      );
      band.position.y = 28 + i * 2.2 + 0.5;
      pagoda.add(band);
    }
  }

  // --- Spire base and tall thin antenna spike ---
  const spireBase = new THREE.Mesh(
    new THREE.ConeGeometry(1.6, 4, 8),
    accentRed
  );
  spireBase.position.y = 42;
  pagoda.add(spireBase);

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.15, 14, 6),
    darkMat
  );
  antenna.position.y = 51;
  pagoda.add(antenna);

  // Tiny warning light on the antenna
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff2222, emissive: 0xff2222, emissiveIntensity: 1.2 })
  );
  beacon.position.y = 58;
  pagoda.add(beacon);

  // Place on the infield, in front of start/finish
  pagoda.position.set(0, 0, INNER_R - 22);
  scene.add(pagoda);
}

// ---- Scoring pylon (smaller tower beside the Pagoda, classic IMS) ----
{
  const pylon = new THREE.Group();
  const black = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.6 });
  const yellow = new THREE.MeshStandardMaterial({
    color: 0xffd54a, emissive: 0xffaa00, emissiveIntensity: 0.5, roughness: 0.4
  });

  // Black slab body
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 22, 1.2), black);
  body.position.y = 11;
  body.castShadow = true;
  pylon.add(body);

  // Yellow "33" panels stacked vertically (suggest positions)
  for (let i = 0; i < 7; i++) {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 2.2),
      yellow
    );
    panel.position.set(0, 4 + i * 2.7, 0.61);
    pylon.add(panel);
    const back = panel.clone();
    back.rotation.y = Math.PI;
    back.position.z = -0.61;
    pylon.add(back);
  }

  pylon.position.set(-22, 0, INNER_R - 22);
  scene.add(pylon);
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

// ---- Trees & outer scenery (G-3) ----
// Procedural foliage scattered in a band outside the stands so the horizon
// reads as a landscape, not empty grass into the sky.
{
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a1f, roughness: 0.95 });
  const foliageMats = [
    new THREE.MeshStandardMaterial({ color: 0x2d6a2d, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x3a8a3a, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x4f7a3a, roughness: 0.92 }),
    new THREE.MeshStandardMaterial({ color: 0x6a8a3a, roughness: 0.92 })
  ];
  const trunkGeo = new THREE.CylinderGeometry(0.4, 0.5, 4, 6);
  const coneGeo = new THREE.ConeGeometry(3, 8, 8);
  const sphereGeo = new THREE.SphereGeometry(3.2, 10, 8);

  // Place ~220 trees in a ring outside the stands.
  // Stand outer extent ≈ TURN_RADIUS + standOffset + panelDepth = 120 + 12 + 18 = 150
  // Trees from ~180 to ~750 outward, avoiding the track interior.
  const TREES = 220;
  for (let i = 0; i < TREES; i++) {
    const ang = Math.random() * Math.PI * 2;
    const dist = 180 + Math.random() * 580;
    const x = Math.cos(ang) * dist;
    const z = Math.sin(ang) * dist;
    // Skip if too close to track (defensive — distance threshold should already handle)
    if (Math.abs(x) < TRACK.STRAIGHT_HALF + 80 && Math.abs(z) < OUTER_R + 100) continue;

    const group = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 2;
    trunk.castShadow = true;
    group.add(trunk);

    // 50/50 cone (pine) or sphere (deciduous)
    const isCone = Math.random() < 0.55;
    const foliageMat = foliageMats[Math.floor(Math.random() * foliageMats.length)];
    const foliage = new THREE.Mesh(isCone ? coneGeo : sphereGeo, foliageMat);
    foliage.position.y = isCone ? 8 : 6;
    foliage.castShadow = true;
    // Vary tree size
    const scale = 0.7 + Math.random() * 1.3;
    group.scale.set(scale, scale * (0.9 + Math.random() * 0.3), scale);
    group.position.set(x, 0, z);
    group.rotation.y = Math.random() * Math.PI * 2;
    scene.add(group);
  }
}

// ---- Infield decorative buildings (small support structures) ----
{
  const bldgMat = new THREE.MeshStandardMaterial({ color: 0xd0c4a8, roughness: 0.85 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x6a5a4a, roughness: 0.8 });
  const positions = [
    { x: -160, z: 40, w: 18, d: 10, h: 5 },
    { x: 160, z: 40, w: 18, d: 10, h: 5 },
    { x: -80, z: -40, w: 24, d: 12, h: 4 },
    { x: 80, z: -40, w: 24, d: 12, h: 4 }
  ];
  for (const p of positions) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(p.w, p.h, p.d), bldgMat);
    b.position.set(p.x, p.h / 2, p.z);
    b.castShadow = true;
    b.receiveShadow = true;
    scene.add(b);
    const r = new THREE.Mesh(new THREE.BoxGeometry(p.w + 0.4, 0.3, p.d + 0.4), roofMat);
    r.position.set(p.x, p.h + 0.15, p.z);
    scene.add(r);
  }
}

// ============================================================
// GROUND DIMENSIONAL VARIATIONS (G-9)
// ============================================================

// ---- Garage row (Gasoline Alley analogue, lined up behind pit lane) ----
{
  const garageWhite = new THREE.MeshStandardMaterial({ color: 0xeae4d4, roughness: 0.8 });
  const garageRoof = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.4 });
  const doorMat   = new THREE.MeshStandardMaterial({ color: 0x4a4a55, roughness: 0.7 });
  const garageGroup = new THREE.Group();
  // 16 connected garages forming a long building
  const stalls = 16;
  const stallW = 7;
  const totalW = stalls * stallW;
  const startX = -totalW / 2 + stallW / 2;
  const rowZ = INNER_R - TRACK.PIT_OFFSET - 20;

  // Single big building base
  const building = new THREE.Mesh(
    new THREE.BoxGeometry(totalW + 4, 5.5, 11),
    garageWhite
  );
  building.position.set(0, 2.75, rowZ);
  building.castShadow = true;
  building.receiveShadow = true;
  garageGroup.add(building);

  // Flat roof slab
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(totalW + 5, 0.4, 12),
    garageRoof
  );
  roof.position.set(0, 5.7, rowZ);
  garageGroup.add(roof);

  // Stall doors facing the pit lane (toward +Z)
  for (let i = 0; i < stalls; i++) {
    const x = startX + i * stallW;
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(stallW - 1, 4.5, 0.2),
      doorMat
    );
    door.position.set(x, 2.5, rowZ + 5.6);
    garageGroup.add(door);
    // Door number panel (white with the slot index)
    if (i % 2 === 0) {
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 0.8),
        new THREE.MeshStandardMaterial({ color: 0xf5d76e })
      );
      sign.position.set(x, 5.0, rowZ + 5.71);
      garageGroup.add(sign);
    }
  }
  scene.add(garageGroup);
}

// ---- Corner curbing — red/white stripes on the inside of each turn ----
{
  const stripeRed = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.7 });
  const stripeWhite = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.7 });
  const curbSegments = 28; // per turn

  function placeCurbAlongArc(centerX, centerZ, startAngle, endAngle, radius) {
    const totalAng = endAngle - startAngle;
    const stepAng = totalAng / curbSegments;
    for (let i = 0; i < curbSegments; i++) {
      const a0 = startAngle + i * stepAng;
      const a1 = startAngle + (i + 1) * stepAng;
      const aMid = (a0 + a1) / 2;
      const x = centerX + Math.cos(aMid) * radius;
      const z = centerZ + Math.sin(aMid) * radius;
      // Segment length along arc
      const segLen = Math.hypot(
        Math.cos(a0) * radius - Math.cos(a1) * radius,
        Math.sin(a0) * radius - Math.sin(a1) * radius
      ) * 1.04;
      const tangentAngle = aMid + Math.PI / 2; // perpendicular to radial direction
      const mat = i % 2 === 0 ? stripeRed : stripeWhite;
      const curb = new THREE.Mesh(new THREE.BoxGeometry(segLen, 0.18, 1.2), mat);
      curb.position.set(x, 0.06, z);
      curb.rotation.y = -tangentAngle + Math.PI / 2;
      scene.add(curb);
    }
  }

  // Turn 1/2 (right side, inside edge): center at (+STRAIGHT_HALF, 0), inner radius = INNER_R - 0.6
  placeCurbAlongArc(TRACK.STRAIGHT_HALF, 0, -Math.PI / 2, Math.PI / 2, INNER_R - 0.6);
  // Turn 3/4 (left side, inside edge): center at (-STRAIGHT_HALF, 0)
  placeCurbAlongArc(-TRACK.STRAIGHT_HALF, 0, Math.PI / 2, 3 * Math.PI / 2, INNER_R - 0.6);
}

// ---- Infield road (paved loop inside the oval, for service vehicles) ----
{
  const roadMat = new THREE.MeshStandardMaterial({ color: 0x4a4a50, roughness: 0.85 });
  const loop = new THREE.Shape();
  buildStadiumPath(loop, TRACK.STRAIGHT_HALF * 0.55, INNER_R * 0.55);
  const hole = new THREE.Path();
  buildStadiumPath(hole, TRACK.STRAIGHT_HALF * 0.55, INNER_R * 0.55 - 4);
  loop.holes.push(hole);
  const geom = new THREE.ShapeGeometry(loop, 48);
  const mesh = new THREE.Mesh(geom, roadMat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.01;
  mesh.receiveShadow = true;
  scene.add(mesh);
}

// ---- Grass tone variations (overlay patches of slightly different greens) ----
{
  const tones = [0x5a9a4a, 0x3e7a3a, 0x6aa64a, 0x4a8a3a];
  for (let i = 0; i < 40; i++) {
    const tone = tones[i % tones.length];
    const mat = new THREE.MeshStandardMaterial({
      color: tone, roughness: 0.98, transparent: true, opacity: 0.45
    });
    const r = 14 + Math.random() * 28;
    const geom = new THREE.CircleGeometry(r, 18);
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = -Math.PI / 2;
    // Place inside the oval (small radius variance from center)
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.random() * (INNER_R - 30);
    mesh.position.set(Math.cos(ang) * dist, 0.005, Math.sin(ang) * dist);
    mesh.receiveShadow = true;
    scene.add(mesh);
  }
}

// ---- Sand traps / dirt patches at corner runoff areas (outside curbing) ----
{
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xc6a87a, roughness: 0.98 });
  for (const cx of [-TRACK.STRAIGHT_HALF, TRACK.STRAIGHT_HALF]) {
    for (let a = 0; a < 4; a++) {
      const ang = (a / 3 - 0.5) * Math.PI * 0.8 + (cx > 0 ? 0 : Math.PI);
      const r = INNER_R - 8 - Math.random() * 6;
      const x = cx + Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const mesh = new THREE.Mesh(
        new THREE.CircleGeometry(3 + Math.random() * 4, 12),
        sandMat
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.012, z);
      scene.add(mesh);
    }
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

// ============================================================
// INDYCAR (3D-3)
// ============================================================
// Open-wheel, single-seat racer. Procedural geometry built as a hierarchy
// under `car` so it moves/rotates as one unit. Local +Z is the front of the car.

const car = new THREE.Group();
const carPaint = new THREE.MeshStandardMaterial({
  color: 0xd63a3a, metalness: 0.4, roughness: 0.35
});
const carDark = new THREE.MeshStandardMaterial({
  color: 0x1a1a1a, metalness: 0.5, roughness: 0.5
});
const carCarbon = new THREE.MeshStandardMaterial({
  color: 0x2a2a2a, metalness: 0.2, roughness: 0.6
});
const carChrome = new THREE.MeshStandardMaterial({
  color: 0xcccccc, metalness: 0.9, roughness: 0.2
});
const carWindow = new THREE.MeshStandardMaterial({
  color: 0x223344, metalness: 0.8, roughness: 0.15
});
const carTire = new THREE.MeshStandardMaterial({
  color: 0x0a0a0a, roughness: 0.95
});
const carWingAccent = new THREE.MeshStandardMaterial({
  color: 0xffffff, metalness: 0.1, roughness: 0.5
});

// --- Main chassis (low, narrow tub) ---
{
  const main = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 4.2), carPaint);
  main.position.set(0, 0.55, 0);
  main.castShadow = true;
  car.add(main);

  // White stripe on top of chassis (livery accent)
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 4.0), carWingAccent);
  stripe.position.set(0, 0.84, 0);
  car.add(stripe);
}

// --- Nose cone (tapered) ---
{
  const nose = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.45, 1.4, 8),
    carPaint
  );
  nose.position.set(0, 0.55, 2.7);
  nose.rotation.x = Math.PI / 2;
  nose.castShadow = true;
  car.add(nose);
}

// --- Sidepods (wider mid-section with air intakes) ---
for (const sign of [-1, 1]) {
  const pod = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.5, 2.0), carPaint);
  pod.position.set(sign * 0.7, 0.5, -0.2);
  pod.castShadow = true;
  car.add(pod);

  // Intake mouth
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.05), carDark);
  intake.position.set(sign * 0.72, 0.55, 0.8);
  car.add(intake);
}

// --- Cockpit + driver halo ---
{
  // Cockpit opening (dark)
  const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.3, 0.9), carDark);
  cockpit.position.set(0, 0.95, 0.5);
  car.add(cockpit);

  // Driver helmet (dome)
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.22, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x222266, metalness: 0.2, roughness: 0.4 })
  );
  helmet.position.set(0, 1.0, 0.55);
  helmet.castShadow = true;
  car.add(helmet);

  // Helmet visor
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.36, 0.08, 0.04),
    carWindow
  );
  visor.position.set(0, 1.1, 0.76);
  car.add(visor);

  // Halo (driver protection ring — characteristic of modern IndyCar/F1)
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.05, 8, 24, Math.PI),
    carDark
  );
  halo.position.set(0, 1.3, 0.55);
  halo.rotation.x = Math.PI / 2;
  halo.rotation.y = Math.PI;
  car.add(halo);

  // Halo front pillar
  const pillar = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.5, 0.06),
    carDark
  );
  pillar.position.set(0, 1.05, 0.97);
  car.add(pillar);
}

// --- Engine air scoop above driver ---
{
  const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 1.2), carPaint);
  scoop.position.set(0, 1.15, -0.4);
  scoop.castShadow = true;
  car.add(scoop);

  // Roll hoop (dark)
  const hoop = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.5, 6),
    carDark
  );
  hoop.position.set(0, 1.35, -0.05);
  car.add(hoop);
}

// --- Front wing ---
{
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, 0.5), carDark);
  wing.position.set(0, 0.3, 3.2);
  wing.castShadow = true;
  car.add(wing);

  // Endplates
  for (const sign of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.3, 0.5), carWingAccent);
    ep.position.set(sign * 1.0, 0.4, 3.2);
    car.add(ep);
  }

  // Wing flap
  const flap = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.2), carPaint);
  flap.position.set(0, 0.4, 3.45);
  flap.rotation.x = -0.15;
  car.add(flap);
}

// --- Rear wing ---
{
  // Vertical endplates
  for (const sign of [-1, 1]) {
    const ep = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 0.6), carDark);
    ep.position.set(sign * 0.85, 1.1, -2.6);
    car.add(ep);
  }

  // Main plane (high)
  const main = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.45), carDark);
  main.position.set(0, 1.45, -2.6);
  main.castShadow = true;
  car.add(main);

  // Flap (angled)
  const flap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.06, 0.3), carPaint);
  flap.position.set(0, 1.32, -2.45);
  flap.rotation.x = -0.5;
  car.add(flap);

  // Lower beam wing
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 0.2), carDark);
  beam.position.set(0, 0.55, -2.6);
  car.add(beam);
}

// --- Exhaust pipes ---
for (const sign of [-1, 1]) {
  const exhaust = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 0.4, 6),
    carChrome
  );
  exhaust.position.set(sign * 0.15, 0.95, -2.0);
  exhaust.rotation.x = Math.PI / 2;
  car.add(exhaust);
}

// --- 4 exposed wheels (with rim spokes + brake disc + caliper) ---
{
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.34, 20);
  const sidewallGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.02, 20);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.36, 8);
  const hubGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.4, 8);
  const spokeGeo = new THREE.BoxGeometry(0.36, 0.04, 0.04);
  const brakeGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.04, 18);
  const caliperGeo = new THREE.BoxGeometry(0.1, 0.18, 0.18);

  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8b8b8, metalness: 0.75, roughness: 0.28 });
  const hubMat = new THREE.MeshStandardMaterial({ color: 0xf5d76e, metalness: 0.6, roughness: 0.35 });
  const sidewallMat = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, metalness: 0.4, roughness: 0.6 });
  const caliperMat = new THREE.MeshStandardMaterial({ color: 0xd63a3a, metalness: 0.5, roughness: 0.35 });

  const wheelPositions = [
    [-0.85, 0.42, 1.5, 'front'],
    [ 0.85, 0.42, 1.5, 'front'],
    [-0.85, 0.42, -1.6, 'rear'],
    [ 0.85, 0.42, -1.6, 'rear']
  ];

  for (const [x, y, z, kind] of wheelPositions) {
    const wheelGroup = new THREE.Group();
    // Tire body
    const tire = new THREE.Mesh(wheelGeo, carTire);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    wheelGroup.add(tire);
    // Sidewall accents (slightly visible from the side)
    for (const sgn of [-1, 1]) {
      const sw = new THREE.Mesh(sidewallGeo, sidewallMat);
      sw.rotation.z = Math.PI / 2;
      sw.position.x = sgn * 0.16;
      wheelGroup.add(sw);
    }
    // Rim (slightly inset from tire)
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.z = Math.PI / 2;
    wheelGroup.add(rim);
    // Hub (center cap)
    const hub = new THREE.Mesh(hubGeo, hubMat);
    hub.rotation.z = Math.PI / 2;
    wheelGroup.add(hub);
    // 5 rim spokes
    for (let s = 0; s < 5; s++) {
      const sp = new THREE.Mesh(spokeGeo, rimMat);
      sp.rotation.x = (s / 5) * Math.PI * 2;
      sp.position.x = 0; // along axle
      wheelGroup.add(sp);
    }
    // Brake disc (slightly outboard so it peeks through spokes)
    for (const sgn of [-1, 1]) {
      const brake = new THREE.Mesh(brakeGeo, brakeMat);
      brake.rotation.z = Math.PI / 2;
      brake.position.x = sgn * 0.14;
      wheelGroup.add(brake);
      // Red brake caliper at top of disc
      const caliper = new THREE.Mesh(caliperGeo, caliperMat);
      caliper.position.set(sgn * 0.14, 0.18, 0);
      wheelGroup.add(caliper);
    }
    wheelGroup.position.set(x, y, z);
    wheelGroup.userData = { kind, baseZ: z };
    car.add(wheelGroup);
  }
}

// --- Suspension push-rods (visible struts between chassis and wheels) ---
{
  const strutMat = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.35 });
  const positions = [
    { wheelX: -0.85, wheelZ: 1.5,  chassisX: -0.3, chassisZ: 1.5 },
    { wheelX:  0.85, wheelZ: 1.5,  chassisX:  0.3, chassisZ: 1.5 },
    { wheelX: -0.85, wheelZ: -1.6, chassisX: -0.3, chassisZ: -1.6 },
    { wheelX:  0.85, wheelZ: -1.6, chassisX:  0.3, chassisZ: -1.6 }
  ];
  for (const p of positions) {
    const dx = p.wheelX - p.chassisX;
    const len = Math.hypot(dx, 0.3);
    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.04, len, 6),
      strutMat
    );
    strut.position.set((p.wheelX + p.chassisX) / 2, 0.5, p.chassisZ);
    strut.rotation.z = Math.atan2(0.3, -dx) - Math.PI / 2;
    car.add(strut);
  }
}

// --- Mirrors (small wing-mounted side-pods near the cockpit) ---
for (const sign of [-1, 1]) {
  const mirror = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.15, 0.3),
    carPaint
  );
  mirror.position.set(sign * 0.55, 0.95, 0.3);
  car.add(mirror);
  // Mirror glass
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.18, 0.13),
    carWindow
  );
  glass.position.set(sign * 0.55, 0.95, 0.45);
  glass.rotation.y = sign * 0.2;
  car.add(glass);
  // Mirror stalk
  const stalk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.025, 0.3, 6),
    carDark
  );
  stalk.position.set(sign * 0.42, 0.85, 0.3);
  stalk.rotation.z = Math.PI / 2;
  car.add(stalk);
}

// --- Livery number panel on each sidepod (yellow with black "27") ---
{
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const cx = c.getContext('2d');
  cx.fillStyle = '#f5d76e';
  cx.beginPath();
  cx.arc(64, 64, 56, 0, Math.PI * 2);
  cx.fill();
  cx.fillStyle = '#111';
  cx.font = 'bold 90px Arial';
  cx.textAlign = 'center';
  cx.textBaseline = 'middle';
  cx.fillText('27', 64, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const liveryMat = new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.4 });
  for (const sign of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), liveryMat);
    panel.position.set(sign * 0.93, 0.5, -0.4);
    panel.rotation.y = sign * Math.PI / 2;
    car.add(panel);
  }
}

// --- Front wing endplate flaps (more visible detail) ---
for (const sign of [-1, 1]) {
  const flap = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.16, 0.45),
    carPaint
  );
  flap.position.set(sign * 1.05, 0.35, 3.2);
  car.add(flap);
}

// --- Rear wing endplate winglets (small horizontal wings on outside) ---
for (const sign of [-1, 1]) {
  const winglet = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.5),
    carPaint
  );
  winglet.position.set(sign * 0.86, 1.55, -2.55);
  car.add(winglet);
}

// --- Floor / underbody ---
{
  const floor = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 4.0), carCarbon);
  floor.position.set(0, 0.21, 0);
  car.add(floor);
  // Splitter at front
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.04, 0.3), carCarbon);
  splitter.position.set(0, 0.18, 2.5);
  car.add(splitter);
  // Diffuser at rear (angled)
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.7), carCarbon);
  diffuser.position.set(0, 0.4, -2.2);
  diffuser.rotation.x = -0.25;
  car.add(diffuser);
}

scene.add(car);

// Chase camera anchor — child of car for trivial position tracking.
const chaseAnchor = new THREE.Object3D();
chaseAnchor.position.set(0, 2.6, -8.5);
car.add(chaseAnchor);

const lookAnchor = new THREE.Object3D();
lookAnchor.position.set(0, 1.4, 4);
car.add(lookAnchor);

// ============================================================
// CAR / TRACK PLACEMENT
// ============================================================
// Rail-based motion: car position is parameterized by progress `u` around the
// centerline (0..1 per lap). Lateral offset `lane` puts the car off-center.
const CAR_STATE = {
  u: 0,           // [0, 1) progress around the lap
  lane: 0,        // lateral offset from centerline, in meters (positive = outside)
  speed: 0,       // forward speed, m/s
  facing: 0       // world-space heading (radians, 0 = +X direction)
};

// Compute the centerline radius and lap perimeter for converting speed → u/sec.
const CENTERLINE_R = (OUTER_R + INNER_R) / 2;
const LAP_PERIMETER = (TRACK.STRAIGHT_HALF * 2) * 2 + Math.PI * CENTERLINE_R * 2;

// Returns world (x, z) and tangent heading for a given lap-parameter u in [0,1).
// u increases COUNTER-CLOCKWISE viewed from above (true IMS race direction).
function pointAndHeadingAtU(u) {
  const norm = ((u % 1) + 1) % 1;
  // Counter-clockwise from front straight, heading west.
  // Segment plan:
  //   [0..s1]: front straight, x: 0 → -STRAIGHT_HALF, z = +CENTERLINE_R, heading = -X (PI)
  //   [s1..s2]: turn 3+4 (left arc), centered at -STRAIGHT_HALF
  //   [s2..s3]: back straight, x: -STRAIGHT_HALF → +STRAIGHT_HALF, z = -CENTERLINE_R, heading = +X (0)
  //   [s3..1]: turn 1+2 (right arc), centered at +STRAIGHT_HALF
  const straight = TRACK.STRAIGHT_HALF;
  const arc = Math.PI * CENTERLINE_R;
  const total = straight * 2 + arc * 2;
  const s1 = straight / total;
  const s2 = (straight + arc) / total;
  const s3 = (straight + arc + straight * 2) / total;

  let x, z, heading;
  if (norm < s1) {
    const v = norm / s1;
    x = -v * straight;
    z = CENTERLINE_R;
    heading = Math.PI; // moving -X
  } else if (norm < s2) {
    const v = (norm - s1) / (s2 - s1);
    const ang = Math.PI / 2 + v * Math.PI; // arc from top-left to bottom-left
    x = -straight + Math.cos(ang) * CENTERLINE_R;
    z = Math.sin(ang) * CENTERLINE_R;
    heading = ang + Math.PI / 2; // tangent direction along arc, CCW
  } else if (norm < s3) {
    const v = (norm - s2) / (s3 - s2);
    x = -straight + v * straight * 2;
    z = -CENTERLINE_R;
    heading = 0; // moving +X
  } else {
    const v = (norm - s3) / (1 - s3);
    const ang = -Math.PI / 2 + v * Math.PI; // arc from bottom-right to top-right
    x = straight + Math.cos(ang) * CENTERLINE_R;
    z = Math.sin(ang) * CENTERLINE_R;
    heading = ang + Math.PI / 2;
  }
  return { x, z, heading };
}

// Place the car at the start/finish line, ready to race.
function placeCarAtStart() {
  CAR_STATE.u = 0;
  CAR_STATE.lane = 0;
  CAR_STATE.speed = 0;
  applyCarTransform();
}

function applyCarTransform() {
  const p = pointAndHeadingAtU(CAR_STATE.u);
  // Lateral offset: perpendicular to heading
  const perpX = Math.cos(p.heading - Math.PI / 2);
  const perpZ = Math.sin(p.heading - Math.PI / 2);
  car.position.set(p.x + perpX * CAR_STATE.lane, 0, p.z + perpZ * CAR_STATE.lane);
  // Three.js: object's local +Z is "forward". Heading is angle in XZ plane from +X.
  // To align local +Z with the heading direction, rotation.y must be the angle
  // such that R_y(theta) * (0,0,1) = (cos(heading), 0, sin(heading)).
  // Solving: theta = -heading + PI/2  (working with right-handed coords)
  car.rotation.y = -p.heading + Math.PI / 2;
  CAR_STATE.facing = p.heading;
}

placeCarAtStart();

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
  const now = performance.now() / 1000;
  state.lap = 1;
  state.lapStartTime = now;
  state.lastLapTime = 0;
  state.bestLapTime = Infinity;
  state.score = 0;
  state.fuel = FUEL_MAX;
  state.speed = 0;
  state.pendingScore = 0;
  raceStartTime = now;
  placeCarAtStart();
  show(SCREEN.PLAYING);
  // Snap camera to chase position so it doesn't lerp from miles away.
  chaseAnchor.getWorldPosition(camera.position);
  lookAnchor.getWorldPosition(tmpLook);
  camera.lookAt(tmpLook);
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
// PARTICLES (G-6) — tire smoke + spark puffs
// ============================================================
const PARTICLE_COUNT = 100;
const _particlePositions = new Float32Array(PARTICLE_COUNT * 3);
const _particleColors = new Float32Array(PARTICLE_COUNT * 3);
const _particleSizes = new Float32Array(PARTICLE_COUNT);
const _particleState = [];
for (let i = 0; i < PARTICLE_COUNT; i++) {
  _particleState.push({ vx: 0, vy: 0, vz: 0, life: 0, max: 1 });
  _particlePositions[i * 3 + 1] = -1000; // start hidden far underground
}

function makeSmokeTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const cx = c.getContext('2d');
  const grad = cx.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const _particleGeo = new THREE.BufferGeometry();
_particleGeo.setAttribute('position', new THREE.BufferAttribute(_particlePositions, 3));
_particleGeo.setAttribute('color', new THREE.BufferAttribute(_particleColors, 3));
_particleGeo.setAttribute('aSize', new THREE.BufferAttribute(_particleSizes, 1));

const _particleMat = new THREE.PointsMaterial({
  size: 1.8,
  sizeAttenuation: true,
  vertexColors: true,
  map: makeSmokeTexture(),
  transparent: true,
  opacity: 0.7,
  depthWrite: false,
  blending: THREE.NormalBlending
});
const _particleSystem = new THREE.Points(_particleGeo, _particleMat);
scene.add(_particleSystem);

function emitParticle(x, y, z, color, lifeRange, velRange, sizeBoost = 1) {
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const s = _particleState[i];
    if (s.life <= 0) {
      s.max = lifeRange[0] + Math.random() * (lifeRange[1] - lifeRange[0]);
      s.life = s.max;
      s.vx = (Math.random() - 0.5) * velRange;
      s.vy = 0.6 + Math.random() * 1.6;
      s.vz = (Math.random() - 0.5) * velRange;
      _particlePositions[i * 3] = x;
      _particlePositions[i * 3 + 1] = y;
      _particlePositions[i * 3 + 2] = z;
      _particleColors[i * 3]     = color[0];
      _particleColors[i * 3 + 1] = color[1];
      _particleColors[i * 3 + 2] = color[2];
      _particleSizes[i] = sizeBoost;
      return;
    }
  }
}

function updateParticles(dt) {
  let anyAlive = false;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const s = _particleState[i];
    if (s.life <= 0) {
      _particlePositions[i * 3 + 1] = -1000;
      continue;
    }
    anyAlive = true;
    _particlePositions[i * 3]     += s.vx * dt;
    _particlePositions[i * 3 + 1] += s.vy * dt;
    _particlePositions[i * 3 + 2] += s.vz * dt;
    s.vy -= 1.2 * dt; // mild gravity
    s.vx *= (1 - 0.6 * dt);
    s.vz *= (1 - 0.6 * dt);
    s.life -= dt;
    const fade = Math.max(0, s.life / s.max);
    // fade color toward darker as smoke ages
    _particleColors[i * 3]     *= 0.995;
    _particleColors[i * 3 + 1] *= 0.995;
    _particleColors[i * 3 + 2] *= 0.995;
    // Implicit alpha-like effect via color * fade (since we use vertex colors)
    _particleColors[i * 3]     = Math.min(_particleColors[i * 3],     fade);
    _particleColors[i * 3 + 1] = Math.min(_particleColors[i * 3 + 1], fade);
    _particleColors[i * 3 + 2] = Math.min(_particleColors[i * 3 + 2], fade);
  }
  _particleGeo.attributes.position.needsUpdate = true;
  _particleGeo.attributes.color.needsUpdate = true;
}

// Helper: rear-wheel world positions for emitter origin.
const _rearLocalL = new THREE.Vector3(-0.85, 0.4, -1.6);
const _rearLocalR = new THREE.Vector3(0.85, 0.4, -1.6);
const _tmpWheel = new THREE.Vector3();
function emitTireSmoke(intensity) {
  for (const local of [_rearLocalL, _rearLocalR]) {
    _tmpWheel.copy(local).applyAxisAngle(new THREE.Vector3(0, 1, 0), car.rotation.y).add(car.position);
    const puffs = Math.ceil(intensity);
    for (let p = 0; p < puffs; p++) {
      emitParticle(
        _tmpWheel.x + (Math.random() - 0.5) * 0.4,
        _tmpWheel.y + 0.1,
        _tmpWheel.z + (Math.random() - 0.5) * 0.4,
        [0.95, 0.95, 0.97],
        [0.6, 1.1],
        1.5
      );
    }
  }
}

function emitSparkBurst(x, y, z) {
  for (let i = 0; i < 12; i++) {
    emitParticle(
      x + (Math.random() - 0.5) * 0.4,
      y + 0.5,
      z + (Math.random() - 0.5) * 0.4,
      [1.0, 0.6 + Math.random() * 0.3, 0.2],
      [0.3, 0.6],
      4.0,
      1
    );
  }
}

// ============================================================
// DRIVING PHYSICS (3D-4)
// ============================================================
const PHYS = {
  MAX_SPEED: 82,          // m/s (~183 mph)
  ACCEL: 24,              // m/s^2
  BRAKE: 42,              // m/s^2
  DRAG: 6,                // m/s^2 when no input
  OFF_TRACK_CAP: 32,      // m/s when off-track
  OFF_TRACK_SCRUB: 30,    // m/s^2 deceleration when off-track
  STEER_RATE: 7,          // m/s lateral speed at full input
  LANE_MAX: TRACK.WIDTH / 2 - 1.0, // hard wall lane
  BOOST_MULT: 1.25,       // boost speed multiplier
  BOOST_DRAIN: 1.8,       // extra fuel/sec while boosting
  FUEL_DRAIN_BASE: 0.75,  // fuel/sec at any speed
  FUEL_DRAIN_HIGH: 0.4,   // additional fuel/sec, scaled by speed/max
  WALL_FUEL_PENALTY: 12,
  WALL_SPEED_PENALTY: 0.45 // multiply speed by this on wall hit
};

let wallCooldown = 0;
let raceStartTime = 0;

function updateDriving(dt) {
  // ---- Input ----
  const wantThrottle = state.keys.has('Space') || state.keys.has('KeyW') || state.keys.has('ArrowUp');
  const wantBrake = state.keys.has('KeyS') || state.keys.has('ArrowDown');
  const wantLeft = state.keys.has('KeyA') || state.keys.has('ArrowLeft');
  const wantRight = state.keys.has('KeyD') || state.keys.has('ArrowRight');
  const wantBoost = (state.keys.has('ShiftLeft') || state.keys.has('ShiftRight')) && state.fuel > 5;

  // ---- Longitudinal physics ----
  if (wantBrake) {
    CAR_STATE.speed -= PHYS.BRAKE * dt;
  } else if (wantThrottle) {
    const target = wantBoost ? PHYS.MAX_SPEED * PHYS.BOOST_MULT : PHYS.MAX_SPEED;
    CAR_STATE.speed += PHYS.ACCEL * dt;
    if (CAR_STATE.speed > target) CAR_STATE.speed = target;
  } else {
    CAR_STATE.speed -= PHYS.DRAG * dt;
  }
  // Off-track scrub
  const offTrack = Math.abs(CAR_STATE.lane) > TRACK.WIDTH / 2 - 0.5;
  if (offTrack && CAR_STATE.speed > PHYS.OFF_TRACK_CAP) {
    CAR_STATE.speed -= PHYS.OFF_TRACK_SCRUB * dt;
  }
  if (CAR_STATE.speed < 0) CAR_STATE.speed = 0;

  // ---- Steering (lane offset) ----
  if (wantLeft) CAR_STATE.lane -= PHYS.STEER_RATE * dt;
  if (wantRight) CAR_STATE.lane += PHYS.STEER_RATE * dt;
  // Gentle auto-center bias when no input
  if (!wantLeft && !wantRight) {
    const center = -CAR_STATE.lane * 0.5 * dt;
    CAR_STATE.lane += center;
  }

  // ---- Wall collision ----
  if (Math.abs(CAR_STATE.lane) > PHYS.LANE_MAX && wallCooldown <= 0) {
    CAR_STATE.lane = Math.sign(CAR_STATE.lane) * PHYS.LANE_MAX;
    CAR_STATE.speed *= PHYS.WALL_SPEED_PENALTY;
    state.fuel -= PHYS.WALL_FUEL_PENALTY;
    wallCooldown = 0.5;
    flashHud();
    emitSparkBurst(car.position.x, car.position.y, car.position.z);
  }
  wallCooldown = Math.max(0, wallCooldown - dt);

  // ---- Advance around the lap ----
  const prevU = CAR_STATE.u;
  const du = (CAR_STATE.speed * dt) / LAP_PERIMETER;
  CAR_STATE.u = (CAR_STATE.u + du) % 1;

  // Lap completion: u wrapped from near-1 back to near-0
  if (prevU > 0.9 && CAR_STATE.u < 0.1) {
    onLapCompleted();
  }

  // ---- Apply to transform ----
  applyCarTransform();

  // ---- Wheel spin ----
  const wheelOmega = CAR_STATE.speed / 0.42; // rad/sec
  car.children.forEach((child) => {
    if (child.userData && child.userData.kind) {
      child.rotation.x -= wheelOmega * dt;
    }
  });

  // ---- Tire smoke (G-6) ----
  // Emit lightly when accelerating at low speeds (wheelspin) and continuously when boosting.
  if (wantBoost) {
    emitTireSmoke(1.4);
  } else if (wantThrottle && CAR_STATE.speed < 25 && CAR_STATE.speed > 1) {
    emitTireSmoke(0.6);
  } else if (offTrack && CAR_STATE.speed > 15) {
    emitTireSmoke(0.8);
  }

  // ---- Fuel + score ----
  const speedFrac = CAR_STATE.speed / PHYS.MAX_SPEED;
  const drain = PHYS.FUEL_DRAIN_BASE + PHYS.FUEL_DRAIN_HIGH * speedFrac + (wantBoost ? PHYS.BOOST_DRAIN : 0);
  state.fuel -= drain * dt;
  state.score += CAR_STATE.speed * dt; // 1 point per meter traveled

  if (state.fuel <= 0) {
    state.fuel = 0;
    show(SCREEN.GAMEOVER);
    const pct = Math.round(((state.lap - 1) / LAPS_TO_WIN) * 100);
    document.getElementById('go-summary').textContent =
      `You completed ${state.lap - 1} of ${LAPS_TO_WIN} laps (${pct}%).`;
    document.getElementById('go-score').textContent = pad(state.score, 6);
    state.pendingScore = state.score;
  }
}

function onLapCompleted() {
  const now = performance.now() / 1000;
  const lapTime = now - state.lapStartTime;
  state.lastLapTime = lapTime;
  if (lapTime < state.bestLapTime) state.bestLapTime = lapTime;
  state.lapStartTime = now;
  // Bonuses
  state.score += 1000;
  if (lapTime < 30) state.score += Math.max(0, 800 - (lapTime - 15) * 30);
  state.lap += 1;
  if (state.lap > LAPS_TO_WIN) {
    show(SCREEN.WIN);
    const total = now - raceStartTime;
    document.getElementById('win-summary').textContent =
      `Finished ${LAPS_TO_WIN} laps in ${formatTime(total)}. Best lap: ${formatTime(state.bestLapTime)}.`;
    document.getElementById('win-score').textContent = pad(state.score, 6);
    state.pendingScore = state.score;
  }
}

function formatTime(seconds) {
  if (!isFinite(seconds)) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function flashHud() {
  const fuel = document.getElementById('hud-fuel');
  if (!fuel) return;
  fuel.parentElement.style.transition = 'background 0.05s';
  fuel.parentElement.style.background = 'rgba(232, 90, 26, 0.5)';
  setTimeout(() => {
    fuel.parentElement.style.background = '';
  }, 200);
}

function updateHUD() {
  document.getElementById('hud-lap').textContent = `${Math.min(state.lap, LAPS_TO_WIN)} / ${LAPS_TO_WIN}`;
  document.getElementById('hud-last').textContent = state.lastLapTime ? formatTime(state.lastLapTime) : '--:--.---';
  document.getElementById('hud-best').textContent = state.bestLapTime < Infinity ? formatTime(state.bestLapTime) : '--:--.---';
  document.getElementById('hud-score').textContent = pad(state.score, 6);
  const mph = Math.round(CAR_STATE.speed * 2.237);
  document.getElementById('hud-mph').textContent = String(mph);
  const fuelPct = Math.max(0, state.fuel) / FUEL_MAX;
  const fuelEl = document.getElementById('hud-fuel');
  fuelEl.style.width = `${fuelPct * 100}%`;
  fuelEl.classList.toggle('low', fuelPct < 0.25);
  fuelEl.classList.toggle('mid', fuelPct >= 0.25 && fuelPct < 0.5);
}

// ============================================================
// MAIN LOOP
// ============================================================
const TITLE_CAM_POS = new THREE.Vector3(-160, 32, 60);
const TITLE_CAM_LOOK = new THREE.Vector3(120, 18, 105);
const tmpVec = new THREE.Vector3();
const tmpLook = new THREE.Vector3();

function tick() {
  const dt = Math.min(0.05, state.clock.getDelta());
  const elapsed = state.clock.getElapsedTime();

  if (state.screen === SCREEN.PLAYING) {
    updateDriving(dt);
    updateChaseCamera(dt);
    updateHUD();
  } else {
    updateTitleCamera(elapsed);
  }
  updateParticles(dt);

  composer.render();
  requestAnimationFrame(tick);
}

// Debug hook for headless preview (where rAF is throttled when the tab is hidden).
// Lets tests force-step the simulation. Safe to keep in prod — it's only data.
window.__dbg = { camera, car, state, CAR_STATE, chaseAnchor, lookAnchor, SCREEN,
  step(dtOverride = 0.016) {
    const dt = dtOverride;
    if (state.screen === SCREEN.PLAYING) {
      updateDriving(dt);
      updateChaseCamera(dt);
      updateHUD();
    } else {
      updateTitleCamera(performance.now() / 1000);
    }
    updateParticles(dt);
    composer.render();
  }
};

function updateTitleCamera(t) {
  // Slow orbital drift around the establishing position for a cinematic title shot.
  const wobble = Math.sin(t * 0.15) * 12;
  camera.position.set(
    TITLE_CAM_POS.x + wobble,
    TITLE_CAM_POS.y,
    TITLE_CAM_POS.z + Math.cos(t * 0.15) * 6
  );
  camera.lookAt(TITLE_CAM_LOOK);
}

const CHASE_FOV_BASE = 55;
const CHASE_FOV_BOOST = 12; // additional FOV at top speed for sense of speed

function updateChaseCamera(dt) {
  chaseAnchor.getWorldPosition(tmpVec);
  lookAnchor.getWorldPosition(tmpLook);
  camera.position.lerp(tmpVec, 1 - Math.pow(0.001, dt));
  camera.lookAt(tmpLook);

  // Speed-driven FOV: subtle widening pushes the world past the camera at speed.
  const speedFrac = Math.min(1, CAR_STATE.speed / PHYS.MAX_SPEED);
  const targetFov = CHASE_FOV_BASE + speedFrac * CHASE_FOV_BOOST;
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();
}

// Window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  bloomPass.setSize(window.innerWidth, window.innerHeight);
  smaaPass.setSize(window.innerWidth, window.innerHeight);
});

// ============================================================
// BOOT
// ============================================================
state.scores = loadScores();
applyScreen();
requestAnimationFrame(tick);
