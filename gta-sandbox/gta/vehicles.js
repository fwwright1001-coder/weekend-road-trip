// ============================================================
// gta/vehicles.js — drivable + jackable cars AND ambient traffic
// ------------------------------------------------------------
// Builds ~10-16 low-poly cars (sedan / coupe / van / pickup) in code. Some sit
// PARKED next to sidewalks; the rest drive as ambient TRAFFIC along the world's
// road grid. Every car is a damageable target in the shared ctx.targets registry
// (kind:'vehicle'); shoot one enough and it explodes (shake + emissive flash,
// ejects/kills its occupant, then respawns later somewhere else).
//
// ON FOOT, press F within ~3.2 of an enterable car to get in (jacking it if an
// NPC was inside — that's a vehicleTheft crime). While driving, WASD drives,
// Space is the handbrake, F gets out. Arcade physics: throttle along heading,
// steering scaled by speed, friction/brake decel, top speed ~24. Collisions push
// out of buildings and kill speed (propertyDamage crime + shake on big hits).
// Run a pedestrian over while moving and that's an assault.
//
// All art generated in code (BoxGeometry/Cylinder + MeshStandardMaterial). No
// textures, no loaders, no external assets. Decoupled: talks to other systems
// only through ctx + GTA.bus, and null-checks every cross-system api it touches
// because load order varies.
// ============================================================
import { GTA, GU } from './core.js';

// ---- tunables --------------------------------------------------------------
const MAX_CARS        = 13;     // total fleet size (parked + traffic)
const PARKED_FRACTION = 0.45;   // ~45% start parked, rest are traffic
const ENTER_RANGE     = 3.2;    // how close on foot to enter a car
const MAX_SPEED       = 24;     // player car top speed (units/s)
const TRAFFIC_SPEED   = 9.5;    // ambient car cruise speed
const ACCEL           = 16;     // throttle accel
const BRAKE           = 26;     // active brake decel
const FRICTION        = 6.0;    // rolling friction decel
const REVERSE_MAX     = 8;      // reverse top speed
const STEER_RATE      = 1.9;    // base steering (radians/s at speed)
const CAR_HEALTH      = 100;
const RUNOVER_SPEED   = 4;      // min speed to injure a ped
const RUNOVER_COOLDOWN = 1.0;   // s between run-over hits/crimes on the same target
const RESPAWN_DELAY   = 9.0;    // seconds before a destroyed car comes back
const FAR_WRAP        = 220;    // traffic farther than this from player respawns
const SEAT_Y          = 1.05;   // driver "seat" height (player.pos.y while driving)

// car body palette (original low-poly colours)
const BODY_COLORS = [
  0xc23b3b, 0x2f6fa8, 0x3aa05a, 0xd6a93a, 0x8a4fb0,
  0x444a52, 0xd9d4c8, 0x2a2d34, 0xd97a2a, 0x3a8f96,
];

// car type templates: footprint + roof/cabin shape
const CAR_TYPES = {
  sedan:  { len: 4.2, wid: 1.9, bodyH: 0.62, cabinH: 0.62, cabinLen: 2.0, cabinOff: -0.1, ride: 0.34 },
  coupe:  { len: 4.0, wid: 1.86, bodyH: 0.56, cabinH: 0.56, cabinLen: 1.5, cabinOff: -0.25, ride: 0.30 },
  van:    { len: 4.7, wid: 2.1, bodyH: 1.10, cabinH: 0.40, cabinLen: 2.9, cabinOff: 0.2, ride: 0.40 },
  pickup: { len: 4.6, wid: 2.0, bodyH: 0.66, cabinH: 0.66, cabinLen: 1.5, cabinOff: 0.7, ride: 0.42 },
};
const TYPE_KEYS = Object.keys(CAR_TYPES);

// ---- module-scope scratch (no per-frame allocation) ------------------------
let _THREE = null;
const _tmp   = { x: 0, z: 0 };          // plain scratch for nearestRoad out
const _road  = { x: 0, z: 0, dir: 0 };  // scratch for nearestRoad results
let _fwd, _v3a, _v3b, _v3c;             // THREE.Vector3 scratch, made in init
let _eul;                               // THREE.Euler scratch

// helper: heading-radians convention here matches world.nearestRoad:
// 0 = facing +Z, +X is at heading PI/2. forwardFromHeading writes a unit XZ dir.
function forwardFromHeading(h, out) {
  out.set(Math.sin(h), 0, Math.cos(h));
  return out;
}

