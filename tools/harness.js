// Headless smoke/behaviour harness for Open Roads.
// Stubs THREE + DOM with auto-vivifying Proxies so the REAL game physics runs in Node.
// Boots the game, drives each vehicle, and asserts missions complete + no runtime throws.
// Run: node --check game.js && node tools/harness.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- generic auto-stub: any property access returns a callable chainable Proxy ---
function autoStub() {
  const fn = function () { return autoStub(); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;       // numeric/string coercion → 0/""
      if (p === 'then') return undefined;                  // not a thenable
      if (p in t) return t[p];
      if (p === 'length') return 0;
      return autoStub();
    },
    set() { return true; },
    apply() { return autoStub(); },
    construct() { return autoStub(); }
  });
}
const THREE = autoStub();

// --- DOM stubs ---
function elStub() {
  return new Proxy({
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    dataset: {}, textContent: '', value: '0', innerHTML: '', children: [],
    appendChild() {}, removeChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector() { return elStub(); }, querySelectorAll() { return []; },
    getContext() { return ctx2d(); }, requestFullscreen() { return Promise.resolve(); },
    focus() {}, getBoundingClientRect() { return { width: 1280, height: 800 }; }, remove() {}
  }, { get(t, p) { return p in t ? t[p] : autoStub(); }, set(t, p, v) { t[p] = v; return true; } });
}
function ctx2d() {
  return new Proxy({}, { get() { return () => {}; }, set() { return true; } });
}
const documentStub = new Proxy({
  getElementById() { return elStub(); }, querySelector() { return elStub(); },
  querySelectorAll() { return []; }, createElement() { return elStub(); },
  addEventListener() {}, body: elStub(), documentElement: elStub(), hidden: false
}, { get(t, p) { return p in t ? t[p] : autoStub(); } });

const listeners = {};
const windowStub = new Proxy({
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  addEventListener(ev, fn) { listeners[ev] = fn; },
  AudioContext: undefined, webkitAudioContext: undefined,   // → initAudio bails (browser-only)
  requestAnimationFrame() { return 0; }
}, { get(t, p) { return p in t ? t[p] : autoStub(); }, set(t, p, v) { t[p] = v; return true; } });

const store = {};
const localStorageStub = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};

const sandbox = {
  THREE, window: windowStub, document: documentStub,
  navigator: { maxTouchPoints: 0 },          // no getGamepads → pollGamepad returns early
  localStorage: localStorageStub,
  requestAnimationFrame() { return 0; },     // no-op: animate() runs once, no recursion
  cancelAnimationFrame() {},
  setInterval() { return 0; }, clearInterval() {}, setTimeout() { return 0; }, clearTimeout() {},
  performance: { now: () => 0 }, console, fetch: undefined, Math, JSON, Date, Object, Array
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);

let code = fs.readFileSync(path.join(__dirname, '..', 'game.js'), 'utf8');
// expose internals + a season/vehicle setter (they're lexical consts/lets in game.js)
code += `
;globalThis.__game = {
  update: (typeof update !== 'undefined') ? update : null,
  startGame: (typeof startGame !== 'undefined') ? startGame : null,
  State: (typeof State !== 'undefined') ? State : null,
  Missions: (typeof Missions !== 'undefined') ? Missions : null,
  keys: (typeof keys !== 'undefined') ? keys : null,
  VEHICLES: (typeof VEHICLES !== 'undefined') ? VEHICLES : null,
  setVehicle: (v) => { selectedVehicle = v; },
  setSeason: (s) => { selectedSeason = s; },
  setMode: (m) => { State.mode = m; },
  TT_DIST: (typeof TT_DIST !== 'undefined') ? TT_DIST : 2000,
  ghostStored: () => !!localStorage.getItem('openroads_tt_ghost_car'),
  hasGhost: () => (typeof ghostData !== 'undefined') && !!ghostData,
  // perfect-driver helper: snap heading to the road tangent so a straight full-throttle
  // run stays on asphalt (otherwise the harness wanders off the procedural curves).
  followRoad: () => { const i = nearestPathInfo(State.carX, State.carZ); State.heading = Math.atan2(i.hx, i.hz); }
};`;

let failures = 0;
function check(name, cond) { console.log((cond ? '  ✓ ' : '  ✗ ') + name); if (!cond) failures++; }

try {
  vm.runInContext(code, sandbox, { filename: 'game.js' });
} catch (e) {
  console.error('FATAL: game.js threw on load:', e && e.stack || e);
  process.exit(1);
}

// trigger boot (registered on window 'load')
try { if (listeners.load) listeners.load(); } catch (e) { console.error('FATAL: boot() threw:', e.stack || e); process.exit(1); }

const G = sandbox.__game;
check('internals exposed (update/State/Missions)', !!(G && G.update && G.State && G.Missions));

const SEASONS = ['summer', 'spring', 'winter', 'monsoon', 'desert'];
const VEHS = ['car', 'bike', 'truck'];

function resetKeys(k) { for (const p in k) k[p] = false; }

