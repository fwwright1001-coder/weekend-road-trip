// ============================================================
// render3d.js — Three.js chase-camera renderer for Weekend Road Trip
// ------------------------------------------------------------
// This module draws the SAME simulation that game.js already runs. It does not
// own any game logic: every frame it reads window.__roadtrip (the read-only
// bridge published by game.js) and positions 3D objects from that state.
//
// MODE BINDING (T key): game.js owns the T key — toggleCameraMode() flips
// state.cameraMode between 'side' and 'chase'. This module POLLS that field:
//   chase + (PLAYING|PAUSED) + WebGL OK  ->  3D renderer active
//   anything else                        ->  2D canvas renderer
// The swap is a fast opacity crossfade on #game3d (CSS in the RT3D block at
// the END of styles.css). The 2D pseudo-3D chase view in game.js remains the
// no-WebGL / no-CDN fallback: if this module fails to import (CDN down) or
// WebGL init throws, the game never knows 3D existed.
//
// Coordinate mapping from the 2D side-scroller to the 3D road:
//   2D screen x (obstacles scroll right -> left)  ->  3D depth Z (far -> near)
//   entity .lane (0 near / 1 center / 2 far)      ->  3D lateral X (left/mid/right)
//   2D screen y (GROUND_Y = road, smaller = up)   ->  3D height Y
//   biomeIdx + biomeBlend()                       ->  sky / fog / sun / ground
//
// Look: "polished stylized" — clean low-poly shapes, PCFSoft shadows, ACES
// tone mapping, gradient sky dome, clearcoat car paint, biome-aware sun.
// If anything here throws during render, game.js disables 3D and falls back.
// ============================================================
import * as THREE from 'three';

// Public handle game.js looks for (see the render() delegate in game.js).
const RT = {
  enabled: false,   // game.js early-returns to renderFrame() when true && ready
  ready: false,
  render: renderFrame,
};
window.RT3D = RT;

// ---- tunables (eyeball these; they drive the whole look) -------------------
const SCALE = 0.05;      // pixels -> world units for sizes / heights
const SCALE_Z = 0.06;    // pixels -> world units for depth (distance ahead)
const ROAD_HALF = 6.0;   // half width of the asphalt
const LANE_W = 3.1;      // lateral spacing of the three lanes (lane-1)*LANE_W
const LANE_TWEEN = 0.16; // mirror of LANE_TWEEN_DUR in game.js (cosmetic only)
const SEMI_X = -4.55;    // oncoming semis run down the far-left edge
const DASH_GAP = 6;      // spacing of lane-boundary dashes (world units)
const DASH_SPAN = 108;   // total scroll length before a dash recycles
const Z_NEAR = 16;       // nearest road point (behind the car a little)
const Z_FAR = -110;      // farthest visible road point
// Behind-the-car chase camera: above + behind, looking down the road.
const CAM_POS = { x: 0, y: 3.6, z: 10 };
const CAM_LOOK = { x: 0, y: 1.4, z: -22 };
const FOV_BASE = 55, FOV_GAIN = 12;
const SCN_COUNT = 20;    // roadside props per side
const SCN_GAP = 16;      // spacing between props (world units)
const SCN_SPAN = 320;    // scroll length before a prop recycles into the distance
// Sun direction + intensity per biome leg (dawn / morning / afternoon / sunset).
const SUN_POS = [
  [16, 12, -30],  // DOWNTOWN  — dawn, low-ish to the right
  [10, 20, -22],  // MUSIC ROW — morning, climbing
  [-12, 22, -14], // CUMBERLAND— afternoon, high left
  [-17, 9, -38],  // BROADWAY  — sunset, low left
];
const SUN_INT = [2.0, 2.2, 2.1, 1.8];

// ---- module state ----------------------------------------------------------
let bridge = null;          // window.__roadtrip
let C = null;               // bridge.consts (W, GROUND_Y, PLAYER_X, ...)
let scene, camera, renderer, car, wheels = [], cabin = null;
let hemi, sun, skyMat, bodyMat, stripeMat, shadowMesh, driverGrp;
let initialized = false;
let permFail = false;       // WebGL/init/render failed once -> stay 2D forever
let lastApplied = false;    // mode we last applied (crossfade state)
const dashes = [], posts = [], scnSlots = [];
let lastBiomeIdx = -1;
let lastLivery = '';
let lastT = 0;
const statusEl = () => document.getElementById('rt3d-status');

// Shared geometries / materials (built once, reused by every pooled mesh).
let G = {}, M = {};
// Per-type object pools so we never allocate meshes inside the frame loop.
const pools = {};

// Scratch objects for per-frame blending (avoid per-frame allocation).
const _ca = new THREE.Color(), _cb = new THREE.Color(), _out = new THREE.Color();
const _sunA = new THREE.Vector3(), _sunB = new THREE.Vector3();
const camCur = { x: CAM_POS.x, y: CAM_POS.y };
const lookCur = { x: CAM_LOOK.x };

// ============================================================
// COORDINATE HELPERS
// ============================================================
function zForX(x) { return (C.PLAYER_X - x) * SCALE_Z; }            // ahead -> -Z
function laneX(lane) { return ((lane == null ? 1 : lane) - 1) * LANE_W; }
function worldH(px) { return px * SCALE; }                          // size
// World Y of an entity's vertical centre, given its 2D top y and height.
function centreY(y, h) { return (C.GROUND_Y - (y + h / 2)) * SCALE; }

