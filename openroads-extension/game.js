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
    wheel: { r: 0.5, offX: 1.02, offZ: 1.55 }, engine: 'mid'
  },
  bike: {
    name: 'Chopper', icon: '🏍️', desc: 'Raked-out American chopper',
    maxSpeed: 230, accel: 15, grip: 0.9, mass: 0.6, len: 1.7, turn: 2.0,
    wheel: { r: 0.62, offX: 0.0, offZ: 1.45 }, engine: 'high'
  },
  truck: {
    name: 'Big Rig', icon: '🚛', desc: 'Optimus-style hauler',
    maxSpeed: 160, accel: 8.5, grip: 1.3, mass: 2.4, len: 3.0, turn: 1.25,
    wheel: { r: 0.68, offX: 1.3, offZ: 2.5 }, engine: 'low'
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
const MAT = {
  paint:  (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: toonRamp() }),
  matte:  (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: toonRamp() }),
  chrome: () => new THREE.MeshToonMaterial({ color: 0xd2d7dd, gradientMap: toonRamp() }),
  glass:  () => new THREE.MeshToonMaterial({ color: 0x2c3e4c, gradientMap: toonRamp(), transparent: true, opacity: 0.82 }),
  tire:   () => new THREE.MeshToonMaterial({ color: 0x1b1e23, gradientMap: toonRamp() }),
  dark:   () => new THREE.MeshToonMaterial({ color: 0x2a2d33, gradientMap: toonRamp() }),
  light:  (c) => new THREE.MeshBasicMaterial({ color: c }),
  // ground/terrain & scenery want the toon banding too
  land:   (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: toonRamp() })
};

