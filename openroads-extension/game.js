/* ============================================================================
   Open Roads — endless driving game (Three.js r128)
   Single-file engine: procedural road, seasons, vehicles, physics, audio.
   ========================================================================== */
'use strict';

// ---------------------------------------------------------------------------
// Config: vehicles & seasons
// ---------------------------------------------------------------------------
const VEHICLES = {
  car: {
    name: 'Muscle Car', icon: '🏎️', desc: 'American V8 muscle',
    maxSpeed: 220, accel: 13, grip: 1.05, mass: 1.0, len: 2.0, turn: 1.7,
    wheel: { r: 0.5, offX: 1.02, offZ: 1.55 }, engine: 'mid',
    brake: 62, suspK: 100, suspD: 15   // balanced stop power + suspension feel
  },
  bike: {
    name: 'Chopper', icon: '🏍️', desc: 'Raked-out American chopper',
    maxSpeed: 230, accel: 15, grip: 0.9, mass: 0.6, len: 1.7, turn: 2.0,
    wheel: { r: 0.62, offX: 0.0, offZ: 1.45 }, engine: 'high',
    brake: 78, suspK: 62, suspD: 10    // strong brakes, soft floppy ride
  },
  truck: {
    name: 'Big Rig', icon: '🚛', desc: 'Optimus-style hauler',
    maxSpeed: 160, accel: 8.5, grip: 1.3, mass: 2.4, len: 3.0, turn: 1.25,
    wheel: { r: 0.68, offX: 1.3, offZ: 2.5 }, engine: 'low',
    brake: 55, suspK: 140, suspD: 20   // heavy, stiff, longer to haul down
  }
};

// Cel-shaded palette — MeshToonMaterial + a hard 4-step gradient ramp gives the
// banded, comic-illustration look (vs the old flat 3D-toy Phong shading).
let _toonRamp = null;
function toonRamp() {
  if (_toonRamp) return _toonRamp;
  const steps = [90, 150, 205, 255];           // 4 brightness bands
  const data = new Uint8Array(steps.length * 4);
  steps.forEach((v, i) => { data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; });
  const tex = new THREE.DataTexture(data, steps.length, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false; tex.needsUpdate = true;
  _toonRamp = tex;
  return tex;
}
// Art style: 'cel' (MeshToonMaterial + banded ramp + ink outlines) or 'flat' (faceted
// MeshLambertMaterial, flatShading, no outlines) — the bright low-poly polygon look.
// Chosen in Settings and persisted; every surface flows through surf() so one toggle
// reskins the whole world.
function isFlat() { return typeof Settings !== 'undefined' && Settings.artStyle === 'flat'; }
function surf(color, opts) {
  opts = opts || {};
  const o = { color: color, transparent: !!opts.transparent, opacity: opts.opacity == null ? 1 : opts.opacity };
  if (opts.map) o.map = opts.map;
  if (isFlat()) {
    // r128: only Phong/Standard honour flatShading (Lambert shades per-vertex and warns).
    // Phong with no specular reads as a matte, truly faceted low-poly surface.
    o.flatShading = true; o.shininess = 0; o.specular = 0x000000;
    return new THREE.MeshPhongMaterial(o);
  }
  o.gradientMap = toonRamp();
  return new THREE.MeshToonMaterial(o);
}
const MAT = {
  paint:  (c) => surf(c),
  matte:  (c) => surf(c),
  chrome: () => surf(0xd2d7dd),
  glass:  () => surf(0x2c3e4c, { transparent: true, opacity: 0.82 }),
  tire:   () => surf(0x1b1e23),
  dark:   () => surf(0x2a2d33),
  light:  (c) => new THREE.MeshBasicMaterial({ color: c }),
  // ground/terrain & scenery
  land:   (c) => surf(c)
};

// Cheap "ink outline" for the hero vehicle: a slightly inflated back-face shell.
const OUTLINE_INK = 0x1b1d23;
function addVehicleOutline() {
  if (isFlat()) return;            // flat low-poly look reads cleaner with no ink outline
  if (!vehicleGroup || typeof vehicleGroup.clone !== 'function') return;
  const shell = vehicleGroup.clone(true);
  const ink = new THREE.MeshBasicMaterial({ color: OUTLINE_INK, side: THREE.BackSide });
  // Inflate EACH panel about its own centre (not the whole group) — scaling the
  // group origin slid panels outward and produced the doubled/offset artifact.
  shell.traverse(o => {
    if (o.geometry && o.material) {
      o.material = ink;
      o.castShadow = false;
      o.scale.multiplyScalar(1.06);
    }
  });
  shell.scale.set(1, 1, 1);
  shell.position.set(0, 0, 0);
  vehicleGroup.add(shell);
}

// Optional real GLTF vehicle model (CC0). If assets/models/<vehicle>.glb exists it
// replaces the procedural body (toon-converted, autoscaled, grounded); otherwise the
// procedural model stays. Async + guarded, so the game never blocks or breaks.
// Cohesive CC0 low-poly set (Kenney cars/truck + CC0 bike) — one consistent style.
const GLB_MODELS = {
  car: 'assets/models/car.gltf',
  bike: 'assets/models/bike.gltf',
  truck: 'assets/models/truck.gltf'
};
function loadVehicleModel() {
  if (typeof THREE.GLTFLoader !== 'function') return;
  const v = selectedVehicle, url = GLB_MODELS[v];
  if (!url) return;
  const loader = new THREE.GLTFLoader();
  loader.load(url, (gltf) => {
    if (selectedVehicle !== v || !vehicleGroup) return;   // selection changed during load
    const model = gltf.scene;
    // drop baked shadow/ground planes (they bloat the bbox → bad autoscale + black blob)
    const kill = [], wheels = [];
    model.traverse(o => {
      if (!o.isMesh) return;
      const nm = (o.name || '').toLowerCase();
      o.geometry.computeBoundingBox();
      const bb = o.geometry.boundingBox, sz = new THREE.Vector3(); bb.getSize(sz);
      const flat = sz.y < 0.04 * Math.max(sz.x, sz.z);    // a near-flat plane
      if (/shadow|plane|ground|floor/.test(nm) || flat) { kill.push(o); return; }
      if (/wheel|tyre|tire/.test(nm)) wheels.push(o);     // spinnable wheel node
      o.castShadow = true; o.receiveShadow = true;
      const m = o.material;
      o.material = surf((m && m.color) ? m.color.getHex() : 0xcccccc, { map: (m && m.map) || null });
    });
    kill.forEach(o => o.parent && o.parent.remove(o));
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const scale = (VEHICLES[v].len * 2.2) / (Math.max(size.x, size.z) || 1);
    model.scale.setScalar(scale);
    model.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
    if (size.x > size.z) model.rotation.y = Math.PI / 2;   // run length along forward (Z)
    while (vehicleGroup.children.length) vehicleGroup.remove(vehicleGroup.children[0]);
    vehicleWheels = [];
    // spin wheels about their local axle: pre-store each wheel's resting rotation so
    // we add roll on top without disturbing its mount orientation.
    glbWheels = wheels.map(w => ({ node: w, baseX: w.rotation.x }));
    vehicleGroup.add(model);
    applyLivery();             // recolour the loaded model's body to the chosen paint
  }, undefined, () => { /* missing/failed → keep procedural fallback */ });
}

// Recolour the vehicle's body to the selected livery. Picks the largest non-wheel,
// non-outline mesh (the body panel) so it works for both procedural and GLB vehicles.
function applyLivery() {
  const liv = LIVERIES.find(l => l.id === Progress.livery);
  if (!liv || liv.color == null || !vehicleGroup || typeof vehicleGroup.traverse !== 'function') return;
  let best = null, bestVol = -1;
  vehicleGroup.traverse(o => {
    if (!o.isMesh || !o.geometry) return;
    const nm = (o.name || '').toLowerCase();
    if (/wheel|tyre|tire/.test(nm)) return;
    if (o.material && o.material.side === THREE.BackSide) return;     // skip the ink outline shell
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox; if (!bb) return;
    const s = new THREE.Vector3(); bb.getSize(s);
    const sc = o.scale ? Math.abs(o.scale.x * o.scale.y * o.scale.z) : 1;
    const vol = s.x * s.y * s.z * sc;
    if (vol > bestVol) { bestVol = vol; best = o; }
  });
  if (best && best.material && best.material.color) best.material.color.setHex(liv.color);
}

// A box with rounded long edges + slightly bevelled ends — the core of every body panel.
function chamferBox(w, h, l, radius, bevel) {
  const r = Math.max(0.001, Math.min(radius, w / 2 - 0.001, h / 2 - 0.001));
  const x = -w / 2, y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const bv = bevel || 0;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: l - bv * 2, bevelEnabled: bv > 0, bevelThickness: bv, bevelSize: bv, bevelSegments: 2, steps: 1
  });
  geo.translate(0, 0, -(l - bv * 2) / 2);
  geo.computeVertexNormals();
  return geo;
}
function panel(w, h, l, color, radius, bevel) {
  return new THREE.Mesh(chamferBox(w, h, l, radius == null ? 0.18 : radius, bevel == null ? 0.04 : bevel), MAT.paint(color));
}

const SEASONS = {
  summer: {
    name: 'Sunny Summer', tag: '#ffe08a',
    sky: 0xbfe3f2, fog: 0xcfe9f4, fogDensity: 0.0042,
    ground: 0x9ccb7a, groundEdge: 0x8bbd6a, road: 0x44474f, roadLine: 0xf2efe2,
    sun: 0xfff4d6, sunInt: 1.15, amb: 0x9fb6c8, ambInt: 0.75,
    accent: 0xe7d27a, particles: null, treeStyle: 'leafy', treeColor: 0x7cae5a,
    sound: 'cicada'
  },
  spring: {
    name: 'Soft Spring', tag: '#bfe6c2',
    sky: 0xd6ecdc, fog: 0xe3f1e6, fogDensity: 0.0050,
    ground: 0xa9d49a, groundEdge: 0x9ac88a, road: 0x474b53, roadLine: 0xf4f2e8,
    sun: 0xfff2e8, sunInt: 1.0, amb: 0xc3d6cf, ambInt: 0.85,
    accent: 0xf2bcd0, particles: 'petals', treeStyle: 'blossom', treeColor: 0x88c08a,
    sound: 'birds'
  },
  winter: {
    name: 'Harsh Winter', tag: '#dbe8f2',
    sky: 0xdfe7ee, fog: 0xeaf0f5, fogDensity: 0.0078,
    ground: 0xeef3f7, groundEdge: 0xe2eaf1, road: 0x5b636e, roadLine: 0xfbfdff,
    sun: 0xeef3fb, sunInt: 0.78, amb: 0xc7d4e0, ambInt: 1.0,
    accent: 0xdce8f4, particles: 'snow', treeStyle: 'snowy', treeColor: 0x8fa6a0,
    sound: 'wind'
  },
  monsoon: {
    name: 'Rainy Monsoon', tag: '#9fb4c4',
    sky: 0x9aabb8, fog: 0xa9bac6, fogDensity: 0.0090,
    ground: 0x6f9472, groundEdge: 0x638967, road: 0x383d45, roadLine: 0xdfe3e0,
    sun: 0xc8d4dc, sunInt: 0.6, amb: 0x8395a3, ambInt: 0.95,
    accent: 0x8fb0c4, particles: 'rain', treeStyle: 'leafy', treeColor: 0x5c8a5e,
    sound: 'rain'
  },
  desert: {
    name: 'Desert', tag: '#e8c79a',
    sky: 0xf0dcc0, fog: 0xf2e2cc, fogDensity: 0.0040,
    ground: 0xe3c89a, groundEdge: 0xd8ba87, road: 0x6b6253, roadLine: 0xf3ead7,
    sun: 0xfff0d2, sunInt: 1.25, amb: 0xd8c3a4, ambInt: 0.8,
    accent: 0xe0b173, particles: 'dust', treeStyle: 'cactus', treeColor: 0x8aa86a,
    sound: 'wind'
  }
};

// ---------------------------------------------------------------------------
// Missions — 10 tasks to clear the run
// ---------------------------------------------------------------------------
// Ordered as an easy → hard ramp: warm-up speed, a gentle smash, then sustained
// control, precision, navigation, and finally the high-skill speed/air/braking feats.
const MISSIONS = [
  { id: 'speed80',  label: 'Reach 80 km/h',                    short: '80' },
  { id: 'tree',     label: 'Go off-road & smash a big tree',  short: '🌳' },
  { id: 'hold70',   label: 'Hold 70+ km/h for 8s',            short: '8s', hasProgress: true },
  { id: 'reverse',  label: 'Reverse 40 metres',               short: '40m', hasProgress: true },
  { id: 'cones',    label: 'Bowl down a full set of cones',   short: '🚧', hasProgress: true },
  { id: 'pond',     label: 'Cross an off-road pond',          short: '💧', hasProgress: true },
  { id: 'hut',      label: 'Go off-road & flatten a hut',     short: '🛖' },
  { id: 'speed120', label: 'Hit 120 km/h',                    short: '120' },
  { id: 'jump',     label: 'Big air: clear a hill ramp',      short: '⛰️' },
  { id: 'stop',     label: 'Emergency stop from 80+ (Space)', short: '🛑' }
];

const Missions = {
  done: {},        // id -> true
  count: 0,
  reset() {
    this.done = {}; this.count = 0;
    MISSIONS.forEach(m => { this.done[m.id] = false; });
    renderMissionList();
  },
  complete(id) {
    if (State.mode !== 'challenge') return;   // Zen Drive has no objectives
    if (this.done[id]) return;
    this.done[id] = true; this.count++;
    addCoins(25);                             // objective reward
    const m = MISSIONS.find(x => x.id === id);
    showToast('✓ ' + m.label, this.count + ' / ' + MISSIONS.length + ' done');
    playDing();
    renderMissionList();
    if (this.count === MISSIONS.length) winRun();
  }
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------
let selectedVehicle = 'car';
let selectedSeason = 'summer';

// ---------------------------------------------------------------------------
// Persistence — localStorage can throw (private mode, quota, disabled storage)
// or hold corrupt values. Every read/write goes through these guards so a
// storage failure degrades to in-memory defaults instead of breaking boot.
// ---------------------------------------------------------------------------
const SAVE_VERSION = 1;
function lsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
  catch (e) { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, String(value)); return true; }
  catch (e) { return false; }   // quota / private mode — keep running in memory
}
// one-time schema bookkeeping for future migrations
(function initSaveSchema() {
  const v = parseInt(lsGet('openroads_ver', '0'), 10) || 0;
  if (v < SAVE_VERSION) lsSet('openroads_ver', SAVE_VERSION);
})();

const State = {
  running: false, paused: false, muted: false,
  speed: 0,          // signed, m/s along road
  steer: 0,          // -1..1 visual lean
  lateral: 0,        // x offset on road
  distance: 0,       // metres travelled (forward only, for HUD)
  best: parseFloat(lsGet('openroads_best', '0')) || 0,
  s: 0,              // car's projected arc-length on the path (for road extension/recycling)
  carX: 0, carZ: 0,  // free-roam world position
  vx: 0, vz: 0,      // velocity vector (world) — diverges from heading when drifting
  slip: 0,           // current slip (sideways velocity vs heading), 0..~1
  heading: 0,        // world heading (radians); dir = (sin h, cos h)
  camMode: 0,        // 0 chase, 1 close, 2 hood
  mode: 'challenge', // 'challenge' (missions) | 'zen' (free scenic drive)
  autodrive: false,  // hands-off cruising (Zen)
  // suspension / weight transfer (visual chassis dynamics)
  prevSpeed: 0, pitchS: 0, rollS: 0, suspComp: 0, suspVel: 0,
  launchT: 0,        // seconds of throttle held from near-rest (launch-control window)
  driftDist: 0,      // metres of sustained drift this run (rewards coins)
  _driftReward: 0,   // last drift milestone already paid out (metres)
  minimap: true,     // minimap visible (toggle N)
  touchSteer: null,  // analog steer from the mobile joystick (-1..1), null when not touching
  touchThrottle: null, // analog throttle from the mobile pad (-1 reverse .. 1 accel)
  // time-trial state
  ttFinished: false, ttSampleT: 0,
  // tutorial state
  tutStep: -1, tutT: 0,
  // mission run state
  jumpY: 0, vy: 0, airborne: false,
  gripMod: 1,        // surface grip multiplier (oil/mud/puddle hazards drop it < 1)
  hold70: 0,         // seconds held >= 70 km/h
  pondTime: 0,       // seconds spent crossing a pond
  reverseDist: 0,    // metres reversed
  wasMoving: false,  // for full-stop detection (reached 80+)
  offRoad: false,    // currently off the asphalt
  runStart: 0,       // clock time at run start
  _lastCoinD: 0,     // distance bookmark for coin accrual
  won: false
};

const keys = { up: false, down: false, left: false, right: false, brake: false, drift: false };

// Persisted user settings (volume + graphics quality)
const Settings = {
  volume: (() => { const v = parseFloat(lsGet('openroads_vol', '')); return isNaN(v) ? 0.9 : Math.max(0, Math.min(1, v)); })(),
  quality: (() => { const q = lsGet('openroads_quality', 'med'); return ['low', 'med', 'high'].includes(q) ? q : 'med'; })(),
  artStyle: (() => { const a = lsGet('openroads_art', 'cel'); return ['cel', 'flat'].includes(a) ? a : 'cel'; })(),
  musicOn: lsGet('openroads_music', '1') !== '0'
};
function setVolume(v) {
  Settings.volume = Math.max(0, Math.min(1, v));
  lsSet('openroads_vol', Settings.volume);
  if (Audio.masterGain && Audio.ctx) Audio.masterGain.gain.setTargetAtTime(State.muted ? 0 : Settings.volume, Audio.ctx.currentTime, 0.05);
}
function applyQuality() {
  if (!renderer) return;
  const q = Settings.quality;
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(q === 'low' ? 1 : Math.min(dpr, q === 'high' ? 2 : 1.5));
  renderer.shadowMap.enabled = q !== 'low';
  if (sunLight) {
    sunLight.castShadow = q !== 'low';
    // scale shadow resolution with quality: cheaper on low-end, crisper on high-end
    const sz = q === 'high' ? 2048 : (q === 'low' ? 512 : 1024);
    if (sunLight.shadow.mapSize.x !== sz) {
      sunLight.shadow.mapSize.set(sz, sz);
      if (sunLight.shadow.map) { sunLight.shadow.map.dispose(); sunLight.shadow.map = null; }
    }
  }
  setupPost();   // rebuild the post pipeline for this quality (FXAA/bloom gating)
}
function setQuality(q) {
  Settings.quality = q;
  lsSet('openroads_quality', q);
  applyQuality();
}
// Art-style toggle: cel-shaded ↔ flat low-poly. Persisted, applied live (rebuilds the
// world + vehicle so every material picks up the new style — safe on the menu backdrop).
function setArtStyle(a) {
  if (!['cel', 'flat'].includes(a)) return;
  Settings.artStyle = a;
  lsSet('openroads_art', a);
  applyArtStyle();
}
function applyArtStyle() {
  const flat = Settings.artStyle === 'flat';
  if (document.body) document.body.classList.toggle('flat', flat);
  if (renderer) {
    // Flat colours want literal output — ACES desaturates them; toon banding doesn't.
    renderer.toneMapping = flat ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = flat ? 1.0 : 1.1;
  }
  if (scene) { buildWorld(); buildVehicle(); }
}

// Cosmetic paint jobs — recolour the vehicle body. 'stock' keeps the model's own colour.
const LIVERIES = [
  { id: 'stock',    name: 'Stock',    color: null,     cost: 0 },
  { id: 'crimson',  name: 'Crimson',  color: 0xc0392f, cost: 0 },
  { id: 'midnight', name: 'Midnight', color: 0x1b2433, cost: 150 },
  { id: 'sunburst', name: 'Sunburst', color: 0xe8a13a, cost: 150 },
  { id: 'forest',   name: 'Forest',   color: 0x2f6b40, cost: 300 },
  { id: 'violet',   name: 'Violet',   color: 0x6a4fb0, cost: 300 },
  { id: 'pearl',    name: 'Pearl',    color: 0xe7ebf0, cost: 500 }
];

