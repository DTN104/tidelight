# TIDELIGHT

A lighthouse keeper's night. **One rule: every ship steers toward your light.**

## The loop
1. Ships emerge from the fog on the horizon and drift towards the coast.
2. Sweep the lighthouse beam (mouse move / touch drag): any ship inside it turns toward the light.
3. Thread them between the reefs and through the harbor mouth to dock — consecutive dockings build a chain multiplier (+50 for rescuing a ship that was heading for the rocks).
4. Click / tap to fire a flare: a parachute flare that pulls every ship within a wide radius. You hold up to 3; every 3 ships harbored earns one back.
5. Each wreck puts out one of your 3 lamps. Every watch the fog thickens and more, faster ships arrive — when the last lamp goes out, the night wins.

## Run
ES modules + importmap need an HTTP origin (not `file://`):

```
cd game-3d-test
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080/
```

Everything is local: `lib/three.module.js` (three.js r160, MIT — see `lib/three.LICENSE`) is the only dependency. All geometry is modelled in code; the only textures are small canvases drawn at startup. No postprocessing.

Optional: `?seed=123` fixes the run's PRNG seed.

## Recording mode — `?capture`
- No `requestAnimationFrame` loop. The page exposes `window.render(t)`:
  - `t` is in **seconds**.
  - Steps the real simulation from its current time to `t` at a fixed 1/60 s timestep with a seeded PRNG (default seed `20261013`; override with `&seed=`), then renders one frame.
  - Calling with a smaller `t` than the current time resets and replays from 0, so any frame is reproducible.
  - Returns the simulation frame number.
- Ready signal: `window.__TIDELIGHT_READY__ === true` (also `document.documentElement.dataset.ready === "1"` and a `tidelight-ready` window event). `window.CAPTURE_INFO = { duration: 45, fps: 60, timeUnit: 'seconds', seed }`.
- A scripted cursor (`src/bot.js`) plays a 45 s session: it presses "Light the lamp", then watches the bay like a player, sweeping the beam to guide ships, and fires flares to rescue ships heading for the rocks. It drives the same `Input.move/down/up` functions as a real mouse and is drawn on screen with click ripples.
- The renderer uses `preserveDrawingBuffer` and pixel ratio 1 in this mode. All HUD/overlay animation is computed from simulation time (no CSS transitions), so screenshots match the simulation exactly.

Example (Playwright):
```js
await page.goto('http://localhost:8080/?capture');
await page.waitForFunction(() => window.__TIDELIGHT_READY__);
for (let f = 0; f < 45 * 60; f++) {
  await page.evaluate((t) => window.render(t), f / 60);
  await page.screenshot({ path: `frames/${String(f).padStart(5, '0')}.png` });
}
```

## Files
- `index.html` — markup, HUD/overlay styles, importmap
- `src/main.js` — bootstrap, fixed-step loop, capture API
- `src/game.js` — simulation (ships, beam, flares, scoring, particles)
- `src/layout.js` — the bay: coastline, harbor mouth, reefs, lighthouse
- `src/scene.js` — three.js scene built entirely in code + per-frame sync
- `src/input.js` — shared mouse/touch/scripted input path
- `src/bot.js` — scripted cursor for capture
- `src/hud.js` — HUD, title and game-over screens
