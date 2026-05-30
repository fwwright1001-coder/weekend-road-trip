// ============================================================
// gta/world.js — the open-world city the sandbox plays on
// ------------------------------------------------------------
// Builds a seeded low-poly city block grid with a real ROAD NETWORK (so traffic
// and police have lanes to drive), sidewalks, districts, and landmark spawn
// points for missions. Exposes the collision + navigation API every other
// system depends on. This is the one system everyone else lists in `deps`.
//
// Collision contract (matches onfoot3d.js so integration is a drop-in):
//   world.resolve(pos, pad)  — push a THREE.Vector3 out of any building AABB and
//                              clamp to map bounds (mutates pos). Same semantics
//                              as onfoot3d.js resolveCollision().
//   world.isInside(x,z,pad)  — returns the blocking AABB or null.
//
// Navigation contract (for traffic / police AI):
//   world.onRoad(x,z)        — is this point on a drivable road?
//   world.nearestRoad(x,z,o) — snap to nearest road centreline (writes o.x/o.z/o.dir)
//   world.randomSpawn(rng,pad)        — free walkable point (Vector3)
//   world.randomRoadSpawn(rng,out)    — point + heading on a road
//
// All art is generated in code (original, no external assets).
// ============================================================
import { GTA, GU } from './core.js';

// ---- city tunables ---------------------------------------------------------
const BOUND = 120;          // half-size of the walkable/drivable map
const BLOCK = 40;           // grid spacing (road centre to road centre)
const ROAD_HALF = 5.0;      // half width of a road (drivable)
const SIDEWALK = 2.2;       // sidewalk band outside the road
const SEED = 0x6cED2A11;

// road centrelines live on the grid lines x = k*BLOCK and z = k*BLOCK,
// for k in [-GRID..GRID]. Buildings fill the interior of each block.
const GRID = Math.floor(BOUND / BLOCK);   // lines at -GRID..GRID

function isRoadCoord(v) {
  // distance from v to nearest multiple of BLOCK, within ROAD_HALF
  const m = Math.abs(((v + BLOCK * 100) % BLOCK));
  const d = Math.min(m, BLOCK - m);
  return d <= ROAD_HALF;
}