// Cheap "ink outline" for the hero vehicle: a slightly inflated back-face shell.
const OUTLINE_INK = 0x1b1d23;
function addVehicleOutline() {
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
      o.material = new THREE.MeshToonMaterial({
        color: (m && m.color) ? m.color.getHex() : 0xcccccc,
        map: (m && m.map) || null, gradientMap: toonRamp()
      });
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
  }, undefined, () => { /* missing/failed → keep procedural fallback */ });
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
const MISSIONS = [
  { id: 'speed80',  label: 'Reach 80 km/h',                    short: '80' },
  { id: 'hold70',   label: 'Hold 70+ km/h for 8s',            short: '8s', hasProgress: true },
  { id: 'speed120', label: 'Hit 120 km/h',                    short: '120' },
  { id: 'tree',     label: 'Go off-road & smash a big tree',  short: '🌳' },
  { id: 'hut',      label: 'Go off-road & flatten a hut',     short: '🛖' },
  { id: 'pond',     label: 'Cross an off-road pond',          short: '💧', hasProgress: true },
  { id: 'jump',     label: 'Big air: clear a hill ramp',      short: '⛰️' },
  { id: 'cones',    label: 'Bowl down a full set of cones',   short: '🚧', hasProgress: true },
  { id: 'stop',     label: 'Emergency stop from 80+ (Space)', short: '🛑' },
  { id: 'reverse',  label: 'Reverse 40 metres',               short: '40m', hasProgress: true }
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

const State = {
  running: false, paused: false, muted: false,
  speed: 0,          // signed, m/s along road
  steer: 0,          // -1..1 visual lean
  lateral: 0,        // x offset on road
  distance: 0,       // metres travelled (forward only, for HUD)
  best: parseFloat(localStorage.getItem('openroads_best') || '0'),
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
  // mission run state
  jumpY: 0, vy: 0, airborne: false,
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
  volume: (() => { const v = parseFloat(localStorage.getItem('openroads_vol')); return isNaN(v) ? 0.9 : v; })(),
  quality: localStorage.getItem('openroads_quality') || 'med'
};
function setVolume(v) {
  Settings.volume = Math.max(0, Math.min(1, v));
  localStorage.setItem('openroads_vol', String(Settings.volume));
  if (Audio.masterGain && Audio.ctx) Audio.masterGain.gain.setTargetAtTime(State.muted ? 0 : Settings.volume, Audio.ctx.currentTime, 0.05);
}
function applyQuality() {
  if (!renderer) return;
  const q = Settings.quality;
  const dpr = window.devicePixelRatio || 1;
  renderer.setPixelRatio(q === 'low' ? 1 : Math.min(dpr, q === 'high' ? 2 : 1.5));
  renderer.shadowMap.enabled = q !== 'low';
  if (sunLight) sunLight.castShadow = q !== 'low';
}
function setQuality(q) {
  Settings.quality = q;
  localStorage.setItem('openroads_quality', q);
  applyQuality();
}

// Progression: earn coins by driving/smashing/missions; spend them to unlock vehicles.
const Progress = {
  coins: parseInt(localStorage.getItem('openroads_coins') || '0', 10) || 0,
  unlocked: (() => { try { return JSON.parse(localStorage.getItem('openroads_unlocked')) || {}; } catch (e) { return {}; } })()
};
const UNLOCK_COST = { bike: 400, truck: 1200 };   // car is free
function isUnlocked(v) { return v === 'car' || !!Progress.unlocked[v]; }
function addCoins(n) { Progress.coins += n; }
function saveProgress() {
  localStorage.setItem('openroads_coins', String(Math.floor(Progress.coins)));
  localStorage.setItem('openroads_unlocked', JSON.stringify(Progress.unlocked));
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
let sunLight, ambLight, hemiLight;
let vehicleGroup, vehicleWheels = [];
let glbWheels = [];   // wheel nodes detected inside a loaded GLB model (spun in update)
let roadGroup, terrainGroup, sceneryPool = [];
let particleSystem = null, particleData = null;
let rainStreaks = null;

let camShake = 0;
function shakeCamera(amount) { camShake = Math.min(1.2, camShake + amount); }

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
function buildWorld() {
  const S = SEASONS[selectedSeason];

  scene.background = new THREE.Color(S.sky);
  scene.fog = new THREE.FogExp2(S.fog, S.fogDensity);
  buildSky(S);

  // Toon shading already supplies the banding, so total light must stay near 1.0 —
  // otherwise ambient+hemi+sun sum clips colours to white (the washed-out look).
  sunLight.color.setHex(S.sun);
  sunLight.intensity = S.sunInt * 0.85;
  ambLight.color.setHex(S.amb);
  ambLight.intensity = S.ambInt * 0.34;
  hemiLight.color.setHex(S.sky);
  hemiLight.groundColor.setHex(S.ground);
  hemiLight.intensity = (selectedSeason === 'monsoon') ? 0.28 : 0.36;

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
  tex.anisotropy = renderer ? renderer.capabilities.getMaxAnisotropy() : 1;
  return tex;
}

function buildRoad(S) {
  if (roadGroup) scene.remove(roadGroup);
  roadGroup = new THREE.Group();

  roadTex = makeRoadTexture(S);
  const mat = new THREE.MeshToonMaterial({ map: roadTex, gradientMap: toonRamp() });

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
  const water = () => new THREE.MeshToonMaterial({ color: 0x5fa8d6, gradientMap: toonRamp(), transparent: true, opacity: 0.85 });
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
    else if (kind === 'lake') off = 38 + Math.random() * 45;
    else if (kind === 'field') off = 26 + Math.random() * 55;
    else if (kind === 'rock') off = 12 + Math.random() * 60;
    else off = 11 + Math.random() * 70;                // trees: near to far clusters
    const s = (i / N) * SCENERY_SPAN + Math.random() * 6;
    // collision radius (0 = pass-through) + whether it shatters when smashed fast
    const CR = { tree: 1.3, rock: 1.4, fence: 1.7, sign: 0.5, barricade: 1.9,
                 haybale: 1.3, crate: 1.0, barrel: 0.8, mailbox: 0.5, bush: 1.1, lake: 0, field: 0,
                 building: 4, church: 3.5, pizza: 3, watertank: 1.8, park: 0, bridge: 0 };
    const BREAK = { tree: true, fence: true, sign: true, barricade: true,
                    haybale: true, crate: true, barrel: true, mailbox: true, bush: true };
    sceneryPool.push({ mesh, kind, side, off, s, spin: Math.random() * Math.PI,
                       cr: CR[kind] || 0, breakable: !!BREAK[kind], broken: false, breakT: 0 });
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
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshToonMaterial({ map: tex, gradientMap: toonRamp() }));
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
      new THREE.MeshToonMaterial({ color: 0x73b6d6, gradientMap: toonRamp(), transparent: true, opacity: 0.82 }));
    water.rotation.x = -Math.PI / 2; water.position.y = 0.06; g.add(water);
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
      new THREE.MeshToonMaterial({ color: 0x6fb4d8, gradientMap: toonRamp(), transparent: true, opacity: 0.82 }));
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
  const wy = onRoad ? sp.y : heightAt(wx, wz);
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
        playSmash();
        // smashing through costs less speed the faster you hit it
        State.speed *= (Math.abs(State.speed) * 3.6 > 50) ? 0.7 : 0.45;
        shakeCamera(0.5);
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

  addVehicleOutline();
  loadVehicleModel();          // swap in a real GLB if one is bundled for this vehicle

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
  const onRoadKind = (k) => k === 'fence' || k === 'sign' || k === 'barricade' || k === 'bridge';
  const acrossRoad = (k) => k === 'barricade' || k === 'bridge';
  const facesRoad = (k) => k === 'fence' || k === 'sign' || k === 'building' || k === 'church' || k === 'pizza' || k === 'watertank' || k === 'park';
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
    const wy = onRoadKind(o.kind) ? sp.y : heightAt(wx, wz);
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
        if (smashCooldown <= 0) { playSmash(); shakeCamera(0.35); smashCooldown = 0.12; }
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
  // engine torque tapers as you approach top speed (feels punchy off the line)
  if (keys.brake) {
    const dec = 48; // firm, progressive brake
    if (State.speed > 0) State.speed = Math.max(0, State.speed - dec * dt);
    else if (State.speed < 0) State.speed = Math.min(0, State.speed + dec * dt);
  } else if (keys.up) {
    // torque fades hard near the top end, so high speed is earned, not instant
    const torque = V.accel * (1 - 0.85 * Math.max(0, State.speed) / maxMs);
    State.speed += torque * dt;
  } else if (keys.down) {
    // brake first if moving forward, otherwise accelerate in reverse
    if (State.speed > 0.5) State.speed -= V.accel * 1.3 * dt;
    else State.speed -= V.accel * 0.55 * dt;
  } else if (autoOn && !userThrottle) {
    // ease toward a relaxed cruise (~62% of top speed)
    const cruise = maxMs * 0.62;
    State.speed += (cruise - State.speed) * Math.min(1, dt * 0.6);
  } else {
    // coast: rolling + aero drag (stronger at speed)
    const drag = (4 + Math.abs(State.speed) * 0.18) * dt;
    if (State.speed > 0) State.speed = Math.max(0, State.speed - drag);
    else if (State.speed < 0) State.speed = Math.min(0, State.speed + drag);
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
    const steerInput = (keys.left ? 1 : 0) - (keys.right ? 1 : 0);
    const returnRate = steerInput === 0 ? 9 : 7;
    State.steer += (steerInput - State.steer) * Math.min(1, dt * returnRate);
    // can't pivot when stopped; calmer at top speed so it stays controllable
    const turnAuth = V.turn * V.grip * Math.min(1, absSpeed / 7) * (1 - 0.42 * Math.min(1, absSpeed / maxMs));
    State.heading += State.steer * turnAuth * dt * Math.sign(State.speed || 1) * STEER_DIR;
  }

  // --- advance with grip/drift: velocity vector lags the heading by a grip factor ---
  const dir = { x: Math.sin(State.heading), z: Math.cos(State.heading) };
  const desVx = dir.x * State.speed, desVz = dir.z * State.speed;   // forward intent
  // grip = how fast velocity realigns to heading. Lower when handbraking, braking
  // hard, or steering hard at speed → the back slides (drift).
  const fastTurn = Math.abs(State.steer) * Math.min(1, absSpeed / maxMs);
  const grip = V.grip * (keys.drift ? 0.14 : (keys.brake ? 0.5 : 1)) * (1 - 0.34 * fastTurn);
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
  // vertical suspension spring (settles bumps, compresses+rebounds on landing)
  State.suspVel += (-State.suspComp) * 90 * dt - State.suspVel * 13 * dt;
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
  updateInteractables(dt);
  updateSplash(dt);
  updateParticles(dt);
  updateCamera(dt, speedFactor);
  updateAudio(dt, maxMs);
  updateHUD();
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
    camShake *= Math.max(0, 1 - dt * 6);
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
  document.getElementById('mode-name').textContent = State.mode === 'zen' ? 'Zen Drive' : 'Challenge';
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
      (m.hasProgress ? `<span class="prog" data-prog="${m.id}"></span>` : '');
    list.appendChild(li);
  });
  document.getElementById('m-count').textContent = Missions.count + ' / ' + MISSIONS.length;
}