// Progression: earn coins by driving/smashing/missions; spend them to unlock vehicles + paint.
const Progress = {
  coins: parseInt(lsGet('openroads_coins', '0'), 10) || 0,
  unlocked: (() => { try { return JSON.parse(lsGet('openroads_unlocked', '{}')) || {}; } catch (e) { return {}; } })(),
  liveries: (() => { try { return JSON.parse(lsGet('openroads_liveries', '{}')) || {}; } catch (e) { return {}; } })(),
  livery: lsGet('openroads_livery', 'stock')
};
const UNLOCK_COST = { bike: 400, truck: 1200 };   // car is free
function isUnlocked(v) { return v === 'car' || !!Progress.unlocked[v]; }
function liveryUnlocked(id) { const l = LIVERIES.find(x => x.id === id); return !!l && (l.cost === 0 || !!Progress.liveries[id]); }
function tryUnlockLivery(id) {
  if (liveryUnlocked(id)) return true;
  const l = LIVERIES.find(x => x.id === id); if (!l) return false;
  if (Progress.coins >= l.cost) { Progress.coins -= l.cost; Progress.liveries[id] = true; saveProgress(); return true; }
  return false;
}
function addCoins(n) { Progress.coins += n; }
function saveProgress() {
  lsSet('openroads_coins', Math.floor(Progress.coins));
  lsSet('openroads_unlocked', JSON.stringify(Progress.unlocked));
  lsSet('openroads_liveries', JSON.stringify(Progress.liveries));
  lsSet('openroads_livery', Progress.livery);
}
function tryUnlock(v) {
  if (isUnlocked(v)) return true;
  const cost = UNLOCK_COST[v] || 0;
  if (Progress.coins >= cost) { Progress.coins -= cost; Progress.unlocked[v] = true; saveProgress(); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------
let scene, camera, renderer, clock;
// Post-processing pipeline (optional — built only if the example libs loaded)
let composer = null, bloomPass = null, fxaaPass = null, postReady = false;
function postAvailable() {
  return typeof THREE.EffectComposer === 'function' && typeof THREE.RenderPass === 'function' &&
         typeof THREE.ShaderPass === 'function' && !!THREE.FXAAShader;
}
// (Re)build the composer for the current quality: low → direct render (fastest);
// med → FXAA; high → FXAA + a subtle bloom on bright highlights. Safe no-op if libs absent.
function setupPost() {
  composer = null; bloomPass = null; fxaaPass = null; postReady = false;
  if (!renderer || !scene || !camera || !postAvailable()) return;
  if (Settings.quality === 'low') return;     // skip the extra passes on low-end hardware
  try {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    if (Settings.quality === 'high' && typeof THREE.UnrealBloomPass === 'function') {
      const sz = new THREE.Vector2(window.innerWidth, window.innerHeight);
      bloomPass = new THREE.UnrealBloomPass(sz, 0.35, 0.5, 0.85);  // strength, radius, threshold — gentle
      composer.addPass(bloomPass);
    }
    fxaaPass = new THREE.ShaderPass(THREE.FXAAShader);
    composer.addPass(fxaaPass);
    resizePost();
    postReady = true;
  } catch (e) { composer = null; postReady = false; }   // any failure → direct render fallback
}
function resizePost() {
  if (!composer) return;
  const dpr = renderer.getPixelRatio ? renderer.getPixelRatio() : 1;
  if (composer.setPixelRatio) composer.setPixelRatio(dpr);
  composer.setSize(window.innerWidth, window.innerHeight);
  if (fxaaPass && fxaaPass.material && fxaaPass.material.uniforms.resolution) {
    fxaaPass.material.uniforms.resolution.value.set(1 / (window.innerWidth * dpr), 1 / (window.innerHeight * dpr));
  }
  if (bloomPass && bloomPass.setSize) bloomPass.setSize(window.innerWidth, window.innerHeight);
}
let sunLight, ambLight, hemiLight;
let vehicleGroup, vehicleWheels = [];
let glbWheels = [];   // wheel nodes detected inside a loaded GLB model (spun in update)
let roadGroup, terrainGroup, sceneryPool = [];
let actorGroup = null, actorPool = [];      // living, moving entities (animals + people)
let particleSystem = null, particleData = null;
let rainStreaks = null;

let camShake = 0, camShakeDecay = 6, camShakeRoll = 0;
// type: 'sharp' = quick high-freq rattle (landings, rumble); 'roll' = bigger, slower,
// rolls the camera (heavy smashes). Decay rate is chosen so each event reads distinctly.
function shakeCamera(amount, type) {
  camShake = Math.min(1.2, camShake + amount);
  if (type === 'roll') { camShakeDecay = 3.5; camShakeRoll = Math.min(0.09, camShakeRoll + amount * 0.12); }
  else { camShakeDecay = 9; }   // sharp: fast settle so it punches without lingering
}

const ROAD_WIDTH = 13;
let roadMesh = null;
// Steering sign for the free-roam heading model. LEFT must turn the car screen-left.
const STEER_DIR = 1;

// ---------------------------------------------------------------------------
// Procedural path — a rolling centerline buffer with curvature, elevation, bank.
// Replaces the old quadratic roadCenterAt(). All world placement samples this.
// ---------------------------------------------------------------------------
const PATH_DS = 4;           // metres between centerline nodes
const PATH_AHEAD = 600;      // how far ahead of the car we keep generated
const PATH_BEHIND = 90;      // how far behind to retain
const PATH = { nodes: [] };

// --- seeded value noise (smooth, non-repeating) drives a varied, biome'd route ---
let ROUTE_SEED = 1234;
function hash1(n) { const x = Math.sin(n * 12.9898 + ROUTE_SEED * 0.731) * 43758.5453; return x - Math.floor(x); }
function vnoise(x) {            // smooth 1-D value noise → 0..1
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  const a = hash1(i), b = hash1(i + 1);
  return a + (b - a) * u;
}
const sgn = (x) => (x - 0.5) * 2;  // 0..1 → -1..1

function curvatureAt(s) {       // rad/m — twistiness varies by "biome" along the route
  const biome = vnoise(s * 0.0006 + 11);          // slow 0..1 (straight ↔ twisty stretches)
  const amp = 0.0012 + biome * biome * 0.0042;
  const c = sgn(vnoise(s * 0.0016 + 1)) * 0.7 + sgn(vnoise(s * 0.0055 + 2)) * 0.3;
  return Math.max(-0.006, Math.min(0.006, c * amp));
}
function baseElevationAt(s) {    // metres — flat plains ↔ tall hilly stretches (no bridges)
  const hilly = vnoise(s * 0.0005 + 22);          // slow 0..1
  const amp = 2.5 + hilly * hilly * 13;
  return sgn(vnoise(s * 0.0038 + 3)) * amp + sgn(vnoise(s * 0.013 + 4)) * amp * 0.28;
}
// Rivers cross the route at spaced intervals; the road humps UP into a bridge over each.
const RIVER_SPACING = 520, BRIDGE_H = 3.4, BRIDGE_W = 20;
function riverCenter(k) { return k * RIVER_SPACING + RIVER_SPACING * 0.5 + 70 * Math.sin(k * 1.7 + ROUTE_SEED * 0.013); }
function riverHumpAt(s) {
  const k0 = Math.round(s / RIVER_SPACING - 0.5);
  let h = 0;
  for (let k = k0 - 1; k <= k0 + 1; k++) { const d = (s - riverCenter(k)) / BRIDGE_W; h += BRIDGE_H * Math.exp(-d * d); }
  return h;
}
function elevationAt(s) { return baseElevationAt(s) + riverHumpAt(s); }
function bumpAt(x, z) {        // off-road terrain relief (grows away from the road)
  return 3.4 * Math.sin(x * 0.018 + z * 0.012)
       + 2.6 * Math.cos(x * 0.009 - z * 0.02 + 2.1)
       + 1.7 * Math.sin((x + z) * 0.028 + 0.7);
}

function pathSeedNode() {
  const s = 0;
  return { s, x: 0, z: 0, y: elevationAt(s), head: 0, hx: 0, hz: 1, nx: -1, nz: 0,
           bank: 0, curv: curvatureAt(s), width: ROAD_WIDTH };
}
function pathPush() {
  const last = PATH.nodes[PATH.nodes.length - 1];
  const s = last.s + PATH_DS;
  const curv = curvatureAt(s);
  const head = last.head + curv * PATH_DS;
  const hx = Math.sin(head), hz = Math.cos(head);
  const x = last.x + hx * PATH_DS, z = last.z + hz * PATH_DS;
  const bank = Math.max(-0.16, Math.min(0.16, -curv * 55));
  PATH.nodes.push({ s, x, z, y: elevationAt(s), head, hx, hz, nx: -hz, nz: hx,
                    bank, curv, width: ROAD_WIDTH });
}
function pathReset() {
  PATH.nodes = [pathSeedNode()];
  while (PATH.nodes[PATH.nodes.length - 1].s < PATH_AHEAD) pathPush();
}
function pathMaintain(s) {
  while (PATH.nodes[PATH.nodes.length - 1].s < s + PATH_AHEAD) pathPush();
  // trim behind (keep buffer bounded for long drives)
  let drop = 0;
  while (drop < PATH.nodes.length - 2 && PATH.nodes[drop].s < s - PATH_BEHIND) drop++;
  if (drop > 0) PATH.nodes.splice(0, drop);
}
function samplePath(s) {
  const n = PATH.nodes;
  let i = Math.floor((s - n[0].s) / PATH_DS);
  if (i < 0) i = 0; if (i > n.length - 2) i = n.length - 2;
  const a = n[i], b = n[i + 1];
  let t = (s - a.s) / PATH_DS; if (t < 0) t = 0; if (t > 1) t = 1;
  const lf = (k) => a[k] + (b[k] - a[k]) * t;
  return { x: lf('x'), y: lf('y'), z: lf('z'), hx: lf('hx'), hz: lf('hz'),
           nx: lf('nx'), nz: lf('nz'), head: lf('head'), bank: lf('bank') };
}
// nearest centerline point — distance, elevation, arc-length, tangent, signed lateral
function nearestPathInfo(x, z) {
  const n = PATH.nodes; let best = Infinity, bi = 0;
  for (let i = 0; i < n.length; i += 1) {
    const dx = x - n[i].x, dz = z - n[i].z, d2 = dx * dx + dz * dz;
    if (d2 < best) { best = d2; bi = i; }
  }
  const a = n[bi];
  const lateral = (x - a.x) * a.nx + (z - a.z) * a.nz;
  return { d: Math.sqrt(best), y: a.y, s: a.s, hx: a.hx, hz: a.hz, lateral };
}
// terrain height: road elevation inside the corridor, blending up into hills outside
function heightAt(x, z) {
  const info = nearestPathInfo(x, z);
  const corridor = ROAD_WIDTH / 2 + 3, blend = 24;
  let k = info.d <= corridor ? 0 : (info.d >= corridor + blend ? 1 : (info.d - corridor) / blend);
  return info.y + bumpAt(x, z) * k;
}
// O(1) ground height for a point whose centerline elevation (yc) and perpendicular
// lateral distance are already known — e.g. pooled scenery placed at a fixed offset.
// Avoids heightAt's full O(path-node) nearestPathInfo scan on the per-frame hot path.
function heightFromPath(yc, lateralDist, x, z) {
  const corridor = ROAD_WIDTH / 2 + 3, blend = 24;
  const k = lateralDist <= corridor ? 0 : (lateralDist >= corridor + blend ? 1 : (lateralDist - corridor) / blend);
  return yc + bumpAt(x, z) * k;
}

function initThree() {
  scene = new THREE.Scene();
  clock = new THREE.Clock();

  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1400);
  camera.position.set(0, 6, -12);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Correct gamma (r128 defaults to LinearEncoding, which reads washed/dark) plus a
  // gentle ACES curve. ACES tone-maps highlights, so the toon bands stay vivid without
  // the additive sun+ambient+hemi sum clipping to white. Exposure nudged up to keep the
  // overall brightness the per-season lighting was originally tuned for.
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  if (Settings.artStyle === 'flat') { renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1.0; }
  document.getElementById('game').appendChild(renderer.domElement);

  // Lights
  sunLight = new THREE.DirectionalLight(0xffffff, 1.1);
  sunLight.position.set(60, 90, 40);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(1024, 1024);
  sunLight.shadow.camera.near = 1; sunLight.shadow.camera.far = 260;
  sunLight.shadow.camera.left = -60; sunLight.shadow.camera.right = 60;
  sunLight.shadow.camera.top = 60; sunLight.shadow.camera.bottom = -60;
  sunLight.shadow.bias = -0.0008;
  scene.add(sunLight);
  scene.add(sunLight.target);

  hemiLight = new THREE.HemisphereLight(0xffffff, 0x808080, 0.6);
  scene.add(hemiLight);

  ambLight = new THREE.AmbientLight(0xffffff, 0.7);
  scene.add(ambLight);

  applyQuality();   // honor saved graphics quality (pixel ratio + shadows)
  window.addEventListener('resize', onResize);
}

function onResize() {
  if (!camera) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizePost();
}

// ---------------------------------------------------------------------------
// Gradient sky dome (zenith -> horizon), follows the camera
// ---------------------------------------------------------------------------
let skyDome = null;
function buildSky(S) {
  if (skyDome) { scene.remove(skyDome); skyDome = null; }
  const top = new THREE.Color(S.sky).offsetHSL(0, 0.04, 0.08);    // clearer blue overhead
  const horizon = new THREE.Color(S.accent).offsetHSL(0, -0.06, 0.18); // soft warm band
  const haze = new THREE.Color(S.fog);                            // matches fog at the rim
  const R = 640;
  const geo = new THREE.SphereGeometry(R, 28, 18);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = Math.max(0, pos.getY(i)) / R;            // 0 horizon → 1 zenith
    if (h < 0.18) c.copy(haze).lerp(horizon, h / 0.18);            // hazy warm horizon
    else c.copy(horizon).lerp(top, Math.pow((h - 0.18) / 0.82, 0.7)); // up to blue
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
  skyDome = new THREE.Mesh(geo, mat);
  scene.add(skyDome);
}

// ---------------------------------------------------------------------------
// Build world for a season
// ---------------------------------------------------------------------------
// Flat low-poly palette: nudge each season's colours brighter/cleaner so faceted
// surfaces read as punchy solid polygons (vs the muted cel palette). Returns a copy —
// physics/audio keep reading the untouched SEASONS entry.
function flatPalette(S) {
  const bump = (hex, ds, dl) => new THREE.Color(hex).offsetHSL(0, ds, dl).getHex();
  return Object.assign({}, S, {
    sky:        bump(S.sky, 0.08, 0.04),
    fog:        bump(S.fog, 0.04, 0.05),
    ground:     bump(S.ground, 0.20, -0.04),
    groundEdge: bump(S.groundEdge, 0.18, -0.05),
    treeColor:  bump(S.treeColor, 0.18, -0.04),
    accent:     bump(S.accent, 0.08, 0.02)
  });
}

function buildWorld() {
  const flat = isFlat();
  const S = flat ? flatPalette(SEASONS[selectedSeason]) : SEASONS[selectedSeason];

  scene.background = new THREE.Color(S.sky);
  scene.fog = new THREE.FogExp2(S.fog, S.fogDensity);
  buildSky(S);

  sunLight.color.setHex(S.sun);
  ambLight.color.setHex(S.amb);
  hemiLight.color.setHex(S.sky);
  hemiLight.groundColor.setHex(S.ground);
  if (flat) {
    // Flat Lambert + NoToneMapping: keep the additive sun+amb+hemi sum under ~1.0 so bright
    // greens stay saturated instead of clipping to white, while a clear directional keeps the
    // facets shaded (lit ~0.9, shadowed ~0.4) — the punchy low-poly read.
    sunLight.intensity = Math.min(S.sunInt, 1.0) * 0.7;
    ambLight.intensity = 0.38;
    hemiLight.intensity = 0.22;
  } else {
    // Toon shading already supplies the banding, so total light must stay near 1.0 —
    // otherwise ambient+hemi+sun sum clips colours to white (the washed-out look).
    sunLight.intensity = S.sunInt * 0.85;
    ambLight.intensity = S.ambInt * 0.34;
    hemiLight.intensity = (selectedSeason === 'monsoon') ? 0.28 : 0.36;
  }

  // --- Procedural terrain grid (follows car) + distant hill ring ---
  if (terrainGroup) scene.remove(terrainGroup);
  terrainGroup = new THREE.Group();
  scene.add(terrainGroup);
  pathReset();
  buildTerrain(S);

  // --- Road + river bridges ---
  buildRoad(S);
  buildBridges(S);

  // --- Scenery pool (trees / cacti / rocks) ---
  buildScenery(S);

  // --- Living actors (animals + pedestrians) ---
  buildActors();
  buildBlood();

  // --- Mission interactables ---
  buildInteractables();

  // --- Weather particles ---
  buildParticles(S);

  // update tag
  document.getElementById('scene-name').textContent = S.name;
  document.getElementById('scene-dot').style.background = S.tag;
}

// Displaced terrain grid centred on the car + a distant hill ring for the horizon.
const TGRID = 64, TCELL = 8, TSPAN = TGRID * TCELL;
let terrainMesh = null, hillRing = null, terrainSnap = null;

function buildTerrain(S) {
  const geo = new THREE.PlaneGeometry(TSPAN, TSPAN, TGRID, TGRID);
  geo.rotateX(-Math.PI / 2);
  terrainMesh = new THREE.Mesh(geo, MAT.land(S.ground));
  terrainMesh.receiveShadow = true;
  terrainMesh.frustumCulled = false;
  terrainGroup.add(terrainMesh);

  // distant hill ring (rides with the camera; fog softens it into a horizon)
  hillRing = new THREE.Group();
  const hillMat = MAT.land(new THREE.Color(S.groundEdge).offsetHSL(0, -0.02, -0.04).getHex());
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const r = 24 + Math.random() * 30;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5), hillMat);
    dome.position.set(Math.sin(a) * 300, -6, Math.cos(a) * 300);
    dome.scale.y = 0.5 + Math.random() * 0.5;
    hillRing.add(dome);
  }
  terrainGroup.add(hillRing);

  terrainSnap = null;
  updateTerrain(true);
}

function updateTerrain(force) {
  if (!terrainMesh) return;
  const v = vehicleGroup ? vehicleGroup.position : { x: 0, y: 0, z: 0 };
  const cx = Math.round(v.x / TCELL) * TCELL;
  const cz = Math.round(v.z / TCELL) * TCELL;
  if (hillRing) hillRing.position.set(v.x, 0, v.z);
  if (!force && terrainSnap && terrainSnap.x === cx && terrainSnap.z === cz) return;
  terrainSnap = { x: cx, z: cz };
  terrainMesh.position.set(cx, 0, cz);
  const pos = terrainMesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, heightAt(cx + pos.getX(i), cz + pos.getZ(i)));
  }
  pos.needsUpdate = true;
  terrainMesh.geometry.computeVertexNormals();
}

// --- Smooth road: one subdivided ribbon (world-space) following the path buffer.
const ROAD_ROWS = 200;
const ROAD_BACK = 36;                                  // metres of road kept behind the car
const ROAD_FWD = 520;                                  // metres ahead
const ROAD_LEN = ROAD_BACK + ROAD_FWD;
const ROAD_TILE = 16;                                  // metres per texture repeat (dash cycle)
let roadGeo = null, roadTex = null;

// Building facade textures (base colour + a grid of lit/dark windows + storefront band).
const FACADE_CACHE = {};
function makeFacadeTexture(base, cols, rows) {
  const key = base + '_' + cols + '_' + rows;
  if (FACADE_CACHE[key]) return FACADE_CACHE[key];
  const cw = 128, ch = 256, cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const x = cv.getContext('2d');
  x.fillStyle = '#' + new THREE.Color(base).getHexString(); x.fillRect(0, 0, cw, ch);
  const pad = cw * 0.13, gw = (cw - pad * 2) / cols, gh = (ch - pad * 1.6) / (rows + 1);
  const win = ['#ffe6a8', '#ffe6a8', '#cfe2ee', '#9fb6c4', '#2c3a44'];   // warm-lit biased
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const wx = pad + c * gw + gw * 0.2, wy = pad + r * gh + gh * 0.2, ww = gw * 0.6, wh = gh * 0.58;
    x.fillStyle = '#26323c'; x.fillRect(wx - 1.5, wy - 1.5, ww + 3, wh + 3);   // frame
    x.fillStyle = win[Math.floor(Math.random() * win.length)];
    x.fillRect(wx, wy, ww, wh);
  }
  // darker ground-floor / storefront band
  x.fillStyle = 'rgba(0,0,0,0.28)'; x.fillRect(0, ch - gh * 1.2, cw, gh * 1.2);
  const tex = new THREE.CanvasTexture(cv);
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  if (renderer) tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  FACADE_CACHE[key] = tex; return tex;
}

// Painted asphalt texture: dark base + faint speckle, solid edge lines, dashed centre.
function makeRoadTexture(S) {
  const cw = 128, ch = 512;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const base = '#' + new THREE.Color(S.road).getHexString();
  ctx.fillStyle = base; ctx.fillRect(0, 0, cw, ch);
  // subtle speckle for asphalt grain
  for (let i = 0; i < 1400; i++) {
    const v = Math.random() * 0.16 - 0.08;
    ctx.fillStyle = `rgba(${v > 0 ? '255,255,255' : '0,0,0'},${Math.abs(v)})`;
    ctx.fillRect(Math.random() * cw, Math.random() * ch, 1.4, 1.4);
  }
  const line = '#' + new THREE.Color(S.roadLine).getHexString();
  // solid edge lines
  ctx.fillStyle = line;
  ctx.fillRect(cw * 0.085, 0, 4, ch);
  ctx.fillRect(cw * 0.915 - 4, 0, 4, ch);
  // dashed centre line (two dashes per tile)
  const dashW = 5;
  ctx.fillRect(cw / 2 - dashW / 2, ch * 0.10, dashW, ch * 0.30);
  ctx.fillRect(cw / 2 - dashW / 2, ch * 0.60, dashW, ch * 0.30);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, ROAD_LEN / ROAD_TILE);
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  return tex;
}

function buildRoad(S) {
  if (roadGroup) scene.remove(roadGroup);
  roadGroup = new THREE.Group();

  roadTex = makeRoadTexture(S);
  const mat = surf(0xffffff, { map: roadTex });

  // ribbon of ROAD_ROWS rows × 2 edge columns; vertices are filled per-frame in
  // world space from the path buffer (here we only allocate + index it).
  const verts = new Float32Array(ROAD_ROWS * 2 * 3);
  const uvs = new Float32Array(ROAD_ROWS * 2 * 2);
  const idx = [];
  for (let r = 0; r < ROAD_ROWS; r++) {
    const v = (r / (ROAD_ROWS - 1)) * (ROAD_LEN / ROAD_TILE);
    const a = r * 2, b = r * 2 + 1;
    uvs[a * 2] = 0; uvs[a * 2 + 1] = v;
    uvs[b * 2] = 1; uvs[b * 2 + 1] = v;
    if (r < ROAD_ROWS - 1) {
      const c = (r + 1) * 2, d = (r + 1) * 2 + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  roadGeo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  roadGeo.setIndex(idx);

  roadMesh = new THREE.Mesh(roadGeo, mat);
  roadMesh.receiveShadow = true;
  roadMesh.frustumCulled = false;
  roadGroup.add(roadMesh);
  scene.add(roadGroup);
}

// Lay the ribbon along the path each frame, banked, in absolute world coordinates.
function updateRoadRibbon() {
  if (!roadGeo) return;
  const pos = roadGeo.attributes.position.array;
  const hw = ROAD_WIDTH / 2;
  const s0 = State.s - ROAD_BACK;
  for (let r = 0; r < ROAD_ROWS; r++) {
    const s = s0 + (r / (ROAD_ROWS - 1)) * ROAD_LEN;
    const sp = samplePath(s);
    const lift = hw * Math.sin(sp.bank);
    const a = r * 2 * 3, b = (r * 2 + 1) * 3;
    pos[a] = sp.x + sp.nx * hw; pos[a + 1] = sp.y + lift + 0.05; pos[a + 2] = sp.z + sp.nz * hw;
    pos[b] = sp.x - sp.nx * hw; pos[b + 1] = sp.y - lift + 0.05; pos[b + 2] = sp.z - sp.nz * hw;
  }
  roadGeo.attributes.position.needsUpdate = true;
  roadGeo.computeVertexNormals();
  if (roadTex) roadTex.offset.y = State.s / ROAD_TILE;
}

// --- River bridges: the road humps up over a river; pooled structures placed at crossings ---
let bridgeGroup = null, bridges = [];
function buildBridges(S) {
  if (bridgeGroup) scene.remove(bridgeGroup);
  bridgeGroup = new THREE.Group(); scene.add(bridgeGroup);
  bridges = [];
  const water = () => surf(0x5fa8d6, { transparent: true, opacity: 0.85 });
  const stone = MAT.matte(0xb9b3a4), rail = MAT.matte(0xcdd2d8);
  const hw = ROAD_WIDTH / 2;
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    // river water crossing perpendicular to the road (long in local X), below deck
    const riv = new THREE.Mesh(new THREE.PlaneGeometry(120, 30), water());
    riv.rotation.x = -Math.PI / 2; riv.position.y = 0.3; g.add(riv);
    // banks
    [-1, 1].forEach(sn => { const b = new THREE.Mesh(new THREE.BoxGeometry(120, 1.2, 4), stone); b.position.set(0, 0.4, sn * 17); g.add(b); });
    // deck side beams (the road rests on these) + railings, running along the road (local Z)
    [-1, 1].forEach(sn => {
      const beam = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 30), stone);
      beam.position.set(sn * (hw + 0.2), BRIDGE_H - 0.4, 0); beam.castShadow = true; g.add(beam);
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, 30), rail);
      r.position.set(sn * (hw + 0.2), BRIDGE_H + 0.5, 0); g.add(r);
      for (let p = -1; p <= 1; p++) {        // rail posts
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.0, 0.34), rail);
        post.position.set(sn * (hw + 0.2), BRIDGE_H + 0.4, p * 9); g.add(post);
      }
    });
    // support pillars from the riverbed up to the deck
    [-9, 9].forEach(z => [-1, 1].forEach(sn => {
      const pil = new THREE.Mesh(new THREE.BoxGeometry(1.3, BRIDGE_H, 1.3), stone);
      pil.position.set(sn * (hw - 1), BRIDGE_H / 2, z); pil.castShadow = true; g.add(pil);
    }));
    g.visible = false;
    bridgeGroup.add(g); bridges.push(g);
  }
}
function updateBridges() {
  if (!bridges.length) return;
  const from = State.s - 30, to = State.s + ROAD_FWD;
  const k0 = Math.floor(from / RIVER_SPACING) - 1, k1 = Math.ceil(to / RIVER_SPACING) + 1;
  let idx = 0;
  for (let k = k0; k <= k1 && idx < bridges.length; k++) {
    const c = riverCenter(k);
    if (c < from || c > to) continue;
    const sp = samplePath(c), g = bridges[idx++];
    g.visible = true;
    g.position.set(sp.x, baseElevationAt(c), sp.z);
    g.rotation.y = Math.atan2(sp.hx, sp.hz);
  }
  for (; idx < bridges.length; idx++) bridges[idx].visible = false;
}