// ============================================================
// THE SYSTEM
// ============================================================
const sys = {
  name: 'vehicles',
  deps: ['world'],

  cars: [],            // all vehicle records
  _root: null,         // THREE.Group parent for all car meshes
  _wheelMat: null,
  _glassMat: null,
  _seeded: false,
  _explosionPool: null,

  // ----------------------------------------------------------
  init(ctx) {
    const THREE = ctx.THREE;
    _THREE = THREE;
    // (re)build scratch vectors bound to this THREE
    _fwd = new THREE.Vector3();
    _v3a = new THREE.Vector3();
    _v3b = new THREE.Vector3();
    _v3c = new THREE.Vector3();
    _eul = new THREE.Euler();

    if (!this._root) {
      this._root = new THREE.Group();
      this._root.name = 'gta-vehicles';
      ctx.scene.add(this._root);
    }

    this._wheelMat = new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.95 });
    this._glassMat = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.25, metalness: 0.1, emissive: 0x0a0f16, emissiveIntensity: 0.3 });

    // explosion flash pool (reused; never per-frame allocated)
    this._explosionPool = GTA.makePool((i) => {
      const m = new THREE.Mesh(
        new THREE.IcosahedronGeometry(1, 0),
        new THREE.MeshStandardMaterial({ color: 0xffae3a, emissive: 0xff5a14, emissiveIntensity: 1.4, transparent: true, opacity: 0.9 }));
      m.visible = false;
      return m;
    }, this._root);

    // build the fleet once
    if (!this._seeded) {
      this._seedFleet(ctx);
      this._seeded = true;
    }

    // clean up any in-flight driving when the player respawns
    if (!this._wired) {
      ctx.bus.on('playerRespawn', () => { try { this._bailOut(ctx); } catch (e) {} });
      this._wired = true;
    }
  },

  // ----------------------------------------------------------
  // FLEET CONSTRUCTION
  // ----------------------------------------------------------
  _seedFleet(ctx) {
    const rng = GU.makeRng(0x5EED0CA7);
    const world = ctx.systems.world && ctx.systems.world.api;
    const count = Math.max(6, Math.round(MAX_CARS * (ctx.config && ctx.config.pedDensity || 1)));
    for (let i = 0; i < count; i++) {
      const parked = (i / count) < PARKED_FRACTION;
      const car = this._buildCar(ctx, rng, parked);
      this.cars.push(car);
      this._registerTarget(ctx, car);
    }
  },

  // build one car record + its mesh, place it parked or as traffic.
  // `place` (optional) overrides the random placement with a fixed world spot:
  //   { x, z, heading?, type? } — used by the public spawnAt() for mission cars.
  _buildCar(ctx, rng, parked, place) {
    const THREE = ctx.THREE;
    const type = (place && place.type && CAR_TYPES[place.type]) ? place.type : GU.pick(rng, TYPE_KEYS);
    const t = CAR_TYPES[type];
    const color = GU.pick(rng, BODY_COLORS);

    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 });

    // lower body (chassis box)
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(t.wid, t.bodyH, t.len), bodyMat);
    chassis.position.y = t.ride + t.bodyH / 2;
    group.add(chassis);

    // cabin / roof (smaller box on top, offset along length)
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(t.wid * 0.86, t.cabinH, t.cabinLen),
      type === 'van' ? bodyMat : bodyMat);
    cabin.position.set(0, t.ride + t.bodyH + t.cabinH / 2, t.cabinOff);
    group.add(cabin);

    // glass band wrapped around the cabin (slightly inset)
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(t.wid * 0.88, t.cabinH * 0.62, t.cabinLen * 0.96),
      this._glassMat);
    glass.position.set(0, t.ride + t.bodyH + t.cabinH * 0.58, t.cabinOff);
    group.add(glass);

    // pickup gets an open bed: shave the rear of the cabin visually by adding low walls
    if (type === 'pickup') {
      const bedMat = bodyMat;
      const bed = new THREE.Mesh(new THREE.BoxGeometry(t.wid * 0.94, 0.30, t.len * 0.4), bedMat);
      bed.position.set(0, t.ride + t.bodyH + 0.15, -t.len * 0.28);
      group.add(bed);
    }

    // headlights (emissive front) + taillights (emissive rear)
    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d0, emissive: 0xfff0b0, emissiveIntensity: 1.0 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0xff5a4a, emissive: 0xff2a18, emissiveIntensity: 0.9 });
    for (const s of [-1, 1]) {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.18, 0.08), headMat);
      hl.position.set(s * t.wid * 0.32, t.ride + t.bodyH * 0.7, t.len / 2 + 0.02);
      group.add(hl);
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.08), tailMat);
      tl.position.set(s * t.wid * 0.32, t.ride + t.bodyH * 0.7, -t.len / 2 - 0.02);
      group.add(tl);
    }

    // wheels (4 cylinders laid on their sides)
    const wheels = [];
    const wheelGeo = new THREE.CylinderGeometry(t.ride, t.ride, 0.32, 12);
    const wx = t.wid / 2 - 0.05;
    const wz = t.len / 2 - 0.95;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const w = new THREE.Mesh(wheelGeo, this._wheelMat);
        w.rotation.z = Math.PI / 2;       // lay cylinder on its side
        w.position.set(sx * wx, t.ride, sz * wz);
        group.add(w);
        wheels.push(w);
      }
    }

    GTA.shadowize(group, true, true);

    const rec = {
      type, mesh: group,
      pos: new THREE.Vector3(),
      heading: 0,
      speed: 0,
      health: CAR_HEALTH,
      occupant: null,          // 'ped' | 'player' | null
      wheels,
      bodyMat,
      footLen: t.len, footWid: t.wid,
      seatY: SEAT_Y + t.ride * 0.3,
      // traffic AI state
      isTraffic: !parked,
      parked,
      destroyed: false,
      respawnAt: 0,
      _flashT: 0,
      _wheelSpin: 0,
      _leanTarget: 0, _lean: 0,
      _stuckT: 0,
      target: null,            // ctx.targets entry (set by _registerTarget)
    };

    if (place) {
      // fixed placement (mission car): parked + enterable at an exact spot
      rec.pos.set(place.x, 0, place.z);
      rec.heading = (typeof place.heading === 'number') ? place.heading : 0;
      rec.speed = 0;
      rec.isTraffic = false;
      const world = ctx.systems.world && ctx.systems.world.api;
      if (world && world.resolve) world.resolve(rec.pos, 1.3);   // nudge out of buildings
      this._applyTransform(rec);
    } else {
      this._placeCar(ctx, rec, GU.makeRng((ctx.rng ? (ctx.rng() * 1e9) : (Math.random() * 1e9)) | 0));
    }
    this._root.add(group);
    return rec;
  },

  // pick a spot: parked cars sit just off a road near a sidewalk; traffic cars
  // sit on a lane with a road heading.
  _placeCar(ctx, rec, rng) {
    const world = ctx.systems.world && ctx.systems.world.api;
    if (!world) {
      // no world yet — drop it near origin; will get re-placed on first update
      rec.pos.set(GU.rand(rng, -10, 10), 0, GU.rand(rng, -10, 10));
      rec.heading = 0;
      this._applyTransform(rec);
      return;
    }
    if (rec.parked) {
      // place along a road, then nudge toward the sidewalk so it's off the lane
      const rr = world.randomRoadSpawn(rng, {});
      const dir = rr.dir;
      // perpendicular offset to park beside the lane
      const side = GU.chance(rng, 0.5) ? 1 : -1;
      const off = (world.roadHalf + 0.4) * side;
      // perpendicular of heading: rotate heading by 90deg
      const px = Math.cos(dir) * off;   // perp x
      const pz = -Math.sin(dir) * off;  // perp z
      rec.pos.set(rr.x + px, 0, rr.z + pz);
      rec.heading = dir;
      rec.speed = 0;
      rec.isTraffic = false;
    } else {
      const rr = world.randomRoadSpawn(rng, {});
      rec.pos.set(rr.x, 0, rr.z);
      rec.heading = rr.dir;
      rec.speed = TRAFFIC_SPEED * GU.rand(rng, 0.6, 1.0);
      rec.isTraffic = true;
    }
    // keep out of buildings
    world.resolve(rec.pos, 1.3);
    this._applyTransform(rec);
  },

  // push the record's pos/heading into its mesh transform + spin wheels + lean
  _applyTransform(rec) {
    const m = rec.mesh;
    m.position.set(rec.pos.x, rec.pos.y, rec.pos.z);
    m.rotation.y = rec.heading;
    // body lean into turns
    m.rotation.z = rec._lean;
  },

  // ----------------------------------------------------------
  // TARGETS REGISTRY
  // ----------------------------------------------------------
  _registerTarget(ctx, rec) {
    if (!ctx.targets) return;
    const self = this;
    const entry = {
      pos: rec.pos,            // shares the same Vector3 — updates as car moves
      height: 1.4,
      radius: 1.4,
      kind: 'vehicle',
      dead: false,
      onHit(amount, srcKind, hitPos) {
        if (rec.destroyed) return;
        rec.health -= amount;
        // a little hit flash
        rec._flashT = Math.max(rec._flashT, 0.12);
        if (rec.health <= 0) {
          self._explode(ctx, rec);
        }
      },
    };
    rec.target = entry;
    ctx.targets.push(entry);
  },

  _removeTarget(ctx, rec) {
    if (!ctx.targets || !rec.target) return;
    const i = ctx.targets.indexOf(rec.target);
    if (i >= 0) ctx.targets.splice(i, 1);
    rec.target = null;
  },

  // ----------------------------------------------------------
  // EXPLOSION / DESTRUCTION
  // ----------------------------------------------------------
  _explode(ctx, rec) {
    if (rec.destroyed) return;
    rec.destroyed = true;
    rec.health = 0;
    rec.speed = 0;
    if (rec.target) rec.target.dead = true;

    // if the PLAYER was inside, throw them out (and hurt them) before the car dies
    const hadPlayer = rec.occupant === 'player';
    if (hadPlayer) {
      this._bailOut(ctx);
      const combat = ctx.systems.combat && ctx.systems.combat.api;
      if (combat && combat.damagePlayer) {
        try { combat.damagePlayer(45, 'explosion', rec.pos.clone()); } catch (e) {}
      } else {
        // fall back to direct request so the player still takes the hit
        try { ctx.bus.emit('damage', { target: 'player', amount: 45, kind: 'explosion', pos: rec.pos.clone() }); } catch (e) {}
      }
    } else if (rec.occupant === 'ped') {
      // an NPC occupant dies with the car
      this._ejectPed(ctx, rec, true);
    }
    rec.occupant = null;

    // emit shake + a crime (your own car blowing up is propertyDamage)
    try { ctx.bus.emit('shake', { amount: 3.2 }); } catch (e) {}
    try {
      ctx.bus.emit('crime', { kind: 'propertyDamage', pos: rec.pos.clone(), severity: 0.6, source: 'vehicle' });
    } catch (e) {}

    // visual: emissive flash + sink the wreck slightly, then schedule respawn
    if (rec.bodyMat) {
      rec.bodyMat.emissive = new _THREE.Color(0x331a08);
      rec.bodyMat.emissiveIntensity = 1.0;
      rec.bodyMat.color.setHex(0x2a2622);
    }
    rec._wreckFlash = 0.6;

    // spawn a brief explosion flash mesh from the pool
    this._spawnFlash(rec.pos);

    // hide wreck after a beat, then respawn elsewhere
    rec.respawnAt = (ctx.time ? ctx.time.t : 0) + RESPAWN_DELAY;

    // a destroyed car can drop a little cash pickup (economy creates it)
    try {
      ctx.bus.emit('spawnPickup', { kind: 'cash', value: 15 + ((ctx.rng ? ctx.rng() : Math.random()) * 25 | 0), pos: rec.pos.clone() });
    } catch (e) {}
  },

  _spawnFlash(pos) {
    if (!this._explosionPool) return;
    // we don't run a continuous begin/end loop for these; instead grab one and
    // animate it down over its own life via the wreckFlash timer on the car.
    // Use the pool item directly and stash a timer on it.
    const pool = this._explosionPool;
    pool.begin();
    const m = pool.get();
    pool.end();           // hides others; this one stays visible until timer ends
    m.visible = true;
    m.position.set(pos.x, pos.y + 0.8, pos.z);
    m.scale.setScalar(0.6);
    m.userData.flashT = 0.55;
  },

  // restore a destroyed car to a fresh state somewhere new.
  // `salt` (the car's index) diverges seeds for cars respawning on the same frame.
  _respawnCar(ctx, rec, salt) {
    rec.destroyed = false;
    rec.health = CAR_HEALTH;
    rec.speed = 0;
    rec.occupant = rec.parked ? null : 'ped';
    rec._wreckFlash = 0;
    rec._flashT = 0;
    if (rec.bodyMat) {
      // restore a random fresh body colour
      rec.bodyMat.emissive = new _THREE.Color(0x000000);
      rec.bodyMat.emissiveIntensity = 0;
      rec.bodyMat.color.setHex(GU.pick(ctx.rng, BODY_COLORS));
    }
    // re-place far enough from the player so it doesn't pop in view.
    // mix in a per-car salt so multiple same-frame respawns don't share a seed
    // (and thus stack at the same spot).
    const baseSeed = ((ctx.time ? ctx.time.t * 1000 : 1) | 0) ^ (((salt | 0) + 1) * 2654435761);
    const rng = GU.makeRng(baseSeed);
    this._placeCar(ctx, rec, rng);
    // re-register a target if it was removed
    if (!rec.target) this._registerTarget(ctx, rec);
    else { rec.target.dead = false; }
  },

  // ----------------------------------------------------------
  // PED OCCUPANT HANDLING
  // ----------------------------------------------------------
  // Hand a jacked/ejected ped to the peds system if it offers a hook; otherwise
  // just clear the occupant (the ped vanishes — acceptable for ambient traffic).
  _ejectPed(ctx, rec, killed) {
    const peds = ctx.systems.peds && ctx.systems.peds.api;
    rec.occupant = null;
    if (!peds) return;
    // peds.api isn't a hard contract beyond count()/spawn(); try optional hooks
    try {
      if (killed && typeof peds.spawnCorpse === 'function') {
        peds.spawnCorpse(rec.pos.clone());
      } else if (typeof peds.spawnFleeing === 'function') {
        peds.spawnFleeing(rec.pos.clone());
      } else if (typeof peds.spawn === 'function') {
        // generic: nudge one ambient ped into the world near the car
        peds.spawn(1);
      }
    } catch (e) { /* peds shape varies; never let this brick a frame */ }
  },

  // ----------------------------------------------------------
  // ENTER / EXIT / JACK
  // ----------------------------------------------------------
  _enter(ctx, rec) {
    const player = ctx.player;
    const jacked = rec.occupant === 'ped';
    if (jacked) {
      // carjack: crime + eject the NPC driver
      try { ctx.bus.emit('vehicle:jacked', { vehicle: rec, victim: 'ped' }); } catch (e) {}
      try { ctx.bus.emit('crime', { kind: 'vehicleTheft', pos: rec.pos.clone(), severity: 0.5, source: 'player' }); } catch (e) {}
      this._ejectPed(ctx, rec, false);
    }
    rec.occupant = 'player';
    rec.isTraffic = false;
    player.inVehicle = true;
    player.vehicle = rec;
    if (player.mesh) player.mesh.visible = false;
    // snap player to the seat immediately so the camera frames the car this frame
    player.pos.set(rec.pos.x, rec.seatY, rec.pos.z);
    player.vel && player.vel.set(0, 0, 0);
    player.vy = 0;
    try { ctx.bus.emit('vehicle:entered', { vehicle: rec, byPlayer: true }); } catch (e) {}
    try { ctx.bus.emit('toast', { html: '<b>F</b> exit · <b>WASD</b> drive · <b>Space</b> handbrake', ms: 3000 }); } catch (e) {}
  },

  _exit(ctx, rec) {
    const player = ctx.player;
    const world = ctx.systems.world && ctx.systems.world.api;
    // place the player beside the driver door (left side of car)
    forwardFromHeading(rec.heading, _fwd);
    // left = rotate heading +90deg
    const lx = Math.cos(rec.heading);   // perpendicular-left x
    const lz = -Math.sin(rec.heading);  // perpendicular-left z
    _v3a.set(rec.pos.x + lx * (rec.footWid / 2 + 0.8), 0, rec.pos.z + lz * (rec.footWid / 2 + 0.8));
    if (world) world.resolve(_v3a, 0.5);
    player.pos.set(_v3a.x, 0, _v3a.z);
    player.vy = 0; player.grounded = true;
    player.inVehicle = false;
    player.vehicle = null;
    rec.occupant = null;
    rec.speed = 0;
    if (player.mesh) { player.mesh.visible = true; player.mesh.position.copy(player.pos); }
    try { ctx.bus.emit('vehicle:exited', { vehicle: rec, byPlayer: true }); } catch (e) {}
  },

  // force the player out of whatever they're in (used by respawn / explosion)
  _bailOut(ctx) {
    const player = ctx.player;
    if (!player || !player.inVehicle) return;
    const rec = player.vehicle;
    player.inVehicle = false;
    player.vehicle = null;
    if (player.mesh) player.mesh.visible = true;
    if (rec) { rec.occupant = null; rec.speed = 0; }
  },

  // find the closest enterable car within range of a position
  _nearest(ctx, pos, range) {
    let best = null, bestD = range * range;
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.destroyed || c.occupant === 'player') continue;
      const dx = c.pos.x - pos.x, dz = c.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  },

  // ----------------------------------------------------------
  // PER-FRAME UPDATE
  // ----------------------------------------------------------
  update(dt, ctx) {
    if (!_THREE) return;
    const player = ctx.player;
    const input = ctx.input;
    const t = ctx.time ? ctx.time.t : 0;

    // --- F: enter / exit ---
    if (input && input.consume && input.consume('KeyF')) {
      if (player.inVehicle && player.vehicle) {
        this._exit(ctx, player.vehicle);
      } else if (player.alive !== false) {
        const near = this._nearest(ctx, player.pos, ENTER_RANGE);
        if (near) this._enter(ctx, near);
      }
    }

    // --- drive the player's car ---
    if (player.inVehicle && player.vehicle && !player.vehicle.destroyed) {
      this._drivePlayer(dt, ctx, player.vehicle);
    }

    // --- update every car ---
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];

      // respawn destroyed cars after a delay
      if (c.destroyed) {
        // animate the explosion flash decay on any pool item is handled globally below
        if (t >= c.respawnAt) this._respawnCar(ctx, c, i);
        else { this._applyTransform(c); }
        continue;
      }

      // traffic AI (skip the player's car)
      if (c.occupant !== 'player') {
        if (c.isTraffic) this._driveTraffic(dt, ctx, c, player, i);
        // hit-flash decay
        if (c._flashT > 0) {
          c._flashT = Math.max(0, c._flashT - dt);
          this._applyFlash(c);
        }
        this._spinWheels(c, dt);
        this._applyTransform(c);
      }
    }

    // decay any active explosion flash meshes from the pool
    this._animateFlashes(dt);
  },

  // ----------------------------------------------------------
  // PLAYER DRIVING (arcade)
  // ----------------------------------------------------------
  _drivePlayer(dt, ctx, rec) {
    const input = ctx.input;
    const player = ctx.player;
    const world = ctx.systems.world && ctx.systems.world.api;

    const fwd  = input && input.held && (input.held('KeyW') || input.held('ArrowUp'));
    const back = input && input.held && (input.held('KeyS') || input.held('ArrowDown'));
    const left = input && input.held && (input.held('KeyA') || input.held('ArrowLeft'));
    const right= input && input.held && (input.held('KeyD') || input.held('ArrowRight'));
    const hand = input && input.held && input.held('Space');

    // throttle / brake
    if (fwd) {
      rec.speed += ACCEL * dt;
    } else if (back) {
      if (rec.speed > 0.2) rec.speed -= BRAKE * dt;          // braking
      else rec.speed -= ACCEL * 0.7 * dt;                    // reversing
    } else {
      // rolling friction toward 0
      const f = FRICTION * dt;
      if (rec.speed > 0) rec.speed = Math.max(0, rec.speed - f);
      else if (rec.speed < 0) rec.speed = Math.min(0, rec.speed + f);
    }

    // handbrake: strong decel + lets the car slide a touch (just bleed speed)
    if (hand) {
      const f = BRAKE * 1.4 * dt;
      if (rec.speed > 0) rec.speed = Math.max(0, rec.speed - f);
      else rec.speed = Math.min(0, rec.speed + f);
    }

    rec.speed = GU.clamp(rec.speed, -REVERSE_MAX, MAX_SPEED);

    // steering scales with speed (no rotating in place); reverse flips steer
    const speedFrac = GU.clamp(Math.abs(rec.speed) / MAX_SPEED, 0, 1);
    const steerAuthority = STEER_RATE * (0.35 + 0.65 * speedFrac);
    let steer = 0;
    if (left)  steer += 1;
    if (right) steer -= 1;
    const dirSign = rec.speed >= 0 ? 1 : -1;
    if (Math.abs(rec.speed) > 0.3) {
      rec.heading += steer * steerAuthority * dt * dirSign;
    }

    // body lean into turn
    rec._leanTarget = -steer * 0.10 * speedFrac;
    rec._lean = GU.damp(rec._lean, rec._leanTarget, 8, dt);

    // integrate position along heading
    forwardFromHeading(rec.heading, _fwd);
    const prevX = rec.pos.x, prevZ = rec.pos.z;
    rec.pos.x += _fwd.x * rec.speed * dt;
    rec.pos.z += _fwd.z * rec.speed * dt;
    rec.pos.y = 0;

    // collision: push out of buildings + clamp bounds; detect a hard hit
    if (world) {
      world.resolve(rec.pos, 1.3);
      const dx = rec.pos.x - prevX, dz = rec.pos.z - prevZ;
      const moved = Math.hypot(dx, dz);
      const expected = Math.abs(rec.speed) * dt;
      // if we got pushed back hard relative to expected travel -> impact
      if (expected > 0.05 && moved < expected * 0.45 && Math.abs(rec.speed) > 6) {
        const impact = Math.abs(rec.speed);
        rec.speed *= 0.15;             // kill most of the speed
        // damage the car a touch on big impacts
        if (rec.target && impact > 12) {
          rec.health -= Math.min(18, (impact - 12) * 1.5);
          if (rec.health <= 0) { this._explode(ctx, rec); return; }
        }
        if (impact > 9) {
          try { ctx.bus.emit('shake', { amount: GU.clamp(impact * 0.18, 1, 4) }); } catch (e) {}
          try { ctx.bus.emit('crime', { kind: 'propertyDamage', pos: rec.pos.clone(), severity: 0.3, source: 'player' }); } catch (e) {}
        }
      }
    } else {
      rec.pos.x = GU.clamp(rec.pos.x, -118, 118);
      rec.pos.z = GU.clamp(rec.pos.z, -118, 118);
    }

    // run over pedestrians (and cops) in the footprint while moving
    if (Math.abs(rec.speed) > RUNOVER_SPEED) this._runOver(ctx, rec);

    // pin the player to the driver seat (slightly above the car)
    player.pos.set(rec.pos.x, rec.seatY, rec.pos.z);
    player.facing = rec.heading;
    player.vy = 0;

    // hit-flash decay even while driving
    if (rec._flashT > 0) { rec._flashT = Math.max(0, rec._flashT - dt); this._applyFlash(rec); }

    this._spinWheels(rec, dt);
    this._applyTransform(rec);
  },

  // check ctx.targets kind:'ped'/'cop' inside the car footprint
  _runOver(ctx, rec) {
    if (!ctx.targets) return;
    const now = ctx.time ? ctx.time.t : 0;
    const fwd = forwardFromHeading(rec.heading, _v3a);
    // footprint half extents (a bit generous on length for the bumper)
    const halfLen = rec.footLen / 2 + 0.6;
    const halfWid = rec.footWid / 2 + 0.3;
    for (let i = 0; i < ctx.targets.length; i++) {
      const e = ctx.targets[i];
      if (!e || e.dead) continue;
      if (e.kind !== 'ped' && e.kind !== 'cop') continue;
      const dx = e.pos.x - rec.pos.x, dz = e.pos.z - rec.pos.z;
      // project onto car local axes
      const along = dx * fwd.x + dz * fwd.z;            // forward axis
      const side  = dx * fwd.z - dz * fwd.x;            // right axis (perp)
      if (Math.abs(along) <= halfLen && Math.abs(side) <= halfWid) {
        // per-target cooldown: while a ped stays under the car it overlaps the
        // footprint every frame — only apply damage + emit a crime once per ~1s
        // per target so one kill/graze doesn't stack a pile of heat.
        if (typeof e._runOverT === 'number' && (now - e._runOverT) < RUNOVER_COOLDOWN) continue;
        e._runOverT = now;
        const dmg = 55 + Math.abs(rec.speed) * 3.5;
        try { e.onHit && e.onHit(dmg, 'vehicle', rec.pos.clone()); } catch (err) {}
        try {
          ctx.bus.emit('crime', {
            kind: e.kind === 'cop' ? 'copAssault' : 'assault',
            pos: rec.pos.clone(), severity: 0.6, source: 'vehicle',
          });
        } catch (err) {}
      }
    }
  },

  // ----------------------------------------------------------
  // TRAFFIC AI (cheap)
  // ----------------------------------------------------------
  _driveTraffic(dt, ctx, rec, player, salt) {
    const world = ctx.systems.world && ctx.systems.world.api;

    // far from the player? wrap/respawn so we don't simulate the whole map
    if (player) {
      const fd = GU.dist2D(rec.pos.x, rec.pos.z, player.pos.x, player.pos.z);
      if (fd > FAR_WRAP) {
        // mix in a per-car salt so same-frame far-wraps diverge instead of stacking
        const rng = GU.makeRng(((ctx.time ? ctx.time.t * 1000 : 1) | 0) ^ (((salt | 0) + 1) * 2654435761));
        this._placeCar(ctx, rec, rng);
        rec.occupant = 'ped';
        return;
      }
    }

    // target cruise speed; slow if something is just ahead
    let desired = TRAFFIC_SPEED;

    // look-ahead point
    forwardFromHeading(rec.heading, _fwd);
    const aheadX = rec.pos.x + _fwd.x * 4.5;
    const aheadZ = rec.pos.z + _fwd.z * 4.5;

    // building ahead? slow/stop
    let blocked = false;
    if (world && world.isInside && world.isInside(aheadX, aheadZ, 1.0)) blocked = true;

    // another car just ahead? (cheap O(n) but n is small)
    if (!blocked) {
      for (let i = 0; i < this.cars.length; i++) {
        const o = this.cars[i];
        if (o === rec || o.destroyed) continue;
        const dx = o.pos.x - rec.pos.x, dz = o.pos.z - rec.pos.z;
        const along = dx * _fwd.x + dz * _fwd.z;
        const side  = dx * _fwd.z - dz * _fwd.x;
        if (along > 0 && along < 6 && Math.abs(side) < 2.0) { blocked = true; break; }
      }
    }

    if (blocked) desired = 0;

    // accelerate/decelerate toward desired
    if (rec.speed < desired) rec.speed = Math.min(desired, rec.speed + ACCEL * 0.6 * dt);
    else rec.speed = Math.max(desired, rec.speed - BRAKE * 0.8 * dt);

    // follow the lane: snap heading toward the nearest road's direction, and
    // gently correct lateral drift back toward the lane centreline.
    if (world && world.nearestRoad) {
      world.nearestRoad(rec.pos.x, rec.pos.z, _road);
      // road dir is an axis (0 or PI/2); choose the alignment closest to current heading
      const opt1 = _road.dir;
      const opt2 = _road.dir + Math.PI;
      const h = rec.heading;
      const a1 = Math.abs(angleDelta(h, opt1));
      const a2 = Math.abs(angleDelta(h, opt2));
      let laneDir = a1 <= a2 ? opt1 : opt2;

      // occasional turn at an intersection: if we're near a grid crossing, maybe
      // pick the perpendicular road instead.
      if (rec._stuckT <= 0 && nearIntersection(rec.pos.x, rec.pos.z, world.blockSize)) {
        if (GU.chance(ctx.rng, 0.012)) {
          laneDir += (GU.chance(ctx.rng, 0.5) ? Math.PI / 2 : -Math.PI / 2);
        }
      }

      // steer heading toward laneDir
      rec.heading = GU.lerpAngle(rec.heading, laneDir, GU.clamp(3.0 * dt, 0, 1));

      // pull back toward the lane centreline laterally
      const toLaneX = _road.x - rec.pos.x;
      const toLaneZ = _road.z - rec.pos.z;
      // only correct the component perpendicular to travel
      const perpX = _fwd.z, perpZ = -_fwd.x;
      const lateral = toLaneX * perpX + toLaneZ * perpZ;
      rec.pos.x += perpX * lateral * GU.clamp(1.6 * dt, 0, 0.5);
      rec.pos.z += perpZ * lateral * GU.clamp(1.6 * dt, 0, 0.5);
    }

    // integrate
    forwardFromHeading(rec.heading, _fwd);
    rec.pos.x += _fwd.x * rec.speed * dt;
    rec.pos.z += _fwd.z * rec.speed * dt;
    rec.pos.y = 0;

    // keep out of buildings; if shoved, mark stuck so we re-evaluate a turn
    if (world && world.resolve) {
      const px = rec.pos.x, pz = rec.pos.z;
      world.resolve(rec.pos, 1.3);
      if (Math.hypot(rec.pos.x - px, rec.pos.z - pz) > 0.05) {
        rec.speed *= 0.3;
        rec._stuckT = 0.8;
        // turn away
        rec.heading += (GU.chance(ctx.rng, 0.5) ? 1 : -1) * Math.PI / 2;
      }
    }
    if (rec._stuckT > 0) rec._stuckT -= dt;

    // lean is negligible for traffic
    rec._lean = GU.damp(rec._lean, 0, 6, dt);
  },

  // ----------------------------------------------------------
  // VISUALS: wheels, flash
  // ----------------------------------------------------------
  _spinWheels(rec, dt) {
    rec._wheelSpin += rec.speed * dt * 1.6;
    const s = rec._wheelSpin;
    const w = rec.wheels;
    for (let i = 0; i < w.length; i++) {
      // wheels were laid on their side via rotation.z = PI/2; spin about local x
      w[i].rotation.x = s;
    }
  },

  _applyFlash(rec) {
    if (!rec.bodyMat) return;
    const k = GU.clamp(rec._flashT / 0.12, 0, 1);
    rec.bodyMat.emissive = rec.bodyMat.emissive || new _THREE.Color(0);
    rec.bodyMat.emissive.setHex(0xff4422);
    rec.bodyMat.emissiveIntensity = 0.9 * k;
    if (k <= 0) rec.bodyMat.emissiveIntensity = 0;
  },

  _animateFlashes(dt) {
    if (!this._explosionPool) return;
    const items = this._explosionPool.items;
    for (let i = 0; i < items.length; i++) {
      const m = items[i];
      if (!m.visible) continue;
      if (typeof m.userData.flashT !== 'number') { m.visible = false; continue; }
      m.userData.flashT -= dt;
      const k = m.userData.flashT;
      if (k <= 0) { m.visible = false; continue; }
      const g = 1 - k / 0.55;
      m.scale.setScalar(0.6 + g * 2.6);
      if (m.material) m.material.opacity = Math.max(0, 0.9 * (1 - g));
    }
  },

  // ----------------------------------------------------------
  // RESET (respawn / re-enter) — no mesh rebuilding
  // ----------------------------------------------------------
  reset(ctx) {
    // if the player was driving, get them out cleanly
    if (ctx.player && ctx.player.inVehicle) {
      try { this._bailOut(ctx); } catch (e) {}
    }
    // respawn destroyed cars and clear any traffic that wandered off
    const rng = GU.makeRng(0xA11CE);
    for (let i = 0; i < this.cars.length; i++) {
      const c = this.cars[i];
      if (c.destroyed) {
        this._respawnCar(ctx, c, i);
      } else {
        c.occupant = c.parked ? null : 'ped';
        c.speed = 0;
        c._flashT = 0;
        c._lean = 0;
        if (c.bodyMat) c.bodyMat.emissiveIntensity = 0;
        this._applyTransform(c);
      }
      // make sure every live car still has a registered target
      if (!c.destroyed && !c.target) this._registerTarget(ctx, c);
      if (c.target) c.target.dead = c.destroyed;
    }
    // hide any lingering explosion flashes
    if (this._explosionPool) {
      const items = this._explosionPool.items;
      for (let i = 0; i < items.length; i++) { items[i].visible = false; items[i].userData.flashT = 0; }
    }
  },

  // ----------------------------------------------------------
  // PUBLIC API
  // ----------------------------------------------------------
  api: {
    forceExit() {
      const ctx = GTA.ctx;
      if (!ctx) return;
      const rec = ctx.player && ctx.player.vehicle;
      if (ctx.player && ctx.player.inVehicle && rec && !rec.destroyed) {
        try { sys._exit(ctx, rec); }
        catch (e) { try { sys._bailOut(ctx); } catch (e2) {} }
      } else {
        try { sys._bailOut(ctx); } catch (e) {}
      }
    },
    playerVehicle() {
      const ctx = GTA.ctx;
      if (!ctx || !ctx.player) return null;
      return ctx.player.inVehicle ? (ctx.player.vehicle || null) : null;
    },
    nearestEnterable(pos) {
      const ctx = GTA.ctx;
      if (!ctx || !pos) return null;
      return sys._nearest(ctx, pos, ENTER_RANGE);
    },
    // Place a fresh PARKED, enterable car at world (x,z) on the ground (Y=0).
    // Reuses the normal build/register paths so count()/nearestEnterable() and
    // ctx.targets all see it. opts may carry { heading, type }. Returns the
    // vehicle record (has a `.pos` THREE.Vector3) or null on failure.
    spawnAt(x, z, opts) {
      const ctx = GTA.ctx;
      if (!ctx || !_THREE) return null;
      try {
        const o = opts || {};
        const rng = GU.makeRng(((ctx.time ? ctx.time.t * 1000 : 0) | 0) ^ ((sys.cars.length + 1) * 2654435761));
        const car = sys._buildCar(ctx, rng, true, {
          x, z,
          heading: (typeof o.heading === 'number') ? o.heading : 0,
          type: o.type,
        });
        sys.cars.push(car);
        sys._registerTarget(ctx, car);
        return car;
      } catch (e) {
        return null;
      }
    },
    count() {
      let n = 0;
      for (let i = 0; i < sys.cars.length; i++) if (!sys.cars[i].destroyed) n++;
      return n;
    },
  },
};

// ---- small local angle helpers (no allocation) -----------------------------
function angleDelta(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function nearIntersection(x, z, block) {
  if (!block) return false;
  const mx = Math.abs(((x % block) + block) % block);
  const mz = Math.abs(((z % block) + block) % block);
  const dx = Math.min(mx, block - mx);
  const dz = Math.min(mz, block - mz);
  return dx < 5.5 && dz < 5.5;
}

GTA.register(sys);
export default sys;