function updateMissionProgress() {
  const h = document.querySelector('[data-prog="hold70"]');
  if (h && !Missions.done.hold70) h.textContent = Math.min(8, State.hold70).toFixed(1) + 's';
  const r = document.querySelector('[data-prog="reverse"]');
  if (r && !Missions.done.reverse) r.textContent = Math.min(40, State.reverseDist).toFixed(0) + 'm';
  const p = document.querySelector('[data-prog="pond"]');
  if (p && !Missions.done.pond) p.textContent = Math.min(100, Math.round(State.pondTime / 1.1 * 100)) + '%';
  const c = document.querySelector('[data-prog="cones"]');
  if (c && !Missions.done.cones) c.textContent = (window.__coneProg || '0/6');
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
  if (Audio.engineGain && Audio.ctx) Audio.engineGain.gain.setTargetAtTime(0, Audio.ctx.currentTime, 0.3);
  playFanfare();
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
  ambGain: null, ambNodes: [], masterGain: null,
  // sampled (CC0) sounds
  buffers: {}, sampleEngine: null, sampleEngineGain: null, useSample: false, skidCD: 0
};

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
  src.connect(g); g.connect(Audio.masterGain); src.start();
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
  Audio.masterGain.connect(ctx.destination);

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
  Audio.tyreSrc.connect(Audio.tyreFilter); Audio.tyreFilter.connect(Audio.tyreGain); Audio.tyreGain.connect(Audio.masterGain);
  Audio.windFilter = ctx.createBiquadFilter(); Audio.windFilter.type = 'highpass'; Audio.windFilter.frequency.value = 2200;
  Audio.windGain = ctx.createGain(); Audio.windGain.gain.value = 0;
  Audio.tyreSrc.connect(Audio.windFilter); Audio.windFilter.connect(Audio.windGain); Audio.windGain.connect(Audio.masterGain);
  Audio.tyreSrc.start();

  buildAmbient();
  loadSounds();        // async-load CC0 samples; sampled engine swaps in when ready
  Audio.started = true;
}