function buildScenery(S) {
  sceneryPool.forEach(o => scene.remove(o.mesh));
  sceneryPool = [];

  // A mixed scenic population spread along the route on both sides, recycled
  // ahead of the car. Everything sits on the terrain via heightAt().
  const q = Settings.quality;
  const treeN = q === 'low' ? 70 : (q === 'high' ? 150 : 120);   // density scales with quality
  const recipe = [];
  for (let i = 0; i < treeN; i++) recipe.push('tree');
  for (let i = 0; i < 22; i++) recipe.push('rock');
  for (let i = 0; i < 26; i++) recipe.push('fence');    // close to the shoulder
  for (let i = 0; i < 8; i++) recipe.push('sign');
  for (let i = 0; i < 6; i++) recipe.push('lake');
  for (let i = 0; i < 10; i++) recipe.push('field');
  for (let i = 0; i < 9; i++) recipe.push('barricade');  // smashable, on/near the road
  // more smashables
  for (let i = 0; i < 12; i++) recipe.push('haybale');
  for (let i = 0; i < 12; i++) recipe.push('crate');
  for (let i = 0; i < 9; i++) recipe.push('barrel');
  for (let i = 0; i < 8; i++) recipe.push('mailbox');
  for (let i = 0; i < 12; i++) recipe.push('bush');
  // authored landmarks (roadside structures + overpasses)
  for (let i = 0; i < 7; i++) recipe.push('building');
  for (let i = 0; i < 2; i++) recipe.push('church');
  for (let i = 0; i < 3; i++) recipe.push('pizza');
  for (let i = 0; i < 3; i++) recipe.push('watertank');
  for (let i = 0; i < 3; i++) recipe.push('park');
  // roadside commerce
  for (let i = 0; i < 9; i++) recipe.push('stall');        // single smashable stall
  for (let i = 0; i < 3; i++) recipe.push('market');       // a cluster set-piece
  for (let i = 0; i < 2; i++) recipe.push('fuelstation');
  // launch ramps + road-surface hazards (grip modifiers)
  for (let i = 0; i < 5; i++) recipe.push('ramp');
  for (let i = 0; i < 5; i++) recipe.push('oil');
  for (let i = 0; i < 6; i++) recipe.push('puddle');
  for (let i = 0; i < 5; i++) recipe.push('mud');

  const N = recipe.length;
  recipe.forEach((kind, i) => {
    const mesh = (kind === 'tree') ? makeSceneryObject(S) : makeScenicProp(kind, S);
    scene.add(mesh);
    const side = (i % 2 === 0) ? 1 : -1;
    let off;
    if (kind === 'fence') off = ROAD_WIDTH / 2 + 1.6 + Math.random() * 1.2;
    else if (kind === 'sign') off = ROAD_WIDTH / 2 + 2.5 + Math.random() * 1.5;
    // on-road obstacles sit in ONE lane (side ±1 picks L/R) so the other lane is clear to dodge
    else if (kind === 'barricade') off = ROAD_WIDTH / 4 + (Math.random() - 0.5) * 0.6;
    else if (kind === 'haybale' || kind === 'crate') off = ROAD_WIDTH / 4 + (Math.random() - 0.5) * 1.3;
    else if (kind === 'barrel') off = ROAD_WIDTH / 4 + (Math.random() - 0.5) * 1.3;
    else if (kind === 'mailbox') off = ROAD_WIDTH / 2 + 1.4 + Math.random() * 1.2;
    else if (kind === 'bush') off = ROAD_WIDTH / 2 + 2 + Math.random() * 30;
    else if (kind === 'bridge') off = 0;               // overpass: spans the road
    else if (kind === 'building') off = ROAD_WIDTH / 2 + 16 + Math.random() * 16;   // clusters sit well back
    else if (kind === 'pizza' || kind === 'church') off = ROAD_WIDTH / 2 + 9 + Math.random() * 14;
    else if (kind === 'watertank' || kind === 'park') off = ROAD_WIDTH / 2 + 12 + Math.random() * 22;
    else if (kind === 'stall') off = ROAD_WIDTH / 2 + 2.2 + Math.random() * 2.5;       // right on the verge
    else if (kind === 'market') off = ROAD_WIDTH / 2 + 7 + Math.random() * 6;          // cluster set back a touch
    else if (kind === 'fuelstation') off = ROAD_WIDTH / 2 + 8 + Math.random() * 8;
    else if (kind === 'ramp') off = ROAD_WIDTH / 4 + (Math.random() - 0.5) * 1.0;       // in one lane
    else if (kind === 'oil' || kind === 'puddle' || kind === 'mud') off = (Math.random() - 0.5) * (ROAD_WIDTH - 3); // anywhere across the road
    else if (kind === 'lake') off = 38 + Math.random() * 45;
    else if (kind === 'field') off = 26 + Math.random() * 55;
    else if (kind === 'rock') off = 12 + Math.random() * 60;
    else off = 11 + Math.random() * 70;                // trees: near to far clusters
    const s = (i / N) * SCENERY_SPAN + Math.random() * 6;
    // collision radius (0 = pass-through) + whether it shatters when smashed fast
    const CR = { tree: 1.3, rock: 1.4, fence: 1.7, sign: 0.5, barricade: 1.9,
                 haybale: 1.3, crate: 1.0, barrel: 0.8, mailbox: 0.5, bush: 1.1, lake: 0, field: 0,
                 building: 4, church: 3.5, pizza: 3, watertank: 1.8, park: 0, bridge: 0,
                 stall: 1.6, market: 4.5, fuelstation: 2.6 };           // ramp/oil/puddle/mud = 0 (drive over)
    const BREAK = { tree: true, fence: true, sign: true, barricade: true,
                    haybale: true, crate: true, barrel: true, mailbox: true, bush: true, stall: true };
    // road-surface hazards: radius + grip/drag behaviour applied while the car is over them
    const HAZ = { oil: 3.0, puddle: 3.2, mud: 3.4, ramp: 2.6 };
    sceneryPool.push({ mesh, kind, side, off, s, spin: Math.random() * Math.PI,
                       cr: CR[kind] || 0, breakable: !!BREAK[kind], broken: false, breakT: 0,
                       hazard: HAZ[kind] ? kind : null, hr: HAZ[kind] || 0 });
  });
}

const SCENERY_SPAN = ROAD_FWD + 80;

// rocks / fences / road-signs / lakes / field patches (toon-shaded)
function makeScenicProp(kind, S) {
  const g = new THREE.Group();
  if (kind === 'rock') {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), MAT.matte(0x9aa0a6));
    rock.scale.set(1 + Math.random(), 0.6 + Math.random() * 0.5, 1 + Math.random());
    rock.position.y = 0.4; rock.castShadow = true; g.add(rock);
  } else if (kind === 'fence') {
    const wood = MAT.matte(0xb39068);
    for (let p = 0; p < 3; p++) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), wood);
      post.position.set((p - 1) * 1.4, 0.5, 0); g.add(post);
    }
    [0.7, 0.35].forEach(yy => { const rail = new THREE.Mesh(new THREE.BoxGeometry(2.9, 0.1, 0.08), wood); rail.position.y = yy; g.add(rail); });
  } else if (kind === 'sign') {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 8), MAT.matte(0x8a8f96));
    post.position.y = 1.1; g.add(post);
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.7, 0.08), MAT.matte(0xd8a23c));
    board.position.y = 1.9; g.add(board);
  } else if (kind === 'barricade') {
    // red/white striped road barrier on two legs (smash through it at speed)
    [-1.5, 1.5].forEach(x => { const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), MAT.matte(0x3a3d42)); leg.position.set(x, 0.55, 0); g.add(leg); });
    for (let s = 0; s < 5; s++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.42, 0.18), MAT.matte(s % 2 ? 0xeae6da : 0xc23030));
      seg.position.set((s - 2) * 0.74, 1.05, 0); seg.castShadow = true; g.add(seg);
    }
  } else if (kind === 'haybale') {
    const bale = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.4, 14), MAT.matte(0xd9c172));
    bale.rotation.z = Math.PI / 2; bale.position.y = 0.7; bale.castShadow = true; g.add(bale);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.71, 0.71, 1.42, 14), MAT.matte(0xc7ad5c));
    cap.rotation.z = Math.PI / 2; cap.position.y = 0.7; cap.scale.set(0.55, 1, 0.55); g.add(cap);
  } else if (kind === 'crate') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), MAT.matte(0xb07a44));
    box.position.y = 0.5; box.castShadow = true; g.add(box);
    [-0.5, 0.5].forEach(yy => { const r = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.12, 1.04), MAT.matte(0x8a5e34)); r.position.y = 0.5 + yy * 0.9; g.add(r); });
  } else if (kind === 'barrel') {
    const c = [0xc23030, 0x2f63b8, 0x4a8c4a][Math.floor(Math.random() * 3)];
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.1, 14), MAT.matte(c));
    b.position.y = 0.55; b.castShadow = true; g.add(b);
    [0.35, 0.75].forEach(yy => { const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.08, 14), MAT.matte(0xcdd2d8)); ring.position.y = yy; g.add(ring); });
  } else if (kind === 'mailbox') {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), MAT.matte(0x7a5a40));
    post.position.y = 0.55; g.add(post);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.6), MAT.matte(0xb5413a));
    box.position.set(0, 1.15, 0.1); box.castShadow = true; g.add(box);
  } else if (kind === 'bush') {
    const col = (s) => MAT.matte(s);
    [[0, 0.5, 0, 0.7], [0.4, 0.45, 0.1, 0.5], [-0.35, 0.4, -0.1, 0.45]].forEach(([x, y, z, r]) => {
      const b = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), col(0x6fa44f));
      b.position.set(x, y, z); b.castShadow = true; g.add(b);
    });
  } else if (kind === 'building') {
    // a block of 2–4 buildings (mix of towers / mid-rise / shops) → reads as a town
    const cityCols = [0xcbb89a, 0xb7c0c8, 0xd8c3a4, 0xb0bcae, 0xd2c0b0, 0xa9b8c4, 0xc4a98c];
    const roofCol = 0x57514a;
    const n = 2 + Math.floor(Math.random() * 3);
    // pre-pick sizes so the cluster can be CENTRED on the anchor (never grows onto the road)
    const specs = [];
    for (let b = 0; b < n; b++) {
      const tall = Math.random() < 0.4;
      specs.push({ tall, w: 3 + Math.random() * 2.5, d: 3 + Math.random() * 2.5,
                   h: tall ? 10 + Math.random() * 10 : 4 + Math.random() * 4 });
    }
    const totalW = specs.reduce((s, p) => s + p.w + 0.8, 0) - 0.8;
    let bx = -totalW / 2;
    for (let b = 0; b < n; b++) {
      const { tall, w, d, h } = specs[b];
      const base = cityCols[Math.floor(Math.random() * cityCols.length)];
      const cols = tall ? 3 : 4, rows = tall ? 9 : (h < 6 ? 2 : 4);
      const tex = makeFacadeTexture(base, cols, rows);
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), surf(0xffffff, { map: tex }));
      bx += w / 2;
      wall.position.set(bx, h / 2, (Math.random() - 0.5) * 2.5); wall.castShadow = true; g.add(wall);
      // parapet rim + rooftop unit + (towers) antenna
      const par = new THREE.Mesh(new THREE.BoxGeometry(w + 0.25, 0.5, d + 0.25), MAT.matte(roofCol));
      par.position.set(bx, h + 0.2, wall.position.z); g.add(par);
      const unit = new THREE.Mesh(new THREE.BoxGeometry(w * 0.4, 0.7, d * 0.4), MAT.matte(0x8a8f96));
      unit.position.set(bx + w * 0.15, h + 0.6, wall.position.z); g.add(unit);
      if (tall) {
        const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.2, 6), MAT.matte(0x6b6f74));
        ant.position.set(bx - w * 0.2, h + 1.6, wall.position.z); g.add(ant);
      }
      bx += w / 2 + 0.8;
    }
  } else if (kind === 'church') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 8), MAT.matte(0xeae2d2));
    wall.position.y = 2.5; wall.castShadow = true; g.add(wall);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 3.6, 2.4, 4), MAT.matte(0x7a4a3a));
    roof.rotation.y = Math.PI / 4; roof.position.y = 6.2; roof.scale.z = 2.2; g.add(roof);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2, 8, 2), MAT.matte(0xe2dac8));
    tower.position.set(0, 4, 4.2); tower.castShadow = true; g.add(tower);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1.5, 3, 4), MAT.matte(0x6a4030));
    spire.rotation.y = Math.PI / 4; spire.position.set(0, 9.5, 4.2); g.add(spire);
    const crossV = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.4, 0.18), MAT.matte(0xd8c98c)); crossV.position.set(0, 11.6, 4.2); g.add(crossV);
    const crossH = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.18), MAT.matte(0xd8c98c)); crossH.position.set(0, 11.7, 4.2); g.add(crossH);
  } else if (kind === 'pizza') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 5), MAT.matte(0xe7d9c0));
    wall.position.y = 2; wall.castShadow = true; g.add(wall);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.5, 5.4), MAT.matte(0x8a5a3c)); roof.position.y = 4.2; g.add(roof);
    // red sign board with white "slice" triangle
    const sign = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.4, 0.2), MAT.matte(0xc23030));
    sign.position.set(0, 5.4, 2.4); g.add(sign);
    const slice = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.0, 3), MAT.matte(0xf2c14e));
    slice.rotation.z = Math.PI; slice.position.set(-1.4, 5.4, 2.55); g.add(slice);
    // red/white striped awning
    for (let s = 0; s < 6; s++) { const a = new THREE.Mesh(new THREE.BoxGeometry(1, 0.12, 1.2), MAT.matte(s % 2 ? 0xeae6da : 0xc23030)); a.position.set((s - 2.5) * 1, 3.2, 2.8); a.rotation.x = 0.5; g.add(a); }
  } else if (kind === 'watertank') {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3, 16), MAT.matte(0x9fb3bd));
    tank.position.y = 7; tank.castShadow = true; g.add(tank);
    const top = new THREE.Mesh(new THREE.ConeGeometry(2.3, 1.2, 16), MAT.matte(0x7d949f)); top.position.y = 9; g.add(top);
    [[1.4, 1.4], [-1.4, 1.4], [1.4, -1.4], [-1.4, -1.4]].forEach(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 5.5, 6), MAT.matte(0x6b6f74));
      leg.position.set(x, 2.75, z); leg.rotation.x = (z > 0 ? 1 : -1) * 0.12; leg.rotation.z = (x > 0 ? -1 : 1) * 0.12; g.add(leg);
    });
  } else if (kind === 'park') {
    const lawn = new THREE.Mesh(new THREE.CircleGeometry(9, 20), MAT.matte(0x8fc47a));
    lawn.rotation.x = -Math.PI / 2; lawn.position.y = 0.05; g.add(lawn);
    for (let t = 0; t < 3; t++) {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 1.6, 6), MAT.matte(0x7a5a40));
      const tx = (Math.random() - 0.5) * 10, tz = (Math.random() - 0.5) * 10;
      trunk.position.set(tx, 0.8, tz); g.add(trunk);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(1.4, 8, 7), MAT.matte(0x6fa44f)); crown.position.set(tx, 2.3, tz); crown.castShadow = true; g.add(crown);
    }
    const bench = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.5), MAT.matte(0x9a6f44)); bench.position.set(0, 0.5, 1.5); g.add(bench);
    const back = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 0.12), MAT.matte(0x9a6f44)); back.position.set(0, 0.75, 1.75); g.add(back);
  } else if (kind === 'bridge') {
    // overpass spanning the road; the car drives underneath
    const span = ROAD_WIDTH + 8, deckY = 5.4;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(span, 0.7, 4.5), MAT.matte(0x9a9ea4));
    deck.position.y = deckY; deck.castShadow = true; g.add(deck);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(span, 0.6, 0.3), MAT.matte(0xc9ced6));
    rail.position.set(0, deckY + 0.6, 2.1); g.add(rail);
    const rail2 = rail.clone(); rail2.position.z = -2.1; g.add(rail2);
    [span / 2 - 1.2, -span / 2 + 1.2].forEach(x => {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.6, deckY, 3.5), MAT.matte(0x8a8e94));
      pier.position.set(x, deckY / 2, 0); pier.castShadow = true; g.add(pier);
    });
  } else if (kind === 'lake') {
    const water = new THREE.Mesh(new THREE.CircleGeometry(7 + Math.random() * 5, 22),
      surf(0x73b6d6, { transparent: true, opacity: 0.82 }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.06; g.add(water);
  } else if (kind === 'stall') {
    // roadside market stall — striped awning, goods on the counter (smashable)
    const awC = [0xc23030, 0x2f8f4a, 0x2f63b8, 0xe8a13a][Math.floor(Math.random() * 4)];
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.1), MAT.matte(0xb5895c));
    counter.position.y = 0.45; counter.castShadow = true; g.add(counter);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.12, 1.2), MAT.matte(0xd8b483));
    top.position.y = 0.96; g.add(top);
    [-1.1, 1.1].forEach(x => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 2.2, 0.1), MAT.matte(0x8a6a44)); p.position.set(x, 1.1, -0.45); g.add(p); });
    for (let s2 = 0; s2 < 5; s2++) { const st = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 1.4), MAT.matte(s2 % 2 ? 0xf4f1e4 : awC)); st.position.set((s2 - 2) * 0.5, 2.1, 0.05); st.rotation.x = 0.32; st.castShadow = true; g.add(st); }
    const fc = [0xe8534e, 0xf2c14e, 0x6fae4f];
    for (let s2 = 0; s2 < 6; s2++) { const f = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5), MAT.matte(fc[s2 % 3])); f.position.set((Math.random() - 0.5) * 1.9, 1.08, (Math.random() - 0.5) * 0.7); g.add(f); }
  } else if (kind === 'market') {
    // a cluster of three stalls in a row + crates — instant village-market set-piece
    const awC = [0xc23030, 0x2f8f4a, 0x2f63b8];
    [-3, 0, 3].forEach((zz, si) => {
      const counter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.85, 1.0), MAT.matte(0xb5895c));
      counter.position.set(0, 0.42, zz); counter.castShadow = true; g.add(counter);
      const awn = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 1.2), MAT.matte(awC[si % 3]));
      awn.position.set(0, 1.9, zz + 0.1); awn.rotation.x = 0.3; awn.castShadow = true; g.add(awn);
      [-0.9, 0.9].forEach(x => { const p = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.9, 0.1), MAT.matte(0x8a6a44)); p.position.set(x, 0.95, zz - 0.4); g.add(p); });
    });
    for (let c = 0; c < 3; c++) { const cr = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), MAT.matte(0xb07a44)); cr.position.set(1.5, 0.35, (c - 1) * 2.2); cr.castShadow = true; g.add(cr); }
  } else if (kind === 'fuelstation') {
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 6), MAT.matte(0xe7ebf0));
    canopy.position.y = 4; canopy.castShadow = true; g.add(canopy);
    const band = new THREE.Mesh(new THREE.BoxGeometry(5.05, 0.26, 6.05), MAT.matte(0xc23030)); band.position.y = 3.78; g.add(band);
    [[-2.2, -2.6], [2.2, -2.6], [-2.2, 2.6], [2.2, 2.6]].forEach(([x, z]) => { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4, 8), MAT.matte(0x9aa0a6)); p.position.set(x, 2, z); g.add(p); });
    [-1, 1].forEach(s2 => {
      const pump = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.5, 0.5), MAT.matte(0xcdd2d8)); pump.position.set(s2 * 1.2, 0.75, 0); pump.castShadow = true; g.add(pump);
      const scr = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.05), MAT.matte(0x2c3e4c)); scr.position.set(s2 * 1.2, 1.1, 0.27); g.add(scr);
    });
  } else if (kind === 'ramp') {
    // launch wedge in one lane — rises along the driving direction (local +z after rotate)
    const rg = new THREE.Group(); rg.rotation.y = -Math.PI / 2;
    const shape = new THREE.Shape(); shape.moveTo(0, 0); shape.lineTo(4.6, 0); shape.lineTo(4.6, 1.5); shape.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 4.6, bevelEnabled: false }); geo.translate(0, 0, -2.3);
    const ramp = new THREE.Mesh(geo, MAT.matte(0x44474f)); ramp.castShadow = true; ramp.receiveShadow = true; rg.add(ramp);
    const chev = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 4.4), new THREE.MeshBasicMaterial({ color: 0xf4d23c }));
    chev.position.set(4.55, 0.78, 0); chev.rotation.z = Math.atan2(1.5, 4.6); rg.add(chev);
    g.add(rg);
  } else if (kind === 'oil') {
    const d = new THREE.Mesh(new THREE.CircleGeometry(2.8, 16), new THREE.MeshBasicMaterial({ color: 0x141418 }));
    d.rotation.x = -Math.PI / 2; d.position.y = 0.03; d.scale.set(1.2, 1, 0.8); g.add(d);
    const sheen = new THREE.Mesh(new THREE.CircleGeometry(1.5, 14), new THREE.MeshBasicMaterial({ color: 0x2c2c44 }));
    sheen.rotation.x = -Math.PI / 2; sheen.position.y = 0.04; g.add(sheen);
  } else if (kind === 'puddle') {
    const d = new THREE.Mesh(new THREE.CircleGeometry(3.0, 18), surf(0x6fb4d8, { transparent: true, opacity: 0.68 }));
    d.rotation.x = -Math.PI / 2; d.position.y = 0.03; d.scale.set(1.3, 1, 0.9); g.add(d);
  } else if (kind === 'mud') {
    const d = new THREE.Mesh(new THREE.CircleGeometry(3.2, 16), MAT.matte(0x5a4632));
    d.rotation.x = -Math.PI / 2; d.position.y = 0.03; d.scale.set(1.2, 1, 0.9); g.add(d);
    const sp = new THREE.Mesh(new THREE.CircleGeometry(1.8, 14), MAT.matte(0x6e5740));
    sp.rotation.x = -Math.PI / 2; sp.position.y = 0.04; g.add(sp);
  } else { // field patch — a flat tinted disc that reads as a meadow/crop field
    const tint = new THREE.Color(S.ground).offsetHSL((Math.random() - 0.5) * 0.04, 0.05, (Math.random() - 0.5) * 0.06);
    const patch = new THREE.Mesh(new THREE.CircleGeometry(10 + Math.random() * 8, 18), MAT.matte(tint.getHex()));
    patch.rotation.x = -Math.PI / 2; patch.position.y = 0.04; g.add(patch);
  }
  return g;
}

function makeSceneryObject(S) {
  const g = new THREE.Group();
  const style = S.treeStyle;
  if (style === 'cactus') {
    const mat = MAT.matte(S.treeColor);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 4.5, 7), mat);
    trunk.position.y = 2.25; trunk.castShadow = true; g.add(trunk);
    for (let a = 0; a < 2; a++) {
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.8, 6), mat);
      arm.position.set(a === 0 ? 0.7 : -0.7, 2.6, 0);
      arm.rotation.z = a === 0 ? -0.6 : 0.6; arm.castShadow = true; g.add(arm);
    }
  } else if (style === 'snowy') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.6, 6),
      MAT.matte(0x8a6a52));
    trunk.position.y = 0.8; trunk.castShadow = true; g.add(trunk);
    const coneMat = MAT.matte(S.treeColor);
    const snowMat = MAT.matte(0xf4f8fc);
    for (let c = 0; c < 3; c++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(2.0 - c * 0.4, 1.8, 8), coneMat);
      cone.position.y = 2 + c * 1.1; cone.castShadow = true; g.add(cone);
      const snow = new THREE.Mesh(new THREE.ConeGeometry(2.05 - c * 0.4, 0.5, 8), snowMat);
      snow.position.y = 2.7 + c * 1.1; g.add(snow);
    }
  } else if (style === 'blossom') {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 2.4, 6),
      MAT.matte(0x9a7256));
    trunk.position.y = 1.2; trunk.castShadow = true; g.add(trunk);
    const foliage = new THREE.Mesh(new THREE.SphereGeometry(2.0, 8, 7),
      MAT.matte(S.treeColor));
    foliage.position.y = 3.4; foliage.castShadow = true; g.add(foliage);
    const blossom = new THREE.Mesh(new THREE.SphereGeometry(1.5, 7, 6),
      MAT.matte(0xf2c2d6));
    blossom.position.set(0.6, 4.0, 0.4); g.add(blossom);
  } else {
    // leafy (summer/monsoon)
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 2.6, 6),
      MAT.matte(0x7a5a40));
    trunk.position.y = 1.3; trunk.castShadow = true; g.add(trunk);
    const c1 = new THREE.Mesh(new THREE.SphereGeometry(2.1, 8, 7),
      MAT.matte(S.treeColor));
    c1.position.y = 3.6; c1.castShadow = true; g.add(c1);
    const c2 = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 7),
      MAT.matte(S.treeColor));
    c2.position.set(1.2, 3.0, 0.5); c2.castShadow = true; g.add(c2);
  }
  const s = 0.8 + Math.random() * 0.8;
  g.scale.set(s, s, s);
  return g;
}