// Smoothed lane value (0..2) replicating chaseLaneValue() in game.js.
function laneValue(p) {
  if (p.laneTweenT > 0) {
    const prog = Math.max(0, Math.min(1, 1 - p.laneTweenT / LANE_TWEEN));
    const eased = 0.5 - Math.cos(prog * Math.PI) * 0.5;
    return p.lane + (p.laneTarget - p.lane) * eased;
  }
  return p.lane;
}

// Effective biome colour for a property, blended toward the neighbouring biome
// exactly like game.js's blendedBiomeColor(). `i` indexes into array props.
function biomeColor(prop, i = 0) {
  const cur = bridge.currentBiome();
  const idx = bridge.state.biomeIdx;
  const blend = bridge.biomeBlend();
  const BIOMES = bridge.BIOMES;
  const pick = (b) => (Array.isArray(b[prop]) ? b[prop][i] : b[prop]);
  _ca.set(pick(cur));
  if (blend > 0) {
    _cb.set(pick(BIOMES[Math.min(idx + 1, BIOMES.length - 1)]));
    return _out.lerpColors(_ca, _cb, blend);
  }
  if (blend < 0) {
    _cb.set(pick(BIOMES[Math.max(idx - 1, 0)]));
    return _out.lerpColors(_ca, _cb, -blend);
  }
  return _out.copy(_ca);
}

// Biome-blended sun direction + intensity (warm directional key light).
function applySunForBiome() {
  const idx = bridge.state.biomeIdx;
  const blendRaw = bridge.biomeBlend();
  let a = idx, b = idx, t = 0;
  if (blendRaw > 0) { b = Math.min(idx + 1, SUN_POS.length - 1); t = blendRaw; }
  else if (blendRaw < 0) { b = Math.max(idx - 1, 0); t = -blendRaw; }
  _sunA.fromArray(SUN_POS[Math.min(a, SUN_POS.length - 1)]);
  _sunB.fromArray(SUN_POS[Math.min(b, SUN_POS.length - 1)]);
  _sunA.lerp(_sunB, t);
  sun.position.copy(_sunA);
  sun.intensity = SUN_INT[Math.min(a, SUN_INT.length - 1)] * (1 - t) +
                  SUN_INT[Math.min(b, SUN_INT.length - 1)] * t;
}

// ============================================================
// POOLING — reuse meshes per type, just toggle .visible each frame
// ============================================================
function poolGet(type) {
  const p = pools[type] || (pools[type] = { items: [], idx: 0 });
  if (p.idx >= p.items.length) {
    const factory = make[type] || make.snack;   // unknown type -> safe placeholder
    const m = factory();
    m.traverse((o) => {
      if (o.isMesh) { o.castShadow = type !== 'pothole'; o.receiveShadow = type === 'pothole'; }
    });
    scene.add(m);
    p.items.push(m);
  }
  const m = p.items[p.idx++];
  m.visible = true;
  return m;
}
function poolReset() { for (const k in pools) pools[k].idx = 0; }
function poolHideRest() {
  for (const k in pools) {
    const p = pools[k];
    for (let i = p.idx; i < p.items.length; i++) p.items[i].visible = false;
  }
}

// ============================================================
// MESH BUILDERS (one factory per entity type; share G/M resources)
// ============================================================
const make = {
  pothole() {
    const g = new THREE.Group();
    const m = new THREE.Mesh(G.pothole, M.pothole);
    m.rotation.x = -Math.PI / 2;
    const rim = new THREE.Mesh(G.potholeRim, M.potholeRim);
    rim.rotation.x = -Math.PI / 2; rim.position.y = -0.004;
    g.add(rim, m);
    return g;
  },
  cone() {
    // Traffic cone with a white reflective band — unmistakable "jump me".
    const g = new THREE.Group();
    const body = new THREE.Mesh(G.cone, M.cone); body.position.y = 0.7;
    const band = new THREE.Mesh(G.coneBand, M.coneBand); band.position.y = 0.72;
    const base = new THREE.Mesh(G.coneBase, M.coneDark); base.position.y = 0.05;
    g.add(body, band, base);
    return g;
  },
  sign() {
    // Per-lane low-clearance sign: panel at head height over ITS lane — duck under.
    const g = new THREE.Group();
    const lp = new THREE.Mesh(G.post, M.signPost); lp.position.set(-1.1, 1.05, 0);
    const rp = new THREE.Mesh(G.post, M.signPost); rp.position.set(1.1, 1.05, 0);
    const panel = new THREE.Mesh(G.signPanel, M.signPanel); panel.position.y = 1.72;
    const trim = new THREE.Mesh(G.signTrim, M.signTrim); trim.position.y = 1.72; trim.position.z = 0.012;
    g.add(lp, rp, panel, trim);
    return g;
  },
  fuel() {
    const g = new THREE.Group();
    const can = new THREE.Mesh(G.fuel, M.fuel);
    const spout = new THREE.Mesh(G.spout, M.fuel); spout.position.set(0.18, 0.45, 0);
    const cross = new THREE.Mesh(G.fuelCross, M.fuelCross); cross.position.z = 0.26;
    g.add(can, spout, cross);
    return g;
  },
  snack() { return new THREE.Mesh(G.snack, M.snack); },
  nitro() {
    // Nitro canister — cool blue tank with a glowing core (fixes the missing
    // factory that crashed the old renderer the first time a nitro spawned).
    const g = new THREE.Group();
    const tank = new THREE.Mesh(G.nitro, M.nitro);
    const core = new THREE.Mesh(G.nitroCore, M.nitroCore);
    g.add(tank, core);
    return g;
  },
  pitstop() {
    const g = new THREE.Group();
    const lp = new THREE.Mesh(G.archPost, M.pit); lp.position.set(-ROAD_HALF + 0.5, 1.6, 0);
    const rp = new THREE.Mesh(G.archPost, M.pit); rp.position.set(ROAD_HALF - 0.5, 1.6, 0);
    const beam = new THREE.Mesh(G.beam, M.pit); beam.position.y = 3.2;
    const banner = new THREE.Mesh(G.pitBanner, M.pitBanner); banner.position.y = 2.75;
    g.add(lp, rp, beam, banner);
    return g;
  },
  semi() {
    // Oncoming box truck: cab faces +Z (toward the camera), runs the left edge.
    const g = new THREE.Group();
    const trailer = new THREE.Mesh(G.semiTrailer, M.semiTrailer); trailer.position.set(0, 1.65, -0.7);
    const cabMat = M.semiCab.clone();
    const cab = new THREE.Mesh(G.semiCab, cabMat); cab.position.set(0, 1.05, 2.7);
    const glass = new THREE.Mesh(G.semiGlass, M.glassDark); glass.position.set(0, 1.55, 3.42);
    const hl1 = new THREE.Mesh(G.semiLamp, M.headlamp); hl1.position.set(-0.7, 0.7, 3.55);
    const hl2 = new THREE.Mesh(G.semiLamp, M.headlamp); hl2.position.set(0.7, 0.7, 3.55);
    g.add(trailer, cab, glass, hl1, hl2);
    for (const [x, z] of [[-1.0, 2.6], [1.0, 2.6], [-1.0, -1.6], [1.0, -1.6], [-1.0, -2.9], [1.0, -2.9]]) {
      const w = new THREE.Mesh(G.semiWheel, M.tire); w.position.set(x, 0.55, z);
      g.add(w);
    }
    g.userData.cabMat = cabMat;
    return g;
  },
};

