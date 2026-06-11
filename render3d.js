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
// Look: "heavy stylized" — multi-part beveled car hull (ExtrudeGeometry),
// canvas-baked asphalt with worn wheel tracks, InstancedMesh scenery per
// Nashville leg (window-lit towers, the AT&T twin-spire 'Batman building',
// a Ryman-style arched hall, Music Row brick studios with awnings, Cumberland
// pines, Broadway honky-tonk facades with neon blade signs + streetlight
// cones), pooled 3D particles (landing dust / near-miss sparks), and the
// per-biome exposure / sun-disc / cloud grade from the fidelity pass.
// All scenery scrolls by rewriting per-instance matrices with one scratch
// Object3D — zero allocations inside the frame loop.
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
const SCN_SPAN = 308;    // scroll length before a scenery slot recycles
// Sun direction + intensity per biome leg (dawn / morning / afternoon / sunset).
const SUN_POS = [
  [16, 12, -30],  // DOWNTOWN  — dawn, low-ish to the right
  [10, 20, -22],  // MUSIC ROW — morning, climbing
  [-12, 22, -14], // CUMBERLAND— afternoon, high left
  [-17, 9, -38],  // BROADWAY  — sunset, low left
];
const SUN_INT = [2.0, 2.2, 2.1, 1.8];
// Per-biome ACES exposure grade, blended like the sun. A flat 1.25 washed the
// dawn DOWNTOWN leg to pale grey; the 2D palette there is peach-to-amber, so
// dawn/sunset legs run darker and the bright midday legs keep their punch.
const EXPOSURE = [1.04, 1.22, 1.14, 1.08];

// ---- module state ----------------------------------------------------------
let bridge = null;          // window.__roadtrip
let C = null;               // bridge.consts (W, GROUND_Y, PLAYER_X, ...)
let scene, camera, renderer, car, wheels = [], cabin = null;
let hemi, sun, skyMat, bodyMat, stripeMat, shadowMesh, driverGrp;
let sunSprite = null, sunSpriteMat = null;   // billboard sun disc on the dome
const clouds = [];                            // drifting billboard cloud sprites
let WINDOW_TEX = null;                        // shared window-grid textures
let initialized = false;
let permFail = false;       // WebGL/init/render failed once -> stay 2D forever
let lastApplied = false;    // mode we last applied (crossfade state)
const dashes = [];
let guardPosts = null, guardRefl = null;   // instanced guardrail posts + reflectors
const GUARD_N = 18;                        // posts per side
let lastBiomeIdx = -1;
let activeBiomeSet = -1;
let lastLivery = '';
let lastT = 0;
let prevJumping = false;     // landing-dust edge detector
const sparkedSet = new WeakSet();  // obstacles that already burst sparks
const statusEl = () => document.getElementById('rt3d-status');

// Shared geometries / materials (built once, reused by every pooled mesh).
let G = {}, M = {};
// Per-type object pools so we never allocate meshes inside the frame loop.
const pools = {};
// Biome scenery sets: [{ group, update(scroll) }] — index-aligned with BIOMES.
const biomeSets = [];
// Road texture scroll bookkeeping.
let roadTexWorldPerRepeat = 1;

// Scratch objects for per-frame blending (avoid per-frame allocation).
const _ca = new THREE.Color(), _cb = new THREE.Color(), _out = new THREE.Color();
const _pc = new THREE.Color();                 // particle colour scratch
const _sunA = new THREE.Vector3(), _sunB = new THREE.Vector3();
const _white = new THREE.Color(0xffffff);
const _dummy = new THREE.Object3D();           // instanced-matrix scratch
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

// Biome-blended scalar from a per-biome array (same blend rule as the sun).
function biomeLerp(arr) {
  const idx = bridge.state.biomeIdx;
  const blendRaw = bridge.biomeBlend();
  let b = idx, t = 0;
  if (blendRaw > 0) { b = Math.min(idx + 1, arr.length - 1); t = blendRaw; }
  else if (blendRaw < 0) { b = Math.max(idx - 1, 0); t = -blendRaw; }
  const a = Math.min(idx, arr.length - 1);
  return arr[a] * (1 - t) + arr[b] * t;
}

// ============================================================
// CANVAS-BAKED TEXTURES (procedural; no external files, built once at init)
// ============================================================
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeSunTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const cx = cv.getContext('2d');
  const grad = cx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.16, 'rgba(255,245,218,1)');
  grad.addColorStop(0.28, 'rgba(255,226,166,0.9)');
  grad.addColorStop(0.55, 'rgba(255,200,120,0.22)');
  grad.addColorStop(1.0, 'rgba(255,190,110,0)');
  cx.fillStyle = grad; cx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCloudTexture() {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96;
  const cx = cv.getContext('2d');
  // overlapping soft blobs -> one puffy cumulus silhouette
  const blobs = [[70, 62, 40], [120, 48, 52], [178, 60, 42], [100, 70, 34], [150, 72, 30], [52, 72, 26], [204, 74, 24]];
  for (const [x, y, r] of blobs) {
    const grad = cx.createRadialGradient(x, y - 4, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.85)');
    grad.addColorStop(0.65, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    cx.fillStyle = grad;
    cx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Three density variants of a lit-window facade grid (short / mid / tall
// towers). Warm amber panes against near-black glass: the same emissive
// language the BROADWAY honky-tonk strips already use.
function windowTextures() {
  if (WINDOW_TEX) return WINDOW_TEX;
  WINDOW_TEX = [];
  for (let v = 0; v < 3; v++) {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#06070a'; cx.fillRect(0, 0, 64, 128);
    const cols = 4 + v, rows = 9 + v * 3;
    const cw = 64 / cols, ch = 128 / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = Math.random() < 0.42;
        cx.globalAlpha = lit ? 0.7 + Math.random() * 0.3 : 1;
        cx.fillStyle = lit
          ? ['#ffd9a0', '#ffc97e', '#fff3cf', '#e8b36a'][(Math.random() * 4) | 0]
          : (Math.random() < 0.5 ? '#10131b' : '#181e2c');
        cx.fillRect(c * cw + cw * 0.22, r * ch + ch * 0.26, cw * 0.56, ch * 0.5);
      }
    }
    cx.globalAlpha = 1;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;   // crisp pane edges at distance
    WINDOW_TEX.push(tex);
  }
  return WINDOW_TEX;
}

// 6-slot material array for BoxGeometry: window grid on the four walls,
// plain tone on roof/underside (group order: +x, -x, +y, -y, +z, -z).
// Pass 0xffffff as the tone when the mesh is tinted per-instance instead.
function facadeMats(tone, tex, intensity = 1.15) {
  const wall = new THREE.MeshStandardMaterial({
    color: tone, roughness: 0.85,
    emissive: 0xffc488, emissiveIntensity: intensity, emissiveMap: tex,
  });
  const flat = new THREE.MeshStandardMaterial({ color: tone, roughness: 0.95 });
  return [wall, wall, flat, flat, wall, wall];
}

// Asphalt: neutral mid-grey (the per-biome road tint multiplies on top),
// speckle noise, tar cracks, and two darker worn wheel tracks per lane.
function makeAsphaltTextures() {
  const draw = (ctx, w, h, forBump) => {
    ctx.fillStyle = forBump ? '#808080' : '#b4b4b8';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = Math.random();
      ctx.fillStyle = v < 0.5
        ? `rgba(255,255,255,${0.04 + Math.random() * 0.10})`
        : `rgba(0,0,0,${0.05 + Math.random() * 0.12})`;
      ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0,
        1 + ((Math.random() * 2) | 0), 1 + ((Math.random() * 2) | 0));
    }
    // worn wheel tracks: lanes at u = 0.5 + laneX/12; wheels sit ±1.04 world
    const laneU = [0.5 - LANE_W / (ROAD_HALF * 2), 0.5, 0.5 + LANE_W / (ROAD_HALF * 2)];
    const wheelDu = 1.04 / (ROAD_HALF * 2);
    for (const lu of laneU) {
      for (const s of [-1, 1]) {
        const x = (lu + s * wheelDu) * w;
        const grad = ctx.createLinearGradient(x - 11, 0, x + 11, 0);
        grad.addColorStop(0, 'rgba(0,0,0,0)');
        grad.addColorStop(0.5, 'rgba(0,0,0,0.26)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x - 11, 0, 22, h);
      }
    }
    // a few faint tar cracks
    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      let cx = Math.random() * w, cy = Math.random() * h;
      ctx.moveTo(cx, cy);
      for (let j = 0; j < 5; j++) {
        cx += (Math.random() - 0.5) * 26; cy += 8 + Math.random() * 22;
        ctx.lineTo(cx, cy);
      }
      ctx.stroke();
    }
  };
  const map = canvasTex(256, 512, (c, w, h) => draw(c, w, h, false), true);
  const bump = canvasTex(128, 256, (c, w, h) => draw(c, w, h, true), false);
  for (const t of [map, bump]) {
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1, 8);
  }
  return { map, bump };
}