// ---------------------------------------------------------------------------
// Interactable props (mission targets you drive into / over / through)
// ---------------------------------------------------------------------------
let interactables = [];
let propsGroup = null;
// the sequence guarantees the player meets every mission target, then loops
const PROP_SEQUENCE = ['tree', 'cones', 'pond', 'hut', 'ramp', 'tree', 'pond', 'cones', 'ramp', 'hut'];
const PROP_SPACING = 95; // metres between mission props
let splashSystem = null, splashData = null;

function buildInteractables() {
  if (propsGroup) scene.remove(propsGroup);
  propsGroup = new THREE.Group();
  scene.add(propsGroup);
  interactables = [];

  const S = SEASONS[selectedSeason];
  for (let i = 0; i < PROP_SEQUENCE.length; i++) {
    const type = PROP_SEQUENCE[i];
    const item = makeProp(type, S);
    propsGroup.add(item.mesh);
    item.s = 70 + i * PROP_SPACING;                  // arc-length position on the route
    // Cones are a road slalom; everything else is OFF-ROAD — you must leave the
    // asphalt and aim for it out on the terrain.
    const side = i % 2 === 0 ? 1 : -1;
    if (type === 'cones') item.lane = (i % 3 - 1) * 3;            // -3..3, on road
    else item.lane = side * (16 + (i % 3) * 6);                   // 16..28 m off-road
    interactables.push(item);
  }
  positionProps();
  buildSplash();
}

function makeProp(type, S) {
  const g = new THREE.Group();
  let radius = 2.5, kind = type;

  if (type === 'tree') {
    // an oversized landmark tree
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.85, 5, 8),
      MAT.matte(0x6e4f38));
    trunk.position.y = 2.5; trunk.castShadow = true; g.add(trunk);
    const foliageColor = S.treeStyle === 'snowy' ? 0x9fb4ad : 0x6fa44f;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(3.6, 10, 9),
      MAT.matte(foliageColor));
    crown.position.y = 6.2; crown.castShadow = true; g.add(crown);
    if (S.treeStyle === 'snowy') {
      const snow = new THREE.Mesh(new THREE.SphereGeometry(3.7, 10, 9, 0, Math.PI * 2, 0, Math.PI * 0.45),
        MAT.matte(0xf4f8fc));
      snow.position.y = 6.4; g.add(snow);
    }
    radius = 3.2;
  } else if (type === 'hut') {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(5, 3.4, 5),
      MAT.matte(0xb5895c));
    wall.position.y = 1.7; wall.castShadow = true; g.add(wall);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.4, 4),
      MAT.matte(0x8a5a3c));
    roof.position.y = 4.6; roof.rotation.y = Math.PI / 4; roof.castShadow = true; g.add(roof);
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.1, 0.2),
      MAT.matte(0x5e3d28));
    door.position.set(0, 1.05, 2.55); g.add(door);
    radius = 3.6;
  } else if (type === 'pond') {
    const water = new THREE.Mesh(new THREE.CircleGeometry(6.5, 28),
      surf(0x6fb4d8, { transparent: true, opacity: 0.82 }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.04; g.add(water);
    const rim = new THREE.Mesh(new THREE.RingGeometry(6.5, 7.4, 28),
      MAT.matte(S.groundEdge));
    rim.rotation.x = -Math.PI / 2; rim.position.y = 0.03; g.add(rim);
    radius = 6.0;
  } else if (type === 'ramp') {
    // a wedge ramp / hill you launch off
    const shape = new THREE.Shape();
    shape.moveTo(0, 0); shape.lineTo(10, 0); shape.lineTo(10, 3.2); shape.lineTo(0, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 9, bevelEnabled: false });
    geo.translate(0, 0, -4.5);
    const ramp = new THREE.Mesh(geo, MAT.matte(S.groundEdge));
    ramp.rotation.y = -Math.PI / 2; // slope rises toward +z (driving direction)
    ramp.position.y = 0; ramp.castShadow = true; ramp.receiveShadow = true;
    g.add(ramp);
    radius = 5.5;
  } else if (type === 'cones') {
    const coneMat = MAT.matte(0xe07a3c);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf4f1e4 });
    g.userData.cones = [];
    for (let c = 0; c < 6; c++) {
      const cg = new THREE.Group();
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 10), coneMat);
      cone.position.y = 0.6; cone.castShadow = true; cg.add(cone);
      const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, 0.25, 10), stripeMat);
      stripe.position.y = 0.65; cg.add(stripe);
      cg.position.set((c % 2 === 0 ? -1.6 : 1.6), 0, (c - 2.5) * 1.6);
      cg.userData.fallen = false;
      g.add(cg); g.userData.cones.push(cg);
    }
    radius = 4.5;
  }

  return { mesh: g, type, kind, radius, hit: false, lane: 0, z: 0 };
}

// place each prop at (arc-length s, lateral lane) in world space, sat on terrain
function placeProp(o) {
  const sp = samplePath(o.s);
  const wx = sp.x + sp.nx * o.lane;
  const wz = sp.z + sp.nz * o.lane;
  const onRoad = o.type === 'cones';
  // |o.lane| is the perpendicular distance from the centerline at o.s; reuse it instead
  // of a full nearestPathInfo scan (placeProp runs every frame for each prop).
  const wy = onRoad ? sp.y : heightFromPath(sp.y, Math.abs(o.lane), wx, wz);
  o.mesh.position.set(wx, wy, wz);
  o.head = Math.atan2(sp.hx, sp.hz);
  o.mesh.rotation.y = o.head;
  o.wx = wx; o.wz = wz;                              // cache for collision tests
}
function positionProps() {
  interactables.forEach(placeProp);
}

function buildSplash() {
  if (splashSystem) { scene.remove(splashSystem); splashSystem = null; }
  const N = 120;
  const positions = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) positions[i * 3 + 1] = -10; // park below
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xbfe2f2, size: 0.4, transparent: true, opacity: 0.9, depthWrite: false });
  splashSystem = new THREE.Points(geo, mat);
  splashSystem.frustumCulled = false;
  scene.add(splashSystem);
  splashData = { positions, vel, count: N, next: 0, active: false };
}

function triggerSplash(x, z) {
  if (!splashData) return;
  const { positions, vel } = splashData;
  for (let k = 0; k < 40; k++) {
    const i = splashData.next; splashData.next = (splashData.next + 1) % splashData.count;
    const i3 = i * 3;
    positions[i3] = x + (Math.random() - 0.5) * 3;
    positions[i3 + 1] = 0.5;
    positions[i3 + 2] = z + (Math.random() - 0.5) * 3;
    vel[i3] = (Math.random() - 0.5) * 6;
    vel[i3 + 1] = 4 + Math.random() * 6;
    vel[i3 + 2] = (Math.random() - 0.5) * 6;
  }
  splashData.active = true;
}

function updateSplash(dt) {
  if (!splashData || !splashData.active) return;
  const { positions, vel, count } = splashData;
  let any = false;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    if (positions[i3 + 1] <= -5) continue;
    positions[i3] += vel[i3] * dt;
    positions[i3 + 1] += vel[i3 + 1] * dt;
    positions[i3 + 2] += vel[i3 + 2] * dt;
    vel[i3 + 1] -= 18 * dt;
    if (positions[i3 + 1] < 0) positions[i3 + 1] = -10;
    else any = true;
  }
  splashData.active = any;
  splashSystem.geometry.attributes.position.needsUpdate = true;
}

function updateInteractables(dt) {
  if (!vehicleGroup) return;
  const carZ = vehicleGroup.position.z;
  const carX = vehicleGroup.position.x;
  const span = PROP_SEQUENCE.length * PROP_SPACING;
  const moving = Math.abs(State.speed) > 4;

  interactables.forEach(o => {
    // recycle behind the player (arc-length based)
    if (o.s < State.s - 45) {
      o.s += span;
      o.hit = false; o.broken = false; o.breakT = 0;
      o.mesh.scale.set(1, 1, 1); o.mesh.rotation.set(0, 0, 0); o.mesh.visible = true;
      if (o.type === 'cones' && o.mesh.userData.cones) {
        o.mesh.userData.cones.forEach(cg => { cg.rotation.set(0, 0, 0); cg.userData.fallen = false; });
      }
    }
    placeProp(o);

    // a smashed tree/hut collapses: flatten, topple, sink, then vanish
    if (o.broken) {
      o.breakT += dt;
      const k = Math.min(1, o.breakT * 2.5);
      o.mesh.scale.set(1 - k * 0.4, Math.max(0.12, 1 - k * 0.95), 1 - k * 0.4);
      o.mesh.rotation.z = k * 1.3;
      o.mesh.position.y -= k * 0.6;
      if (o.breakT > 1.4) o.mesh.visible = false;
      return;
    }

    const dx = carX - o.wx;
    const dz = carZ - o.wz;
    const dist = Math.hypot(dx, dz);

    if (o.type === 'ramp') {
      // needs a committed run-up — hit it slow and you barely hop
      if (dist < o.radius && State.speed > 11 && State.jumpY < 0.3) {
        State.vy = Math.min(17, 6 + State.speed * 0.55);
      }
    } else if (o.type === 'pond') {
      // must actually cross it — accumulate time spent in the water
      if (dist < o.radius && moving) {
        if (!o.wet) { o.wet = true; playSplash(); }   // splash on entry
        State.pondTime += dt;
        triggerSplash(carX, carZ);
        State.speed *= (1 - dt * 0.8); // water drag — you must commit to the crossing
        if (State.pondTime >= 0.8) Missions.complete('pond');
      } else if (o.wet && dist > o.radius + 1) {
        o.wet = false;                                // reset so re-entry splashes again
      }
    } else if (o.type === 'cones') {
      if (dist < o.radius + 1 && moving && o.mesh.userData.cones) {
        const ch = Math.cos(o.head), sh = Math.sin(o.head);
        o.mesh.userData.cones.forEach(cg => {
          // rotate the cone's local offset into world space (Y rotation)
          const cgx = o.wx + ch * cg.position.x + sh * cg.position.z;
          const cgz = o.wz - sh * cg.position.x + ch * cg.position.z;
          if (!cg.userData.fallen && Math.hypot(carX - cgx, carZ - cgz) < 2.0) {
            cg.userData.fallen = true;
            cg.rotation.z = (Math.random() - 0.5) * 2;
            cg.rotation.x = Math.PI / 2 * (Math.random() > 0.5 ? 1 : -1) * 0.8;
            playThud(0.35);
          }
        });
        // only counts once EVERY cone in the set is down
        const downCount = o.mesh.userData.cones.filter(cg => cg.userData.fallen).length;
        const total = o.mesh.userData.cones.length;
        window.__coneProg = downCount + '/' + total;
        if (downCount === total && !o.hit) { o.hit = true; Missions.complete('cones'); }
      }
    } else if (o.type === 'tree' || o.type === 'hut') {
      if (dist < o.radius && moving && !o.hit) {
        o.hit = true;
        o.broken = true; o.breakT = 0;        // collapse it (see broken animation above)
        addCoins(15);
        Missions.complete(o.type);
        playSmash(o.type);
        // smashing through costs less speed the faster you hit it
        State.speed *= (Math.abs(State.speed) * 3.6 > 50) ? 0.7 : 0.45;
        shakeCamera(0.5, 'roll');
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Particles (snow / rain / petals / dust)
// ---------------------------------------------------------------------------
function buildParticles(S) {
  if (particleSystem) { scene.remove(particleSystem); particleSystem = null; }
  if (rainStreaks) { scene.remove(rainStreaks); rainStreaks = null; }
  particleData = null;
  if (!S.particles) return;

  const type = S.particles;
  const qMul = Settings.quality === 'low' ? 0.45 : (Settings.quality === 'high' ? 1 : 0.75);
  const COUNT = Math.floor((type === 'rain' ? 1400 : (type === 'snow' ? 1100 : 500)) * qMul);
  const positions = new Float32Array(COUNT * 3);
  const vel = new Float32Array(COUNT * 3);

  for (let i = 0; i < COUNT; i++) {
    resetParticle(positions, vel, i, type, true);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  let color = 0xffffff, size = 0.5;
  if (type === 'snow') { color = 0xfdfeff; size = 0.55; }
  else if (type === 'rain') { color = 0xc8d6df; size = 0.22; }
  else if (type === 'petals') { color = 0xf3c4d8; size = 0.5; }
  else if (type === 'dust') { color = 0xe6cda2; size = 0.4; }

  const mat = new THREE.PointsMaterial({
    color, size, transparent: true,
    opacity: type === 'rain' ? 0.55 : 0.85,
    depthWrite: false
  });

  particleSystem = new THREE.Points(geo, mat);
  particleSystem.frustumCulled = false;
  scene.add(particleSystem);
  particleData = { positions, vel, count: COUNT, type };
}

function resetParticle(pos, vel, i, type, initial) {
  const i3 = i * 3;
  pos[i3] = (Math.random() - 0.5) * 120;
  pos[i3 + 1] = initial ? Math.random() * 60 : 40 + Math.random() * 20;
  pos[i3 + 2] = (Math.random() - 0.3) * 200;
  if (type === 'snow') {
    vel[i3] = (Math.random() - 0.5) * 2; vel[i3 + 1] = -3 - Math.random() * 2; vel[i3 + 2] = (Math.random() - 0.5) * 2;
  } else if (type === 'rain') {
    vel[i3] = -2; vel[i3 + 1] = -55 - Math.random() * 25; vel[i3 + 2] = -8;
  } else if (type === 'petals') {
    vel[i3] = (Math.random() - 0.5) * 4; vel[i3 + 1] = -2 - Math.random() * 1.5; vel[i3 + 2] = (Math.random() - 0.5) * 3;
  } else { // dust
    vel[i3] = (Math.random() - 0.5) * 6; vel[i3 + 1] = -0.5 - Math.random(); vel[i3 + 2] = (Math.random() - 0.5) * 5;
  }
}

function updateParticles(dt) {
  if (!particleData) return;
  const { positions, vel, count, type } = particleData;
  const cx = vehicleGroup ? vehicleGroup.position.x : 0;
  const cz = vehicleGroup ? vehicleGroup.position.z : 0;
  const t = clock.elapsedTime;
  for (let i = 0; i < count; i++) {
    const i3 = i * 3;
    positions[i3] += vel[i3] * dt;
    positions[i3 + 1] += vel[i3 + 1] * dt;
    positions[i3 + 2] += vel[i3 + 2] * dt;
    if (type === 'snow' || type === 'petals') {
      positions[i3] += Math.sin(t * 1.5 + i) * dt * 1.2; // sway
    }
    if (positions[i3 + 1] < 0) {
      positions[i3] = cx + (Math.random() - 0.5) * 120;
      positions[i3 + 1] = 45 + Math.random() * 20;
      positions[i3 + 2] = cz + (Math.random() - 0.2) * 180 + 40;
    }
  }
  particleSystem.geometry.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Vehicle build
// ---------------------------------------------------------------------------
function buildVehicle() {
  glbWheels = [];
  if (vehicleGroup) scene.remove(vehicleGroup);
  vehicleGroup = new THREE.Group();
  vehicleWheels = [];

  if (selectedVehicle === 'car') buildMuscleCar();
  else if (selectedVehicle === 'bike') buildChopper();
  else buildBigRig();

  applyLivery();               // tint the procedural body before the ink outline is cloned
  addVehicleOutline();
  loadVehicleModel();          // swap in a real GLB if one is bundled (re-applies livery on load)

  vehicleGroup.position.set(0, 0, 0);
  scene.add(vehicleGroup);
}

// A wheel = group of [tire, rim] so the loop can spin children[0]/[1].
function makeWheel(r, width) {
  const grp = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 28), MAT.tire());
  tire.rotation.z = Math.PI / 2; tire.castShadow = true; grp.add(tire);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, width + 0.04, 28), MAT.chrome());
  rim.rotation.z = Math.PI / 2; grp.add(rim);
  // 6 spokes carried by the rim so they spin with it
  for (let i = 0; i < 6; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, r * 1.1, 0.07), MAT.chrome());
    spoke.rotation.x = (i / 6) * Math.PI;
    rim.add(spoke);
  }
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.2, r * 0.2, width + 0.08, 12), MAT.dark());
  cap.rotation.z = Math.PI / 2; rim.add(cap);
  return grp;
}
function addWheel(r, width, x, z) {
  const w = makeWheel(r, width);
  w.position.set(x, r, z);
  vehicleGroup.add(w); vehicleWheels.push(w);
  return w;
}
// dark wheel-arch flare to visually seat the wheels into the body
function archFlare(x, z, r, color) {
  const flare = new THREE.Mesh(new THREE.TorusGeometry(r * 1.15, 0.13, 8, 16, Math.PI), MAT.matte(color));
  flare.position.set(x, r + 0.02, z);
  flare.rotation.y = Math.PI / 2;
  vehicleGroup.add(flare);
}
function slab(w, h, l, color) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, l), MAT.matte(color)); }

// ---------- American muscle car ----------
function buildMuscleCar() {
  const RED = 0xc0392f, RED_D = 0x962a23, STRIPE = 0xeee9dc, GLASS = 0x1d2a34;
  // low wide main body (rounded)
  const body = panel(2.0, 0.66, 4.9, RED, 0.32, 0.06);
  body.position.y = 0.66; body.castShadow = true; body.receiveShadow = true; vehicleGroup.add(body);
  // long sculpted hood + raised cowl
  const hood = panel(1.84, 0.34, 2.05, RED, 0.22, 0.05);
  hood.position.set(0, 0.96, 1.35); hood.castShadow = true; vehicleGroup.add(hood);
  // rear deck / haunches
  const deck = panel(1.92, 0.42, 1.7, RED, 0.26, 0.05);
  deck.position.set(0, 1.0, -1.55); deck.castShadow = true; vehicleGroup.add(deck);
  // fastback greenhouse — sloped, rear-biased
  const cabin = panel(1.66, 0.56, 2.25, RED_D, 0.3, 0.05);
  cabin.position.set(0, 1.34, -0.35); cabin.castShadow = true; vehicleGroup.add(cabin);
  // glass: raked windshield + fastback rear + side windows
  const ws = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 0.08), MAT.glass());
  ws.position.set(0, 1.4, 0.78); ws.rotation.x = 0.62; vehicleGroup.add(ws);
  const rg = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.62, 0.08), MAT.glass());
  rg.position.set(0, 1.36, -1.5); rg.rotation.x = -0.78; vehicleGroup.add(rg);
  [0.8, -0.8].forEach(x => { const sw = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 1.7), MAT.glass()); sw.position.set(x, 1.42, -0.4); vehicleGroup.add(sw); });
  // hood scoop
  const scoop = panel(0.62, 0.2, 0.8, 0x2a2d33, 0.08, 0.03);
  scoop.position.set(0, 1.18, 1.5); vehicleGroup.add(scoop);
  // rear ducktail spoiler
  const spoiler = panel(1.86, 0.1, 0.4, RED_D, 0.05, 0.02);
  spoiler.position.set(0, 1.28, -2.35); vehicleGroup.add(spoiler);
  // dual racing stripes hugging the top
  [-0.3, 0.3].forEach(x => {
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 4.85), MAT.matte(STRIPE));
    st.position.set(x, 1.0, 0.1); vehicleGroup.add(st);
  });
  // chrome bumpers + blacked grille
  const fb = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.26, 0.3), MAT.chrome()); fb.position.set(0, 0.5, 2.5); vehicleGroup.add(fb);
  const rb = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.26, 0.3), MAT.chrome()); rb.position.set(0, 0.55, -2.52); vehicleGroup.add(rb);
  const grille = slab(1.4, 0.34, 0.12, 0x1a1c20); grille.position.set(0, 0.74, 2.52); vehicleGroup.add(grille);
  const splitter = slab(2.0, 0.08, 0.5, 0x202225); splitter.position.set(0, 0.34, 2.45); vehicleGroup.add(splitter);
  // round headlights + tail bar
  [-0.66, 0.66].forEach(x => {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 16), MAT.light(0xfff6dc));
    hl.rotation.x = Math.PI / 2; hl.position.set(x, 0.82, 2.55); vehicleGroup.add(hl);
  });
  const tail = slab(1.5, 0.16, 0.06, 0xe2483a); tail.position.set(0, 0.9, -2.6); vehicleGroup.add(tail);
  // wheels — fat rear, tucked into arches
  [[1.0, 1.55, 0.46, 0.34], [-1.0, 1.55, 0.46, 0.34], [1.04, -1.6, 0.54, 0.46], [-1.04, -1.6, 0.54, 0.46]]
    .forEach(([x, z, r, w]) => { addWheel(r, w, x, z); archFlare(x, z, r, RED_D); });
}

// ---------- American chopper ----------
function buildChopper() {
  const FRAME = 0x191b1f, TANK = 0xca5a2e, TANK2 = 0xe98a3c;
  // backbone frame tube
  const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 2.4, 12), MAT.paint(FRAME));
  frame.rotation.x = Math.PI / 2; frame.position.set(0, 0.72, -0.15); vehicleGroup.add(frame);
  const downtube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 12), MAT.paint(FRAME));
  downtube.position.set(0, 0.6, 0.35); downtube.rotation.x = 0.5; vehicleGroup.add(downtube);
  // teardrop fuel tank with flame-orange top
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.4, 18, 14), MAT.paint(TANK));
  tank.scale.set(1, 0.82, 1.8); tank.position.set(0, 0.98, 0.2); tank.castShadow = true; vehicleGroup.add(tank);
  const flame = new THREE.Mesh(new THREE.SphereGeometry(0.3, 14, 10), MAT.paint(TANK2));
  flame.scale.set(1, 0.5, 1.6); flame.position.set(0, 1.12, 0.2); vehicleGroup.add(flame);
  // finned V-twin engine
  const engine = panel(0.5, 0.52, 0.6, 0x2c3036, 0.1, 0.03); engine.position.set(0, 0.6, -0.05); vehicleGroup.add(engine);
  [-0.16, 0.16].forEach(x => {
    const jug = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.5, 12), MAT.chrome());
    jug.position.set(x, 0.78, 0.05); jug.rotation.z = x > 0 ? -0.3 : 0.3; vehicleGroup.add(jug);
  });
  // raked front fork to a far-forward wheel
  [-0.2, 0.2].forEach(x => {
    const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 10), MAT.chrome());
    fork.position.set(x, 0.95, 1.4); fork.rotation.x = -0.6; vehicleGroup.add(fork);
  });
  // ape-hanger bars
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.95, 10), MAT.chrome());
  bars.rotation.z = Math.PI / 2; bars.position.set(0, 1.5, 0.6); vehicleGroup.add(bars);
  [-0.47, 0.47].forEach(x => { const g = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.32, 10), MAT.dark()); g.position.set(x, 1.36, 0.6); vehicleGroup.add(g); });
  // seat + rear fender
  const seat = panel(0.46, 0.16, 0.85, 0x141518, 0.07, 0.02); seat.position.set(0, 1.02, -0.6); vehicleGroup.add(seat);
  const fender = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.08, 8, 18, Math.PI), MAT.paint(TANK));
  fender.position.set(0, 0.62, -1.05); fender.rotation.y = Math.PI / 2; vehicleGroup.add(fender);
  // staggered exhaust pipes
  [-0.3, 0.3].forEach((x, i) => {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.085, 1.9, 12), MAT.chrome());
    pipe.rotation.x = Math.PI / 2 + 0.05; pipe.position.set(x, 0.42 + i * 0.06, -0.75); vehicleGroup.add(pipe);
  });
  // rider leaning back (Cylinder torso — r128 has no CapsuleGeometry)
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.3, 0.95, 12), MAT.matte(0x2b2e34));
  torso.position.set(0, 1.36, -0.45); torso.rotation.x = 0.3; torso.castShadow = true; vehicleGroup.add(torso);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 12), MAT.paint(0x14151a));
  helmet.position.set(0, 1.92, -0.22); vehicleGroup.add(helmet);
  // headlight
  const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.1, 16), MAT.light(0xfff6dc));
  hl.rotation.x = Math.PI / 2 - 0.15; hl.position.set(0, 1.06, 1.1); vehicleGroup.add(hl);
  // wheels
  addWheel(0.5, 0.16, 0, 2.0);
  addWheel(0.62, 0.3, 0, -1.05);
}

