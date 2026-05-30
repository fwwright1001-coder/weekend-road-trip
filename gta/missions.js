// ============================================================
// gta/missions.js — mission/objective FRAMEWORK + sample missions
// ------------------------------------------------------------
// A tiny, decoupled mission runner for the crime-sandbox layer. It owns:
//   * a registry of mission DEFINITIONS (id, title, objectives[], reward, ...)
//   * floating "start markers" placed at world landmarks (glowing pillars).
//     Walk within ~2.5m of one with no mission active -> that mission starts.
//   * a runner that walks the active mission's objectives one at a time,
//     drawing a beacon at the current objective marker + a radar blip, and
//     advancing as each objective's test() passes. On the final objective it
//     pays the reward (economy.add) and emits 'mission:complete'. On a time
//     limit / fail() it emits 'mission:failed' and aborts.
//
// Objective KINDS supported (def.objectives[i].kind):
//   'goto'      reach a marker within radius
//   'eliminate' kill N targets (counts 'entityKilled' byPlayer events)
//   'collect'   walk over a spawned package mesh
//   'deliver'   reach a dropoff marker (optionally while in a vehicle)
//   'survive'   stay alive / hold out until a timer elapses
//   'evade'     drop the wanted level back to 0 stars
//
// Everything is decoupled through GTA.bus + cross-system api, and every call
// into another system is null-guarded because load order varies and a sibling
// system may not be present in a given build. No external assets — all meshes
// are generated in code. No per-frame allocation in the hot path.
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
const START_TRIGGER_R = 2.5;     // walk this close to a start marker to begin
const GOTO_R = 4.0;              // 'goto' / 'deliver' reach radius
const COLLECT_R = 2.2;           // 'collect' pickup radius
const HOTSPOT_SPREAD = 7.0;      // radius targets/objectives scatter around a hotspot
const BEACON_SPIN = 1.4;         // rad/s spin of the objective beacon
const PILLAR_SPIN = 0.6;         // rad/s spin of idle start markers
const MARKER_Y = 0;              // markers sit on the ground, rise upward

// ---- module-scope scratch (NO per-frame allocation) ------------------------
// ctx.THREE isn't available at module-eval time, so the scratch Vector3s are
// created lazily in init() and reused everywhere after. world.resolve() only
// reads/writes .x/.z so even before promotion these stand-ins are safe inputs;
// init() upgrades them to real Vector3 instances on first boot.
let THREE = null;                 // bound in init from ctx.THREE
let _v = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
const _tmp = { x: 0, z: 0, dir: 0 };