// ============================================================
// THE CAR — low-poly convertible facing -Z; livery read live from state
// ============================================================
function buildCar() {
  const g = new THREE.Group();
  bodyMat = new THREE.MeshPhysicalMaterial({ color: 0xc81e28, roughness: 0.28, metalness: 0.1, clearcoat: 0.9, clearcoatRoughness: 0.18 });
  stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.85, roughness: 0.3 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, roughness: 0.08, metalness: 0.0, transparent: true, opacity: 0.45 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3838, emissive: 0xcc1010, emissiveIntensity: 1.3, roughness: 0.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.4 });

  // main hull: lower body + raised hood + rear deck + dark rocker
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.6, 4.1), bodyMat); hull.position.y = 0.62;
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.32, 1.5), bodyMat); hood.position.set(0, 0.86, -1.25);
  const rear = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.4, 1.2), bodyMat); rear.position.set(0, 0.9, 1.35);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.08, 0.28, 3.4), dark); sill.position.y = 0.4;
  // racing stripe down hood + rear deck (honors the run's livery)
  const stripeH = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 1.52), stripeMat); stripeH.position.set(0, 1.04, -1.25);
  const stripeR = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.04, 1.22), stripeMat); stripeR.position.set(0, 1.12, 1.35);

  // open cockpit: a dark recessed tub with two seats, a windshield + a rollbar
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.9), dark); tub.position.set(0, 0.95, 0.15);
  const seatL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.6), dark); seatL.position.set(-0.4, 1.18, 0.45);
  const seatR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 0.6), dark); seatR.position.set(0.4, 1.18, 0.45);
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.5, 0.08), glass); wind.position.set(0, 1.3, -0.75); wind.rotation.x = -0.35;
  cabin = wind; // hidden on duck (see renderFrame)
  const barL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), chrome); barL.position.set(-0.55, 1.35, 0.95);
  const barR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), chrome); barR.position.set(0.55, 1.35, 0.95);
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(1.22, 0.12, 0.12), chrome); barTop.position.set(0, 1.55, 0.95);

  // driver figure (Marty) — torso + head + cap, sat in the left seat
  driverGrp = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a066, roughness: 0.8 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0x355a8c, roughness: 0.85 });
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.3), shirt); torso.position.y = 0.25;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 10), skin); head.position.y = 0.62;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.09, 12), new THREE.MeshStandardMaterial({ color: 0xa83232, roughness: 0.8 })); cap.position.y = 0.74;
  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), shirt); armL.position.set(-0.18, 0.32, -0.18); armL.rotation.x = 0.7;
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), shirt); armR.position.set(0.18, 0.32, -0.18); armR.rotation.x = 0.7;
  driverGrp.add(torso, head, cap, armL, armR);
  driverGrp.position.set(-0.4, 1.05, 0.35);

  // lights + bumpers (front = -Z, rear = +Z)
  const tl1 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl1.position.set(-0.6, 0.78, 2.06);
  const tl2 = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.08), tail); tl2.position.set(0.6, 0.78, 2.06);
  const hl1 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl1.position.set(-0.62, 0.78, -2.06);
  const hl2 = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.2, 0.08), lamp); hl2.position.set(0.62, 0.78, -2.06);
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.2), dark); bumperF.position.set(0, 0.5, -2.05);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.22, 0.2), dark); bumperR.position.set(0, 0.5, 2.05);

  g.add(sill, hull, hood, rear, stripeH, stripeR, tub, seatL, seatR, wind, barL, barR, barTop, driverGrp, tl1, tl2, hl1, hl2, bumperF, bumperR);

  // wheels — protrude beyond the body, light rims + a spoke so spin reads
  const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.38, 20); wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.26, 0.26, 0.4, 16); rimGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.42, 0.09, 0.52);
  const wp = [[-1.06, -1.4], [1.06, -1.4], [-1.06, 1.45], [1.06, 1.45]];
  wheels = [];
  for (const [x, z] of wp) {
    const w = new THREE.Group(); w.position.set(x, 0.5, z);
    const tire = new THREE.Mesh(wheelGeo, M.tire);
    const rim = new THREE.Mesh(rimGeo, chrome);
    const spoke = new THREE.Mesh(spokeGeo, chrome);
    w.add(tire, rim, spoke);
    g.add(w);
    wheels.push(w);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ============================================================
// ROADSIDE SCENERY — Nashville legs: DOWNTOWN towers, MUSIC ROW houses,
// CUMBERLAND pines + river rocks, BROADWAY neon honky-tonks.
// ============================================================
function buildProp(name) {
  const g = new THREE.Group();
  const rnd = (a, b) => a + Math.random() * (b - a);
  if (name === 'DOWNTOWN') {
    const h = rnd(6, 17), w = rnd(3, 6), d = rnd(3, 6);
    const tone = [0x4a4e5a, 0x53506a, 0x3e4a5c, 0x615a52][(Math.random() * 4) | 0];
    const lit = Math.random() < 0.5;
    const mat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.85, emissive: lit ? 0x2a2620 : 0x070808, emissiveIntensity: lit ? 0.5 : 1 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.y = h / 2; g.add(b);
    if (Math.random() < 0.5) { const caph = rnd(1, 3); const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, caph, d * 0.5), mat); cap.position.y = h + caph / 2; g.add(cap); }
  } else if (name === 'MUSIC ROW') {
    // low brick studio-houses with pitched roofs, the odd tree between them
    if (Math.random() < 0.65) {
      const hw = rnd(2.6, 4), hh = rnd(2.2, 3.4), hd = rnd(2.6, 4);
      const brick = [0x8c5a48, 0x9c6a50, 0x7a6258, 0xa88a6a][(Math.random() * 4) | 0];
      const body = new THREE.Mesh(new THREE.BoxGeometry(hw, hh, hd), new THREE.MeshStandardMaterial({ color: brick, roughness: 0.95 }));
      body.position.y = hh / 2; g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(hw, hd) * 0.75, rnd(1, 1.7), 4), new THREE.MeshStandardMaterial({ color: 0x3a3236, roughness: 1, flatShading: true }));
      roof.position.y = hh + 0.55; roof.rotation.y = Math.PI / 4; g.add(roof);
    } else {
      const th = rnd(1.2, 2);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, th, 7), new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 }));
      trunk.position.y = th / 2; g.add(trunk);
      const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(1.2, 1.9), 0), new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 1, flatShading: true }));
      crown.position.y = th + 1.1; g.add(crown);
    }
  } else if (name === 'CUMBERLAND') {
    // riverfront: pines + grey rocks
    if (Math.random() < 0.7) {
      const th = rnd(1, 1.8);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, th, 7), new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 }));
      trunk.position.y = th / 2; g.add(trunk);
      const green = new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 1 });
      const ch = rnd(2.5, 4.2);
      const c1 = new THREE.Mesh(new THREE.ConeGeometry(rnd(1.1, 1.8), ch, 8), green); c1.position.y = th + ch / 2 - 0.2; g.add(c1);
      const c2 = new THREE.Mesh(new THREE.ConeGeometry(rnd(0.8, 1.2), ch * 0.7, 8), green); c2.position.y = th + ch * 0.9; g.add(c2);
    } else {
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(rnd(1, 2.2), 0), new THREE.MeshStandardMaterial({ color: 0x6b6e72, roughness: 1, flatShading: true }));
      rock.position.y = rnd(0.2, 0.6); rock.scale.y = rnd(0.5, 0.9); g.add(rock);
    }
  } else { // BROADWAY — neon honky-tonk blocks
    const h = rnd(4, 9), w = rnd(3, 5.5), d = rnd(3, 5);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2c2436, roughness: 0.9, emissive: 0x14101e, emissiveIntensity: 1 });
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.y = h / 2; g.add(b);
    const neon = [0xff2d95, 0x2de6ff, 0xffd23f, 0x9d4edd][(Math.random() * 4) | 0];
    const sign = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, rnd(1.6, Math.max(1.8, h * 0.55)), 0.55),
      new THREE.MeshStandardMaterial({ color: neon, emissive: neon, emissiveIntensity: 1.6, roughness: 0.4 }));
    sign.position.set(-(w / 2) - 0.18, h * 0.55, 0); g.add(sign);
    if (Math.random() < 0.6) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.8, 0.22, 0.18),
        new THREE.MeshStandardMaterial({ color: 0xffe9a0, emissive: 0xffd76a, emissiveIntensity: 1.3 }));
      strip.position.set(0, rnd(1.4, h - 0.6), d / 2 + 0.1); g.add(strip);
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// Rebuild every slot's prop for the given biome (called on biome change only).
function rebuildScenery(name) {
  for (const grp of scnSlots) {
    for (let j = grp.children.length - 1; j >= 0; j--) {
      const child = grp.children[j];
      grp.remove(child);
      child.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    }
    grp.add(buildProp(name));
  }
}