// ---------- Optimus-style big rig ----------
function buildBigRig() {
  const BLUE = 0x2f63b8, BLUE_D = 0x244f95, RED = 0xc23030, GLASS = 0x1d2a34;
  // chassis rail
  const chassis = slab(2.2, 0.5, 6.4, 0x202327); chassis.position.y = 0.95; vehicleGroup.add(chassis);
  // red sculpted hood
  const hood = panel(2.3, 1.45, 2.7, RED, 0.3, 0.06); hood.position.set(0, 1.55, 1.85); hood.castShadow = true; vehicleGroup.add(hood);
  // blue cab
  const cab = panel(2.45, 2.4, 2.3, BLUE, 0.34, 0.06); cab.position.set(0, 2.55, -0.55); cab.castShadow = true; vehicleGroup.add(cab);
  // sleeper
  const sleeper = panel(2.35, 2.05, 1.7, BLUE_D, 0.3, 0.06); sleeper.position.set(0, 2.35, -2.45); sleeper.castShadow = true; vehicleGroup.add(sleeper);
  // wrap windshield + side glass
  const ws = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.95, 0.1), MAT.glass()); ws.position.set(0, 3.12, 0.6); ws.rotation.x = 0.16; vehicleGroup.add(ws);
  [1.2, -1.2].forEach(x => { const sg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.8, 1.2), MAT.glass()); sg.position.set(x, 2.85, -0.3); vehicleGroup.add(sg); });
  // blue cowl band over the red hood (Optimus look)
  const band = panel(2.34, 0.55, 2.7, BLUE, 0.18, 0.04); band.position.set(0, 2.45, 1.85); vehicleGroup.add(band);
  // chrome grille bars + bull bar
  for (let i = 0; i < 6; i++) { const bar = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.06), MAT.chrome()); bar.position.set(0, 1.0 + i * 0.18, 3.28); vehicleGroup.add(bar); }
  const bull = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.18, 0.18), MAT.chrome()); bull.position.set(0, 0.85, 3.32); vehicleGroup.add(bull);
  // round headlights
  [-0.95, 0.95].forEach(x => {
    const hl = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 18), MAT.light(0xfff6dc));
    hl.rotation.x = Math.PI / 2; hl.position.set(x, 1.5, 3.3); vehicleGroup.add(hl);
  });
  // twin chrome exhaust stacks
  [-1.32, 1.32].forEach(x => {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 3.1, 14), MAT.chrome());
    stack.position.set(x, 2.7, -0.85); stack.castShadow = true; vehicleGroup.add(stack);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.25, 14), MAT.chrome());
    tip.position.set(x, 4.3, -0.85); vehicleGroup.add(tip);
  });
  // 6 big wheels
  const r = 0.68;
  [[1.3, 2.25], [-1.3, 2.25], [1.32, -1.35], [-1.32, -1.35], [1.32, -2.65], [-1.32, -2.65]]
    .forEach(([x, z]) => addWheel(r, 0.46, x, z));
}

// ---------------------------------------------------------------------------
// Scenery recycling — placed by (arc-length, side, lateral) and sat on terrain
// ---------------------------------------------------------------------------
function updateScenery(dt) {
  const onRoadKind = (k) => k === 'fence' || k === 'sign' || k === 'barricade' || k === 'bridge' || k === 'ramp' || k === 'oil' || k === 'puddle' || k === 'mud';
  const acrossRoad = (k) => k === 'barricade' || k === 'bridge';
  const facesRoad = (k) => k === 'fence' || k === 'sign' || k === 'building' || k === 'church' || k === 'pizza' || k === 'watertank' || k === 'park' || k === 'stall' || k === 'market' || k === 'fuelstation' || k === 'ramp';
  sceneryPool.forEach(o => {
    if (o.s < State.s - 36) {                 // recycle behind → ahead (respawn intact)
      o.s += SCENERY_SPAN;
      o.side = Math.random() > 0.5 ? 1 : -1;
      o.broken = false; o.breakT = 0; o.mesh.rotation.set(0, 0, 0); o.mesh.visible = true;
    }
    const sp = samplePath(o.s);
    const wx = sp.x + sp.nx * o.side * o.off;
    const wz = sp.z + sp.nz * o.side * o.off;
    o.wx = wx; o.wz = wz;                 // cache for collision resolution
    // o.off is the perpendicular lateral distance from the centerline at o.s, and sp.y is
    // that centerline's elevation — so we can skip the full nearestPathInfo scan here.
    const wy = onRoadKind(o.kind) ? sp.y : heightFromPath(sp.y, o.off, wx, wz);
    if (o.broken) {                       // smashed: topple over + sink, then settle
      o.breakT += dt || 0.016;
      const k = Math.min(1, o.breakT * 3.5);
      o.mesh.position.set(wx, wy - k * 0.4, wz);
      o.mesh.rotation.set(k * 1.5, (onRoadKind(o.kind) ? Math.atan2(sp.hx, sp.hz) + Math.PI / 2 : o.spin), k * 0.6);
      return;
    }
    o.mesh.position.set(wx, wy, wz);
    const head = Math.atan2(sp.hx, sp.hz);
    if (acrossRoad(o.kind)) o.mesh.rotation.y = head + Math.PI / 2;   // barricade, bridge
    else if (facesRoad(o.kind)) o.mesh.rotation.y = head;            // fence/sign/landmarks line the road
    else o.mesh.rotation.y = o.spin;
  });
}

// ---------------------------------------------------------------------------
// Living actors — animals that graze + bolt across the road, and pedestrians that
// walk the roadside. Unlike scenery (fixed lateral offset), an actor's lateral
// position `lat` changes over time: that's what makes a deer dash across in front
// of you. Pooled + recycled ahead exactly like scenery so the world stays alive
// without unbounded object growth.
// ---------------------------------------------------------------------------
const ANIMAL_KINDS = {
  deer:  { body: 0x9c6b3f, h: 1.3, len: 1.7, legR: 1.0, antler: true,  grazeOff: [8, 18], flee: 11 },
  cow:   { body: 0xe9e4dc, h: 1.5, len: 2.2, legR: 1.0, horns: true,   grazeOff: [10, 22], flee: 6.5 },
  sheep: { body: 0xe7e2d6, h: 1.0, len: 1.3, legR: 0.8, wool: true,    grazeOff: [9, 20], flee: 7.5 },
  dog:   { body: 0x8a6a44, h: 0.8, len: 1.2, legR: 0.7,                grazeOff: [6, 14], flee: 12 }
};
function makeAnimal(kind) {
  const A = ANIMAL_KINDS[kind], g = new THREE.Group();
  const skin = A.wool ? MAT.matte(A.body) : MAT.matte(A.body);
  const bodyGeo = A.wool ? new THREE.SphereGeometry(A.h * 0.5, 7, 6) : new THREE.BoxGeometry(A.h * 0.62, A.h * 0.55, A.len);
  const body = new THREE.Mesh(bodyGeo, skin);
  body.position.y = A.h * 0.62; body.castShadow = true;
  if (A.wool) body.scale.set(1.25, 1, 1.5);
  g.add(body);
  // head + neck at the front (+Z)
  const head = new THREE.Mesh(new THREE.BoxGeometry(A.h * 0.42, A.h * 0.42, A.h * 0.5), MAT.matte(A.wool ? 0x33312e : A.body));
  head.position.set(0, A.h * (kind === 'deer' ? 0.95 : 0.7), A.len * 0.5 + A.h * 0.1);
  head.castShadow = true; g.add(head);
  if (A.antler) [-1, 1].forEach(sx => {
    const an = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.5, 4), MAT.matte(0x6e5638));
    an.position.set(sx * 0.14, A.h * 1.2, A.len * 0.5); an.rotation.z = sx * 0.4; g.add(an);
  });
  if (A.horns) [-1, 1].forEach(sx => {
    const hn = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 4), MAT.matte(0xcfc6b2));
    hn.position.set(sx * 0.18, A.h * 0.92, A.len * 0.52); hn.rotation.z = sx * 0.9; g.add(hn);
  });
  // 4 legs (front pair / back pair) — stored for the gallop animation
  const legs = [], lw = A.h * 0.1, lh = A.h * 0.55;
  [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz]) => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(lw, lh, lw), MAT.matte(A.wool ? 0x33312e : 0x5b4630));
    leg.position.set(sx * A.h * 0.24, lh * 0.5, sz * A.len * 0.32);
    leg.userData.front = sz > 0; leg.userData.baseY = lh * 0.5; leg.userData.lh = lh;
    g.add(leg); legs.push(leg);
  });
  g.userData.legs = legs;
  return g;
}
const SHIRTS = [0xc0392f, 0x2f63b8, 0x4a8c4a, 0xe8a13a, 0x6a4fb0, 0xd23f7a, 0x3aa6a0];
function makePerson() {
  const g = new THREE.Group();
  const skin = 0xe0b48c, shirt = SHIRTS[Math.floor(Math.random() * SHIRTS.length)], pants = 0x394b63;
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.6, 0.26), MAT.matte(shirt));
  torso.position.y = 1.15; torso.castShadow = true; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 7, 6), MAT.matte(skin));
  head.position.y = 1.62; head.castShadow = true; g.add(head);
  const legs = [], arms = [];
  [-1, 1].forEach(sx => {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.7, 0.16), MAT.matte(pants));
    leg.position.set(sx * 0.11, 0.45, 0); leg.userData.baseY = 0.45; g.add(leg); legs.push(leg);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.13), MAT.matte(shirt));
    arm.position.set(sx * 0.3, 1.18, 0); g.add(arm); arms.push(arm);
  });
  g.userData.legs = legs; g.userData.arms = arms;
  return g;
}

function buildActors() {
  if (actorGroup) scene.remove(actorGroup);
  actorGroup = new THREE.Group();
  scene.add(actorGroup);
  actorPool = [];
  const q = Settings.quality;
  const animalN = q === 'low' ? 8 : (q === 'high' ? 20 : 14);
  const peopleN = q === 'low' ? 6 : (q === 'high' ? 18 : 12);
  const animalKinds = Object.keys(ANIMAL_KINDS);
  const total = animalN + peopleN;
  for (let i = 0; i < total; i++) {
    const isAnimal = i < animalN;
    const kind = isAnimal ? animalKinds[i % animalKinds.length] : 'pedestrian';
    const mesh = isAnimal ? makeAnimal(kind) : makePerson();
    actorGroup.add(mesh);
    const side = (i % 2 === 0) ? 1 : -1;
    const A = isAnimal ? ANIMAL_KINDS[kind] : null;
    const homeOff = isAnimal ? (A.grazeOff[0] + Math.random() * (A.grazeOff[1] - A.grazeOff[0]))
                             : (ROAD_WIDTH / 2 + 2.5 + Math.random() * 5);   // people on the verge
    actorPool.push({
      mesh, kind, isAnimal,
      s: (i / total) * SCENERY_SPAN + Math.random() * 8,
      side, lat: side * homeOff, homeOff,
      state: 'idle', phase: Math.random() * Math.PI * 2, t: 0,
      cr: isAnimal ? (A.len * 0.35 + 0.4) : 0.5,
      crossSpeed: isAnimal ? A.flee : 1.1,
      target: 0, credited: false, hop: 0,
      walkDir: Math.random() > 0.5 ? 1 : -1
    });
  }
}

// Stylized low-poly hit burst (red particles) — game-style impact VFX, not realistic.
// One pooled Points cloud; spawnBlood seeds a ring of particles with outward+up velocity.
let bloodSys = null, bloodData = null;
const BLOOD_MAX = 160;
function buildBlood() {
  if (bloodSys) { scene.remove(bloodSys); bloodSys = null; }
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(BLOOD_MAX * 3);
  for (let i = 0; i < BLOOD_MAX; i++) pos[i * 3 + 1] = -1000;   // park offscreen
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xb31218, size: 0.55, transparent: true, opacity: 0.95, depthWrite: false });
  bloodSys = new THREE.Points(geo, mat); bloodSys.frustumCulled = false; scene.add(bloodSys);
  bloodData = { vx: new Float32Array(BLOOD_MAX), vy: new Float32Array(BLOOD_MAX), vz: new Float32Array(BLOOD_MAX), life: new Float32Array(BLOOD_MAX), head: 0 };
}
function spawnBlood(x, y, z, n) {
  if (!bloodData) return;
  const pos = bloodSys.geometry.attributes.position.array;
  for (let k = 0; k < (n || 14); k++) {
    const i = bloodData.head; bloodData.head = (bloodData.head + 1) % BLOOD_MAX;
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5.5;
    bloodData.vx[i] = Math.cos(a) * sp; bloodData.vy[i] = 3 + Math.random() * 4.5; bloodData.vz[i] = Math.sin(a) * sp;
    bloodData.life[i] = 0.6 + Math.random() * 0.5;
  }
  bloodSys.geometry.attributes.position.needsUpdate = true;
}
function updateBlood(dt) {
  if (!bloodData) return;
  const pos = bloodSys.geometry.attributes.position.array; let any = false;
  for (let i = 0; i < BLOOD_MAX; i++) {
    if (bloodData.life[i] <= 0) continue; any = true;
    bloodData.life[i] -= dt; bloodData.vy[i] -= 15 * dt;
    pos[i * 3] += bloodData.vx[i] * dt; pos[i * 3 + 1] += bloodData.vy[i] * dt; pos[i * 3 + 2] += bloodData.vz[i] * dt;
    if (bloodData.life[i] <= 0 || pos[i * 3 + 1] < 0) { pos[i * 3 + 1] = -1000; bloodData.life[i] = 0; }
  }
  if (any) bloodSys.geometry.attributes.position.needsUpdate = true;
}

// near-miss credit + spook fan-out live here so update() stays readable
let actorMsgCool = 0;
function updateActors(dt) {
  if (!actorPool.length) return;
  if (actorMsgCool > 0) actorMsgCool -= dt;
  const carAhead = State.s;                       // car's arc-length
  for (let i = 0; i < actorPool.length; i++) {
    const o = actorPool[i];
    o.t += dt; o.phase += dt;
    if (o.broken) {                       // hit: crumple over, sink + fade, then respawn ahead intact
      o.breakT += dt;
      const k = Math.min(1, o.breakT * 2.0);
      o.mesh.position.set(o.wx, (o.wy || 0) - k * 0.5, o.wz);
      o.mesh.rotation.set(k * 1.7, o.mesh.rotation.y, k * 0.6);
      o.mesh.scale.setScalar(Math.max(0.15, 1 - 0.5 * k));
      if (o.breakT > 1.5) {
        o.s += SCENERY_SPAN; o.broken = false; o.breakT = 0;
        o.side = Math.random() > 0.5 ? 1 : -1; o.lat = o.side * o.homeOff;
        o.state = 'idle'; o.credited = false; o.hop = 0;
        o.mesh.scale.setScalar(1); o.mesh.rotation.set(0, 0, 0);
      }
      continue;
    }
    // recycle behind → ahead, reset to a calm roadside graze/walk
    if (o.s < State.s - 40) {
      o.s += SCENERY_SPAN;
      o.side = Math.random() > 0.5 ? 1 : -1;
      o.lat = o.side * o.homeOff; o.state = 'idle'; o.credited = false; o.hop = 0;
    }
    const sp = samplePath(o.s);
    const aheadGap = o.s - carAhead;              // >0 means actor is in front of the car
    const dxC = State.carX - (sp.x + sp.nx * o.lat);
    const dzC = State.carZ - (sp.z + sp.nz * o.lat);
    const distCar = Math.sqrt(dxC * dxC + dzC * dzC);

    if (o.isAnimal) {
      // FSM: idle/graze → flee (bolt across to the far side) → idle again
      if (o.state === 'idle' || o.state === 'graze') {
        // spook when the car is close, ahead, and moving with some pace
        if (aheadGap > -4 && aheadGap < 34 && distCar < 30 && Math.abs(State.speed) > 6) {
          o.state = 'flee';
          o.target = -Math.sign(o.lat || 1) * (o.homeOff * 0.9 + 4);   // dash to the opposite verge
          o.credited = false;
        } else {
          o.lat += (o.side * o.homeOff - o.lat) * Math.min(1, dt * 2);  // ease home
        }
      } else if (o.state === 'flee') {
        const dir = Math.sign(o.target - o.lat) || 1;
        o.lat += dir * o.crossSpeed * dt;
        // near-miss reward: bolting across, close in front, but you didn't clobber it
        if (!o.credited && Math.abs(o.lat) < ROAD_WIDTH / 2 + 1 && distCar > o.cr + CAR_R && distCar < 5.5 && Math.abs(State.speed) > 11) {
          o.credited = true; addCoins(15);
          if (actorMsgCool <= 0) { showToast('🦌 Close one!', '+15 — near miss'); actorMsgCool = 2.2; }
        }
        if ((dir > 0 && o.lat >= o.target) || (dir < 0 && o.lat <= o.target)) {
          o.state = 'graze'; o.side = Math.sign(o.lat) || 1; o.homeOff = Math.abs(o.lat);
        }
      }
    } else {
      // pedestrian: stroll along the verge; flinch back a step if the car barrels close
      if (distCar < 7 && aheadGap > -3 && aheadGap < 18) {
        o.lat += (o.side * (o.homeOff + 2.5) - o.lat) * Math.min(1, dt * 4);  // step away from road
      } else {
        o.lat += (o.side * o.homeOff - o.lat) * Math.min(1, dt * 2);
        o.s += o.walkDir * 1.0 * dt;             // amble along the route
      }
    }

    // place on terrain + face travel direction
    const wx = sp.x + sp.nx * o.lat, wz = sp.z + sp.nz * o.lat;
    const wy = heightFromPath(sp.y, Math.abs(o.lat), wx, wz);
    o.wx = wx; o.wz = wz; o.wy = wy;
    // contact: at speed the car ploughs through — the figure crumples with a red hit
    // burst (stylized low-poly impact VFX); a crawl just shoves it aside.
    if (o.cr && !o.broken) {
      const dd = dxC * dxC + dzC * dzC, minD = o.cr + CAR_R;
      if (dd < minD * minD && dd > 1e-4) {
        if (Math.abs(State.speed) > 7) {
          o.broken = true; o.breakT = 0;
          spawnBlood(wx, wy + (o.isAnimal ? 0.6 : 1.0), wz, o.isAnimal ? 18 : 14);
          State.speed *= 0.9; shakeCamera(0.3, 'roll');
          if (typeof playSmash === 'function') playSmash('bush');
        } else {
          const d = Math.sqrt(dd), push = minD - d;
          State.carX += (dxC / d) * push; State.carZ += (dzC / d) * push; State.speed *= 0.9;
        }
      }
    }
    if (o.hop > 0) o.hop = Math.max(0, o.hop - dt * 1.6);
    o.mesh.position.set(wx, wy + (o.hop > 0 ? Math.sin((0.5 - o.hop) * Math.PI / 0.5) * 0.6 : 0), wz);

    // heading: face the way it's moving (across the road when fleeing, else along it)
    let hx, hz;
    if (o.isAnimal && o.state === 'flee') { const dir = Math.sign(o.target - o.lat) || 1; hx = sp.nx * dir; hz = sp.nz * dir; }
    else { hx = sp.hx; hz = sp.hz; if (!o.isAnimal) { hx *= o.walkDir; hz *= o.walkDir; } }
    o.mesh.rotation.y = Math.atan2(hx, hz);

    // limb animation: gait speed scales with how fast it's moving
    const legs = o.mesh.userData.legs;
    if (legs) {
      const moving = (o.isAnimal ? (o.state === 'flee') : (distCar >= 7 || aheadGap <= -3 || aheadGap >= 18));
      const sw = moving ? Math.sin(o.phase * (o.isAnimal ? 14 : 7)) : Math.sin(o.phase * 1.5) * 0.12;
      legs.forEach((leg, li) => {
        const ph = (li % 2 === 0) ? sw : -sw;
        leg.rotation.x = ph * (o.isAnimal ? 0.9 : 0.7);
      });
      const arms = o.mesh.userData.arms;
      if (arms) arms.forEach((arm, ai) => { arm.rotation.x = ((ai % 2 === 0) ? -sw : sw) * 0.7; });
    }
  }
}