// ============================================================
// THE SYSTEM
// ============================================================
const missions = {
  name: 'missions',
  deps: ['world', 'economy'],

  // registry + runtime
  _defs: new Map(),          // id -> mission def
  _markers: [],              // [{ id, mesh, pos:{x,z}, label }]
  _root: null,               // THREE.Group holding all mission visuals
  _beacon: null,             // single reusable objective beacon mesh
  _package: null,            // single reusable collectible package mesh
  _dropMesh: null,           // single reusable dropoff ring mesh
  _hotspotRing: null,        // single reusable hotspot ring mesh

  // active mission state
  _active: null,             // active mission def (or null)
  _objIndex: 0,              // current objective index
  _m: null,                  // scratch state bag handed to mission/objective callbacks
  _killCount: 0,             // running kill tally (for 'eliminate')
  _killWant: 0,              // target kill count for current 'eliminate'
  _objSetup: false,          // has the current objective's setup() run
  _objStart: 0,              // ctx.time.t when current objective began
  _misStart: 0,              // ctx.time.t when mission began
  _collected: false,         // has the active 'collect' package been grabbed
  _curMarker: { x: 0, z: 0, active: false }, // where the objective beacon should sit

  _unsub: [],                // bus unsubscribe fns (cleared on reset isn't needed; init once)

  // ----------------------------------------------------------
  init(ctx) {
    THREE = ctx.THREE;
    if (!THREE) return;

    // tear down any prior bus subscriptions so re-init is safe & consistent
    // with sibling systems (no duplicate handlers on re-init).
    for (const off of this._unsub || []) { try { off(); } catch {} }
    this._unsub = [];

    // upgrade module scratch to a real Vector3 (once)
    if (!_v.isVector3) _v = new THREE.Vector3();

    // build a root group for all mission visuals (lazily, once)
    if (!this._root) {
      this._root = new THREE.Group();
      this._root.name = 'gta-missions';
      if (ctx.scene) ctx.scene.add(this._root);
    }

    // shared reusable meshes (pooled-by-singleton: one beacon, one package, etc.)
    if (!this._beacon) { this._beacon = makeBeacon(THREE); this._beacon.visible = false; this._root.add(this._beacon); }
    if (!this._package) { this._package = makePackage(THREE); this._package.visible = false; this._root.add(this._package); }
    if (!this._dropMesh) { this._dropMesh = makeDropoff(THREE); this._dropMesh.visible = false; this._root.add(this._dropMesh); }
    if (!this._hotspotRing) { this._hotspotRing = makeHotspot(THREE); this._hotspotRing.visible = false; this._root.add(this._hotspotRing); }

    // register the sample missions (idempotent — Map keyed by id)
    registerSamples(this);

    // place start markers at landmarks (only once)
    this._placeStartMarkers(ctx);

    // listen for kills (eliminate objectives) — (re)subscribe; teardown above
    // guarantees no duplicate handlers across re-inits.
    this._wired = true;
    const offKill = GTA.bus.on('entityKilled', (p) => {
      if (!p || !p.byPlayer) return;
      if (this._active && this._active.objectives[this._objIndex] &&
          this._active.objectives[this._objIndex].kind === 'eliminate') {
        // only count peds/cops (not the player)
        if (p.kind !== 'ped' && p.kind !== 'cop') return;
        // if this objective has a hotspot, only count kills inside its radius so
        // the on-screen ring isn't misleading; with no hotspot, count any kill.
        const hs = this._m && this._m.hotspot;
        if (hs && typeof hs.x === 'number' && p.pos && typeof p.pos.x === 'number') {
          if (GU.dist2D(p.pos.x, p.pos.z, hs.x, hs.z) > HOTSPOT_SPREAD) return;
        }
        this._killCount++;
      }
    });
    // clean up the active mission's spawned helpers if the player dies/respawns
    const offResp = GTA.bus.on('playerRespawn', () => { try { this.api.abort(); } catch (e) {} });
    this._unsub.push(offKill, offResp);
  },

  // ----------------------------------------------------------
  // place 2–3 floating start markers at distinct landmarks
  // ----------------------------------------------------------
  _placeStartMarkers(ctx) {
    if (this._markers.length) return; // already placed
    const world = ctx.systems && ctx.systems.world ? ctx.systems.world.api : (ctx.world || null);

    // choose spots: prefer named landmarks, fall back to fixed offsets
    const ids = ['repo', 'sweep', 'courier'];
    const colors = [0x47b6ff, 0xff5d5d, 0x6df08a];
    const seedRng = GU.makeRng(0x51A57E);
    const used = [];

    for (let i = 0; i < ids.length; i++) {
      let sx, sz;
      let placed = false;
      // try a handful of landmark picks that aren't too close to each other
      for (let t = 0; t < 24 && world && world.randomLandmark; t++) {
        const lm = world.randomLandmark(seedRng);
        if (!lm || !lm.pos) continue;
        const x = lm.pos.x, z = lm.pos.z;
        let ok = true;
        for (const u of used) { if (GU.dist2D(x, z, u.x, u.z) < 30) { ok = false; break; } }
        if (lm.district === 'park') { /* parks are fine and open */ }
        if (ok) { sx = x; sz = z; placed = true; break; }
      }
      if (!placed) {
        // deterministic fallback ring around origin
        const ang = (i / ids.length) * Math.PI * 2;
        const rad = 46;
        sx = Math.cos(ang) * rad;
        sz = Math.sin(ang) * rad;
        // nudge onto open ground if a world is present
        if (world && world.resolve) { _v.set(sx, 0, sz); world.resolve(_v, 1.2); sx = _v.x; sz = _v.z; }
      }
      used.push({ x: sx, z: sz });

      const def = this._defs.get(ids[i]);
      const mesh = makePillar(THREE, colors[i]);
      mesh.position.set(sx, MARKER_Y, sz);
      this._root.add(mesh);
      this._markers.push({ id: ids[i], mesh, pos: { x: sx, z: sz }, label: def ? def.title : ids[i] });

      GTA.bus.emit('mission:offered', { id: ids[i], title: def ? def.title : ids[i], pos: { x: sx, z: sz } });
    }
  },

  // ----------------------------------------------------------
  update(dt, ctx) {
    if (!THREE || !ctx) return;
    const t = ctx.time ? ctx.time.t : 0;
    const player = ctx.player;
    if (!player || !player.pos) return;

    // spin / bob the idle start markers (cheap)
    for (let i = 0; i < this._markers.length; i++) {
      const mk = this._markers[i];
      if (!mk.mesh) continue;
      // hide a marker while its mission is the active one
      const isActive = this._active && this._active.id === mk.id;
      mk.mesh.visible = !isActive;
      if (mk.mesh.visible) {
        mk.mesh.rotation.y += PILLAR_SPIN * dt;
        const inner = mk.mesh.userData.inner;
        if (inner) inner.position.y = 3.0 + Math.sin(t * 2.2 + i) * 0.35;
      }
    }

    // ---- no active mission: check start triggers ----
    if (!this._active) {
      for (let i = 0; i < this._markers.length; i++) {
        const mk = this._markers[i];
        if (GU.dist2D(player.pos.x, player.pos.z, mk.pos.x, mk.pos.z) <= START_TRIGGER_R) {
          this.api.start(mk.id);
          break;
        }
      }
      // make sure transient visuals are hidden when idle
      this._beacon.visible = false;
      this._package.visible = false;
      this._dropMesh.visible = false;
      this._hotspotRing.visible = false;
      return;
    }

    // ---- active mission: run the current objective ----
    this._runObjective(dt, ctx, t);
  },

  // ----------------------------------------------------------
  // drive the current objective: setup() once, then test() each frame
  // ----------------------------------------------------------
  _runObjective(dt, ctx, t) {
    const def = this._active;
    const obj = def.objectives[this._objIndex];
    if (!obj) { this._complete(ctx); return; }

    // run setup once when we enter this objective
    if (!this._objSetup) {
      this._objSetup = true;
      this._objStart = t;
      this._collected = false;
      this._curMarker.active = false;
      // 'eliminate' resets its kill tally relative to now
      if (obj.kind === 'eliminate') {
        this._killWant = (obj.count | 0) || 1;
        this._killCount = 0;
      }
      try { if (typeof obj.setup === 'function') obj.setup(this._m, ctx); } catch (e) { /* never brick host */ }
      // announce the new objective to the HUD
      GTA.bus.emit('mission:objective', {
        id: def.id, text: this.api.currentObjective() ? this.api.currentObjective().text : (obj.text || ''),
        kind: obj.kind, progress: 0,
      });
    }

    // position the objective beacon at this objective's marker (if any)
    this._updateBeacon(dt, ctx, obj, t);

    // ---- mission-level fail conditions ----
    // time limit on the whole mission
    if (def.timeLimit && (t - this._misStart) > def.timeLimit) { this._fail(ctx, 'time'); return; }
    // custom fail()
    if (typeof def.fail === 'function') {
      let failed = false;
      try { failed = !!def.fail(this._m, ctx); } catch (e) { failed = false; }
      if (failed) { this._fail(ctx, 'failed'); return; }
    }

    // ---- objective test ----
    let done = false;
    try {
      done = this._testObjective(obj, ctx, t);
    } catch (e) { done = false; }

    if (done) this._advance(ctx);
  },

  // built-in objective tests by kind; an objective may also supply its own test()
  _testObjective(obj, ctx, t) {
    const player = ctx.player;

    // a custom test() wins if provided
    if (typeof obj.test === 'function') {
      // built-in kinds still update visuals above; custom logic decides completion
      return !!obj.test(this._m, ctx);
    }

    switch (obj.kind) {
      case 'goto': {
        const mk = this._objectiveMarker(obj);
        if (!mk) return false;
        return GU.dist2D(player.pos.x, player.pos.z, mk.x, mk.z) <= (obj.radius || GOTO_R);
      }
      case 'deliver': {
        const mk = this._objectiveMarker(obj);
        if (!mk) return false;
        const near = GU.dist2D(player.pos.x, player.pos.z, mk.x, mk.z) <= (obj.radius || GOTO_R);
        if (!near) return false;
        // require a vehicle ONLY if a vehicles system exists (graceful in the
        // bare demo where carjacking isn't loaded — otherwise it'd soft-lock).
        const hasVehicles = !!(ctx.systems && ctx.systems.vehicles);
        if (obj.requireVehicle && hasVehicles) return !!player.inVehicle;
        return true;
      }
      case 'eliminate': {
        const prog = GU.clamp(this._killCount / Math.max(1, this._killWant), 0, 1);
        // throttle progress toasts implicitly via objective re-emit on change
        if (this._m) this._m._elimProg = prog;
        return this._killCount >= this._killWant;
      }
      case 'collect': {
        if (this._collected) return true;
        const mk = this._objectiveMarker(obj);
        if (!mk) return false;
        if (GU.dist2D(player.pos.x, player.pos.z, mk.x, mk.z) <= (obj.radius || COLLECT_R)) {
          this._collected = true;
          GTA.bus.emit('toast', { html: 'Package secured.', ms: 1600 });
          return true;
        }
        return false;
      }
      case 'survive': {
        const dur = (obj.duration || obj.time || 30);
        return (t - this._objStart) >= dur;
      }
      case 'evade': {
        const wanted = ctx.systems && ctx.systems.wanted ? ctx.systems.wanted.api : null;
        if (!wanted) return true; // no wanted system -> nothing to evade
        const stars = typeof wanted.stars === 'function' ? wanted.stars() : 0;
        return stars <= 0;
      }
      default:
        return false;
    }
  },

  // where is the current objective's marker in world XZ? (null if none)
  _objectiveMarker(obj) {
    if (!obj) return null;
    // explicit marker on the objective
    if (obj.marker && typeof obj.marker.x === 'number') return obj.marker;
    // dynamic marker stashed on the scratch bag by setup()
    if (this._m && this._m.marker && typeof this._m.marker.x === 'number') return this._m.marker;
    return null;
  },

  // beacon + transient visuals for the active objective
  _updateBeacon(dt, ctx, obj, t) {
    const beacon = this._beacon;
    const pkg = this._package;
    const drop = this._dropMesh;
    const hot = this._hotspotRing;
    // default: hide transients, decide per-kind
    pkg.visible = false;
    drop.visible = false;
    hot.visible = false;

    const mk = this._objectiveMarker(obj);
    if (mk) {
      this._curMarker.x = mk.x; this._curMarker.z = mk.z; this._curMarker.active = true;
      beacon.visible = true;
      beacon.position.set(mk.x, MARKER_Y, mk.z);
      beacon.rotation.y += BEACON_SPIN * dt;
      const inner = beacon.userData.inner;
      if (inner) inner.position.y = 2.4 + Math.sin(t * 3) * 0.3;

      // kind-specific decoration on the same spot
      if (obj.kind === 'collect') {
        pkg.visible = !this._collected;
        pkg.position.set(mk.x, 0.6 + Math.sin(t * 2.5) * 0.15, mk.z);
        pkg.rotation.y += dt * 1.6;
      } else if (obj.kind === 'deliver') {
        drop.visible = true;
        drop.position.set(mk.x, 0.05, mk.z);
        drop.rotation.z += dt * 0.8;
      } else if (obj.kind === 'goto') {
        // plain beacon is enough
      }
    } else {
      this._curMarker.active = false;
      beacon.visible = false;
    }

    // hotspot ring for eliminate (centered on the eliminate marker if any)
    if (obj.kind === 'eliminate') {
      const center = mk || (this._m && this._m.hotspot) || null;
      if (center) {
        hot.visible = true;
        hot.position.set(center.x, 0.06, center.z);
        hot.rotation.z += dt * 0.5;
        beacon.visible = true;
        beacon.position.set(center.x, MARKER_Y, center.z);
      }
    }
  },

  // ----------------------------------------------------------
  // advance to the next objective, or complete the mission
  // ----------------------------------------------------------
  _advance(ctx) {
    const def = this._active;
    if (!def) return;
    // tear down anything the finished objective spawned
    const finished = def.objectives[this._objIndex];
    this._teardownObjective(ctx, finished);

    this._objIndex++;
    this._objSetup = false;

    if (this._objIndex >= def.objectives.length) {
      this._complete(ctx);
      return;
    }
    // emit the new objective text
    const next = def.objectives[this._objIndex];
    GTA.bus.emit('mission:objective', {
      id: def.id, text: next ? next.text : '', kind: next ? next.kind : '', progress: 0,
    });
    GTA.bus.emit('toast', { html: next ? ('Objective: ' + next.text) : 'Next objective', ms: 2200 });
  },

  _teardownObjective(ctx, obj) {
    if (obj && typeof obj.cleanup === 'function') {
      try { obj.cleanup(this._m, ctx); } catch (e) {}
    }
    // hide transient visuals between objectives
    if (this._package) this._package.visible = false;
    if (this._dropMesh) this._dropMesh.visible = false;
    if (this._hotspotRing) this._hotspotRing.visible = false;
    // clear dynamic marker so the next objective's setup re-supplies it
    if (this._m) this._m.marker = null;
  },

  // ----------------------------------------------------------
  _complete(ctx) {
    const def = this._active;
    if (!def) return;
    const reward = def.reward | 0;
    // pay out via economy if present
    const econ = ctx.systems && ctx.systems.economy ? ctx.systems.economy.api : null;
    if (econ && typeof econ.add === 'function' && reward) econ.add(reward, 'mission:' + def.id);

    GTA.bus.emit('mission:complete', { id: def.id, reward });
    GTA.bus.emit('toast', { html: '<b>Mission complete:</b> ' + def.title + '  +$' + reward, ms: 4000 });

    this._clearActive(ctx);
  },

  _fail(ctx, reason) {
    const def = this._active;
    if (!def) return;
    GTA.bus.emit('mission:failed', { id: def.id, reason: reason || 'failed' });
    GTA.bus.emit('toast', { html: '<b>Mission failed:</b> ' + def.title, ms: 3500 });
    this._clearActive(ctx);
  },

  // restore to no-mission state WITHOUT destroying reusable meshes
  _clearActive(ctx) {
    const def = this._active;
    if (def) {
      const obj = def.objectives[this._objIndex];
      this._teardownObjective(ctx, obj);
    }
    this._active = null;
    this._objIndex = 0;
    this._objSetup = false;
    this._killCount = 0;
    this._killWant = 0;
    this._collected = false;
    this._curMarker.active = false;
    this._m = null;
    if (this._beacon) this._beacon.visible = false;
    if (this._package) this._package.visible = false;
    if (this._dropMesh) this._dropMesh.visible = false;
    if (this._hotspotRing) this._hotspotRing.visible = false;
  },

  // ----------------------------------------------------------
  reset(ctx) {
    // on respawn / re-enter: abort any active mission, restore markers visible.
    this._clearActive(ctx || GTA.ctx);
    for (let i = 0; i < this._markers.length; i++) {
      if (this._markers[i].mesh) this._markers[i].mesh.visible = true;
    }
  },

  // ----------------------------------------------------------
  // optional radar hook (hud-radar may call drawRadar(r, ctx))
  // r is expected to expose a blip(worldX, worldZ, color, size) helper; we
  // defend against any shape so this never throws.
  // ----------------------------------------------------------
  drawRadar(r, ctx) {
    if (!r) return;
    try {
      const blip = r.blip || r.dot || null;
      // active objective marker
      if (this._active && this._curMarker.active && typeof blip === 'function') {
        blip.call(r, this._curMarker.x, this._curMarker.z, '#ffd24a', 4);
      }
      // idle mission start markers
      if (!this._active && typeof blip === 'function') {
        for (let i = 0; i < this._markers.length; i++) {
          const mk = this._markers[i];
          blip.call(r, mk.pos.x, mk.pos.z, '#7fd0ff', 3);
        }
      }
    } catch (e) { /* radar is best-effort */ }
  },

  // ============================================================
  // PUBLIC API
  // ============================================================
  api: {
    // {text} of the current objective, or null
    currentObjective() {
      if (!missions._active) return null;
      const def = missions._active;
      const obj = def.objectives[missions._objIndex];
      if (!obj) return null;
      let text = obj.text || '';
      // decorate certain kinds with live progress
      if (obj.kind === 'eliminate') {
        const have = Math.min(missions._killCount, missions._killWant || (obj.count | 0) || 1);
        const want = missions._killWant || (obj.count | 0) || 1;
        text = text + ' (' + have + '/' + want + ')';
      } else if (obj.kind === 'survive') {
        const dur = (obj.duration || obj.time || 30);
        const left = Math.max(0, dur - ((GTA.ctx && GTA.ctx.time ? GTA.ctx.time.t : 0) - missions._objStart));
        text = text + ' (' + Math.ceil(left) + 's)';
      } else if (def.timeLimit) {
        const left = Math.max(0, def.timeLimit - ((GTA.ctx && GTA.ctx.time ? GTA.ctx.time.t : 0) - missions._misStart));
        text = text + ' (' + Math.ceil(left) + 's)';
      }
      return { text };
    },

    active() { return !!missions._active; },

    // begin a registered mission by id
    start(id) {
      if (missions._active) return false;          // one at a time
      const def = missions._defs.get(id);
      if (!def) return false;
      missions._active = def;
      missions._objIndex = 0;
      missions._objSetup = false;
      missions._killCount = 0;
      missions._killWant = 0;
      missions._collected = false;
      missions._misStart = (GTA.ctx && GTA.ctx.time ? GTA.ctx.time.t : 0);
      // fresh scratch bag for this run
      missions._m = { id: def.id, marker: null, hotspot: null, data: {}, vehicle: null };
      // run mission-level start()
      if (typeof def.start === 'function') {
        try { def.start(missions._m, GTA.ctx); } catch (e) {}
      }
      GTA.bus.emit('mission:start', { id: def.id, title: def.title });
      const first = def.objectives[0];
      GTA.bus.emit('toast', { html: '<b>' + def.title + '</b><br>' + (first ? first.text : ''), ms: 4200 });
      return true;
    },

    // cancel the active mission silently (no reward, no fail toast spam)
    abort() {
      if (!missions._active) return false;
      const id = missions._active.id;
      missions._clearActive(GTA.ctx);
      GTA.bus.emit('mission:failed', { id, reason: 'aborted' });
      return true;
    },

    // register / replace a mission definition
    registerMission(def) {
      if (!def || !def.id || !Array.isArray(def.objectives)) return false;
      missions._defs.set(def.id, def);
      return true;
    },
  },
};