function buildAmbient() {
  // remove old ambient
  Audio.ambNodes.forEach(n => { try { n.stop && n.stop(); } catch (e) {} });
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
  const rpm = base + sp * (V.engine === 'high' ? 360 : 230);
  Audio.engineOsc.frequency.setTargetAtTime(rpm, t, 0.07);
  Audio.engineOsc2.frequency.setTargetAtTime(rpm * 0.5, t, 0.07);
  Audio.engineOsc3.frequency.setTargetAtTime(rpm * 1.01, t, 0.07);
  Audio.engineSub.frequency.setTargetAtTime(rpm * 0.5, t, 0.07);
  // brighter under throttle (engine "load"), darker when coasting; tone per vehicle
  const load = keys.up ? 1 : (keys.down || keys.brake ? 0.4 : 0.62);
  const toneBase = V.engine === 'low' ? 260 : (V.engine === 'high' ? 620 : 420);   // truck darker, bike brighter
  const toneRange = V.engine === 'low' ? 1400 : (V.engine === 'high' ? 2400 : 1900);
  Audio.engineFilter.frequency.setTargetAtTime(toneBase + sp * toneRange + load * 500, t, 0.09);
  const targetGain = (0.05 + sp * 0.11) * (0.7 + load * 0.5) * (V.engine === 'low' ? 1.15 : 1);
  Audio.engineGain.gain.setTargetAtTime(Audio.useSample ? 0 : targetGain, t, 0.1);

  // sampled engine (CC0): pitch + volume rise with revs; idles low at a standstill
  if (Audio.useSample && Audio.sampleEngine) {
    Audio.sampleEngine.playbackRate.setTargetAtTime(0.7 + sp * 1.5, t, 0.08);
    Audio.sampleEngineGain.gain.setTargetAtTime((0.25 + sp * 0.5) * (0.7 + load * 0.5), t, 0.1);
  }

  // tyre/road roar grows with speed (louder & grittier off-road), wind at high speed
  const tyre = (0.015 + sp * 0.14) * (State.offRoad ? 1.7 : 1);
  Audio.tyreFilter.frequency.setTargetAtTime(State.offRoad ? 600 : 1100, t, 0.2);
  Audio.tyreGain.gain.setTargetAtTime(Math.abs(State.speed) > 1 ? tyre : 0, t, 0.15);
  Audio.windGain.gain.setTargetAtTime(sp * sp * 0.09, t, 0.15);

  // skid sample on hard braking OR while drifting (tyres screech)
  if (Audio.skidCD > 0) Audio.skidCD -= dt;
  const skidding = Math.abs(State.speed) > 12 && (keys.brake || State.slip > 0.3);
  if (skidding && Audio.skidCD <= 0) {
    if (playSample('skid', 0.5)) Audio.skidCD = 0.9;
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
  src.start();
}

// water splash — bright, swishy noise (pond crossing)
function playSplash() {
  if (!Audio.ctx || State.muted) return;
  noiseBurst(0.4, 0.28, 'highpass', 1600, 0.6);
  noiseBurst(0.25, 0.18, 'bandpass', 2600, 1.2);
}

// crash/smash — real CC0 impact sample if loaded, else synth crunch + thump
function playSmash() {
  if (!Audio.ctx || State.muted) return;
  if (playSample('impact', 0.7, 0.9 + Math.random() * 0.2)) return;
  noiseBurst(0.35, 0.4, 'bandpass', 900, 1.0);
  playThud(1.1);
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
    o.start(t); o.stop(t + 0.55);
  });
}