// Collisions: above SMASH_KMH the car PLOWS THROUGH breakable objects (they topple,
// with a smash sound + small speed loss); below that, or vs solid rocks, it's a soft
// push-out (slide around, no wall). CAR_R is the car's collision radius.
const CAR_R = 1.4;
const SMASH_MS = 50 / 3.6;     // 50 km/h
let smashCooldown = 0;
function resolveCollisions(dt) {
  if (smashCooldown > 0) smashCooldown -= dt;
  const fast = Math.abs(State.speed) > SMASH_MS;
  let bumped = false;
  for (let i = 0; i < sceneryPool.length; i++) {
    const o = sceneryPool[i];
    if (!o.cr || o.broken || o.wx === undefined) continue;
    const dx = State.carX - o.wx, dz = State.carZ - o.wz;
    const minD = o.cr + CAR_R;
    const d2 = dx * dx + dz * dz;
    if (d2 < minD * minD && d2 > 1e-4) {
      if (fast && o.breakable) {
        o.broken = true; o.breakT = 0;          // smash through it
        State.speed *= 0.92;
        addCoins(10);                            // reward for demolition
        if (smashCooldown <= 0) { playSmash(o.kind); shakeCamera(0.35, 'roll'); smashCooldown = 0.12; }
      } else {
        const d = Math.sqrt(d2);                 // soft push-out
        const push = minD - d;
        State.carX += (dx / d) * push;
        State.carZ += (dz / d) * push;
        State.speed *= 0.86;
        bumped = true;
      }
    }
  }
  if (bumped && Math.abs(State.speed) > 10) shakeCamera(0.1);

  // road-surface hazards + launch ramps (cr = 0, so handled apart from collisions).
  // gripMod feeds next frame's grip calc; drag/launch apply now.
  let gm = 1;
  for (let i = 0; i < sceneryPool.length; i++) {
    const o = sceneryPool[i];
    if (!o.hazard || o.wx === undefined) continue;
    const dx = State.carX - o.wx, dz = State.carZ - o.wz;
    const inside = (dx * dx + dz * dz) < o.hr * o.hr;
    if (inside) {
      if (o.hazard === 'oil') gm = Math.min(gm, 0.16);                 // slick → the back steps out
      else if (o.hazard === 'mud') { gm = Math.min(gm, 0.62); State.speed *= (1 - dt * 1.3); }  // grip + heavy drag
      else if (o.hazard === 'puddle') {
        gm = Math.min(gm, 0.82); State.speed *= (1 - dt * 0.55);
        if (!o._wet) { o._wet = true; playSplash(); } triggerSplash(State.carX, State.carZ);
      } else if (o.hazard === 'ramp') {
        if (Math.abs(State.speed) > 11 && State.jumpY < 0.3 && !o._launched) {
          State.vy = Math.min(18, 6 + Math.abs(State.speed) * 0.55); o._launched = true;   // big air
        }
      }
    } else {
      if (o.hazard === 'puddle') o._wet = false;
      if (o.hazard === 'ramp') o._launched = false;
    }
  }
  State.gripMod = gm;
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------
function update(dt) {
  const V = VEHICLES[selectedVehicle];
  const maxMs = V.maxSpeed / 3.6;

  // --- autodrive: hands-off cruising (Zen Drive). User input overrides it. ---
  const userThrottle = keys.up || keys.down || keys.brake;
  const userSteer = keys.left || keys.right;
  const autoOn = State.autodrive;

  // --- throttle / brake / reverse ---
  // analog mobile pad scales torque by how far it's pushed; keyboard/gamepad = full (1)
  const thrScale = State.touchThrottle != null ? Math.min(1, Math.abs(State.touchThrottle)) : 1;
  // engine torque tapers as you approach top speed (feels punchy off the line)
  if (keys.brake) {
    const dec = V.brake || 60; // per-vehicle stopping power (bike bites hardest, rig least)
    if (State.speed > 0) State.speed = Math.max(0, State.speed - dec * dt);
    else if (State.speed < 0) State.speed = Math.min(0, State.speed + dec * dt);
    State.launchT = 0;
  } else if (keys.up) {
    // Launch control: brief full-torque window off the line, then the taper eases in so
    // the top end is still earned (was a flat 0.85 taper — felt gutless from a standstill).
    State.launchT = Math.min(0.35, State.launchT + dt);
    const launch = 1 - State.launchT / 0.35;                 // 1 → 0 over the first 0.35s
    const taper = (0.6 - 0.45 * launch) * Math.max(0, State.speed) / maxMs;
    const torque = V.accel * (1 - taper) * thrScale;
    State.speed += torque * dt;
  } else if (keys.down) {
    State.launchT = 0;
    // brake first if moving forward, otherwise accelerate in reverse (now punchier)
    if (State.speed > 0.5) State.speed -= V.accel * 1.3 * thrScale * dt;
    else State.speed -= V.accel * 0.75 * thrScale * dt;
  } else if (autoOn && !userThrottle) {
    // ease toward a relaxed cruise (~62% of top speed)
    const cruise = maxMs * 0.62;
    State.speed += (cruise - State.speed) * Math.min(1, dt * 0.6);
  } else {
    // coast: rolling + aero drag (stronger at speed)
    const drag = (4 + Math.abs(State.speed) * 0.18) * dt;
    if (State.speed > 0) State.speed = Math.max(0, State.speed - drag);
    else if (State.speed < 0) State.speed = Math.min(0, State.speed + drag);
    State.launchT = 0;   // lifting off re-arms the next standstill launch
  }
  if (keys.drift && State.speed > 0) State.speed *= (1 - dt * 0.5);   // handbrake bleeds speed
  State.speed = Math.max(-maxMs * 0.28, Math.min(maxMs, State.speed));

  // --- steering → free-roam heading (you can turn and drive anywhere) ---
  const absSpeed = Math.abs(State.speed);
  const speedFactor = Math.min(1, absSpeed / 9);
  if (autoOn && !userSteer) {
    // hands-off: ease the heading toward the road's tangent, nudged to rejoin it
    const info = nearestPathInfo(State.carX, State.carZ);
    // bias the target heading back toward the centerline (independent of STEER_DIR)
    const tgt = Math.atan2(info.hx, info.hz) + info.lateral * 0.02;
    let dAng = ((tgt - State.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    State.heading += dAng * Math.min(1, dt * 1.3);
    State.steer += (0 - State.steer) * Math.min(1, dt * 6);
  } else {
    // analog joystick steers proportionally; keyboard/gamepad fall back to ±1
    const steerInput = State.touchSteer != null ? State.touchSteer : ((keys.left ? 1 : 0) - (keys.right ? 1 : 0));
    const returnRate = Math.abs(steerInput) < 0.01 ? 9 : 7;
    State.steer += (steerInput - State.steer) * Math.min(1, dt * returnRate);
    // Authority reaches full by ~3.5 m/s instead of 7 (tight turns/donuts come alive once
    // rolling) but is still 0 at a true standstill (no tank-pivot). High-speed bleed is
    // gentler too (was 0.42 → felt mushy up top; 0.2 keeps it carveable).
    const lowAuth = Math.min(1, absSpeed / 3.5);
    const highAuth = 1 - 0.2 * Math.min(1, absSpeed / maxMs);
    const turnAuth = V.turn * V.grip * lowAuth * highAuth;
    State.heading += State.steer * turnAuth * dt * Math.sign(State.speed || 1) * STEER_DIR;
  }

  // --- advance with grip/drift: velocity vector lags the heading by a grip factor ---
  const dir = { x: Math.sin(State.heading), z: Math.cos(State.heading) };
  const desVx = dir.x * State.speed, desVz = dir.z * State.speed;   // forward intent
  // grip = how fast velocity realigns to heading. Lower when handbraking, braking
  // hard, or steering hard at speed → the back slides (drift).
  const fastTurn = Math.abs(State.steer) * Math.min(1, absSpeed / maxMs);
  const grip = V.grip * (State.gripMod || 1) * (keys.drift ? 0.14 : (keys.brake ? 0.5 : 1)) * (1 - 0.34 * fastTurn);
  const gl = Math.min(1, grip * 3.2 * dt);
  State.vx += (desVx - State.vx) * gl;
  State.vz += (desVz - State.vz) * gl;
  State.carX += State.vx * dt;
  State.carZ += State.vz * dt;
  // slip angle drives skid-sound + extra body lean while drifting
  State.slip = Math.abs(State.vx * dir.z - State.vz * dir.x) / (Math.abs(State.speed) + 4);
  const fwdProgress = (State.vx * dir.x + State.vz * dir.z) * dt;
  State.distance += Math.max(0, fwdProgress);
  // +1 coin per 50 m travelled
  if (State.distance - State._lastCoinD >= 50) {
    addCoins(Math.floor((State.distance - State._lastCoinD) / 50));
    State._lastCoinD = State.distance;
  }

  // --- drift reward: sustained sideways slip at speed banks distance → coins ---
  if (State.slip > 0.35 && absSpeed > 8) {
    State.driftDist += absSpeed * dt;
    if (State.driftDist - State._driftReward >= 50) {
      State._driftReward = State.driftDist;
      addCoins(10);
      showToast('🌀 Drift! +10', Math.round(State.driftDist) + ' m banked');
    }
  } else if (State.slip < 0.15) {
    State.driftDist = State._driftReward = 0;   // chain breaks when grip recovers
  }

  // road keeps generating ahead of wherever the car projects onto it; off-road
  // is true terrain you can roam (just slower), not a bounded side-offset.
  resolveCollisions(dt);                // smash-through (fast) or soft push-out (slow)

  const proj = nearestPathInfo(State.carX, State.carZ);
  State.s = proj.s;
  pathMaintain(State.s);
  State.offRoad = proj.d > ROAD_WIDTH / 2;
  if (State.offRoad && absSpeed > 5) {
    const terrainDrag = selectedSeason === 'winter' ? 0.22 : (selectedSeason === 'desert' ? 0.2 : 0.14);
    State.speed *= (1 - dt * terrainDrag);
    if (absSpeed > 14) shakeCamera(0.05);
  }

  // --- jump / vertical physics ---
  if (State.vy !== 0 || State.jumpY > 0) {
    State.jumpY += State.vy * dt;
    State.vy -= 34 * dt; // gravity
    if (State.jumpY <= 0) {
      State.jumpY = 0;
      if (State.airborne) {                 // touchdown: compress the suspension + sproing
        State.airborne = false;
        State.suspComp = -0.45; State.suspVel = 0;
        shakeCamera(0.35); playLanding();
      }
      State.vy = 0;
    }
  }
  // big air takes a real launch — only tall jumps count
  State.airborne = State.jumpY > 1.4;

  // --- mission checks (continuous; Challenge Run only) ---
  const kmh = Math.abs(State.speed) * 3.6;
  if (State.mode === 'challenge') {
    if (kmh >= 80) Missions.complete('speed80');
    if (kmh >= 120) Missions.complete('speed120');
    // hold 70+ for a sustained 8s
    if (kmh >= 70) { State.hold70 += dt; if (State.hold70 >= 8) Missions.complete('hold70'); }
    else State.hold70 = 0;
    updateMissionProgress();
    // big air: must clear a genuine height off a ramp
    if (State.jumpY > 2.4) Missions.complete('jump');
    // emergency stop: reached 80+ km/h, then braked to a standstill with Space
    if (kmh > 80) State.wasMoving = true;
    if (State.wasMoving && keys.brake && Math.abs(State.speed) < 0.4) {
      Missions.complete('stop');
      State.wasMoving = false;
    }
    // reverse distance — now a longer 40 m
    if (State.speed < -0.2) { State.reverseDist += -State.speed * dt; if (State.reverseDist >= 40) Missions.complete('reverse'); }
  }

  // --- place the car, conforming to the ground slope, with sprung suspension ---
  const L = V.len;
  const cy = heightAt(State.carX, State.carZ);
  const fy = heightAt(State.carX + dir.x * L, State.carZ + dir.z * L);
  const ry = heightAt(State.carX - dir.x * L, State.carZ - dir.z * L);
  const baseY = Math.max(cy, (fy + ry) / 2);          // never dip below a crest

  // weight transfer: nose lifts under power, dives under braking
  const accelLong = (State.speed - State.prevSpeed) / Math.max(dt, 1e-3);
  State.prevSpeed = State.speed;
  const dive = Math.max(-0.06, Math.min(0.06, -accelLong * 0.011));
  const slopePitch = Math.atan2(ry - fy, 2 * L);
  const pitchTarget = State.airborne ? -State.vy * 0.02 : slopePitch + dive;
  State.pitchS += (pitchTarget - State.pitchS) * Math.min(1, dt * 7);
  // body roll: leans outward as you turn (heavier vehicles lean more)
  const rollTarget = State.steer * speedFactor * 0.13 * Math.min(1.4, V.mass);
  State.rollS += (rollTarget - State.rollS) * Math.min(1, dt * 7);
  // vertical suspension spring (settles bumps, compresses+rebounds on landing) —
  // per-vehicle: truck stiff & well-damped, chopper soft & floppy, car balanced
  State.suspVel += (-State.suspComp) * (V.suspK || 90) * dt - State.suspVel * (V.suspD || 13) * dt;
  State.suspComp += State.suspVel * dt;
  const bounce = Math.sin(clock.elapsedTime * 8) * 0.012 * speedFactor;

  vehicleGroup.position.set(State.carX, baseY + State.jumpY + bounce + State.suspComp, State.carZ);
  vehicleGroup.rotation.set(State.pitchS, State.heading, State.rollS);

  // spin wheels
  const wheelSpin = State.speed * dt / (VEHICLES[selectedVehicle].wheel.r);
  vehicleWheels.forEach((wg, idx) => {
    wg.children[0].rotation.x -= wheelSpin;
    wg.children[1].rotation.x -= wheelSpin;
    // steer front wheels
    const isFront = wg.position.z > 0.5;
    if (isFront) wg.rotation.y = State.steer * 0.4;
  });
  // loaded-model (GLB) wheels: roll about their local axle on top of the rest pose
  if (glbWheels.length) {
    const spin = State.speed * dt / 0.4;
    glbWheels.forEach(w => { w.node.rotation.x = w.baseX - (w.spin = (w.spin || 0) + spin); });
  }

  updateTerrain(false);
  updateRoadRibbon();
  updateBridges();
  updateScenery(dt);
  updateActors(dt);
  updateBlood(dt);
  updateInteractables(dt);
  updateSplash(dt);
  updateParticles(dt);
  updateCamera(dt, speedFactor);
  updateAudio(dt, maxMs);
  updateTimeTrial(dt);
  updateTutorial(dt);
  updateHUD();
  drawMinimap();
}

function updateCamera(dt, speedFactor) {
  const v = vehicleGroup.position;
  const hx = Math.sin(State.heading), hz = Math.cos(State.heading);  // car forward
  let dist, height, lerp;
  if (State.camMode === 0) { dist = 12; height = 4.8 + speedFactor * 0.7; lerp = 4; }     // chase
  else if (State.camMode === 1) { dist = 7.5; height = 3.3; lerp = 6; }                    // close
  else { dist = -2.4; height = 2.2; lerp = 11; }                                           // hood (ahead of car)

  const target = new THREE.Vector3(v.x - hx * dist, v.y + height, v.z - hz * dist);
  // always look ahead of the car along its heading — keeps it framed on or off road
  const look = new THREE.Vector3(v.x + hx * 16, v.y + 1.6, v.z + hz * 16);

  camera.position.lerp(target, Math.min(1, dt * lerp));
  if (camShake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * camShake;
    camera.position.y += (Math.random() - 0.5) * camShake * 0.6;
    camShake *= Math.max(0, 1 - dt * camShakeDecay);
  }
  // heavy hits also roll the horizon briefly, which reads more like an impact than jitter
  if (camShakeRoll > 0.0005) {
    camShakeRoll *= Math.max(0, 1 - dt * 3.5);
    look.x += (Math.random() - 0.5) * camShakeRoll * 30;
  }
  camera.lookAt(look);

  // sun/shadow + sky ride with the action
  sunLight.position.set(v.x + 60, 110, v.z + 40);
  sunLight.target.position.set(v.x, v.y, v.z);
  if (skyDome) skyDome.position.copy(camera.position);
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
let hudAccum = 0;
function updateHUD() {
  hudAccum += 1;
  document.getElementById('speed-val').textContent = Math.round(Math.abs(State.speed) * 3.6);
  document.getElementById('dist-val').textContent = (State.distance / 1000).toFixed(2) + ' km';
  const best = Math.max(State.best, State.distance);
  document.getElementById('best-val').textContent = (best / 1000).toFixed(2) + ' km';
  document.getElementById('coin-val').textContent = Math.floor(Progress.coins);
  let gear = 'D';
  if (State.speed < -0.3) gear = 'R';
  else if (Math.abs(State.speed) < 0.3) gear = 'N';
  document.getElementById('gear-val').textContent = gear;
}

// ---------------------------------------------------------------------------
// Mission UI
// ---------------------------------------------------------------------------
function updateModePill() {
  const pill = document.getElementById('mode-pill');
  if (!pill) return;
  document.getElementById('mode-name').textContent = (MODES[State.mode] || {}).name || 'Challenge';
  pill.classList.toggle('auto', State.autodrive);
}

function renderMissionList() {
  const list = document.getElementById('m-list');
  list.innerHTML = '';
  let firstOpen = MISSIONS.find(m => !Missions.done[m.id]);
  MISSIONS.forEach(m => {
    const done = Missions.done[m.id];
    const li = document.createElement('li');
    li.className = (done ? 'done' : '') + (firstOpen && m.id === firstOpen.id ? ' active-m' : '');
    li.dataset.id = m.id;
    li.innerHTML = `<span class="box">${done ? '✓' : ''}</span><span class="txt">${m.label}</span>` +
      (m.hasProgress ? `<span class="prog" data-prog="${m.id}"></span><span class="pbar"><i data-bar="${m.id}"></i></span>` : '');
    list.appendChild(li);
  });
  document.getElementById('m-count').textContent = Missions.count + ' / ' + MISSIONS.length;
}

function setMissionProg(id, frac, text) {
  if (Missions.done[id]) return;
  const t = document.querySelector('[data-prog="' + id + '"]');
  if (t) t.textContent = text;
  const bar = document.querySelector('[data-bar="' + id + '"]');
  if (bar) bar.style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(0) + '%';
}
function updateMissionProgress() {
  setMissionProg('hold70', State.hold70 / 8, Math.min(8, State.hold70).toFixed(1) + 's');
  setMissionProg('reverse', State.reverseDist / 40, Math.min(40, State.reverseDist).toFixed(0) + 'm');
  setMissionProg('pond', State.pondTime / 1.1, Math.min(100, Math.round(State.pondTime / 1.1 * 100)) + '%');
  const cp = (window.__coneProg || '0/6').split('/');
  setMissionProg('cones', (parseInt(cp[0], 10) || 0) / (parseInt(cp[1], 10) || 6), window.__coneProg || '0/6');
}

let toastTimer = null;
function showToast(title, sub) {
  const t = document.getElementById('toast');
  t.innerHTML = title + (sub ? `<div class="sub">${sub}</div>` : '');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function winRun() {
  State.won = true;
  State.running = false;
  addCoins(150); saveProgress();              // completion bonus
  const elapsed = clock.elapsedTime - State.runStart;
  const mm = Math.floor(elapsed / 60), ss = Math.floor(elapsed % 60);
  document.getElementById('win-time').textContent = mm + ':' + String(ss).padStart(2, '0');
  document.getElementById('win-dist').textContent = (State.distance / 1000).toFixed(2) + ' km';
  document.getElementById('win-overlay').classList.add('show');
  clearRunHud();
  if (Audio.engineGain && Audio.ctx) Audio.engineGain.gain.setTargetAtTime(0, Audio.ctx.currentTime, 0.3);
  playFanfare();
}

function fmtTime(s) {
  const mm = Math.floor(s / 60), ss = Math.floor(s % 60), cs = Math.floor((s % 1) * 100);
  return mm + ':' + String(ss).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// Minimap — heading-up top-down radar of the road, objectives, finish & ghost
// ---------------------------------------------------------------------------
// hide run-only HUD + drop the ghost when a run ends or we return to the menu
function clearRunHud() {
  const mm = document.getElementById('minimap'); if (mm) mm.style.display = 'none';
  showTutBanner(null);
  if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
}
const MINIMAP_RANGE = 150;   // metres from centre to edge
function drawMinimap() {
  const cv = document.getElementById('minimap');
  if (!cv || cv.style.display === 'none') return;
  const g = cv.getContext('2d');
  if (!g || !PATH.nodes.length) return;
  const W = cv.width, H = cv.height, cx = W / 2, cy = H / 2, R = W / 2;
  const scale = R / MINIMAP_RANGE;
  const ch = Math.cos(State.heading), sh = Math.sin(State.heading);
  // world → heading-up screen (car forward = up)
  const toScreen = (wx, wz) => {
    const dx = wx - State.carX, dz = wz - State.carZ;
    return [cx + (dx * ch - dz * sh) * scale, cy - (dx * sh + dz * ch) * scale];
  };
  g.clearRect(0, 0, W, H);
  g.save();
  g.beginPath(); g.arc(cx, cy, R - 2, 0, Math.PI * 2); g.clip();
  // road ribbon
  const n = PATH.nodes;
  g.lineWidth = Math.max(3, ROAD_WIDTH * scale);
  g.strokeStyle = 'rgba(185,205,225,0.55)'; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath();
  for (let i = 0; i < n.length; i++) { const [sx, sy] = toScreen(n[i].x, n[i].z); i ? g.lineTo(sx, sy) : g.moveTo(sx, sy); }
  g.stroke();
  // challenge objectives still outstanding
  if (State.mode === 'challenge') {
    interactables.forEach(o => {
      if (o.hit || o.broken || !o.mesh) return;
      const [sx, sy] = toScreen(o.mesh.position.x, o.mesh.position.z);
      g.fillStyle = '#ffd27a'; g.beginPath(); g.arc(sx, sy, 3.4, 0, Math.PI * 2); g.fill();
    });
  }
  // time-trial finish + ghost blip
  if (State.mode === 'timetrial' && !State.ttFinished) {
    const remain = TT_DIST - State.distance;
    if (remain > 0 && remain < PATH_AHEAD) {
      const sp = samplePath(State.s + remain); const [sx, sy] = toScreen(sp.x, sp.z);
      g.fillStyle = '#aee0cc'; g.fillRect(sx - 5, sy - 5, 10, 10);
    }
    if (ghostGroup) { const [gx, gy] = toScreen(ghostGroup.position.x, ghostGroup.position.z); g.fillStyle = '#9ad0ff'; g.beginPath(); g.arc(gx, gy, 3.4, 0, Math.PI * 2); g.fill(); }
  }
  g.restore();
  // car arrow (always points up) + bezel
  g.fillStyle = '#ff6a4d';
  g.beginPath(); g.moveTo(cx, cy - 7); g.lineTo(cx - 5, cy + 6); g.lineTo(cx + 5, cy + 6); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, R - 2, 0, Math.PI * 2); g.stroke();
}

// ---------------------------------------------------------------------------
// Practice tutorial — guided control walkthrough, advances as you do each thing
// ---------------------------------------------------------------------------
const Tut = { baseHeading: 0, baseCam: 0, wasFast: false };
const TUT_STEPS = [
  { msg: '▲  Hold UP (or W) to accelerate', done: () => Math.abs(State.speed) * 3.6 > 25 },
  { msg: '◀ ▶  Steer with LEFT / RIGHT', done: () => Math.abs(((State.heading - Tut.baseHeading + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.6 },
  { msg: 'SPACE  — get some speed, then brake to a full stop', done: () => Tut.wasFast && Math.abs(State.speed) < 1.2 },
  { msg: 'SHIFT  — hold it while turning hard to drift', done: () => State.slip > 0.45 },
  { msg: 'C  — press to cycle the camera view', done: () => State.camMode !== Tut.baseCam },
  { msg: "🎉  You're ready! Open the menu (Esc) to pick Challenge, Time Trial or Zen.", done: () => false, hold: 5 }
];
function showTutBanner(msg) {
  const b = document.getElementById('tut-banner');
  if (!b) return;
  if (msg == null) { b.style.display = 'none'; return; }
  b.textContent = msg; b.style.display = 'block';
}
function startTutorial() {
  State.tutStep = 0; State.tutT = 0;
  Tut.baseHeading = State.heading; Tut.baseCam = State.camMode; Tut.wasFast = false;
  showTutBanner(TUT_STEPS[0].msg);
}
function updateTutorial(dt) {
  if (State.mode !== 'practice' || State.tutStep < 0) return;
  State.tutT += dt;
  if (Math.abs(State.speed) * 3.6 > 55) Tut.wasFast = true;
  const step = TUT_STEPS[State.tutStep];
  if (step.done()) {
    playDing();
    State.tutStep++;
    if (State.tutStep >= TUT_STEPS.length) { showTutBanner(null); State.tutStep = -1; return; }
    State.tutT = 0; Tut.baseHeading = State.heading; Tut.baseCam = State.camMode; Tut.wasFast = false;
    showTutBanner(TUT_STEPS[State.tutStep].msg);
  } else if (step.hold && State.tutT > step.hold) {
    showTutBanner(null); State.tutStep = -1;
  }
}

// ---------------------------------------------------------------------------
// Time Trial + ghost replay — race a fixed track against your best run
// ---------------------------------------------------------------------------
const TT_SEED = 73501;   // fixed track for fair comparison
const TT_DIST = 2000;    // metres to the finish
let ghostGroup = null, ghostData = null, ghostBestMs = 0, ghostRec = [], ttMile = 0;
function ttKeyBest() { return 'openroads_tt_best_' + selectedVehicle; }
function ttKeyGhost() { return 'openroads_tt_ghost_' + selectedVehicle; }
function loadGhost() {
  ghostData = null;
  ghostBestMs = parseFloat(lsGet(ttKeyBest(), '')) || 0;
  try { const raw = lsGet(ttKeyGhost(), ''); if (raw) { const gd = JSON.parse(raw); if (gd && gd.dt && gd.samples && gd.samples.length) ghostData = gd; } } catch (e) { ghostData = null; }
}
function buildGhost() {
  if (ghostGroup) { scene.remove(ghostGroup); ghostGroup = null; }
  if (!ghostData || !vehicleGroup || typeof vehicleGroup.clone !== 'function') return;
  ghostGroup = vehicleGroup.clone(true);
  ghostGroup.traverse(o => {
    if (o.material) {
      o.material = (o.material.clone ? o.material.clone() : o.material);
      if (o.material) { o.material.transparent = true; o.material.opacity = 0.32; o.material.depthWrite = false; }
    }
  });
  scene.add(ghostGroup);
}
function recordGhostSample(dt) {
  State.ttSampleT += dt;
  if (State.ttSampleT >= 0.1) {
    State.ttSampleT -= 0.1;
    ghostRec.push([+State.carX.toFixed(2), +State.carZ.toFixed(2), +State.heading.toFixed(3)]);
  }
}
function playGhost(elapsed) {
  if (!ghostGroup || !ghostData) return;
  const s = ghostData.samples, idx = elapsed / ghostData.dt, i0 = Math.floor(idx);
  if (i0 >= s.length - 1) { const L = s[s.length - 1]; ghostGroup.position.set(L[0], heightAt(L[0], L[1]) + 0.1, L[1]); ghostGroup.rotation.y = L[2]; return; }
  const a = s[i0], b = s[i0 + 1], f = idx - i0;
  const x = a[0] + (b[0] - a[0]) * f, z = a[1] + (b[1] - a[1]) * f;
  ghostGroup.position.set(x, heightAt(x, z) + 0.1, z);
  let dh = ((b[2] - a[2] + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  ghostGroup.rotation.y = a[2] + dh * f;
}
function ttComplete() {
  State.ttFinished = true; State.running = false;
  const elapsed = clock.elapsedTime - State.runStart;
  addCoins(120);
  const prevBest = ghostBestMs;
  const isRecord = !prevBest || elapsed < prevBest;
  if (isRecord) { lsSet(ttKeyBest(), elapsed); lsSet(ttKeyGhost(), JSON.stringify({ dt: 0.1, samples: ghostRec })); }
  saveProgress();
  document.getElementById('win-title').innerHTML = isRecord ? '⏱️ <span class="accent">New Record!</span>' : '⏱️ <span class="accent">Time Trial Complete</span>';
  document.getElementById('win-sub').textContent = isRecord ? 'Your fastest run yet — ghost saved for next time.' : (prevBest ? 'Best so far: ' + fmtTime(prevBest) : 'Run saved.');
  document.getElementById('win-time').textContent = fmtTime(elapsed);
  document.getElementById('win-dist').textContent = (State.distance / 1000).toFixed(2) + ' km';
  document.getElementById('win-overlay').classList.add('show');
  clearRunHud();
  if (Audio.engineGain && Audio.ctx) Audio.engineGain.gain.setTargetAtTime(0, Audio.ctx.currentTime, 0.3);
  playFanfare();
}
function updateTimeTrial(dt) {
  if (State.mode !== 'timetrial' || State.ttFinished) return;
  recordGhostSample(dt);
  playGhost(clock.elapsedTime - State.runStart);
  const mile = Math.floor(State.distance / 500);
  if (mile > ttMile) { ttMile = mile; const left = TT_DIST - State.distance; if (left > 0) showToast('⏱️ ' + (left / 1000).toFixed(1) + ' km to go', ''); }
  if (State.distance >= TT_DIST) ttComplete();
}

// ---------------------------------------------------------------------------
// Audio (WebAudio synthesised engine + ambient)
// ---------------------------------------------------------------------------
const Audio = {
  ctx: null, started: false,
  engineOsc: null, engineOsc2: null, engineOsc3: null, engineSub: null,
  engineGain: null, engineFilter: null, engineShaper: null,
  tyreSrc: null, tyreFilter: null, tyreGain: null,
  windFilter: null, windGain: null,
  ambGain: null, ambNodes: [], masterGain: null, limiter: null, pan: null,
  // sampled (CC0) sounds
  buffers: {}, sampleEngine: null, sampleEngineGain: null, useSample: false, skidCD: 0,
  gear: 1, gearBlip: 0   // simulated gearbox for engine pitch (discrete RPM bands)
};
const NUM_GEARS = 5;

// CC0 Kenney racing audio (decoded into AudioBuffers; synth is the fallback)
const SOUND_URLS = { engine: 'assets/audio/engine.ogg', engineBike: 'assets/audio/engine-bike.ogg',
                     impact: 'assets/audio/impact.ogg', skid: 'assets/audio/skid.ogg' };
function loadSounds() {
  const ctx = Audio.ctx; if (!ctx || typeof fetch !== 'function') return;
  Object.entries(SOUND_URLS).forEach(([name, url]) => {
    fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(buf => {
      Audio.buffers[name] = buf;
      const engKey = selectedVehicle === 'bike' ? 'engineBike' : 'engine';
      if (name === engKey && !Audio.useSample) startSampledEngine(buf);
    }).catch(() => { /* keep synth fallback */ });
  });
}
function startSampledEngine(buf) {
  const ctx = Audio.ctx; if (!ctx) return;
  Audio.useSample = true;
  Audio.sampleEngineGain = ctx.createGain(); Audio.sampleEngineGain.gain.value = 0;
  Audio.sampleEngineGain.connect(Audio.masterGain);
  Audio.sampleEngine = ctx.createBufferSource();
  Audio.sampleEngine.buffer = buf; Audio.sampleEngine.loop = true;
  Audio.sampleEngine.connect(Audio.sampleEngineGain);
  Audio.sampleEngine.start();
  // fade the synth engine out — the sample takes over
  Audio.engineGain.gain.setTargetAtTime(0, ctx.currentTime, 0.2);
}
function playSample(name, gain, rate) {
  const ctx = Audio.ctx, buf = Audio.buffers[name];
  if (!ctx || State.muted || !buf) return false;
  const src = ctx.createBufferSource(); src.buffer = buf; if (rate) src.playbackRate.value = rate;
  const g = ctx.createGain(); g.gain.value = gain == null ? 1 : gain;
  src.connect(g); g.connect(Audio.masterGain);
  src.onended = () => { try { src.disconnect(); g.disconnect(); } catch (e) {} };
  src.start();
  return true;
}

function makeNoiseBuffer(ctx, seconds) {
  const len = ctx.sampleRate * seconds;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}
function makeDistCurve(amount) {
  const n = 256, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * amount); }
  return c;
}

function initAudio() {
  if (Audio.started) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  Audio.ctx = new Ctx();
  const ctx = Audio.ctx;

  Audio.masterGain = ctx.createGain();
  Audio.masterGain.gain.value = State.muted ? 0 : Settings.volume;
  // Bus everything through a limiter before the speakers: synth engine + sampled engine +
  // tyre + wind + one-shot SFX can sum past 0 dBFS and clip. A compressor tames the peaks
  // and keeps loudness steady instead of jumping when several sources hit at once.
  if (ctx.createDynamicsCompressor) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 4;
    comp.attack.value = 0.003; comp.release.value = 0.25;
    Audio.masterGain.connect(comp); comp.connect(ctx.destination);
    Audio.limiter = comp;
  } else {
    Audio.masterGain.connect(ctx.destination);
  }
  // stereo placement for rolling noise (panned by steering/slip so corners feel directional)
  Audio.pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (Audio.pan) Audio.pan.connect(Audio.masterGain);

  // --- Engine: sub + 3 detuned voices → waveshaper grit → lowpass ---
  // grit differs per vehicle: truck = smooth rumble, car = muscle, bike = raspy
  Audio.engineShaper = ctx.createWaveShaper();
  const grit = selectedVehicle === 'truck' ? 1.5 : (selectedVehicle === 'bike' ? 3.8 : 2.4);
  Audio.engineShaper.curve = makeDistCurve(grit);
  Audio.engineFilter = ctx.createBiquadFilter();
  Audio.engineFilter.type = 'lowpass';
  Audio.engineFilter.frequency.value = 600;
  Audio.engineFilter.Q.value = 0.8;
  Audio.engineGain = ctx.createGain();
  Audio.engineGain.gain.value = 0.0;

  Audio.engineSub = ctx.createOscillator(); Audio.engineSub.type = 'sine';
  Audio.engineOsc = ctx.createOscillator(); Audio.engineOsc.type = 'sawtooth';
  Audio.engineOsc2 = ctx.createOscillator(); Audio.engineOsc2.type = 'square'; Audio.engineOsc2.detune.value = -10;
  Audio.engineOsc3 = ctx.createOscillator(); Audio.engineOsc3.type = 'sawtooth'; Audio.engineOsc3.detune.value = 14;
  [Audio.engineSub, Audio.engineOsc, Audio.engineOsc2, Audio.engineOsc3].forEach(o => o.connect(Audio.engineShaper));
  Audio.engineShaper.connect(Audio.engineFilter);
  Audio.engineFilter.connect(Audio.engineGain);
  Audio.engineGain.connect(Audio.masterGain);
  [Audio.engineSub, Audio.engineOsc, Audio.engineOsc2, Audio.engineOsc3].forEach(o => o.start());

  // --- Tyre/road roar + wind: one noise source, two filtered buses (speed-scaled) ---
  const noiseBuf = makeNoiseBuffer(ctx, 2);
  Audio.tyreSrc = ctx.createBufferSource(); Audio.tyreSrc.buffer = noiseBuf; Audio.tyreSrc.loop = true;
  Audio.tyreFilter = ctx.createBiquadFilter(); Audio.tyreFilter.type = 'bandpass';
  Audio.tyreFilter.frequency.value = 900; Audio.tyreFilter.Q.value = 0.7;
  Audio.tyreGain = ctx.createGain(); Audio.tyreGain.gain.value = 0;
  const roadBus = Audio.pan || Audio.masterGain;
  Audio.tyreSrc.connect(Audio.tyreFilter); Audio.tyreFilter.connect(Audio.tyreGain); Audio.tyreGain.connect(roadBus);
  Audio.windFilter = ctx.createBiquadFilter(); Audio.windFilter.type = 'highpass'; Audio.windFilter.frequency.value = 2200;
  Audio.windGain = ctx.createGain(); Audio.windGain.gain.value = 0;
  Audio.tyreSrc.connect(Audio.windFilter); Audio.windFilter.connect(Audio.windGain); Audio.windGain.connect(roadBus);
  Audio.tyreSrc.start();

  buildAmbient();
  buildMusic();        // generative ambient soundtrack (no assets)
  loadSounds();        // async-load CC0 samples; sampled engine swaps in when ready
  Audio.started = true;
}

// Generative soundtrack: a slow triangle-wave pad through a soft lowpass, retuned through
// a gentle vi–IV–I–V chord loop. Fully synthesised (no audio files), mixes under the engine
// via masterGain (so master volume + mute + the limiter all apply).
const MUSIC_CHORDS = [
  [110.0, 261.6, 329.6],   // Am
  [87.31, 220.0, 261.6],   // F
  [130.8, 329.6, 392.0],   // C
  [98.00, 246.9, 293.7]    // G
];
function buildMusic() {
  const ctx = Audio.ctx; if (!ctx) return;
  Audio.musicFilter = ctx.createBiquadFilter();
  Audio.musicFilter.type = 'lowpass'; Audio.musicFilter.frequency.value = 950; Audio.musicFilter.Q.value = 0.4;
  Audio.musicGain = ctx.createGain(); Audio.musicGain.gain.value = 0;
  Audio.musicFilter.connect(Audio.musicGain); Audio.musicGain.connect(Audio.masterGain);
  Audio.musicVoices = [0, 1, 2].map((i) => {
    const o = ctx.createOscillator(); o.type = i === 0 ? 'sine' : 'triangle';
    o.frequency.value = MUSIC_CHORDS[0][i]; o.detune.value = (i - 1) * 4;
    const g = ctx.createGain(); g.gain.value = i === 0 ? 0.5 : 0.34;
    o.connect(g); g.connect(Audio.musicFilter); o.start();
    return { o, g };
  });
  Audio.musicT = 0; Audio.musicChord = 0;
}
function updateMusic(dt, t) {
  if (!Audio.musicVoices) return;
  const BAR = 6;                                   // seconds per chord
  Audio.musicT += dt;
  if (Audio.musicT >= BAR) {
    Audio.musicT -= BAR;
    Audio.musicChord = (Audio.musicChord + 1) % MUSIC_CHORDS.length;
    const ch = MUSIC_CHORDS[Audio.musicChord];
    Audio.musicVoices.forEach((v, i) => v.o.frequency.setTargetAtTime(ch[i % ch.length], t, 0.9));
  }
  // slow breathing swell; duck a touch at speed so it never competes with the engine
  const speedDuck = 1 - 0.4 * Math.min(1, Math.abs(State.speed) / 40);
  const level = Settings.musicOn ? (0.07 + 0.025 * Math.sin(t * 0.25)) * speedDuck : 0;
  Audio.musicGain.gain.setTargetAtTime(level, t, 0.6);
}

function buildAmbient() {
  // remove old ambient
  Audio.ambNodes.forEach(n => { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} });
  Audio.ambNodes = [];
  const ctx = Audio.ctx;
  if (!ctx) return;
  const S = SEASONS[selectedSeason];

  Audio.ambGain = ctx.createGain();
  Audio.ambGain.gain.value = 0.0;
  Audio.ambGain.connect(Audio.masterGain);

  // pink-ish noise buffer for wind/rain
  const bufLen = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, bufLen, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < bufLen; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer; noise.loop = true;

  const filt = ctx.createBiquadFilter();
  if (S.sound === 'rain') { filt.type = 'highpass'; filt.frequency.value = 1200; }
  else if (S.sound === 'wind') { filt.type = 'lowpass'; filt.frequency.value = 500; }
  else { filt.type = 'lowpass'; filt.frequency.value = 800; }

  noise.connect(filt); filt.connect(Audio.ambGain);
  noise.start();
  Audio.ambNodes.push(noise);

  // birds / cicada chirps via scheduled oscillators handled in updateAudio
  Audio.ambGain.gain.setTargetAtTime(S.sound === 'rain' ? 0.5 : (S.sound === 'wind' ? 0.4 : 0.18), ctx.currentTime, 1.0);
}

let chirpTimer = 0;
function updateAudio(dt, maxMs) {
  if (!Audio.started || !Audio.ctx) return;
  const ctx = Audio.ctx;
  const t = ctx.currentTime;
  const sp = Math.abs(State.speed) / maxMs; // 0..1
  const V = VEHICLES[selectedVehicle];

  // engine pitch base by vehicle type; idle hum even at rest
  const base = V.engine === 'low' ? 36 : (V.engine === 'high' ? 76 : 52);
  // Gearbox: split the speed range into gears so RPM sweeps up within a gear then drops
  // on the shift, instead of one flat linear sweep. Pitch tracks in-gear revs, not raw speed.
  const gear = Math.min(NUM_GEARS, 1 + Math.floor(sp * NUM_GEARS * 0.999));
  if (gear !== Audio.gear) {
    if (gear > Audio.gear) { Audio.gearBlip = 0.09; playGearShift(); }  // brief cut + clunk on upshift
    Audio.gear = gear;
  }
  if (Audio.gearBlip > 0) Audio.gearBlip = Math.max(0, Audio.gearBlip - dt);
  const gearLo = (gear - 1) / NUM_GEARS, gearHi = gear / NUM_GEARS;
  const inGear = gearHi > gearLo ? (sp - gearLo) / (gearHi - gearLo) : 0;   // 0..1 revs within gear
  const rpm = base + (0.35 + 0.65 * inGear) * (V.engine === 'high' ? 360 : 230);
  Audio.engineOsc.frequency.setTargetAtTime(rpm, t, 0.05);
  Audio.engineOsc2.frequency.setTargetAtTime(rpm * 0.5, t, 0.05);
  Audio.engineOsc3.frequency.setTargetAtTime(rpm * 1.01, t, 0.05);
  Audio.engineSub.frequency.setTargetAtTime(rpm * 0.5, t, 0.05);
  // brighter under throttle (engine "load"), darker when coasting; tone per vehicle
  const load = keys.up ? 1 : (keys.down || keys.brake ? 0.4 : 0.62);
  const toneBase = V.engine === 'low' ? 260 : (V.engine === 'high' ? 620 : 420);   // truck darker, bike brighter
  const toneRange = V.engine === 'low' ? 1400 : (V.engine === 'high' ? 2400 : 1900);
  Audio.engineFilter.frequency.setTargetAtTime(toneBase + sp * toneRange + load * 500, t, 0.09);
  const blipDuck = Audio.gearBlip > 0 ? 0.35 : 1;   // throttle cut during an upshift
  const targetGain = (0.05 + sp * 0.11) * (0.7 + load * 0.5) * (V.engine === 'low' ? 1.15 : 1) * blipDuck;
  Audio.engineGain.gain.setTargetAtTime(Audio.useSample ? 0 : targetGain, t, 0.05);

  // sampled engine (CC0): pitch tracks in-gear revs (not raw speed) + throttle-load volume,
  // matching the synth gearbox so the swap is seamless; ducks on the shift blip too
  if (Audio.useSample && Audio.sampleEngine) {
    Audio.sampleEngine.playbackRate.setTargetAtTime(0.7 + (gear - 1) * 0.18 + inGear * 0.9, t, 0.05);
    Audio.sampleEngineGain.gain.setTargetAtTime((0.25 + sp * 0.5) * (0.7 + load * 0.5) * blipDuck, t, 0.06);
  }

  // tyre/road roar grows with speed (louder & grittier off-road), wind at high speed;
  // tyre timbre shifts per surface so wet/sandy/dry seasons sound distinct
  const tyre = (0.015 + sp * 0.14) * (State.offRoad ? 1.7 : 1);
  const tyreHz = State.offRoad ? 600 : (SEASONS[selectedSeason].sound === 'rain' ? 1300 : (selectedSeason === 'desert' ? 1450 : 1100));
  Audio.tyreFilter.frequency.setTargetAtTime(tyreHz, t, 0.2);
  Audio.tyreGain.gain.setTargetAtTime(Math.abs(State.speed) > 1 ? tyre : 0, t, 0.15);
  Audio.windGain.gain.setTargetAtTime(sp * sp * 0.09, t, 0.15);

  // stereo pan: corner load + slip slide the rolling noise toward the turn
  if (Audio.pan) {
    const p = Math.max(-1, Math.min(1, State.steer * 0.5 + (State.vx * Math.cos(State.heading) - State.vz * Math.sin(State.heading)) * 0.03));
    Audio.pan.pan.setTargetAtTime(p, t, 0.1);
  }

  updateMusic(dt, t);

  // skid sample on hard braking OR while drifting (tyres screech)
  if (Audio.skidCD > 0) Audio.skidCD -= dt;
  const skidding = Math.abs(State.speed) > 12 && (keys.brake || State.slip > 0.3);
  if (skidding && Audio.skidCD <= 0) {
    // louder & more frequent the harder you're sliding (sparse 0.9s → tight 0.45s)
    if (playSample('skid', Math.min(0.8, 0.4 + State.slip * 0.5))) Audio.skidCD = State.slip > 0.5 ? 0.45 : 0.9;
  }

  // ambient chirps (birds / cicada)
  const S = SEASONS[selectedSeason];
  if (S.sound === 'birds' || S.sound === 'cicada') {
    chirpTimer -= dt;
    if (chirpTimer <= 0) {
      chirpTimer = 0.4 + Math.random() * 1.6;
      playChirp(S.sound);
    }
  }
}

function playChirp(kind) {
  const ctx = Audio.ctx;
  if (!ctx || State.muted) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = kind === 'cicada' ? 'sawtooth' : 'sine';
  const f = kind === 'cicada' ? 2400 + Math.random() * 600 : 1800 + Math.random() * 1400;
  o.frequency.value = f;
  g.gain.value = 0;
  o.connect(g); g.connect(Audio.masterGain);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(kind === 'cicada' ? 0.04 : 0.06, t + 0.03);
  if (kind === 'birds') o.frequency.linearRampToValueAtTime(f * 1.5, t + 0.12);
  g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'cicada' ? 0.5 : 0.22));
  o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
  o.start(t); o.stop(t + 0.6);
}

// short rising two-note "objective complete" ding
function playDing() {
  const ctx = Audio.ctx;
  if (!ctx || State.muted) return;
  [880, 1320].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    o.connect(g); g.connect(Audio.masterGain);
    const t = ctx.currentTime + i * 0.09;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
    o.start(t); o.stop(t + 0.3);
  });
}

// impact thud for crashes / landings (filtered noise burst)
function playThud(strength) {
  const ctx = Audio.ctx;
  if (!ctx || State.muted) return;
  const len = Math.floor(ctx.sampleRate * 0.25);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 220;
  const g = ctx.createGain(); g.gain.value = Math.min(0.5, 0.25 * strength);
  src.connect(filt); filt.connect(g); g.connect(Audio.masterGain);
  src.onended = () => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) {} };
  src.start();
}