// ============================================================
// INIT — build the scene once (eager at boot so the first T is instant)
// ============================================================
function ensureInit() {
  if (initialized) return true;
  bridge = window.__roadtrip;
  if (!bridge) return false;              // game.js not booted yet; try next frame
  C = bridge.consts;

  const canvas = document.getElementById('game3d');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Filmic ACES + a hair of extra exposure: rich saturated sunsets without
  // clipping. The sky-dome shader applies the same tone mapping + colourspace
  // chunks, so the horizon still meets the fogged ground without a seam.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9bc3e0');
  scene.fog = new THREE.Fog('#9bc3e0', 55, 420);

  camera = new THREE.PerspectiveCamera(FOV_BASE, 16 / 9, 0.1, 2200);
  camera.position.set(CAM_POS.x, CAM_POS.y, CAM_POS.z);
  camera.lookAt(CAM_LOOK.x, CAM_LOOK.y, CAM_LOOK.z);

  // Gradient sky dome. The tonemapping/colorspace includes keep it consistent
  // with the ACES-mapped, fogged meshes so the horizon blend stays clean.
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color('#9bc3e0') },
      horizonColor: { value: new THREE.Color('#fde4b8') },
      exponent: { value: 2.6 },
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: [
      'varying vec3 vDir; uniform vec3 topColor; uniform vec3 horizonColor; uniform float exponent;',
      'void main(){',
      '  float t = pow(clamp(vDir.y, 0.0, 1.0), exponent);',
      '  gl_FragColor = vec4(mix(horizonColor, topColor, t), 1.0);',
      '  #include <tonemapping_fragment>',
      '  #include <colorspace_fragment>',
      '}',
    ].join('\n'),
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1600, 32, 16), skyMat));

  // Lighting: soft sky/ground ambient + a shadow-casting biome-aware sun.
  hemi = new THREE.HemisphereLight(0xffffff, 0x3a3a40, 1.0);
  scene.add(hemi);
  sun = new THREE.DirectionalLight(0xfff0c0, 1.7);
  sun.position.set(-12, 18, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.camera.near = -40;
  sun.shadow.camera.far = 80;
  sun.shadow.camera.left = -24;
  sun.shadow.camera.right = 24;
  sun.shadow.camera.top = 30;
  sun.shadow.camera.bottom = -30;
  scene.add(sun);
  scene.add(sun.target);   // defaults to (0,0,0) — the car's plane

  // --- road + shoulders + guardrails ---
  const roadLen = Z_NEAR - Z_FAR;
  const roadCz = (Z_NEAR + Z_FAR) / 2;
  M.road = new THREE.MeshStandardMaterial({ color: '#222226', roughness: 0.92 });
  M.grass = new THREE.MeshStandardMaterial({ color: '#3a5a3a', roughness: 1.0 });
  const road = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, roadLen), M.road);
  road.rotation.x = -Math.PI / 2; road.position.z = roadCz; road.receiveShadow = true;
  scene.add(road);
  // One big ground plane that runs past the fog distance, so its edges are never
  // visible and the horizon is a clean fog blend.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), M.grass);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.05, roadCz);
  ground.receiveShadow = true;
  scene.add(ground);
  // solid white edge lines
  M.edge = new THREE.MeshBasicMaterial({ color: 0xd8d8de });
  const edgeGeo = new THREE.PlaneGeometry(0.22, roadLen);
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(edgeGeo, M.edge);
    e.rotation.x = -Math.PI / 2; e.position.set(s * (ROAD_HALF - 0.35), 0.015, roadCz);
    scene.add(e);
  }
  // guardrails: continuous rail + scrolling posts on both shoulders
  M.rail = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.6, roughness: 0.45 });
  const railGeo = new THREE.BoxGeometry(0.16, 0.3, roadLen);
  for (const s of [-1, 1]) {
    const r = new THREE.Mesh(railGeo, M.rail);
    r.position.set(s * (ROAD_HALF + 0.55), 0.62, roadCz);
    r.castShadow = true;
    scene.add(r);
  }

  // distant skyline silhouettes (fog-hazed; sells "driving toward the city")
  const skyTone = new THREE.MeshStandardMaterial({ color: 0x55617a, roughness: 1 });
  for (let i = 0; i < 9; i++) {
    const w = 8 + Math.random() * 16, h = 16 + Math.random() * 42;
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 8), skyTone);
    b.position.set(-90 + i * 22 + (Math.random() * 8 - 4), h / 2 - 0.2, -165 - Math.random() * 40);
    scene.add(b);
  }

  // --- shared geometries / materials for pooled entities ---
  G.pothole = new THREE.CircleGeometry(0.9, 22);
  G.potholeRim = new THREE.CircleGeometry(1.02, 22);
  G.cone = new THREE.ConeGeometry(0.45, 1.4, 16);
  G.coneBand = new THREE.CylinderGeometry(0.27, 0.33, 0.22, 16);
  G.coneBase = new THREE.BoxGeometry(0.8, 0.1, 0.8);
  G.post = new THREE.BoxGeometry(0.14, 2.1, 0.14);
  G.archPost = new THREE.BoxGeometry(0.2, 3.2, 0.2);
  G.beam = new THREE.BoxGeometry(ROAD_HALF * 2, 0.22, 0.22);
  G.signPanel = new THREE.BoxGeometry(2.3, 0.85, 0.1);
  G.signTrim = new THREE.BoxGeometry(2.42, 0.97, 0.08);
  G.pitBanner = new THREE.BoxGeometry(3.4, 0.7, 0.1);
  G.fuel = new THREE.BoxGeometry(0.7, 0.9, 0.5);
  G.spout = new THREE.BoxGeometry(0.18, 0.3, 0.18);
  G.fuelCross = new THREE.BoxGeometry(0.34, 0.34, 0.04);
  G.snack = new THREE.BoxGeometry(0.6, 0.6, 0.6);
  G.nitro = new THREE.CylinderGeometry(0.26, 0.26, 0.85, 12);
  G.nitroCore = new THREE.CylinderGeometry(0.13, 0.13, 0.92, 8);
  G.semiTrailer = new THREE.BoxGeometry(2.2, 2.7, 5.5);
  G.semiCab = new THREE.BoxGeometry(2.1, 2.1, 1.8);
  G.semiGlass = new THREE.BoxGeometry(1.8, 0.7, 0.1);
  G.semiLamp = new THREE.BoxGeometry(0.4, 0.22, 0.08);
  G.semiWheel = new THREE.CylinderGeometry(0.55, 0.55, 0.4, 14);
  G.semiWheel.rotateZ(Math.PI / 2);

  M.pothole = new THREE.MeshStandardMaterial({ color: 0x101013, roughness: 1 });
  M.potholeRim = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 1 });
  M.cone = new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.6, emissive: 0x331400, emissiveIntensity: 0.4 });
  M.coneBand = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.4 });
  M.coneDark = new THREE.MeshStandardMaterial({ color: 0xcf5a10, roughness: 0.8 });
  M.signPost = new THREE.MeshStandardMaterial({ color: 0x8a8a92, metalness: 0.4, roughness: 0.6 });
  M.signPanel = new THREE.MeshStandardMaterial({ color: 0xd03028, emissive: 0x400a08, emissiveIntensity: 0.5, roughness: 0.5 });
  M.signTrim = new THREE.MeshStandardMaterial({ color: 0xf2e6c8, roughness: 0.5 });
  M.fuel = new THREE.MeshStandardMaterial({ color: 0x2fae5a, emissive: 0x0c3a1c, emissiveIntensity: 0.5, roughness: 0.5 });
  M.fuelCross = new THREE.MeshStandardMaterial({ color: 0xf2f2e8, roughness: 0.4 });
  M.snack = new THREE.MeshStandardMaterial({ color: 0xf5d76e, emissive: 0x4a3c10, emissiveIntensity: 0.6, roughness: 0.5 });
  M.nitro = new THREE.MeshStandardMaterial({ color: 0x2a55c0, emissive: 0x10246a, emissiveIntensity: 0.7, roughness: 0.35, metalness: 0.4 });
  M.nitroCore = new THREE.MeshStandardMaterial({ color: 0x7ad8ff, emissive: 0x4ab8ff, emissiveIntensity: 1.6 });
  M.pit = new THREE.MeshStandardMaterial({ color: 0x39c2c2, emissive: 0x0c3636, emissiveIntensity: 0.5, roughness: 0.5 });
  M.pitBanner = new THREE.MeshStandardMaterial({ color: 0x1d7d7d, emissive: 0x0e4242, emissiveIntensity: 0.8, roughness: 0.5 });
  M.semiTrailer = new THREE.MeshStandardMaterial({ color: 0xdfe2e6, roughness: 0.7 });
  M.semiCab = new THREE.MeshStandardMaterial({ color: 0x3a6aa8, roughness: 0.6 });
  M.glassDark = new THREE.MeshStandardMaterial({ color: 0x18222e, roughness: 0.2, metalness: 0.3 });
  M.headlamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.2 });
  M.tire = new THREE.MeshStandardMaterial({ color: 0x111116, roughness: 0.9 });

  // --- lane-boundary dashes (two dashed lines; scroll to sell speed) ---
  M.dash = new THREE.MeshBasicMaterial({ color: '#ffea88' });
  const dashGeo = new THREE.PlaneGeometry(0.28, 2.4);
  const dashCount = Math.ceil(DASH_SPAN / DASH_GAP);
  for (const bx of [-LANE_W / 2 - 0.05, LANE_W / 2 + 0.05]) {
    for (let i = 0; i < dashCount; i++) {
      const d = new THREE.Mesh(dashGeo, M.dash);
      d.rotation.x = -Math.PI / 2; d.position.y = 0.02; d.position.x = bx;
      scene.add(d); dashes.push(d);
    }
  }
  // --- shoulder reflector posts (extra motion cue, under the rails) ---
  M.postRef = new THREE.MeshStandardMaterial({ color: 0xeeeeee, emissive: 0x222222 });
  const refGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12);
  for (let i = 0; i < 18; i++) {
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(refGeo, M.postRef);
      p.position.set(s * (ROAD_HALF + 0.55), 0.4, 0);
      scene.add(p); posts.push(p);
    }
  }

  car = buildCar();
  scene.add(car);
  // soft contact shadow (separate from the car so it stays glued to the road)
  M.blob = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false });
  shadowMesh = new THREE.Mesh(new THREE.CircleGeometry(1.0, 20), M.blob);
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.scale.set(1.4, 2.4, 1);
  shadowMesh.position.y = 0.012;
  scene.add(shadowMesh);

  // roadside scenery slots (props recycle by scrolling; content swaps per biome)
  for (const side of [-1, 1]) {
    for (let i = 0; i < SCN_COUNT; i++) {
      const grp = new THREE.Group();
      grp.userData = { i, side, margin: 3 + Math.random() * 36 };
      scene.add(grp);
      scnSlots.push(grp);
    }
  }
  rebuildScenery(bridge.currentBiome().name);
  lastBiomeIdx = bridge.state.biomeIdx;

  resize();
  initialized = true;
  RT.ready = true;
  return true;
}

