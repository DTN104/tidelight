import * as THREE from 'three';
import { Game, DT } from './game.js';
import { World } from './scene.js';
import { Input } from './input.js';
import { Bot } from './bot.js';
import { Hud } from './hud.js';

const params = new URLSearchParams(location.search);
const CAPTURE = params.has('capture');
const seedParam = parseInt(params.get('seed'), 10);
const SEED = Number.isFinite(seedParam) ? seedParam >>> 0 : CAPTURE ? 20261013 : (Math.random() * 4294967296) >>> 0;
const BEST_KEY = 'tidelight.best';

const viewport = () => ({ w: Math.max(1, window.innerWidth), h: Math.max(1, window.innerHeight) });

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: CAPTURE,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(CAPTURE ? 1 : Math.min(window.devicePixelRatio || 1, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const game = new Game(SEED);
const world = new World(renderer);
const input = new Input(game, world);
const hud = new Hud(CAPTURE);
const bot = CAPTURE ? new Bot(game, input, world, viewport) : null;

let best = 0;
if (!CAPTURE) {
  try {
    best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0;
  } catch (e) {
    best = 0;
  }
}
let recordedOverAt = -1;

let lastW = 0;
let lastH = 0;
function resize() {
  const { w, h } = viewport();
  if (w !== lastW || h !== lastH) {
    lastW = w;
    lastH = h;
    renderer.setSize(w, h, false);
  }
  return { w, h };
}

function step() {
  const { w, h } = viewport();
  world.updateCamera(game, w, h);
  if (bot) bot.update(DT);
  input.apply();
  game.step(DT);
  if (game.state === 'over' && game.overAt !== recordedOverAt) {
    recordedOverAt = game.overAt;
    if (!CAPTURE && game.score > best) {
      try {
        localStorage.setItem(BEST_KEY, String(game.score));
      } catch (e) {
        /* storage unavailable */
      }
    }
    // Best shown on the game-over card is the best *before* this run.
    hud.bestBefore = best;
    if (game.score > best) best = game.score;
  }
}

function draw() {
  const { w, h } = resize();
  world.updateCamera(game, w, h);
  world.sync(game);
  renderer.render(world.scene, world.camera);
  const shownBest = game.state === 'over' && hud.bestBefore !== undefined ? hud.bestBefore : best;
  hud.update(game, world, input, shownBest);
}

if (CAPTURE) {
  document.documentElement.classList.add('capture');
  // Recording mode: no rAF. render(t) advances the real simulation to t seconds
  // with a fixed 1/60 s step (seeded PRNG), lets the scripted cursor play through
  // the same input functions as a human, then renders one frame.
  window.render = (t) => {
    const target = Math.max(0, Math.round((Number(t) || 0) / DT));
    if (target < game.frame) {
      game.reset(SEED);
      input.reset();
      bot.reset();
      recordedOverAt = -1;
      hud.bestBefore = undefined;
      best = 0;
    }
    while (game.frame < target) step();
    draw();
    return game.frame;
  };
  window.CAPTURE_INFO = { duration: 45, fps: 60, timeUnit: 'seconds', seed: SEED };
  window.__game = game; // read-only inspection hook for capture tooling
  draw();
  window.__TIDELIGHT_READY__ = true;
  document.documentElement.dataset.ready = '1';
  window.dispatchEvent(new Event('tidelight-ready'));
} else {
  input.attach(canvas);
  let last = performance.now();
  let acc = 0;
  const frame = (now) => {
    acc += Math.min(0.1, Math.max(0, (now - last) / 1000));
    last = now;
    let n = 0;
    while (acc >= DT && n < 8) {
      step();
      acc -= DT;
      n++;
    }
    if (n === 8) acc = 0;
    draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    last = performance.now();
  });
}