// short filtered-noise burst helper (used by splash/smash)
function noiseBurst(dur, gain, filterType, freq, q) {
  const ctx = Audio.ctx;
  if (!ctx || State.muted) return;
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const filt = ctx.createBiquadFilter(); filt.type = filterType; filt.frequency.value = freq; if (q) filt.Q.value = q;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(filt); filt.connect(g); g.connect(Audio.masterGain);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.onended = () => { try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) {} };
  src.start();
}

// water splash — bright, swishy noise (pond crossing)
function playSplash() {
  if (!Audio.ctx || State.muted) return;
  noiseBurst(0.4, 0.28, 'highpass', 1600, 0.6);
  noiseBurst(0.25, 0.18, 'bandpass', 2600, 1.2);
}

// crash/smash — real CC0 impact sample if loaded, else synth crunch + thump.
// `kind` gives each material its own voice: tin barrels ring high, crates thunk mid,
// mailboxes/signs click thin, hay/bush is a soft dull pad, trees/huts a heavy crack.
const SMASH_VOICE = {
  barrel:   { rate: 1.25, freq: 2400, q: 1.4, dur: 0.22, gain: 0.34, thud: 0.5 },
  crate:    { rate: 0.95, freq: 700,  q: 1.0, dur: 0.30, gain: 0.40, thud: 0.9 },
  mailbox:  { rate: 1.4,  freq: 4200, q: 2.0, dur: 0.10, gain: 0.30, thud: 0.3 },
  sign:     { rate: 1.35, freq: 3600, q: 1.8, dur: 0.12, gain: 0.30, thud: 0.3 },
  haybale:  { rate: 0.8,  freq: 420,  q: 0.6, dur: 0.30, gain: 0.30, thud: 0.5 },
  bush:     { rate: 1.1,  freq: 3000, q: 0.5, dur: 0.16, gain: 0.22, thud: 0.2 },
  fence:    { rate: 1.0,  freq: 1200, q: 1.0, dur: 0.26, gain: 0.36, thud: 0.7 },
  barricade:{ rate: 1.0,  freq: 1000, q: 1.0, dur: 0.28, gain: 0.40, thud: 0.9 }
};
function playSmash(kind) {
  if (!Audio.ctx || State.muted) return;
  const v = SMASH_VOICE[kind] || { rate: 1.0, freq: 900, q: 1.0, dur: 0.35, gain: 0.4, thud: 1.1 };
  if (playSample('impact', 0.7, v.rate * (0.92 + Math.random() * 0.16))) { playThud(v.thud); return; }
  noiseBurst(v.dur, v.gain, 'bandpass', v.freq, v.q);
  playThud(v.thud);
}