for (const veh of VEHS) {
  for (const season of SEASONS) {
    G.setVehicle(veh); G.setSeason(season); G.setMode('challenge');
    try { G.startGame(); } catch (e) { console.error(`startGame threw (${veh}/${season})`, e.stack || e); failures++; continue; }
    const k = G.keys; const S = G.State;
    const tag = `${veh}/${season}`;
    let threw = null, maxKmh = 0;

    // Phase A — clean on-road full-throttle: verify top speed + speed missions still reachable
    resetKeys(k); k.up = true;
    for (let i = 0; i < 1400 && !threw; i++) {
      try { G.followRoad(); G.update(1 / 60); } catch (e) { threw = e; }
      maxKmh = Math.max(maxKmh, Math.abs(S.speed) * 3.6);
    }
    // Phase B — stress the new paths: drift/steer/brake noise must not throw or NaN
    for (let i = 0; i < 600 && !threw; i++) {
      k.up = !(i > 550); k.drift = (i % 120 > 90); k.left = (i % 120 > 60 && i % 120 < 100); k.brake = (i > 550);
      try { G.update(1 / 60); } catch (e) { threw = e; }
    }
    if (threw) { check(`${tag}: ran without throwing`, false); console.error('   ', threw.stack || threw); continue; }
    // top speed target scales with the vehicle (truck maxes at 160 km/h)
    const target = veh === 'truck' ? 120 : 130;
    check(`${tag}: reached >${target} km/h (was ${maxKmh.toFixed(0)})`, maxKmh > target);
    check(`${tag}: speed missions (80/120/hold70) complete`, !!(G.Missions.done.speed80 && G.Missions.done.speed120 && G.Missions.done.hold70));
    check(`${tag}: drift distance is finite`, Number.isFinite(S.driftDist));
    check(`${tag}: no NaN in position/speed`, Number.isFinite(S.carX) && Number.isFinite(S.carZ) && Number.isFinite(S.speed));
  }
}

// Zen mode smoke — clean keys, autodrive should cruise up to a steady speed
G.setVehicle('car'); G.setSeason('summer'); G.setMode('zen');
try {
  G.startGame();
  resetKeys(G.keys);
  for (let i = 0; i < 800; i++) G.update(1 / 60);
  check('zen: autodrive cruises (speed>5) without throwing', Number.isFinite(G.State.speed) && G.State.speed > 5);
} catch (e) { check('zen: ran without throwing', false); console.error(e.stack || e); }

// Time Trial — drive the fixed track to the finish; a ghost should be saved
try {
  localStorageStub.removeItem('openroads_tt_ghost_car'); localStorageStub.removeItem('openroads_tt_best_car');
  G.setVehicle('car'); G.setSeason('summer'); G.setMode('timetrial');
  G.startGame();
  resetKeys(G.keys); G.keys.up = true;
  let threw = null;
  for (let i = 0; i < 6000 && !G.State.ttFinished && !threw; i++) {
    try { G.followRoad(); G.update(1 / 60); } catch (e) { threw = e; }
  }
  if (threw) { check('timetrial: ran without throwing', false); console.error(threw.stack || threw); }
  else {
    check(`timetrial: reached the ${(G.TT_DIST/1000).toFixed(1)}km finish (dist ${(G.State.distance).toFixed(0)}m)`, G.State.ttFinished);
    check('timetrial: ghost saved to localStorage after first run', G.ghostStored());
  }
  // second run: the saved ghost should load and replay without throwing
  G.startGame();
  check('timetrial: saved ghost loads on the next run', G.hasGhost());
  resetKeys(G.keys); G.keys.up = true;
  let threw2 = null;
  for (let i = 0; i < 400 && !threw2; i++) { try { G.followRoad(); G.update(1 / 60); } catch (e) { threw2 = e; } }
  check('timetrial: ghost replay runs without throwing', !threw2 && Number.isFinite(G.State.carX));
  if (threw2) console.error(threw2.stack || threw2);
} catch (e) { check('timetrial: ran without throwing', false); console.error(e.stack || e); }

// Practice — tutorial should advance through its steps as inputs are performed
try {
  G.setVehicle('car'); G.setSeason('summer'); G.setMode('practice');
  G.startGame();
  const k = G.keys; const S = G.State; let threw = null;
  check('practice: tutorial starts at step 0', S.tutStep === 0);
  resetKeys(k); k.up = true;                          // step 0: accelerate
  for (let i = 0; i < 200 && S.tutStep === 0 && !threw; i++) { try { G.update(1/60); } catch (e) { threw = e; } }
  check('practice: advanced past "accelerate" step', S.tutStep !== 0 || threw);
  // exercise steer/brake/drift/camera so the walkthrough can progress without throwing
  for (let i = 0; i < 1200 && !threw; i++) {
    k.up = (i % 100 < 70); k.left = (i % 120 < 60); k.drift = (i % 120 >= 60); k.brake = (i % 200 > 180);
    if (i === 600) S.camMode = (S.camMode + 1) % 3;
    try { G.update(1/60); } catch (e) { threw = e; }
  }
  check('practice: walkthrough ran without throwing', !threw);
  if (threw) console.error(threw.stack || threw);
} catch (e) { check('practice: ran without throwing', false); console.error(e.stack || e); }

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
