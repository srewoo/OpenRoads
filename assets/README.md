# Open Roads — assets

## Bundled vehicle models (all CC0 / public domain)
A cohesive low-poly set sourced from the poimandres CC0 market (pmndrs/market-assets):
- `models/car.gltf` — "Sports Sedan" by **Kenney** (CC0)
- `models/truck.gltf` — "Truck" by **Kenney** (CC0)
- `models/bike.gltf` — "Bike" by **hugodutra** (CC0)

License: Creative Commons Zero (CC0) — https://creativecommons.org/publicdomain/zero/1.0/

The loader (`loadVehicleModel` in `game.js`) strips baked shadow planes, converts materials to
the cel-shaded look, auto-scales to the vehicle length, grounds it, and spins any nodes named
`*wheel*`/`*tyre*`. If a model file is missing it falls back to the procedural vehicle.

## Drop in your own (used automatically)
Replace any of the above or add new slots in `GLB_MODELS`. **Use only assets you have the rights
to (CC0 recommended).** Good CC0 sources: Kenney (kenney.nl), Quaternius (quaternius.com),
poimandres market (market.pmnd.rs).

## Bundled audio (all CC0)
From **KenneyNL/Starter-Kit-Racing** (Kenney, CC0):
- `audio/engine.ogg` — car/truck engine loop (pitch-shifted by RPM)
- `audio/engine-bike.ogg` — motorcycle engine loop
- `audio/impact.ogg` — crash/smash one-shot
- `audio/skid.ogg` — braking skid

Loaded + decoded at startup (`loadSounds` in `game.js`); the sampled engine replaces the synth
when ready, and the synth remains the fallback if a file is missing.