// ============================================================
// MESH FACTORIES (all original, low-poly, code-generated)
// ============================================================
function glowMat(T, color, emissiveI) {
  return new T.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: emissiveI == null ? 0.9 : emissiveI,
    roughness: 0.35, metalness: 0.0, transparent: true, opacity: 0.85,
  });
}

// a tall glowing pillar to mark a mission START point
function makePillar(T, color) {
  const g = new T.Group();
  const baseMat = glowMat(T, color, 0.55);
  const ringMat = glowMat(T, color, 1.0);

  // ground ring
  const ring = new T.Mesh(new T.TorusGeometry(1.4, 0.16, 8, 20), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.08;
  g.add(ring);

  // translucent column
  const col = new T.Mesh(new T.CylinderGeometry(0.6, 0.9, 5.0, 12, 1, true), baseMat);
  col.position.y = 2.5;
  g.add(col);

  // floating inner gem (bobs)
  const gem = new T.Mesh(new T.IcosahedronGeometry(0.55, 0), ringMat);
  gem.position.y = 3.0;
  g.add(gem);
  g.userData.inner = gem;

  // a little point light feel via an extra bright cap (no real light to stay cheap)
  const cap = new T.Mesh(new T.ConeGeometry(0.7, 1.0, 12), ringMat);
  cap.position.y = 5.2;
  g.add(cap);

  return g;
}

// the active OBJECTIVE beacon (brighter, spins)
function makeBeacon(T) {
  const g = new T.Group();
  const mat = glowMat(T, 0xffd24a, 1.1);
  const matSoft = glowMat(T, 0xffd24a, 0.5);

  const ring = new T.Mesh(new T.TorusGeometry(1.6, 0.18, 8, 22), mat);
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.08;
  g.add(ring);

  const beam = new T.Mesh(new T.CylinderGeometry(0.45, 0.7, 6.0, 12, 1, true), matSoft);
  beam.position.y = 3.0;
  g.add(beam);

  const gem = new T.Mesh(new T.OctahedronGeometry(0.6, 0), mat);
  gem.position.y = 2.4;
  g.add(gem);
  g.userData.inner = gem;

  return g;
}

// a collectible PACKAGE (a small crate with a glowing band)
function makePackage(T) {
  const g = new T.Group();
  const box = new T.Mesh(
    new T.BoxGeometry(0.7, 0.7, 0.7),
    new T.MeshStandardMaterial({ color: 0xb8895a, roughness: 0.85 }));
  box.castShadow = true; box.receiveShadow = true;
  g.add(box);
  const band = new T.Mesh(
    new T.BoxGeometry(0.74, 0.16, 0.74),
    glowMat(T, 0x6df08a, 1.0));
  g.add(band);
  const band2 = new T.Mesh(
    new T.BoxGeometry(0.16, 0.74, 0.74),
    glowMat(T, 0x6df08a, 1.0));
  g.add(band2);
  return g;
}

// a DROPOFF ring on the ground (drive/walk into it)
function makeDropoff(T) {
  const g = new T.Group();
  const mat = glowMat(T, 0x47b6ff, 1.0);
  const ring = new T.Mesh(new T.TorusGeometry(2.4, 0.22, 8, 26), mat);
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  const inner = new T.Mesh(new T.TorusGeometry(1.3, 0.14, 8, 22), glowMat(T, 0x47b6ff, 0.7));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.02;
  g.add(inner);
  // store rotation target on the group so we can spin in XZ visually
  g.rotation.x = 0;
  return g;
}

// a HOTSPOT ring (eliminate zone) — red, larger
function makeHotspot(T) {
  const g = new T.Group();
  const mat = glowMat(T, 0xff5d5d, 0.9);
  const ring = new T.Mesh(new T.TorusGeometry(HOTSPOT_SPREAD, 0.28, 8, 30), mat);
  ring.rotation.x = -Math.PI / 2;
  g.add(ring);
  return g;
}

// ============================================================
// SAMPLE MISSIONS (registered into the system)
// ============================================================
function registerSamples(sys) {
  // helper: pick a world point near the player but reachable on a road / open
  function pointOnRoad(ctx, awayFrom, minDist) {
    const world = ctx.systems && ctx.systems.world ? ctx.systems.world.api : (ctx.world || null);
    const rng = ctx.rng || Math.random;
    let best = { x: 0, z: 0 };
    for (let t = 0; t < 30; t++) {
      if (world && world.randomRoadSpawn) {
        world.randomRoadSpawn(rng, _tmp);
        const x = _tmp.x, z = _tmp.z;
        if (!awayFrom || GU.dist2D(x, z, awayFrom.x, awayFrom.z) >= (minDist || 0)) { best = { x, z }; break; }
        best = { x, z };
      } else if (world && world.randomLandmark) {
        const lm = world.randomLandmark(rng);
        if (lm && lm.pos) { best = { x: lm.pos.x, z: lm.pos.z }; break; }
      } else {
        best = { x: GU.rand(rng, -60, 60), z: GU.rand(rng, -60, 60) }; break;
      }
    }
    return best;
  }

  function openPointNear(ctx, cx, cz, spread) {
    const world = ctx.systems && ctx.systems.world ? ctx.systems.world.api : (ctx.world || null);
    const rng = ctx.rng || Math.random;
    let x = cx, z = cz;
    for (let t = 0; t < 16; t++) {
      x = cx + GU.rand(rng, -spread, spread);
      z = cz + GU.rand(rng, -spread, spread);
      if (!world || !world.isInside || !world.isInside(x, z, 0.8)) break;
    }
    if (world && world.resolve) { _v.set(x, 0, z); world.resolve(_v, 0.6); x = _v.x; z = _v.z; }
    return { x, z };
  }

  // -----------------------------------------------------------------
  // 1) REPO RUN — go to a parked car, deliver it to the dropoff
  // -----------------------------------------------------------------
  sys.api.registerMission({
    id: 'repo',
    title: 'Repo Run',
    reward: 750,
    start(m, ctx) {
      // pick a pickup spot for the "parked car" and a dropoff spot
      m.data.carSpot = pointOnRoad(ctx, ctx.player ? ctx.player.pos : null, 22);
      m.data.dropSpot = pointOnRoad(ctx, m.data.carSpot, 40);
      // actually park a real vehicle at the pickup if the vehicles system can.
      // spawnAt(x, z, opts) -> vehicle record ({ .pos: Vector3 }) or null.
      const veh = ctx.systems?.vehicles?.api || null;
      m.vehicle = null;
      try { m.vehicle = veh?.spawnAt?.(m.data.carSpot.x, m.data.carSpot.z) || null; } catch (e) { m.vehicle = null; }
      // aim the goto at the car we obtained; otherwise fall back to the nearest
      // enterable vehicle near the pickup; otherwise the generic carSpot marker.
      if (m.vehicle && m.vehicle.pos && typeof m.vehicle.pos.x === 'number') {
        m.data.carSpot = { x: m.vehicle.pos.x, z: m.vehicle.pos.z };
      } else {
        let near = null;
        try { near = veh?.nearestEnterable?.(m.data.carSpot.x, m.data.carSpot.z) || null; } catch (e) { near = null; }
        if (near && near.pos && typeof near.pos.x === 'number') {
          m.vehicle = near;
          m.data.carSpot = { x: near.pos.x, z: near.pos.z };
        }
        // else: keep the generic carSpot marker; m.vehicle stays null
      }
    },
    objectives: [
      {
        kind: 'goto',
        text: 'Find the marked car',
        radius: 4.5,
        // point at the actual car position (carSpot is updated to it in start())
        setup(m) { m.marker = { x: m.data.carSpot.x, z: m.data.carSpot.z }; },
      },
      {
        kind: 'deliver',
        text: 'Deliver the car to the lot',
        radius: 4.0,
        // only hard-require a vehicle if we actually placed/found one — never
        // soft-lock when vehicles is absent or spawnAt returned null.
        requireVehicle: false,
        setup(m) {
          m.marker = { x: m.data.dropSpot.x, z: m.data.dropSpot.z };
          this.requireVehicle = !!m.vehicle;
        },
      },
    ],
  });

  // -----------------------------------------------------------------
  // 2) CLEANUP — go to a hotspot, eliminate 4 targets, then evade heat
  // -----------------------------------------------------------------
  sys.api.registerMission({
    id: 'sweep',
    title: 'Cleanup',
    reward: 1200,
    start(m, ctx) {
      m.data.hotspot = pointOnRoad(ctx, ctx.player ? ctx.player.pos : null, 24);
    },
    objectives: [
      {
        kind: 'goto',
        text: 'Get to the hotspot',
        radius: 6.0,
        setup(m) { m.marker = { x: m.data.hotspot.x, z: m.data.hotspot.z }; m.hotspot = m.marker; },
      },
      {
        kind: 'eliminate',
        text: 'Take out the targets',
        count: 4,
        setup(m, ctx) {
          m.marker = { x: m.data.hotspot.x, z: m.data.hotspot.z };
          m.hotspot = m.marker;
          // ask the peds system to spawn some bodies near the hotspot if it can
          const peds = ctx.systems && ctx.systems.peds ? ctx.systems.peds.api : null;
          if (peds && typeof peds.spawn === 'function') {
            try { peds.spawn(4); } catch (e) {}
          }
        },
      },
      {
        kind: 'evade',
        text: 'Lose the cops',
        setup(m) { m.marker = null; }, // beacon hidden during the chase
      },
    ],
  });

  // -----------------------------------------------------------------
  // 3) COURIER — collect a package, deliver under a 90s timer
  // -----------------------------------------------------------------
  sys.api.registerMission({
    id: 'courier',
    title: 'Courier',
    reward: 900,
    timeLimit: 90,
    start(m, ctx) {
      m.data.pkgSpot = pointOnRoad(ctx, ctx.player ? ctx.player.pos : null, 14);
      m.data.dropSpot = pointOnRoad(ctx, m.data.pkgSpot, 50);
    },
    objectives: [
      {
        kind: 'collect',
        text: 'Grab the package',
        radius: 2.4,
        setup(m) { m.marker = { x: m.data.pkgSpot.x, z: m.data.pkgSpot.z }; },
      },
      {
        kind: 'deliver',
        text: 'Deliver it before time runs out',
        radius: 4.5,
        setup(m) { m.marker = { x: m.data.dropSpot.x, z: m.data.dropSpot.z }; },
      },
    ],
  });
}

// ============================================================
// REGISTER
// ============================================================
GTA.register(missions);
export default missions;