// ============================================================
// PER-FRAME RENDER
// ============================================================
function renderFrame() {
  if (!initialized && !ensureInit()) return;
  resizeIfNeeded();
  const st = bridge.state;
  const p = st.player;
  const now = performance.now() * 0.001;
  const dt = Math.min(0.05, Math.max(0.001, now - lastT)); lastT = now;
  const speedFrac = Math.max(0, Math.min(1, (st.speed - C.BASE_SPEED) / (C.MAX_SPEED - C.BASE_SPEED)));

  // --- biome-driven sky / fog / sun / surfaces ---
  // top = sky[0], horizon = sky[1] (the warm middle band of the 2D gradient),
  // so dawn/sunset legs keep their golden 2D character in 3D.
  skyMat.uniforms.topColor.value.copy(biomeColor('sky', 0));
  skyMat.uniforms.horizonColor.value.copy(biomeColor('sky', 1)).multiplyScalar(0.93);
  scene.fog.color.copy(skyMat.uniforms.horizonColor.value);
  scene.background.copy(scene.fog.color);
  hemi.color.copy(biomeColor('sky', 0));
  hemi.groundColor.copy(biomeColor('grass')).multiplyScalar(0.6);
  sun.color.copy(biomeColor('sunColor'));
  applySunForBiome();
  // 2D palette road/grass hexes are dark; lift them so ACES doesn't crush
  // the asphalt to black under the chase camera.
  M.road.color.copy(biomeColor('road')).multiplyScalar(1.5);
  M.grass.color.copy(biomeColor('grass')).multiplyScalar(1.25);

  // --- livery: read the run's car style live from state ---
  const style = st.carStyle;
  if (style && style.name !== lastLivery) {
    lastLivery = style.name;
    bodyMat.color.set(style.body);
    stripeMat.color.set(style.stripe);
  }

  // --- scroll the road markings / posts toward the camera ---
  const scroll = st.distance * SCALE_Z;
  const perLine = dashes.length >> 1;
  for (let i = 0; i < dashes.length; i++) {
    const k = i % perLine;
    const wrap = (((k * DASH_GAP - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    dashes[i].position.z = Z_NEAR - wrap;
  }
  const postGap = DASH_SPAN / 9;
  for (let i = 0; i < posts.length; i++) {
    const k = i >> 1, side = (i & 1) ? 1 : -1;
    const wrap = (((k * postGap - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    posts[i].position.z = Z_NEAR - wrap;
    posts[i].position.x = side * (ROAD_HALF + 0.55);
  }

  // --- roadside scenery: swap props on biome change, then scroll like the posts ---
  if (st.biomeIdx !== lastBiomeIdx) { rebuildScenery(bridge.currentBiome().name); lastBiomeIdx = st.biomeIdx; }
  for (const grp of scnSlots) {
    const u = grp.userData;
    const phase = u.side > 0 ? SCN_GAP * 0.5 : 0;
    const wrap = (((u.i * SCN_GAP + phase - scroll) % SCN_SPAN) + SCN_SPAN) % SCN_SPAN;
    grp.position.z = Z_NEAR - wrap;
    grp.position.x = u.side * (ROAD_HALF + u.margin);
  }

  // --- the car: lane X, jump Y, lean/pitch, duck squash, wheel spin, bob ---
  const lv = laneValue(p);                          // smoothed 0..2
  const carX = (lv - 1) * LANE_W;
  const lift = Math.max(0, (p.jumpOff || 0)) * SCALE * 1.15;  // height above lane base
  const bob = (p.bob || 0) * SCALE * 0.4;
  car.position.set(carX, lift + bob, 0);
  // pitch: accel/brake tilt + nose-up while rising, nose-down while falling
  const jumpPitch = p.jumping ? Math.max(-0.3, Math.min(0.3, (p.vy || 0) * 0.022)) : 0;
  car.rotation.x = -(p.tilt || 0) * 1.4 + jumpPitch;
  // lean into lane changes (laneTilt sign: + when moving toward the near/left lane)
  car.rotation.z = (p.laneTilt || 0) * 1.5;
  car.rotation.y = -(p.laneTilt || 0) * 0.6;        // slight yaw toward the new lane
  car.scale.y = p.ducking ? 0.66 : 1;
  if (cabin) cabin.visible = !p.ducking;            // drop the windscreen when ducking
  if (driverGrp) driverGrp.scale.y = p.ducking ? 0.55 : 1;  // Marty hunkers down
  for (const w of wheels) w.rotation.x = -(p.wheelAngle || 0);
  // contact shadow: fades + shrinks as the car rises
  const shFade = Math.max(0, 1 - lift * 0.42);
  shadowMesh.position.x = carX;
  shadowMesh.material.opacity = 0.32 * shFade;
  shadowMesh.scale.set(1.4 * (0.7 + 0.3 * shFade), 2.4 * (0.7 + 0.3 * shFade), 1);

  // --- entities: map each 2D {x,y,w,h,lane} to a 3D mesh at lane X, depth Z ---
  poolReset();
  const t = st.runTime || 0;

  for (const o of st.obstacles) {
    if (o.x > C.W + 120 || o.x < -120) continue;
    const m = poolGet(o.type);
    const z = zForX(o.x);
    const x = laneX(o.lane);
    if (o.type === 'pothole') {
      m.position.set(x, 0.015, z);
      const sx = Math.min(worldH(o.w), 2.5) / 1.8;
      m.scale.set(sx, 1, (worldH(o.h) / 1.8 + 0.4));
    } else {
      m.position.set(x, 0, z);
      if (m.scale.x !== 1) m.scale.set(1, 1, 1);
    }
  }

  for (const c of st.collectibles) {
    if (c.x > C.W + 160 || c.x < -120) continue;
    const m = poolGet(c.type);
    const z = zForX(c.x);
    if (c.type === 'pitstop') {
      m.position.set(0, 0, z);
    } else {
      const yc = Math.max(0.6, centreY(c.y, c.h));
      m.position.set(laneX(c.lane), yc + Math.sin(t * 3 + (c.bob || 0)) * 0.18, z);
      m.rotation.y = t * 2;
    }
  }

  for (const s of st.semis) {
    if (s.x > C.W + 280 || s.x < -160) continue;
    const m = poolGet('semi');
    m.position.set(SEMI_X, 0, zForX(s.x));
    if (s.color && m.userData.cabMat) m.userData.cabMat.color.set(s.color);
  }
  poolHideRest();

  // --- camera: smooth lateral follow + crash shake + speed/nitro FOV ---
  const damp = 1 - Math.exp(-7 * dt);
  camCur.x += (carX * 0.55 - camCur.x) * damp;
  lookCur.x += (carX * 0.8 - lookCur.x) * damp;
  let shX = 0, shY = 0;
  if (st.shakeT > 0 && st.settings && st.settings.screenShake) {
    const k = st.shakeT / 0.35;
    const a = t * 55;
    shX = Math.sin(a * 1.3) * st.shakeMag * 0.025 * k;
    shY = Math.cos(a) * st.shakeMag * 0.025 * k;
  }
  camera.position.set(camCur.x + shX, CAM_POS.y + shY, CAM_POS.z);
  camera.lookAt(lookCur.x + shX, CAM_LOOK.y + shY, CAM_LOOK.z);
  const fov = FOV_BASE + speedFrac * FOV_GAIN + (st.nitro > 0 ? 5 : 0);
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov = fov; camera.updateProjectionMatrix(); }

  renderer.render(scene, camera);
  if (RT.enabled) writeStatus(st);
}

// ============================================================
// CANVAS SIZING / MODE BINDING / STATUS
// ============================================================
let lastW = 0, lastH = 0;
function resize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth || 960, h = canvas.clientHeight || 540;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  lastW = w; lastH = h;
}
function resizeIfNeeded() {
  const canvas = renderer.domElement;
  if (canvas.clientWidth !== lastW || canvas.clientHeight !== lastH) resize();
}

function setVisible(on) {
  const c3d = document.getElementById('game3d');
  if (c3d) c3d.classList.toggle('rt3d-active', on);
  if (!on && statusEl()) statusEl().textContent = '';
}

function writeStatus(st) {
  const el = statusEl();
  if (!el) return;
  const b = bridge.currentBiome();
  el.textContent = `3D CHASE · ${b.name} · ${Math.round(st.distance)}m · [T] side cam`;
}

// MODE POLL — chase camera (during play) drives the 3D renderer; the side
// camera and every menu screen stay on the battle-tested 2D canvas. game.js
// owns the T key; we only watch state.cameraMode. If our renderer ever throws
// inside game.js's try/catch (it sets RT.enabled=false), we treat 3D as
// permanently failed for this session — no error-spam loops.
function pollMode() {
  requestAnimationFrame(pollMode);
  if (permFail) return;
  if (!window.__roadtrip) return;
  if (!bridge) { bridge = window.__roadtrip; C = bridge.consts; }
  if (!initialized) {
    // Eager init + one warm-up render (canvas is at opacity 0) so the first
    // T-press swap is instant — no shader-compile hitch, no empty frame.
    try { if (ensureInit()) renderFrame(); }
    catch (e) {
      permFail = true; RT.enabled = false;
      console.warn('[RT3D] WebGL unavailable — staying on the 2D renderer.', e);
      return;
    }
    if (!initialized) return;
  }
  if (lastApplied && !RT.enabled) {        // game.js caught a render throw
    permFail = true; lastApplied = false; setVisible(false);
    return;
  }
  const st = bridge.state;
  const want = st.cameraMode === 'chase' &&
    (st.screen === bridge.SCREEN.PLAYING || st.screen === bridge.SCREEN.PAUSED);
  if (want !== lastApplied) {
    if (want) {
      // Draw the current sim state BEFORE revealing the canvas: the crossfade
      // always blends from the live 2D frame into a live 3D frame.
      try { renderFrame(); }
      catch (e) { permFail = true; console.warn('[RT3D] render failed — staying 2D.', e); return; }
    }
    lastApplied = want;
    RT.enabled = want;
    setVisible(want);
  }
}

window.addEventListener('resize', () => { if (initialized) resize(); });

// Boot: put the 3D canvas into crossfade mode (transparent until chase cam).
(function bootRT3D() {
  const c3d = document.getElementById('game3d');
  if (c3d) { c3d.classList.remove('hidden'); c3d.classList.add('rt3d-fade'); }
  pollMode();
})();