function setMuted(m) {
  State.muted = m;
  if (Audio.masterGain && Audio.ctx) {
    Audio.masterGain.gain.setTargetAtTime(m ? 0 : Settings.volume, Audio.ctx.currentTime, 0.1);
  }
}

// ---------------------------------------------------------------------------
// Main animation frame
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  if (State.running && !State.paused) {
    update(dt);
  } else {
    // idle: still spin slight ambient
    updateParticles(dt);
  }
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
function bindInput() {
  window.addEventListener('keydown', e => {
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
  zen:       { name: 'Zen Drive',     icon: '🌿', desc: 'Just cruise · autodrive (F)' }
};
// graphics quality presets (sub-label shown on each chip)
const QOPTS = [['low', 'Low', 'Best performance'], ['med', 'Medium', 'Balanced'], ['high', 'High', 'Best visuals']];

// Repaint vehicle chips with lock/cost state + refresh coin balances (menu + win).
function refreshMenu() {
  const vc = document.getElementById('vehicle-choices');
  if (vc) vc.querySelectorAll('.choice').forEach(el => {
    const key = el.dataset.key, v = VEHICLES[key], locked = !isUnlocked(key);
    el.className = 'choice' + (key === selectedVehicle ? ' active' : '') + (locked ? ' locked' : '');
    el.innerHTML = `<div class="icon">${v.icon}</div><div class="name">${v.name}</div>` +
      (locked ? `<div class="lock">🔒 ${UNLOCK_COST[key]} coins</div>` : `<div class="desc">${v.desc}</div>`);
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
      document.getElementById('start-btn').textContent = key === 'zen' ? 'Start Driving →' : 'Start the Run →';
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
    saveProgress(); refreshMenu();
    document.getElementById('overlay').classList.remove('hidden');
    if (Audio.ctx) Audio.ctx.resume();
  });

  document.getElementById('best-val').textContent = (State.best / 1000).toFixed(2) + ' km';
  document.getElementById('start-btn').addEventListener('click', startGame);
  document.getElementById('replay-btn').addEventListener('click', () => {
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
  State.wasMoving = false; State.offRoad = false; State.won = false;
  window.__coneProg = '0/6';
  Missions.reset();
  State.runStart = clock.elapsedTime;
  // Zen starts hands-off & objective-free; Challenge is manual with missions
  State.autodrive = (State.mode === 'zen');
  document.getElementById('missions').style.display = (State.mode === 'challenge') ? 'block' : 'none';
  updateModePill();

  document.getElementById('win-overlay').classList.remove('show');

  buildWorld();
  buildVehicle();

  // place camera behind
  camera.position.set(0, 5.2, -11);

  initAudio();
  if (Audio.ctx && Audio.ctx.state === 'suspended') Audio.ctx.resume();

  State.running = true;
  State.paused = false;
  document.getElementById('overlay').classList.add('hidden');

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
      localStorage.setItem('openroads_best', String(best));
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