// Brick: neutral warm base (instance colour gives each studio its own brick
// tone), mortar courses with a running bond offset.
function makeBrickTexture() {
  return canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#b8a89c'; ctx.fillRect(0, 0, w, h);
    const bh = 8, bw = 16;
    for (let y = 0; y < h; y += bh) {
      ctx.fillStyle = 'rgba(240,232,220,0.85)';
      ctx.fillRect(0, y, w, 1);
      const off = ((y / bh) | 0) % 2 ? bw / 2 : 0;
      for (let x = -bw; x < w; x += bw) {
        ctx.fillRect(x + off, y, 1, bh);
        ctx.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${0.03 + Math.random() * 0.06})`;
        ctx.fillRect(x + off + 1, y + 1, bw - 1, bh - 1);
        ctx.fillStyle = 'rgba(240,232,220,0.85)';
      }
    }
  });
}

function makeAwningTexture() {
  return canvasTex(64, 32, (ctx, w, h) => {
    for (let x = 0; x < w; x += 16) {
      ctx.fillStyle = '#f4f4f0'; ctx.fillRect(x, 0, 8, h);
      ctx.fillStyle = '#9a9aa0'; ctx.fillRect(x + 8, 0, 8, h);
    }
  });
}

// Honky-tonk facade: dark wall, rows of warm-lit windows, lit ground floor.
function makeHonkyTonkFacade() {
  const wins = [];
  const map = canvasTex(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#241c2c'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#3a3046'; ctx.fillRect(0, 0, w, 10);         // cornice
    const cols = 3, rows = 5, cw = w / cols, rh = (h - 70) / rows;
    for (let r = 0; r < rows; r++) {
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        const x = cIdx * cw + 7, y = 14 + r * rh + 4, ww = cw - 14, wh = rh - 10;
        if (Math.random() < 0.78) {
          wins.push([x, y, ww, wh]);
          ctx.fillStyle = '#ffc56a'; ctx.fillRect(x, y, ww, wh);
        } else {
          ctx.fillStyle = '#1b1622'; ctx.fillRect(x, y, ww, wh);
        }
      }
    }
    // lit ground floor: door + wide window
    wins.push([10, h - 52, 36, 44], [56, h - 48, 62, 36]);
    ctx.fillStyle = '#ffdf9a'; ctx.fillRect(10, h - 52, 36, 44);
    ctx.fillStyle = '#ffc56a'; ctx.fillRect(56, h - 48, 62, 36);
  });
  const emissive = canvasTex(128, 256, (ctx, w, h) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffc56a';
    for (const win of wins) ctx.fillRect(win[0], win[1], win[2], win[3]);
  });
  return { map, emissive };
}

// Neon blade sign: white blocks on black (instance colour = the neon hue).
function makeSignTexture() {
  return canvasTex(64, 128, (ctx, w, h) => {
    ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(3, 3, w - 6, 2); ctx.fillRect(3, h - 5, w - 6, 2);  // frame
    ctx.fillRect(3, 3, 2, h - 6); ctx.fillRect(w - 5, 3, 2, h - 6);
    ctx.fillRect(10, 10, w - 20, 22);                                // marquee block
    for (let i = 0; i < 5; i++) ctx.fillRect(16, 42 + i * 16, w - 32, 10); // letters
  });
}

// Ryman-style arched window (warm glow with a rounded top).
function makeArchTexture() {
  return canvasTex(32, 64, (ctx, w, h) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffd9a0';
    ctx.beginPath();
    ctx.moveTo(4, h - 2); ctx.lineTo(4, 18);
    ctx.arc(w / 2, 18, w / 2 - 4, Math.PI, 0);
    ctx.lineTo(w - 4, h - 2); ctx.closePath(); ctx.fill();
  });
}

// Soft round puff for dust particles.
function makePuffTexture() {
  return canvasTex(64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.4)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  });
}

// Tiny equirect environment: sky-over-horizon gradient + bright streaks, so
// chrome / clearcoat picks up believable reflections with no HDR download.
function makeEnvTexture() {
  const t = canvasTex(64, 32, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#7fb4e8'); g.addColorStop(0.45, '#ffe2b8');
    g.addColorStop(0.55, '#caa27a'); g.addColorStop(1, '#33302c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255,246,224,0.85)';
    ctx.fillRect(6, 13, 14, 2); ctx.fillRect(30, 15, 18, 2); ctx.fillRect(52, 12, 9, 2);
  });
  t.mapping = THREE.EquirectangularReflectionMapping;
  return t;
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
// THE CAR — multi-part beveled hull (ExtrudeGeometry) facing -Z;
// chrome bumpers, fender arches, hood scoop, lit dash + seats, torus-spoke
// wheels. Livery (body + stripe colour) is read live from state.
// ============================================================
function buildCar() {
  const g = new THREE.Group();
  bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0xc81e28, roughness: 0.3, metalness: 0.25,
    clearcoat: 1.0, clearcoatRoughness: 0.12,
  });
  stripeMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.7 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8eaee, metalness: 1.0, roughness: 0.1 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x9fc4d8, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.42 });
  const tail = new THREE.MeshStandardMaterial({ color: 0xff3838, emissive: 0xcc1010, emissiveIntensity: 1.3, roughness: 0.4 });
  const lamp = new THREE.MeshStandardMaterial({ color: 0xfff3c0, emissive: 0xfff0b0, emissiveIntensity: 1.5 });
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x4a2c22, roughness: 0.85 });
  const gauge = new THREE.MeshStandardMaterial({ color: 0x9fe8d8, emissive: 0x76d8c4, emissiveIntensity: 1.3 });

  // --- hull: a side-profile Shape extruded across the car's width, with a
  // bevel that rounds the flanks into soft fenders ------------------------
  const prof = new THREE.Shape();
  prof.moveTo(-2.10, 0.30);
  prof.lineTo(-2.10, 0.62);   // nose face
  prof.lineTo(-1.78, 0.72);   // hood leading edge
  prof.lineTo(-0.62, 0.84);   // hood
  prof.lineTo(-0.34, 0.92);   // cowl
  prof.lineTo(-0.10, 0.84);   // cockpit dip (open top)
  prof.lineTo(0.78, 0.86);
  prof.lineTo(1.10, 0.96);    // rear deck rise
  prof.lineTo(1.86, 0.96);
  prof.lineTo(2.10, 0.80);    // tail kick
  prof.lineTo(2.10, 0.30);
  prof.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(prof, {
    depth: 1.66, bevelEnabled: true, bevelThickness: 0.17, bevelSize: 0.10,
    bevelSegments: 3, curveSegments: 6,
  });
  hullGeo.translate(0, 0, -(1.66 / 2 + 0.17));   // centre the width
  hullGeo.rotateY(-Math.PI / 2);                 // profile-x -> world -Z nose
  const hull = new THREE.Mesh(hullGeo, bodyMat);
  g.add(hull);

  // dark rocker sill under the hull
  const sill = new THREE.Mesh(new THREE.BoxGeometry(2.02, 0.26, 3.5), dark);
  sill.position.y = 0.33; g.add(sill);

  // fender arches over each wheel (half-torus, body colour)
  const archGeo = new THREE.TorusGeometry(0.5, 0.12, 10, 16, Math.PI);
  for (const [x, z] of [[-1.04, -1.42], [1.04, -1.42], [-1.04, 1.46], [1.04, 1.46]]) {
    const a = new THREE.Mesh(archGeo, bodyMat);
    a.position.set(x, 0.5, z); a.rotation.y = Math.PI / 2;
    g.add(a);
  }

  // hood scoop + dark intake
  const scoop = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.10, 0.55), bodyMat);
  scoop.position.set(0, 0.93, -1.12); g.add(scoop);
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.06, 0.08), dark);
  intake.position.set(0, 0.95, -1.42); g.add(intake);

  // racing stripes: hood (following the beveled hood slope) + rear deck
  const stripeH = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.03, 1.40), stripeMat);
  stripeH.position.set(0, 0.92, -1.18); stripeH.rotation.x = -0.114;
  const stripeR = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.03, 0.78), stripeMat);
  stripeR.position.set(0, 1.075, 1.48);
  g.add(stripeH, stripeR);

  // chrome bumpers + grille + exhaust + mirrors
  const bumperF = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.16, 0.30), chrome);
  bumperF.position.set(0, 0.42, -2.10);
  const bumperR = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.16, 0.30), chrome);
  bumperR.position.set(0, 0.42, 2.10);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.96, 0.16, 0.05), dark);
  grille.position.set(0, 0.55, -2.12);
  const grilleTrim = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.03, 0.05), chrome);
  grilleTrim.position.set(0, 0.65, -2.12);
  g.add(bumperF, bumperR, grille, grilleTrim);
  const exGeo = new THREE.CylinderGeometry(0.055, 0.06, 0.26, 10);
  exGeo.rotateX(Math.PI / 2);
  for (const x of [-0.45, 0.45]) {
    const ex = new THREE.Mesh(exGeo, chrome);
    ex.position.set(x, 0.34, 2.18); g.add(ex);
  }
  for (const x of [-1.04, 1.04]) {
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.14), chrome);
    mir.position.set(x, 0.98, -0.5); g.add(mir);
  }

  // headlights: emissive housings + glass lens domes; tail lights
  const lensGeo = new THREE.SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  lensGeo.rotateX(-Math.PI / 2);
  for (const x of [-0.62, 0.62]) {
    const hlight = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.18, 0.06), lamp);
    hlight.position.set(x, 0.68, -2.10);
    const lens = new THREE.Mesh(lensGeo, glass);
    lens.position.set(x, 0.68, -2.12);
    g.add(hlight, lens);
    const tlight = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.15, 0.06), tail);
    tlight.position.set(x, 0.80, 2.12);
    g.add(tlight);
  }

  // --- cockpit interior: tub, dash with lit gauges, wheel, two seats -------
  const tub = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.4, 1.85), dark);
  tub.position.set(0, 0.78, 0.30); g.add(tub);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.16, 0.30), dark);
  dash.position.set(0, 1.02, -0.50); g.add(dash);
  for (let i = 0; i < 3; i++) {
    const gd = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.05, 0.02), gauge);
    gd.position.set(-0.52 + i * 0.16, 1.07, -0.36); gd.rotation.x = -0.5;
    g.add(gd);
  }
  const swheel = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 18), dark);
  swheel.position.set(-0.40, 1.10, -0.26); swheel.rotation.x = -1.15;
  g.add(swheel);
  for (const x of [-0.40, 0.40]) {
    const seatB = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.13, 0.5), seatMat);
    seatB.position.set(x, 0.95, 0.45);
    const seatBack = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.45, 0.12), seatMat);
    seatBack.position.set(x, 1.16, 0.70); seatBack.rotation.x = 0.16;
    const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.13, 0.1), seatMat);
    headrest.position.set(x, 1.43, 0.74);
    g.add(seatB, seatBack, headrest);
  }

  // windshield (drops when ducking) + chrome rollbar
  const wind = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.5, 0.06), glass);
  wind.position.set(0, 1.18, -0.66); wind.rotation.x = -0.38;
  cabin = wind; g.add(wind);
  const barL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), chrome); barL.position.set(-0.55, 1.3, 0.95);
  const barR = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), chrome); barR.position.set(0.55, 1.3, 0.95);
  const barTop = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.1, 0.1), chrome); barTop.position.set(0, 1.5, 0.95);
  g.add(barL, barR, barTop);

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
  driverGrp.position.set(-0.4, 0.98, 0.4);
  g.add(driverGrp);

  // --- wheels: torus tire + chrome hub + 3 spoke bars (6 visible spokes) ---
  const tireGeo = new THREE.TorusGeometry(0.36, 0.15, 12, 20);
  const hubGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.3, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const spokeGeo = new THREE.BoxGeometry(0.05, 0.60, 0.06);
  const wp = [[-1.04, -1.42], [1.04, -1.42], [-1.04, 1.46], [1.04, 1.46]];
  wheels = [];
  for (const [x, z] of wp) {
    const w = new THREE.Group(); w.position.set(x, 0.5, z);
    const tire = new THREE.Mesh(tireGeo, M.tire);
    tire.rotation.y = Math.PI / 2;
    w.add(tire);
    w.add(new THREE.Mesh(hubGeo, chrome));
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Mesh(spokeGeo, chrome);
      sp.rotation.x = i * (Math.PI / 3);
      w.add(sp);
    }
    g.add(w);
    wheels.push(w);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

// ============================================================
// INSTANCED ROADSIDE SCENERY — one prebuilt set per Nashville leg, all four
// resident in the scene; only the active leg's group is visible. Slots scroll
// by rewriting instance matrices (a scratch Object3D; zero per-frame allocs).
// ============================================================
function makeInstanced(geo, mat, count, shadow = true) {
  const im = new THREE.InstancedMesh(geo, mat, count);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  im.frustumCulled = false;        // instances span the whole road; never cull
  im.castShadow = shadow;
  return im;
}
const rnd = (a, b) => a + Math.random() * (b - a);
function wrapZ(base, scroll, span) {
  return Z_NEAR - ((((base - scroll) % span) + span) % span);
}

// -- DOWNTOWN: window-lit tower instancing + three landmark set pieces:
// the AT&T 'Batman building', the round drum tower, a Ryman-style hall ------
function buildDowntownSet() {
  const group = new THREE.Group();
  const texes = windowTextures();
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
  const N = 22;
  // dawn towers: white-base facade mats, tinted per instance (4 grey-blue tones)
  const towers = makeInstanced(boxGeo, facadeMats(0xffffff, texes[1], 1.1), N);
  const capMat = new THREE.MeshStandardMaterial({ color: 0x2c2f38, roughness: 1 });
  const caps = makeInstanced(boxGeo, capMat, N);
  const tones = [0x4a4e5a, 0x53506a, 0x3e4a5c, 0x615a52];
  const slots = [];
  for (let k = 0; k < N; k++) {
    const side = k & 1 ? 1 : -1;
    slots.push({
      side, base: (k >> 1) * 28 + (side > 0 ? 14 : 0),
      margin: rnd(4, 28), w: rnd(2.8, 6), h: rnd(6, 19), d: rnd(2.8, 6),
      cap: Math.random() < 0.5 ? rnd(0.6, 2.4) : 0,
    });
    towers.setColorAt(k, _ca.set(tones[k % 4]));
  }
  towers.instanceColor.needsUpdate = true;
  group.add(towers, caps);

  // AT&T "Batman building": dark glass slab, recessed crown, twin spires
  // (design carried over from the fidelity pass, now a scrolling set piece).
  const bat = new THREE.Group();
  {
    const w = 5.4, d = 4.2, h = 21;
    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), facadeMats(0x2e3444, texes[2], 1.25));
    body.position.y = h / 2; bat.add(body);
    const crown = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, 2.4, d * 0.66),
      new THREE.MeshStandardMaterial({ color: 0x232838, roughness: 0.9 }));
    crown.position.y = h + 1.2; bat.add(crown);
    const spireMat = new THREE.MeshStandardMaterial({ color: 0x1c2030, roughness: 0.7 });
    const tipMat = new THREE.MeshStandardMaterial({ color: 0xff6a4a, emissive: 0xff3a20, emissiveIntensity: 1.8 });
    for (const sx of [-1, 1]) {
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.32, 7, 6), spireMat);
      spire.position.set(sx * (w / 2 - 0.5), h + 3.5, 0); bat.add(spire);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), tipMat);
      tip.position.set(sx * (w / 2 - 0.5), h + 7.1, 0); bat.add(tip);
    }
  }
  bat.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(bat);

  // Round drum tower: windowed cylinder, lit ring, wide dark cap, mast.
  const drum = new THREE.Group();
  {
    const h = 15, r = 2.7;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 18),
      new THREE.MeshStandardMaterial({
        color: 0x4d5566, roughness: 0.85,
        emissive: 0xffc488, emissiveIntensity: 1.1, emissiveMap: texes[1],
      }));
    body.position.y = h / 2; drum.add(body);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.34, r + 0.34, 0.3, 18),
      new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffc070, emissiveIntensity: 1.5 }));
    ring.position.y = h + 0.15; drum.add(ring);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.55, r + 0.55, 0.9, 18),
      new THREE.MeshStandardMaterial({ color: 0x2a2f3c, roughness: 0.9 }));
    cap.position.y = h + 0.75; drum.add(cap);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.13, 3.4, 6),
      new THREE.MeshStandardMaterial({ color: 0x39404e, roughness: 0.7 }));
    mast.position.y = h + 2.9; drum.add(mast);
  }
  drum.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(drum);

  // Ryman-style arched hall: brick box + barrel roof + warm arch windows.
  const ryman = new THREE.Group();
  {
    const brick = makeBrickTexture();
    const hall = new THREE.Mesh(new THREE.BoxGeometry(7, 4.6, 10),
      new THREE.MeshStandardMaterial({ map: brick, color: 0x9c5a44, roughness: 0.95 }));
    hall.position.y = 2.3; ryman.add(hall);
    const roofGeo = new THREE.CylinderGeometry(3.55, 3.55, 10.2, 18, 1, false, 0, Math.PI);
    roofGeo.rotateZ(Math.PI / 2); roofGeo.rotateY(Math.PI / 2);
    const roof = new THREE.Mesh(roofGeo, new THREE.MeshStandardMaterial({ color: 0x4a4046, roughness: 0.9 }));
    roof.position.y = 4.6; roof.scale.y = 0.62;
    ryman.add(roof);
    const archTex = makeArchTexture();
    const archMat = new THREE.MeshStandardMaterial({
      map: archTex, emissiveMap: archTex, emissive: 0xffc879, emissiveIntensity: 1.0,
      transparent: true, alphaTest: 0.4,
    });
    for (let i = 0; i < 3; i++) {
      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.9), archMat);
      win.position.set(3.52, 2.2, -3 + i * 3);
      win.rotation.y = Math.PI / 2;
      ryman.add(win);
    }
  }
  ryman.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  group.add(ryman);

  return {
    group,
    update(scroll) {
      for (let k = 0; k < N; k++) {
        const s = slots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        _dummy.position.set(s.side * (ROAD_HALF + s.margin + s.w / 2), 0, z);
        _dummy.scale.set(s.w, s.h, s.d);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        towers.setMatrixAt(k, _dummy.matrix);
        if (s.cap > 0) {
          _dummy.position.y = s.h;
          _dummy.scale.set(s.w * 0.45, s.cap, s.d * 0.45);
        } else {
          _dummy.scale.setScalar(0.0001);
        }
        _dummy.updateMatrix();
        caps.setMatrixAt(k, _dummy.matrix);
      }
      towers.instanceMatrix.needsUpdate = true;
      caps.instanceMatrix.needsUpdate = true;
      bat.position.set(ROAD_HALF + 9, 0, wrapZ(46, scroll, SCN_SPAN));
      drum.position.set(-(ROAD_HALF + 7), 0, wrapZ(132, scroll, SCN_SPAN));
      ryman.position.set(-(ROAD_HALF + 8.5), 0, wrapZ(236, scroll, SCN_SPAN));
    },
  };
}

// -- MUSIC ROW: brick studio-houses with striped awnings + clustered trees --
function buildMusicRowSet() {
  const group = new THREE.Group();
  const brick = makeBrickTexture();
  const studioMat = new THREE.MeshStandardMaterial({ map: brick, roughness: 0.95 });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
  const NS = 14;
  const studios = makeInstanced(boxGeo, studioMat, NS);
  const roofGeo = new THREE.ConeGeometry(0.74, 1, 4); roofGeo.translate(0, 0.5, 0); roofGeo.rotateY(Math.PI / 4);
  const roofs = makeInstanced(roofGeo, new THREE.MeshStandardMaterial({ color: 0x3a3236, roughness: 1, flatShading: true }), NS);
  const awnGeo = new THREE.BoxGeometry(0.9, 0.05, 1);
  const awnings = makeInstanced(awnGeo, new THREE.MeshStandardMaterial({ map: makeAwningTexture(), roughness: 0.8 }), NS, false);
  const brickTones = [0x8c5a48, 0x9c6a50, 0x7a6258, 0xa88a6a];
  const awnTones = [0xc0392b, 0x2a7a8c, 0x4a6a3a, 0x8c5aa0];
  const sSlots = [];
  for (let k = 0; k < NS; k++) {
    const side = k & 1 ? 1 : -1;
    sSlots.push({
      side, base: (k >> 1) * 44 + (side > 0 ? 22 : 0),
      margin: rnd(2.5, 12), w: rnd(2.8, 4.2), h: rnd(2.2, 3.4), d: rnd(2.8, 4),
      roofH: rnd(1.0, 1.7),
    });
    studios.setColorAt(k, _ca.set(brickTones[k % 4]));
    awnings.setColorAt(k, _ca.set(awnTones[k % 4]));
  }
  studios.instanceColor.needsUpdate = true;
  awnings.instanceColor.needsUpdate = true;
  group.add(studios, roofs, awnings);

  // trees: trunk + a 3-blob canopy cluster (detail-1 icosahedra), the cluster
  // yaw-billboarded toward the chase camera so it never reads edge-on.
  const NT = 10;
  const trunkGeo = new THREE.CylinderGeometry(0.2, 0.28, 1, 7); trunkGeo.translate(0, 0.5, 0);
  const trunks = makeInstanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 }), NT);
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x4a7a3a, roughness: 1, flatShading: true });
  const crowns = makeInstanced(new THREE.IcosahedronGeometry(1, 1), crownMat, NT * 3);
  const blobOff = [[0, 0, 0, 1], [0.55, -0.27, 0.15, 0.7], [-0.5, -0.15, -0.12, 0.62]]; // x,y,z,scale (×r0)
  const tSlots = [];
  for (let k = 0; k < NT; k++) {
    const side = k & 1 ? 1 : -1;
    tSlots.push({
      side, base: (k >> 1) * 62 + (side > 0 ? 10 : 41),
      margin: rnd(2, 16), th: rnd(1.2, 2), r0: rnd(1.1, 1.6),
    });
  }
  group.add(trunks, crowns);

  return {
    group,
    update(scroll) {
      for (let k = 0; k < NS; k++) {
        const s = sSlots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        const x = s.side * (ROAD_HALF + s.margin + s.d / 2);
        _dummy.position.set(x, 0, z);
        _dummy.scale.set(s.d, s.h, s.w);     // depth toward the road, width along it
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        studios.setMatrixAt(k, _dummy.matrix);
        _dummy.position.y = s.h;
        _dummy.scale.set(s.d * 1.4, s.roofH, s.w * 1.4);
        _dummy.updateMatrix();
        roofs.setMatrixAt(k, _dummy.matrix);
        // awning hangs off the road-facing wall, sloping down toward the road
        _dummy.position.set(x - s.side * (s.d / 2 + 0.28), s.h * 0.62, z);
        _dummy.scale.set(1, 1, s.w * 0.55);
        _dummy.rotation.set(0, 0, -s.side * 0.42);
        _dummy.updateMatrix();
        awnings.setMatrixAt(k, _dummy.matrix);
      }
      studios.instanceMatrix.needsUpdate = true;
      roofs.instanceMatrix.needsUpdate = true;
      awnings.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < NT; k++) {
        const s = tSlots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        const x = s.side * (ROAD_HALF + s.margin);
        _dummy.position.set(x, 0, z);
        _dummy.scale.set(1, s.th, 1);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        trunks.setMatrixAt(k, _dummy.matrix);
        // canopy cluster, yawed toward the camera (full face, never a slab)
        const yaw = Math.atan2(camera.position.x - x, camera.position.z - z);
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        for (let b = 0; b < 3; b++) {
          const o = blobOff[b];
          const bx = o[0] * s.r0, bz = o[2] * s.r0;
          _dummy.position.set(x + bx * cy + bz * sy, s.th + 1.05 * s.r0 + o[1] * s.r0, z - bx * sy + bz * cy);
          _dummy.scale.setScalar(s.r0 * o[3]);
          _dummy.rotation.set(0, yaw, 0);
          _dummy.updateMatrix();
          crowns.setMatrixAt(k * 3 + b, _dummy.matrix);
        }
      }
      trunks.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
    },
  };
}

// -- CUMBERLAND: instanced pines (trunk + two stacked cones) + river rocks ---
function buildCumberlandSet() {
  const group = new THREE.Group();
  const NP = 32, NR = 10;
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.3, 1, 7); trunkGeo.translate(0, 0.5, 0);
  const trunks = makeInstanced(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 }), NP);
  const coneGeo = new THREE.ConeGeometry(1, 1, 8); coneGeo.translate(0, 0.5, 0);
  const greenMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const cones1 = makeInstanced(coneGeo, greenMat, NP);
  const cones2 = makeInstanced(coneGeo, greenMat, NP);
  const rocks = makeInstanced(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0x6b6e72, roughness: 1, flatShading: true }), NR);
  const pSlots = [], rSlots = [];
  for (let k = 0; k < NP; k++) {
    const side = k & 1 ? 1 : -1;
    pSlots.push({
      side, base: (k >> 1) * 19.25 + (side > 0 ? 9.6 : 0),
      margin: rnd(1.5, 15), th: rnd(1, 1.8),
      r1: rnd(1.1, 1.8), h1: rnd(2.5, 4.2), r2: rnd(0.7, 1.1),
    });
    _ca.setHSL(0.33 + rnd(-0.03, 0.03), rnd(0.32, 0.45), rnd(0.22, 0.32));
    cones1.setColorAt(k, _ca);
    cones2.setColorAt(k, _ca);
  }
  cones1.instanceColor.needsUpdate = true;
  cones2.instanceColor.needsUpdate = true;
  for (let k = 0; k < NR; k++) {
    const side = k & 1 ? 1 : -1;
    rSlots.push({
      side, base: (k >> 1) * 61 + (side > 0 ? 31 : 7),
      margin: rnd(1.5, 14), r: rnd(0.8, 2.0), ys: rnd(0.45, 0.8), rot: rnd(0, Math.PI),
    });
  }
  group.add(trunks, cones1, cones2, rocks);
  return {
    group,
    update(scroll) {
      for (let k = 0; k < NP; k++) {
        const s = pSlots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        const x = s.side * (ROAD_HALF + s.margin);
        _dummy.position.set(x, 0, z);
        _dummy.scale.set(1, s.th, 1);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        trunks.setMatrixAt(k, _dummy.matrix);
        _dummy.position.y = s.th - 0.2;
        _dummy.scale.set(s.r1, s.h1, s.r1);
        _dummy.updateMatrix();
        cones1.setMatrixAt(k, _dummy.matrix);
        _dummy.position.y = s.th + s.h1 * 0.55;
        _dummy.scale.set(s.r2, s.h1 * 0.7, s.r2);
        _dummy.updateMatrix();
        cones2.setMatrixAt(k, _dummy.matrix);
      }
      trunks.instanceMatrix.needsUpdate = true;
      cones1.instanceMatrix.needsUpdate = true;
      cones2.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < NR; k++) {
        const s = rSlots[k];
        _dummy.position.set(s.side * (ROAD_HALF + s.margin), s.r * s.ys * 0.4, wrapZ(s.base, scroll, SCN_SPAN));
        _dummy.scale.set(s.r, s.r * s.ys, s.r);
        _dummy.rotation.set(0, s.rot, 0);
        _dummy.updateMatrix();
        rocks.setMatrixAt(k, _dummy.matrix);
      }
      rocks.instanceMatrix.needsUpdate = true;
    },
  };
}

// -- BROADWAY: honky-tonk canyon — lit facades, neon blade signs, and
// streetlights whose additive cones pool warm light onto the dusk road ------
function buildBroadwaySet() {
  const group = new THREE.Group();
  const facade = makeHonkyTonkFacade();
  const facadeMat = new THREE.MeshStandardMaterial({
    map: facade.map, emissiveMap: facade.emissive,
    emissive: 0xffc56a, emissiveIntensity: 1.15, roughness: 0.9,
  });
  const boxGeo = new THREE.BoxGeometry(1, 1, 1); boxGeo.translate(0, 0.5, 0);
  const NF = 16;
  const facades = makeInstanced(boxGeo, facadeMat, NF);
  const signGeo = new THREE.PlaneGeometry(0.9, 2.4);
  const signMat = new THREE.MeshBasicMaterial({ map: makeSignTexture(), side: THREE.DoubleSide });
  const signs = makeInstanced(signGeo, signMat, NF, false);
  const neon = [0xff2d95, 0x2de6ff, 0xffd23f, 0x9d4edd];
  const fSlots = [];
  for (let k = 0; k < NF; k++) {
    const side = k & 1 ? 1 : -1;
    fSlots.push({
      side, base: (k >> 1) * 38.5 + (side > 0 ? 19 : 0),
      margin: rnd(2.2, 9), w: rnd(3, 5.2), h: rnd(4, 9), d: rnd(3, 4.5),
    });
    signs.setColorAt(k, _ca.set(neon[k % 4]));
  }
  signs.instanceColor.needsUpdate = true;
  group.add(facades, signs);

  // streetlights: pole + warm head + additive light cone (the dusk pools)
  const NL = 14;
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 4.4, 8); poleGeo.translate(0, 2.2, 0);
  const poles = makeInstanced(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2c2c32, roughness: 0.6, metalness: 0.5 }), NL);
  const headGeo = new THREE.BoxGeometry(0.55, 0.12, 0.24);
  const heads = makeInstanced(headGeo, new THREE.MeshStandardMaterial({ color: 0xffe2a8, emissive: 0xffd98a, emissiveIntensity: 2.0 }), NL, false);
  const coneGeo = new THREE.ConeGeometry(1.5, 3.4, 14, 1, true); coneGeo.translate(0, -1.7, 0);
  const coneMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.16, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
  });
  const lightCones = makeInstanced(coneGeo, coneMat, NL, false);
  lightCones.renderOrder = 5;
  const lSlots = [];
  for (let k = 0; k < NL; k++) {
    const side = k & 1 ? 1 : -1;
    lSlots.push({ side, base: (k >> 1) * 44 + (side > 0 ? 22 : 0) });
  }
  group.add(poles, heads, lightCones);

  return {
    group,
    update(scroll) {
      for (let k = 0; k < NF; k++) {
        const s = fSlots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        const x = s.side * (ROAD_HALF + s.margin + s.d / 2);
        _dummy.position.set(x, 0, z);
        _dummy.scale.set(s.d, s.h, s.w);     // depth toward the road, width along it
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        facades.setMatrixAt(k, _dummy.matrix);
        // blade sign hangs off the road-facing wall, facing up/down the road
        _dummy.position.set(x - s.side * (s.d / 2 + 0.5), s.h * 0.55, z);
        _dummy.scale.set(1, Math.min(1.3, s.h / 7), 1);
        _dummy.rotation.set(0, Math.PI / 2, 0);
        _dummy.updateMatrix();
        signs.setMatrixAt(k, _dummy.matrix);
      }
      facades.instanceMatrix.needsUpdate = true;
      signs.instanceMatrix.needsUpdate = true;
      for (let k = 0; k < NL; k++) {
        const s = lSlots[k];
        const z = wrapZ(s.base, scroll, SCN_SPAN);
        const px = s.side * (ROAD_HALF + 0.95);
        _dummy.position.set(px, 0, z);
        _dummy.scale.set(1, 1, 1);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        poles.setMatrixAt(k, _dummy.matrix);
        _dummy.position.set(px - s.side * 0.45, 4.42, z);
        _dummy.updateMatrix();
        heads.setMatrixAt(k, _dummy.matrix);
        _dummy.position.set(px - s.side * 0.45, 4.36, z);
        _dummy.updateMatrix();
        lightCones.setMatrixAt(k, _dummy.matrix);
      }
      poles.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
      lightCones.instanceMatrix.needsUpdate = true;
    },
  };
}

function setSceneryBiome(idx) {
  if (idx === activeBiomeSet) return;
  activeBiomeSet = idx;
  for (let i = 0; i < biomeSets.length; i++) biomeSets[i].group.visible = i === idx;
}

// ============================================================
// 3D PARTICLES — pooled instanced quads: dust puffs on landing, sparks on a
// near-miss (and on a nitro smash-through). Fixed-size ring buffers; matrices
// rewritten in place every frame — nothing is allocated mid-run.
// ============================================================
const DUST_N = 48, SPARK_N = 48;
let dustMesh = null, sparkMesh = null;
// layout per particle: px py pz vx vy vz life maxLife
const dustP = new Float32Array(DUST_N * 8);
const sparkP = new Float32Array(SPARK_N * 8);
let dustCursor = 0, sparkCursor = 0;

function initParticles() {
  const dustMat = new THREE.MeshBasicMaterial({
    map: makePuffTexture(), transparent: true, opacity: 0.5,
    depthWrite: false, fog: true,
  });
  dustMesh = makeInstanced(new THREE.PlaneGeometry(0.34, 0.34), dustMat, DUST_N, false);
  dustMesh.renderOrder = 6;
  const sparkMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  sparkMesh = makeInstanced(new THREE.PlaneGeometry(0.09, 0.16), sparkMat, SPARK_N, false);
  sparkMesh.renderOrder = 7;
  for (let i = 0; i < DUST_N; i++) dustMesh.setColorAt(i, _ca.set(0x9a8a72));
  for (let i = 0; i < SPARK_N; i++) sparkMesh.setColorAt(i, _ca.set(0x000000));
  dustMesh.instanceColor.needsUpdate = true;
  sparkMesh.instanceColor.needsUpdate = true;
  scene.add(dustMesh, sparkMesh);
}

function emitDust(x, y, z, n) {
  for (let i = 0; i < n; i++) {
    const k = dustCursor; dustCursor = (dustCursor + 1) % DUST_N;
    const o = k * 8;
    dustP[o] = x + rnd(-0.7, 0.7);
    dustP[o + 1] = y + rnd(0, 0.15);
    dustP[o + 2] = z + rnd(-1.3, 1.3);
    dustP[o + 3] = rnd(-1.6, 1.6);
    dustP[o + 4] = rnd(0.6, 2.0);
    dustP[o + 5] = rnd(-0.6, 2.4);
    dustP[o + 7] = rnd(0.5, 0.9);
    dustP[o + 6] = dustP[o + 7];
  }
}

function emitSparks(x, y, z, n) {
  for (let i = 0; i < n; i++) {
    const k = sparkCursor; sparkCursor = (sparkCursor + 1) % SPARK_N;
    const o = k * 8;
    sparkP[o] = x + rnd(-0.3, 0.3);
    sparkP[o + 1] = Math.max(0.15, y + rnd(-0.3, 0.3));
    sparkP[o + 2] = z + rnd(-0.3, 0.3);
    sparkP[o + 3] = rnd(-3.5, 3.5);
    sparkP[o + 4] = rnd(1.5, 5.5);
    sparkP[o + 5] = rnd(-2, 5);
    sparkP[o + 7] = rnd(0.3, 0.55);
    sparkP[o + 6] = sparkP[o + 7];
  }
}

function updateParticles(dt) {
  // dust: buoyant puffs that grow then thin out (scale handles the fade)
  for (let i = 0; i < DUST_N; i++) {
    const o = i * 8;
    let life = dustP[o + 6];
    if (life > 0) {
      life -= dt; if (life < 0) life = 0;
      dustP[o + 6] = life;
      const drag = Math.max(0, 1 - 2.2 * dt);
      dustP[o + 3] *= drag; dustP[o + 5] *= drag;
      dustP[o + 4] += 0.8 * dt;
      dustP[o] += dustP[o + 3] * dt;
      dustP[o + 1] += dustP[o + 4] * dt;
      dustP[o + 2] += dustP[o + 5] * dt;
    }
    if (life > 0) {
      const age = 1 - life / dustP[o + 7];
      const tail = Math.min(1, life / (dustP[o + 7] * 0.35));
      _dummy.position.set(dustP[o], dustP[o + 1], dustP[o + 2]);
      _dummy.scale.setScalar((0.7 + age * 1.6) * tail);
      _dummy.quaternion.copy(camera.quaternion);
    } else {
      _dummy.position.set(0, -10, 0);
      _dummy.scale.setScalar(0.0001);
    }
    _dummy.updateMatrix();
    dustMesh.setMatrixAt(i, _dummy.matrix);
  }
  dustMesh.instanceMatrix.needsUpdate = true;

  // sparks: hot streaks under gravity; additive colour fades to black
  for (let i = 0; i < SPARK_N; i++) {
    const o = i * 8;
    let life = sparkP[o + 6];
    if (life > 0) {
      life -= dt; if (life < 0) life = 0;
      sparkP[o + 6] = life;
      sparkP[o + 4] -= 13 * dt;
      sparkP[o] += sparkP[o + 3] * dt;
      sparkP[o + 1] += sparkP[o + 4] * dt;
      sparkP[o + 2] += sparkP[o + 5] * dt;
      if (sparkP[o + 1] < 0.04) { sparkP[o + 1] = 0.04; sparkP[o + 4] *= -0.4; }
    }
    if (life > 0) {
      const f = life / sparkP[o + 7];
      _pc.setRGB(1, 0.55 + 0.45 * f, 0.15 * f).multiplyScalar(f);
      sparkMesh.setColorAt(i, _pc);
      _dummy.position.set(sparkP[o], sparkP[o + 1], sparkP[o + 2]);
      _dummy.scale.setScalar(0.5 + f * 0.7);
      _dummy.quaternion.copy(camera.quaternion);
    } else {
      sparkMesh.setColorAt(i, _pc.setRGB(0, 0, 0));
      _dummy.position.set(0, -10, 0);
      _dummy.scale.setScalar(0.0001);
    }
    _dummy.updateMatrix();
    sparkMesh.setMatrixAt(i, _dummy.matrix);
  }
  sparkMesh.instanceMatrix.needsUpdate = true;
  sparkMesh.instanceColor.needsUpdate = true;
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
  // Filmic ACES; the per-biome EXPOSURE grade is applied every frame in
  // renderFrame(). The sky-dome shader applies the same tone mapping +
  // colourspace chunks, so the horizon meets the fogged ground without a seam.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color('#9bc3e0');
  scene.fog = new THREE.Fog('#9bc3e0', 55, 420);
  // Procedural equirect environment — chrome/clearcoat reflections without
  // any HDR download. Kept subtle so the biome sun/sky still set the mood.
  scene.environment = makeEnvTexture();
  scene.environmentIntensity = 0.45;

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

  // Billboard sun disc — rides the directional-light vector out on the dome,
  // tinted per biome, so the 3D sky finally matches the 2D legs' painted sun.
  sunSpriteMat = new THREE.SpriteMaterial({
    map: makeSunTexture(), transparent: true, depthWrite: false, fog: false, opacity: 0.95,
  });
  sunSprite = new THREE.Sprite(sunSpriteMat);
  sunSprite.scale.set(240, 240, 1);
  sunSprite.position.set(450, 340, -840);
  scene.add(sunSprite);

  // Soft drifting clouds high on the dome (the 2D sky has them; 3D didn't).
  const cloudTex = makeCloudTexture();
  for (let i = 0; i < 7; i++) {
    const cm = new THREE.SpriteMaterial({
      map: cloudTex, transparent: true, depthWrite: false, fog: false,
      opacity: 0.42 + Math.random() * 0.2,
    });
    const cl = new THREE.Sprite(cm);
    const cw = 200 + Math.random() * 260;
    cl.scale.set(cw, cw * (0.3 + Math.random() * 0.14), 1);
    cl.position.set(-680 + (i + Math.random() * 0.7) * 200, 200 + Math.random() * 250, -1050 - Math.random() * 250);
    cl.userData.drift = 2.5 + Math.random() * 4;
    scene.add(cl); clouds.push(cl);
  }

  // --- road (canvas-baked asphalt w/ worn wheel tracks) + shoulders --------
  const roadLen = Z_NEAR - Z_FAR;
  const roadCz = (Z_NEAR + Z_FAR) / 2;
  const asphalt = makeAsphaltTextures();
  asphalt.map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  roadTexWorldPerRepeat = roadLen / asphalt.map.repeat.y;
  M.road = new THREE.MeshStandardMaterial({
    color: '#222226', map: asphalt.map,
    bumpMap: asphalt.bump, bumpScale: 0.6,
    roughness: 0.9,
  });
  M.roadMap = asphalt.map; M.roadBump = asphalt.bump;
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

  // --- guardrails: two static rail beams per side + INSTANCED posts with
  // emissive reflector chips that scroll with the road ----------------------
  M.rail = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, metalness: 0.75, roughness: 0.35 });
  const railGeo = new THREE.BoxGeometry(0.16, 0.3, roadLen);
  const railLipGeo = new THREE.BoxGeometry(0.10, 0.12, roadLen);
  for (const s of [-1, 1]) {
    const r = new THREE.Mesh(railGeo, M.rail);
    r.position.set(s * (ROAD_HALF + 0.55), 0.62, roadCz);
    r.castShadow = true;
    scene.add(r);
    const lip = new THREE.Mesh(railLipGeo, M.rail);
    lip.position.set(s * (ROAD_HALF + 0.55), 0.38, roadCz);
    scene.add(lip);
  }
  const gpGeo = new THREE.BoxGeometry(0.12, 0.62, 0.16);
  gpGeo.translate(0, 0.31, 0);
  guardPosts = makeInstanced(gpGeo, new THREE.MeshStandardMaterial({ color: 0x70747c, metalness: 0.6, roughness: 0.5 }), GUARD_N * 2);
  const reflGeo = new THREE.BoxGeometry(0.03, 0.07, 0.11);
  guardRefl = makeInstanced(reflGeo, new THREE.MeshStandardMaterial({ color: 0xffe9a0, emissive: 0xffd76a, emissiveIntensity: 1.5 }), GUARD_N * 2, false);
  scene.add(guardPosts, guardRefl);

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

  // --- lane-boundary dashes (reflective paint: emissive + low roughness) ---
  M.dash = new THREE.MeshStandardMaterial({
    color: 0xffea88, emissive: 0x8a6f1c, emissiveIntensity: 0.7,
    roughness: 0.25, metalness: 0.2,
  });
  const dashGeo = new THREE.PlaneGeometry(0.28, 2.4);
  const dashCount = Math.ceil(DASH_SPAN / DASH_GAP);
  for (const bx of [-LANE_W / 2 - 0.05, LANE_W / 2 + 0.05]) {
    for (let i = 0; i < dashCount; i++) {
      const d = new THREE.Mesh(dashGeo, M.dash);
      d.rotation.x = -Math.PI / 2; d.position.y = 0.02; d.position.x = bx;
      scene.add(d); dashes.push(d);
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

  // --- prebuilt instanced scenery, one set per Nashville leg ---
  biomeSets.length = 0;
  biomeSets.push(buildDowntownSet(), buildMusicRowSet(), buildCumberlandSet(), buildBroadwaySet());
  for (const set of biomeSets) { set.group.visible = false; scene.add(set.group); }
  setSceneryBiome(bridge.state.biomeIdx);
  lastBiomeIdx = bridge.state.biomeIdx;

  initParticles();

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
  // Per-biome exposure grade: dawn/sunset legs run darker so the
  // peach-to-amber 2D palette survives ACES instead of washing out.
  renderer.toneMappingExposure = biomeLerp(EXPOSURE);
  // Sun disc rides the key-light direction out onto the dome, tinted per leg.
  sunSprite.position.copy(sun.position).normalize().multiplyScalar(1150);
  if (sunSprite.position.y < 120) sunSprite.position.y = 120;  // stay above the haze band
  sunSpriteMat.color.copy(biomeColor('sunColor'));
  // Clouds drift slowly and pick up the horizon tint (peach dawn, pink dusk).
  for (const cl of clouds) {
    cl.position.x += cl.userData.drift * dt;
    if (cl.position.x > 760) cl.position.x = -760;
    cl.material.color.copy(skyMat.uniforms.horizonColor.value).lerp(_white, 0.55);
  }
  // 2D palette road/grass hexes are dark; lift them so ACES doesn't crush
  // the asphalt to black under the chase camera. The asphalt map multiplies
  // against this colour (mid-grey base), hence the higher factor than 2D.
  M.road.color.copy(biomeColor('road')).multiplyScalar(2.1);
  M.grass.color.copy(biomeColor('grass')).multiplyScalar(1.25);

  // --- livery: read the run's car style live from state ---
  const style = st.carStyle;
  if (style && style.name !== lastLivery) {
    lastLivery = style.name;
    bodyMat.color.set(style.body);
    stripeMat.color.set(style.stripe);
  }

  // --- scroll the asphalt texture + markings / guardrail posts ---
  const scroll = st.distance * SCALE_Z;
  M.roadMap.offset.y = (scroll / roadTexWorldPerRepeat) % 1;
  M.roadBump.offset.y = M.roadMap.offset.y;
  const perLine = dashes.length >> 1;
  for (let i = 0; i < dashes.length; i++) {
    const k = i % perLine;
    const wrap = (((k * DASH_GAP - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    dashes[i].position.z = Z_NEAR - wrap;
  }
  const postGap = DASH_SPAN / 9;
  for (let i = 0; i < GUARD_N * 2; i++) {
    const k = i >> 1, side = (i & 1) ? 1 : -1;
    const wrap = (((k * postGap - scroll) % DASH_SPAN) + DASH_SPAN) % DASH_SPAN;
    const z = Z_NEAR - wrap;
    _dummy.position.set(side * (ROAD_HALF + 0.55), 0, z);
    _dummy.rotation.set(0, 0, 0);
    _dummy.scale.set(1, 1, 1);
    _dummy.updateMatrix();
    guardPosts.setMatrixAt(i, _dummy.matrix);
    _dummy.position.set(side * (ROAD_HALF + 0.47), 0.55, z);
    _dummy.updateMatrix();
    guardRefl.setMatrixAt(i, _dummy.matrix);
  }
  guardPosts.instanceMatrix.needsUpdate = true;
  guardRefl.instanceMatrix.needsUpdate = true;

  // --- roadside scenery: swap the visible set on biome change, then scroll ---
  if (st.biomeIdx !== lastBiomeIdx) lastBiomeIdx = st.biomeIdx;
  setSceneryBiome(st.biomeIdx);
  biomeSets[Math.min(st.biomeIdx, biomeSets.length - 1)].update(scroll);

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

  // --- particles: dust burst when the jump lands; sparks handled per-obstacle ---
  if (prevJumping && !p.jumping && lift < 0.05 &&
      st.screen === bridge.SCREEN.PLAYING) {
    emitDust(carX, 0.08, 0.4, 10);
  }
  prevJumping = !!p.jumping;
  updateParticles(st.screen === bridge.SCREEN.PAUSED ? 0 : dt);

  // --- entities: map each 2D {x,y,w,h,lane} to a 3D mesh at lane X, depth Z ---
  poolReset();
  const t = st.runTime || 0;

  for (const o of st.obstacles) {
    // sparks: fire once per obstacle on a near-miss (or a nitro smash-through)
    if ((o.nearMissed || (o.hit && st.nitro > 0)) && !sparkedSet.has(o)) {
      sparkedSet.add(o);
      emitSparks(laneX(o.lane), Math.max(0.3, worldH(o.h) * 0.5), zForX(o.x), 13);
    }
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