const world = {
  name: 'world',
  built: false,
  aabbs: [],          // {minX,maxX,minZ,maxZ, kind}
  spawnPoints: [],    // {name, pos:{x,z}, district}
  _group: null,

  init(ctx) {
    if (this.built) return;
    const THREE = ctx.THREE;
    const rng = GU.makeRng(SEED);
    const root = new THREE.Group();
    root.name = 'gta-world';
    this._group = root;

    // ---------- ground: grass apron + asphalt road grid ----------
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(BOUND * 2 + 200, BOUND * 2 + 200),
      new THREE.MeshStandardMaterial({ color: 0x4f7a44, roughness: 1 }));
    grass.rotation.x = -Math.PI / 2; grass.position.y = -0.04; grass.receiveShadow = true;
    root.add(grass);

    const asphaltMat = new THREE.MeshStandardMaterial({ color: 0x2c2d33, roughness: 0.95 });
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x6b6e75, roughness: 0.9 });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf3e07a });

    const fullSpan = BOUND * 2 + BLOCK;
    for (let k = -GRID; k <= GRID; k++) {
      const c = k * BLOCK;
      // two orientations: road strip running along Z (varying x=c) and along X
      for (const along of ['z', 'x']) {
        const w = along === 'z' ? ROAD_HALF * 2 : fullSpan;
        const d = along === 'z' ? fullSpan : ROAD_HALF * 2;
        const road = new THREE.Mesh(new THREE.PlaneGeometry(w, d), asphaltMat);
        road.rotation.x = -Math.PI / 2;
        road.position.set(along === 'z' ? c : 0, -0.015, along === 'z' ? 0 : c);
        road.receiveShadow = true; root.add(road);
        // sidewalk bands flanking each road
        for (const s of [-1, 1]) {
          const sw = new THREE.Mesh(
            along === 'z' ? new THREE.PlaneGeometry(SIDEWALK, fullSpan) : new THREE.PlaneGeometry(fullSpan, SIDEWALK),
            sidewalkMat);
          sw.rotation.x = -Math.PI / 2;
          const off = (ROAD_HALF + SIDEWALK / 2) * s;
          sw.position.set(along === 'z' ? c + off : 0, -0.01, along === 'z' ? 0 : c + off);
          sw.receiveShadow = true; root.add(sw);
        }
        // dashed centre line
        const lineGeo = new THREE.PlaneGeometry(along === 'z' ? 0.28 : 2.4, along === 'z' ? 2.4 : 0.28);
        for (let p = -BOUND; p <= BOUND; p += 6) {
          const ln = new THREE.Mesh(lineGeo, lineMat);
          ln.rotation.x = -Math.PI / 2;
          ln.position.set(along === 'z' ? c : p, 0.005, along === 'z' ? p : c);
          root.add(ln);
        }
      }
    }

    // ---------- buildings: one cluster per block interior ----------
    const buildingMats = [0x6b7280, 0x7a6f63, 0x5c6b7a, 0x736a78, 0x6f7a6a, 0x8a7d6b, 0x556070]
      .map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
    const winMat = new THREE.MeshStandardMaterial({ color: 0xffe39a, emissive: 0xffcf6a, emissiveIntensity: 0.7, roughness: 0.5 });
    const parkMat = new THREE.MeshStandardMaterial({ color: 0x3f7a3c, roughness: 1 });
    const treeTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3c22, roughness: 1 });
    const treeLeafMat = new THREE.MeshStandardMaterial({ color: 0x2f6a34, roughness: 1 });

    for (let gx = -GRID; gx < GRID; gx++) {
      for (let gz = -GRID; gz < GRID; gz++) {
        const cx = gx * BLOCK + BLOCK / 2;
        const cz = gz * BLOCK + BLOCK / 2;
        const district = this._districtFor(cx, cz);

        if (district === 'park' || GU.chance(rng, 0.10)) {
          // green block: lawn + a few trees, no collision walls
          const lawn = new THREE.Mesh(new THREE.PlaneGeometry(BLOCK - SIDEWALK * 2 - ROAD_HALF, BLOCK - SIDEWALK * 2 - ROAD_HALF), parkMat);
          lawn.rotation.x = -Math.PI / 2; lawn.position.set(cx, 0.002, cz); lawn.receiveShadow = true; root.add(lawn);
          const nTrees = 3 + (rng() * 4 | 0);
          for (let i = 0; i < nTrees; i++) {
            const tx = cx + GU.rand(rng, -12, 12), tz = cz + GU.rand(rng, -12, 12);
            root.add(this._tree(THREE, treeTrunkMat, treeLeafMat, tx, tz, rng));
          }
          this.spawnPoints.push({ name: `park_${gx}_${gz}`, pos: { x: cx, z: cz }, district: 'park' });
          continue;
        }

        // 1–4 buildings packed into the block interior
        const count = 1 + (rng() * 3 | 0);
        const half = (BLOCK - ROAD_HALF * 2 - SIDEWALK * 2) / 2;
        for (let b = 0; b < count; b++) {
          const bw = GU.rand(rng, 8, half * 1.1);
          const bd = GU.rand(rng, 8, half * 1.1);
          const tall = district === 'downtown';
          const bh = tall ? GU.rand(rng, 16, 46) : GU.rand(rng, 6, 18);
          const bx = cx + GU.rand(rng, -half * 0.5, half * 0.5);
          const bz = cz + GU.rand(rng, -half * 0.5, half * 0.5);
          const mat = GU.pick(rng, buildingMats);
          const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
          body.position.set(bx, bh / 2, bz);
          body.castShadow = true; body.receiveShadow = true;
          root.add(body);
          this._addWindows(THREE, root, winMat, bx, bz, bw, bd, bh, rng);
          this.aabbs.push({ minX: bx - bw / 2, maxX: bx + bw / 2, minZ: bz - bd / 2, maxZ: bz + bd / 2, kind: 'building' });
        }
        this.spawnPoints.push({ name: `block_${gx}_${gz}`, pos: { x: cx, z: cz }, district });
      }
    }

    // ---------- street furniture along road edges (lamps) ----------
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x33363c, roughness: 0.7 });
    const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff0b0, emissive: 0xffd070, emissiveIntensity: 1.1 });
    for (let k = -GRID; k <= GRID; k++) {
      for (let p = -BOUND + 10; p < BOUND; p += BLOCK) {
        for (const s of [-1, 1]) {
          this._lamp(THREE, root, poleMat, bulbMat, k * BLOCK + (ROAD_HALF + 1.2) * s, p);
          this._lamp(THREE, root, poleMat, bulbMat, p, k * BLOCK + (ROAD_HALF + 1.2) * s);
        }
      }
    }

    ctx.scene.add(root);
    this.built = true;

    // make the world api reachable both ways
    this.api.bound = BOUND;
    ctx.world = this.api;
  },

  update() { /* static world; nothing per-frame */ },
  reset() { /* nothing to reset */ },

  // ---------- generation helpers ----------
  _districtFor(x, z) {
    const r = Math.hypot(x, z);
    if (r < BLOCK * 1.5) return 'downtown';
    // a dedicated park ring band
    if (Math.abs(Math.abs(x) - BLOCK * 2) < 6 && Math.abs(z) < BLOCK * 1.2) return 'park';
    if (r > BOUND * 0.66) return 'industrial';
    return 'residential';
  },
  _addWindows(THREE, root, mat, bx, bz, bw, bd, bh, rng) {
    const rows = Math.max(2, (bh / 3.2) | 0);
    const cols = Math.max(2, (bw / 3) | 0);
    const winGeo = new THREE.BoxGeometry(0.9, 1.2, 0.08);
    for (let face = -1; face <= 1; face += 2) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        if (GU.chance(rng, 0.4)) continue;
        const win = new THREE.Mesh(winGeo, mat);
        win.position.set(bx - bw / 2 + 1 + c * (bw - 2) / Math.max(1, cols - 1),
          2 + r * (bh - 3) / Math.max(1, rows - 1), bz + face * (bd / 2 + 0.05));
        root.add(win);
      }
    }
  },
  _tree(THREE, trunkMat, leafMat, x, z, rng) {
    const g = new THREE.Group();
    const th = GU.rand(rng, 1.4, 2.4);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, th, 7), trunkMat);
    trunk.position.y = th / 2; trunk.castShadow = true;
    const ch = GU.rand(rng, 2.5, 4);
    const crown = new THREE.Mesh(new THREE.ConeGeometry(GU.rand(rng, 1.2, 2), ch, 8), leafMat);
    crown.position.y = th + ch / 2 - 0.3; crown.castShadow = true;
    g.add(trunk, crown); g.position.set(x, 0, z);
    return g;
  },
  _lamp(THREE, root, poleMat, bulbMat, x, z) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 4.2, 8), poleMat);
    pole.position.y = 2.1; pole.castShadow = true;
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 10), bulbMat);
    bulb.position.y = 4.2;
    g.add(pole, bulb); g.position.set(x, 0, z); root.add(g);
  },

  // ============================================================
  // PUBLIC API (other systems call ctx.systems.world.api.* or ctx.world.*)
  // ============================================================
  api: {
    bound: BOUND,
    blockSize: BLOCK,
    roadHalf: ROAD_HALF,

    isInside(x, z, pad = 0) {
      const a = world.aabbs;
      for (let i = 0; i < a.length; i++) {
        const b = a[i];
        if (x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad) return b;
      }
      return null;
    },

    // push pos (Vector3) out of buildings along the shallowest axis + clamp bounds
    resolve(pos, pad = 0.4) {
      const a = world.aabbs;
      for (let i = 0; i < a.length; i++) {
        const b = a[i];
        if (pos.x > b.minX - pad && pos.x < b.maxX + pad && pos.z > b.minZ - pad && pos.z < b.maxZ + pad) {
          const dl = pos.x - (b.minX - pad), dr = (b.maxX + pad) - pos.x;
          const db = pos.z - (b.minZ - pad), df = (b.maxZ + pad) - pos.z;
          const m = Math.min(dl, dr, db, df);
          if (m === dl) pos.x = b.minX - pad;
          else if (m === dr) pos.x = b.maxX + pad;
          else if (m === db) pos.z = b.minZ - pad;
          else pos.z = b.maxZ + pad;
        }
      }
      pos.x = GU.clamp(pos.x, -BOUND, BOUND);
      pos.z = GU.clamp(pos.z, -BOUND, BOUND);
      return pos;
    },

    onRoad(x, z) {
      if (Math.abs(x) > BOUND || Math.abs(z) > BOUND) return false;
      return isRoadCoord(x) || isRoadCoord(z);
    },

    // snap (x,z) to the nearest road centreline; writes out.x,out.z and out.dir
    // (unit heading along the road, radians: 0 = +Z, PI/2 = +X)
    nearestRoad(x, z, out = {}) {
      const sx = Math.round(x / BLOCK) * BLOCK;   // nearest vertical road (const x)
      const sz = Math.round(z / BLOCK) * BLOCK;   // nearest horizontal road (const z)
      const dx = Math.abs(x - sx), dz = Math.abs(z - sz);
      if (dx < dz) { out.x = sx; out.z = z; out.dir = 0; }          // run along Z
      else { out.x = x; out.z = sz; out.dir = Math.PI / 2; }        // run along X
      out.x = GU.clamp(out.x, -BOUND, BOUND);
      out.z = GU.clamp(out.z, -BOUND, BOUND);
      return out;
    },

    // a free walkable point that is not inside a building
    randomSpawn(rng, pad = 0.6, out) {
      const r = rng || Math.random;
      let x, z, tries = 0;
      do { x = (r() * 2 - 1) * (BOUND - 4); z = (r() * 2 - 1) * (BOUND - 4); tries++; }
      while (world.api.isInside(x, z, pad) && tries < 50);
      if (out) { out.set(x, 0, z); return out; }
      return new GTA.ctx.THREE.Vector3(x, 0, z);
    },

    // a point + heading sitting on a road lane (for traffic/police spawns)
    randomRoadSpawn(rng, out = {}) {
      const r = rng || Math.random;
      const line = (Math.round((r() * 2 - 1) * GRID)) * BLOCK;
      const along = (r() * 2 - 1) * (BOUND - 6);
      const lane = ROAD_HALF * 0.5;
      if (r() < 0.5) { out.x = line + (r() < 0.5 ? -lane : lane); out.z = along; out.dir = r() < 0.5 ? 0 : Math.PI; }
      else { out.x = along; out.z = line + (r() < 0.5 ? -lane : lane); out.dir = r() < 0.5 ? Math.PI / 2 : -Math.PI / 2; }
      return out;
    },

    district(x, z) { return world._districtFor(x, z); },
    landmarks() { return world.spawnPoints; },
    randomLandmark(rng) { return GU.pick(rng, world.spawnPoints); },
  },
};

GTA.register(world);
export default world;