// quick gearbox "clunk" on an upshift — short bandpassed noise tick
function playGearShift() {
  if (!Audio.ctx || State.muted) return;
  noiseBurst(0.06, 0.12, 'bandpass', 1400, 1.6);
}

// jump touchdown — thud + a quick "sproing" rebound from the suspension
function playLanding() {
  const ctx = Audio.ctx;
  playThud(0.55);
  if (!ctx || State.muted) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = 'sine';
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(60, t + 0.18);   // downward boing
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g); g.connect(Audio.masterGain);
  o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
  o.start(t); o.stop(t + 0.24);
}

// victory arpeggio
function playFanfare() {
  const ctx = Audio.ctx;
  if (!ctx || State.muted) return;
  [523, 659, 784, 1047].forEach((f, i) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.value = f;
    o.connect(g); g.connect(Audio.masterGain);
    const t = ctx.currentTime + i * 0.14;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.14, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.onended = () => { try { o.disconnect(); g.disconnect(); } catch (e) {} };
    o.start(t); o.stop(t + 0.55);
  });
}

function setMuted(m) {
  State.muted = m;
  if (Audio.masterGain && Audio.ctx) {
    Audio.masterGain.gain.setTargetAtTime(m ? 0 : Settings.volume, Audio.ctx.currentTime, 0.1);
  }
  showToast(m ? '🔇 Muted' : '🔊 Sound on', 'Press M to toggle');
}

// ---------------------------------------------------------------------------
// Main animation frame
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  // Tab hidden: don't simulate or render — no point drawing an invisible canvas, and it
  // saves real CPU/GPU/battery. clock.getDelta keeps accumulating, so the first visible
  // frame just gets clamped to the 0.05 cap below rather than a huge catch-up step.
  if (document.hidden) return;
  pollGamepad();
  const dt = Math.min(0.05, clock.getDelta());
  if (State.running && !State.paused) {
    update(dt);
  } else {
    // idle: still spin slight ambient
    updateParticles(dt);
  }
  if (postReady && composer) composer.render(); else renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function bindInput() {
  window.addEventListener('keydown', e => {
    // Browsers start the AudioContext suspended until a user gesture. Keyboard players
    // would otherwise get a silent game until they touched the UI — wake it on any key.
    if (Audio.ctx && Audio.ctx.state === 'suspended' && !State.paused) Audio.ctx.resume();
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': keys.up = true; e.preventDefault(); break;
      case 'ArrowDown': case 'KeyS': keys.down = true; e.preventDefault(); break;
      case 'ArrowLeft': case 'KeyA': keys.left = true; e.preventDefault(); break;
      case 'ArrowRight': case 'KeyD': keys.right = true; e.preventDefault(); break;
      case 'Space': keys.brake = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': keys.drift = true; break;   // handbrake / drift
      case 'KeyC': if (State.running) State.camMode = (State.camMode + 1) % 3; break;
      case 'KeyF': if (State.running) {
          State.autodrive = !State.autodrive;
          updateModePill();
          showToast(State.autodrive ? '🌿 Autodrive ON' : 'Autodrive OFF', 'Press F to toggle');
        } break;
      case 'KeyM': setMuted(!State.muted); break;
      case 'KeyK': {
        Settings.musicOn = !Settings.musicOn; lsSet('openroads_music', Settings.musicOn ? '1' : '0');
        showToast(Settings.musicOn ? '🎵 Music on' : '🎵 Music off', 'Press K to toggle');
      } break;
      case 'KeyN': if (State.running) {
          State.minimap = !State.minimap;
          const nav = (State.mode === 'challenge' || State.mode === 'timetrial');
          document.getElementById('minimap').style.display = (nav && State.minimap) ? 'block' : 'none';
          showToast(State.minimap ? '🗺️ Minimap on' : 'Minimap off', '');
        } break;
      case 'KeyP': case 'Escape': if (State.running) togglePause(); break;
    }
  });
  window.addEventListener('keyup', e => {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': keys.up = false; break;
      case 'ArrowDown': case 'KeyS': keys.down = false; break;
      case 'ArrowLeft': case 'KeyA': keys.left = false; break;
      case 'ArrowRight': case 'KeyD': keys.right = false; break;
      case 'Space': keys.brake = false; break;
      case 'ShiftLeft': case 'ShiftRight': keys.drift = false; break;
    }
  });
  // pause when tab hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && State.running && !State.paused) togglePause();
  });

  setupTouch();
}

// ---------------------------------------------------------------------------
// Gamepad — standard mapping. Polled once per frame from animate(). To coexist
// with keyboard/touch (which write `keys` directly), the pad only clears the
// inputs IT asserted last frame, so an idle/plugged-in controller never fights
// the keyboard.
// ---------------------------------------------------------------------------
const GP = { set: {}, cam: false, pause: false, auto: false };
function pollGamepad() {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
  let gp = null;
  const pads = navigator.getGamepads();
  for (let i = 0; i < pads.length; i++) { if (pads[i] && pads[i].connected) { gp = pads[i]; break; } }
  // release whatever the pad held last frame (leaves keyboard/touch flags alone)
  for (const k in GP.set) { if (GP.set[k]) keys[k] = false; }
  GP.set = {};
  if (!gp) return;
  const btn = gp.axes && gp.buttons ? gp.buttons : [];
  const ax = gp.axes || [];
  const val = i => (btn[i] ? btn[i].value : 0);
  const down = i => (btn[i] ? btn[i].pressed : false);
  const assert = (k, on) => { if (on) { keys[k] = true; GP.set[k] = true; } };

  const sx = Math.abs(ax[0] || 0) > 0.22 ? ax[0] : 0;   // left stick X (deadzoned)
  assert('left',  sx < -0.22 || down(14));
  assert('right', sx >  0.22 || down(15));
  assert('up',    val(7) > 0.15 || down(12));            // RT / dpad-up = accelerate
  assert('down',  val(6) > 0.15 || down(13));            // LT / dpad-down = reverse
  assert('brake', down(0));                              // A = brake
  assert('drift', down(5) || down(1));                   // RB / B = handbrake
  if (Audio.ctx && Audio.ctx.state === 'suspended' && !State.paused &&
      (val(7) > 0.1 || val(6) > 0.1 || down(0))) Audio.ctx.resume();

  // edge-triggered toggles (Y = camera, Start = pause, X = autodrive)
  if (down(3) && !GP.cam && State.running) State.camMode = (State.camMode + 1) % 3;
  GP.cam = down(3);
  if (down(9) && !GP.pause && State.running) togglePause();
  GP.pause = down(9);
  if (down(2) && !GP.auto && State.running) {
    State.autodrive = !State.autodrive; updateModePill();
    showToast(State.autodrive ? '🌿 Autodrive ON' : 'Autodrive OFF', 'Press F / ✕ to toggle');
  }
  GP.auto = down(2);
}

// On-screen buttons drive the same `keys` flags as the keyboard.
function setupTouch() {
  const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  if (isTouch) document.body.classList.add('touch');
  document.querySelectorAll('#touch .tbtn').forEach(btn => {
    const k = btn.dataset.k;
    const press = (e) => { e.preventDefault(); keys[k] = true; if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume(); };
    const release = (e) => { e.preventDefault(); keys[k] = false; };
    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });
    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
  });
  setupAnalogPad('t-joy', 'horizontal');    // steering joystick
  setupAnalogPad('t-thr', 'vertical');      // throttle / reverse pad
}

// A draggable analog pad: horizontal drives State.touchSteer, vertical drives
// State.touchThrottle. It also sets the matching binary `keys` so all the existing
// keys-based logic (audio load, autodrive override, mission detection) keeps working.
function setupAnalogPad(id, axis) {
  const pad = document.getElementById(id);
  if (!pad) return;
  const knob = pad.querySelector('.t-knob');
  let active = null;                       // active touch identifier (or 'mouse')
  const reset = () => {
    active = null;
    if (knob) knob.style.transform = 'translate(0,0)';
    if (axis === 'horizontal') { State.touchSteer = null; keys.left = keys.right = false; }
    else { State.touchThrottle = null; keys.up = keys.down = false; }
  };
  const apply = (clientX, clientY) => {
    const r = pad.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const rad = r.width / 2;
    if (axis === 'horizontal') {
      const v = Math.max(-1, Math.min(1, (clientX - cx) / rad));
      State.touchSteer = -v;               // drag right → turn right (matches keyboard sign)
      keys.left = v < -0.15; keys.right = v > 0.15;
      if (knob) knob.style.transform = 'translate(' + (v * rad * 0.55).toFixed(0) + 'px,0)';
    } else {
      const v = Math.max(-1, Math.min(1, -(clientY - cy) / rad));   // up = accelerate
      State.touchThrottle = v;
      keys.up = v > 0.15; keys.down = v < -0.15;
      if (knob) knob.style.transform = 'translate(0,' + (-v * rad * 0.55).toFixed(0) + 'px)';
    }
    if (Audio.ctx && Audio.ctx.state === 'suspended' && !State.paused) Audio.ctx.resume();
  };
  pad.addEventListener('touchstart', (e) => { e.preventDefault(); const t = e.changedTouches[0]; active = t.identifier; apply(t.clientX, t.clientY); }, { passive: false });
  pad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) if (t.identifier === active) { apply(t.clientX, t.clientY); break; }
  }, { passive: false });
  const endTouch = (e) => { for (const t of e.changedTouches) if (t.identifier === active) { reset(); break; } };
  pad.addEventListener('touchend', endTouch, { passive: false });
  pad.addEventListener('touchcancel', endTouch, { passive: false });
  // mouse fallback (desktop testing)
  pad.addEventListener('mousedown', (e) => { e.preventDefault(); active = 'mouse'; apply(e.clientX, e.clientY); });
  window.addEventListener('mousemove', (e) => { if (active === 'mouse') apply(e.clientX, e.clientY); });
  window.addEventListener('mouseup', () => { if (active === 'mouse') reset(); });
}

function togglePause() {
  if (!State.running) return;
  State.paused = !State.paused;
  const pm = document.getElementById('pause-menu');
  pm.classList.toggle('show', State.paused);
  if (State.paused) {                       // sync the menu controls to current settings
    const pv = document.getElementById('p-vol');
    pv.value = Math.round(Settings.volume * 100);
    document.getElementById('p-vol-val').textContent = pv.value;
    document.querySelectorAll('#p-quality .choice').forEach(c => c.classList.toggle('active', c.dataset.key === Settings.quality));
  }
  if (Audio.ctx) { if (State.paused) Audio.ctx.suspend(); else Audio.ctx.resume(); }
}

// ---------------------------------------------------------------------------
// Menu wiring
// ---------------------------------------------------------------------------
const MODES = {
  challenge: { name: 'Challenge Run', icon: '🏁', desc: '10 objectives along the route' },
  timetrial: { name: 'Time Trial',    icon: '⏱️', desc: 'Same track · race your ghost' },
  zen:       { name: 'Zen Drive',     icon: '🌿', desc: 'Just cruise · autodrive (F)' },
  practice:  { name: 'Practice',      icon: '🎓', desc: 'Learn the controls, no pressure' }
};
// graphics quality presets (sub-label shown on each chip)
const QOPTS = [['low', 'Low', 'Best performance'], ['med', 'Medium', 'Balanced'], ['high', 'High', 'Best visuals']];
const AOPTS = [['cel', 'Cel-Shaded', 'Inked comic look'], ['flat', 'Flat Low-Poly', 'Faceted polygon look']];

// Repaint vehicle chips with lock/cost state + refresh coin balances (menu + win).
function refreshMenu() {
  const vc = document.getElementById('vehicle-choices');
  if (vc) vc.querySelectorAll('.choice').forEach(el => {
    const key = el.dataset.key, v = VEHICLES[key], locked = !isUnlocked(key);
    el.className = 'choice' + (key === selectedVehicle ? ' active' : '') + (locked ? ' locked' : '');
    el.innerHTML = `<div class="icon">${v.icon}</div><div class="name">${v.name}</div>` +
      (locked ? `<div class="lock">🔒 ${UNLOCK_COST[key]} coins</div>` : `<div class="desc">${v.desc}</div>`);
  });
  const lc = document.getElementById('livery-choices');
  if (lc) lc.querySelectorAll('.choice').forEach(el => {
    const liv = LIVERIES.find(l => l.id === el.dataset.key); if (!liv) return;
    const locked = !liveryUnlocked(liv.id), sel = Progress.livery === liv.id;
    el.className = 'choice livery' + (sel ? ' active' : '') + (locked ? ' locked' : '');
    const sw = liv.color == null
      ? 'background:repeating-linear-gradient(45deg,#888,#888 4px,#aaa 4px,#aaa 8px)'
      : 'background:#' + new THREE.Color(liv.color).getHexString();
    el.innerHTML = `<div class="swatch" style="${sw};height:18px;border-radius:6px;margin-bottom:5px;"></div>` +
      `<div class="name">${liv.name}</div>` +
      (locked ? `<div class="lock">🔒 ${liv.cost}</div>` : '');
  });
  const cb = document.getElementById('coin-bal-n'); if (cb) cb.textContent = Math.floor(Progress.coins);
}

function buildMenu() {
  const mc = document.getElementById('mode-choices');
  Object.entries(MODES).forEach(([key, m]) => {
    const el = document.createElement('div');
    el.className = 'choice' + (key === State.mode ? ' active' : '');
    el.dataset.key = key;
    el.innerHTML = `<div class="icon">${m.icon}</div><div class="name">${m.name}</div><div class="desc">${m.desc}</div>`;
    el.addEventListener('click', () => {
      State.mode = key;
      mc.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
      const labels = { zen: 'Start Driving →', timetrial: 'Start Time Trial →', practice: 'Start Practice →', challenge: 'Start the Run →' };
      document.getElementById('start-btn').textContent = labels[key] || 'Start →';
    });
    mc.appendChild(el);
  });

  const vc = document.getElementById('vehicle-choices');
  Object.entries(VEHICLES).forEach(([key, v]) => {
    const el = document.createElement('div');
    el.className = 'choice';                 // so refreshMenu's selector finds it
    el.dataset.key = key;
    el.addEventListener('click', () => {
      if (!isUnlocked(key)) {                 // locked → try to buy it
        if (tryUnlock(key)) { showToast('🔓 ' + v.name + ' unlocked!', ''); playDing(); refreshMenu(); }
        else { showToast('🔒 Need ' + UNLOCK_COST[key] + ' coins', 'You have ' + Math.floor(Progress.coins)); return; }
      }
      selectedVehicle = key;
      vc.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
    });
    vc.appendChild(el);
  });

  // (re)paint vehicle chips with lock state + costs; also refreshes coin balances
  refreshMenu();

  const sc = document.getElementById('season-choices');
  Object.entries(SEASONS).forEach(([key, s]) => {
    const el = document.createElement('div');
    el.className = 'choice' + (key === selectedSeason ? ' active' : '');
    el.dataset.key = key;
    const c1 = '#' + new THREE.Color(s.ground).getHexString();
    const c2 = '#' + new THREE.Color(s.sky).getHexString();
    el.innerHTML = `<div class="name">${s.name}</div>
      <div class="swatch" style="background:linear-gradient(90deg,${c2},${c1})"></div>`;
    el.addEventListener('click', () => {
      selectedSeason = key;
      sc.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
    });
    sc.appendChild(el);
  });

  // livery / paint chips
  const lc = document.getElementById('livery-choices');
  if (lc) {
    LIVERIES.forEach(liv => {
      const el = document.createElement('div');
      el.className = 'choice livery';
      el.dataset.key = liv.id;
      el.style.minWidth = '74px'; el.style.padding = '8px 8px';
      el.addEventListener('click', () => {
        if (!liveryUnlocked(liv.id)) {
          if (tryUnlockLivery(liv.id)) { showToast('🎨 ' + liv.name + ' unlocked!', ''); playDing(); }
          else { showToast('🔒 Need ' + liv.cost + ' coins', 'You have ' + Math.floor(Progress.coins)); refreshMenu(); return; }
        }
        Progress.livery = liv.id; saveProgress();
        if (vehicleGroup && !State.running) { buildVehicle(); }   // live preview on the menu backdrop
        refreshMenu();
      });
      lc.appendChild(el);
    });
    refreshMenu();   // paint livery chips now that they exist (initial call ran before this)
  }

  // settings: volume slider + quality chips
  const vol = document.getElementById('vol'), volVal = document.getElementById('vol-val');
  vol.value = Math.round(Settings.volume * 100); volVal.textContent = vol.value;
  vol.addEventListener('input', () => { volVal.textContent = vol.value; setVolume(vol.value / 100); });
  const qc = document.getElementById('quality-choices');
  QOPTS.forEach(([key, label, desc]) => {
    const el = document.createElement('div');
    el.className = 'choice' + (key === Settings.quality ? ' active' : '');
    el.dataset.key = key;
    el.innerHTML = `<div class="name">${label}</div><div class="desc">${desc}</div>`;
    el.addEventListener('click', () => {
      setQuality(key);
      qc.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
      document.querySelectorAll('#p-quality .choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
    });
    qc.appendChild(el);
  });

  // art-style chips (cel-shaded ↔ flat low-poly) — applies live
  const ac = document.getElementById('art-choices');
  if (ac) {
    AOPTS.forEach(([key, label, desc]) => {
      const el = document.createElement('div');
      el.className = 'choice' + (key === Settings.artStyle ? ' active' : '');
      el.dataset.key = key;
      el.innerHTML = `<div class="name">${label}</div><div class="desc">${desc}</div>`;
      el.addEventListener('click', () => {
        setArtStyle(key);
        ac.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
      });
      ac.appendChild(el);
    });
  }
  if (document.body) document.body.classList.toggle('flat', Settings.artStyle === 'flat');

  // --- in-drive pause menu controls ---
  const pVol = document.getElementById('p-vol'), pVolVal = document.getElementById('p-vol-val');
  pVol.addEventListener('input', () => { pVolVal.textContent = pVol.value; setVolume(pVol.value / 100); vol.value = pVol.value; volVal.textContent = pVol.value; });
  const pq = document.getElementById('p-quality');
  QOPTS.forEach(([key, label, desc]) => {
    const el = document.createElement('div');
    el.className = 'choice' + (key === Settings.quality ? ' active' : '');
    el.dataset.key = key;
    el.innerHTML = `<div class="name">${label}</div><div class="desc">${desc}</div>`;
    el.addEventListener('click', () => {
      setQuality(key);
      pq.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
      qc.querySelectorAll('.choice').forEach(c => c.classList.toggle('active', c.dataset.key === key));
    });
    pq.appendChild(el);
  });
  document.getElementById('pause-btn').addEventListener('click', togglePause);
  document.getElementById('resume-btn').addEventListener('click', () => { if (State.paused) togglePause(); });
  document.getElementById('pmenu-btn').addEventListener('click', () => {
    State.paused = false;
    document.getElementById('pause-menu').classList.remove('show');
    State.running = false;
    clearRunHud();
    saveProgress(); refreshMenu();
    document.getElementById('overlay').classList.remove('hidden');
    if (Audio.ctx) Audio.ctx.resume();
  });

  document.getElementById('best-val').textContent = (State.best / 1000).toFixed(2) + ' km';
  document.getElementById('start-btn').addEventListener('click', startGame);
  document.getElementById('replay-btn').addEventListener('click', () => {
    clearRunHud();
    saveProgress(); refreshMenu();
    document.getElementById('win-overlay').classList.remove('show');
    document.getElementById('overlay').classList.remove('hidden');
  });
  renderMissionList();
}

function startGame() {
  // reset run state
  State.speed = 0; State.distance = 0; State.s = 0;
  State.carX = 0; State.carZ = 0; State.heading = 0;
  State.vx = 0; State.vz = 0; State.slip = 0;
  State.steer = 0;
  State.camMode = 0;
  State.prevSpeed = 0; State.pitchS = 0; State.rollS = 0; State.suspComp = 0; State.suspVel = 0;
  State._lastCoinD = 0;
  ROUTE_SEED = Math.floor(Math.random() * 1e6);   // a fresh, varied route every run
  State.jumpY = 0; State.vy = 0; State.airborne = false;
  State.hold70 = 0; State.pondTime = 0; State.reverseDist = 0;
  State.launchT = 0; State.driftDist = 0; State._driftReward = 0;
  State.touchSteer = null; State.touchThrottle = null;
  State.wasMoving = false; State.offRoad = false; State.won = false;
  State.ttFinished = false; State.ttSampleT = 0; ghostRec = []; ttMile = 0;
  State.tutStep = -1; State.tutT = 0;
  window.__coneProg = '0/6';
  // Time Trial pins a fixed seed so the track (and your ghost) are identical every run.
  ROUTE_SEED = (State.mode === 'timetrial') ? TT_SEED : Math.floor(Math.random() * 1e6);
  State.jumpY = 0; State.vy = 0; State.airborne = false;
  State.hold70 = 0; State.pondTime = 0; State.reverseDist = 0;
  Missions.reset();
  State.runStart = clock.elapsedTime;
  // Zen starts hands-off & objective-free; Challenge/Trial/Practice are manual
  State.autodrive = (State.mode === 'zen');
  document.getElementById('missions').style.display = (State.mode === 'challenge') ? 'block' : 'none';
  // minimap aids navigation in goal modes; off for zen/practice
  const navMode = (State.mode === 'challenge' || State.mode === 'timetrial');
  document.getElementById('minimap').style.display = (navMode && State.minimap) ? 'block' : 'none';
  showTutBanner(null);
  updateModePill();

  document.getElementById('win-overlay').classList.remove('show');

  if (State.mode === 'timetrial') loadGhost();
  buildWorld();
  buildVehicle();
  if (State.mode === 'timetrial') buildGhost();

  // place camera behind
  camera.position.set(0, 5.2, -11);

  initAudio();
  if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume();

  State.running = true;
  State.paused = false;
  document.getElementById('overlay').classList.add('hidden');

  // briefing: orient the player to the mode they just started
  if (State.mode === 'challenge') showToast('🏁 ' + MISSIONS.length + ' objectives', 'First up: ' + MISSIONS[0].label);
  else if (State.mode === 'timetrial') showToast('⏱️ ' + (TT_DIST / 1000).toFixed(1) + ' km sprint', ghostData ? 'Beat your ghost: ' + fmtTime(ghostBestMs) : 'Set a time — a ghost saves for next run');
  else if (State.mode === 'practice') startTutorial();
  else showToast('🌿 Zen Drive', 'Just cruise · F toggles autodrive');

  // try fullscreen (best effort; ignored if blocked)
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
}

// persist best score + earned coins periodically
setInterval(() => {
  if (State.running) {
    const best = Math.max(State.best, State.distance);
    if (best > State.best) {
      State.best = best;
      lsSet('openroads_best', best);
    }
    saveProgress();
  }
}, 2000);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function boot() {
  if (typeof THREE === 'undefined') {
    document.getElementById('loader').textContent = 'Failed to load 3D engine. Check your connection.';
    return;
  }
  initThree();
  buildMenu();
  bindInput();
  // build a calm idle world behind the menu
  buildWorld();
  buildVehicle();
  // lay the road/terrain/scenery out once so the menu backdrop is composed
  const sp0 = samplePath(0);
  vehicleGroup.position.set(sp0.x, sp0.y, sp0.z);
  vehicleGroup.rotation.y = Math.atan2(sp0.hx, sp0.hz);
  updateTerrain(true);
  updateRoadRibbon();
  positionProps();
  updateScenery();
  camera.position.set(6, 4.5, -10);
  camera.lookAt(0, 1.4, 6);
  document.getElementById('loader').style.display = 'none';
  animate();
}

window.addEventListener('load', boot);
