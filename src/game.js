// TIDELIGHT simulation. Fixed timestep, all randomness from seeded PRNGs,
// no access to wall-clock time — so ?capture can replay it exactly.
import { mulberry32, clamp, lerp, approach, angleDiff } from './util.js';
import { GATE, REEFS, WORLD, LAMP, barrierZ, inGate } from './layout.js';

export const DT = 1 / 60;
export const BEAM_R = 6.5;
export const FLARE_R = 17;
export const FLIGHT = 0.75;
export const BURN = 3.6;
export const MAX_PARTICLES = 900;
export const MAX_SHIPS = 14;
export const MAX_FLARES = 4;
export const MAX_LAMPS = 3;
export const MAX_FLARE_COUNT = 3;

export const WATCHES = [
  { at: 0, name: 'First Watch', sub: 'Bring the fleet home' },
  { at: 35, name: 'Middle Watch', sub: 'Fog on the water' },
  { at: 80, name: 'Morning Watch', sub: 'More sails on the horizon' },
  { at: 130, name: 'Storm Watch', sub: 'Hold the light steady' },
];

export class Game {
  constructor(seed) {
    this.reset(seed);
  }

  reset(seed = this.seed) {
    this.seed = seed >>> 0;
    this.rng = mulberry32(this.seed); // gameplay
    this.fxr = mulberry32((this.seed ^ 0x9e3779b9) >>> 0); // cosmetic
    this.frame = 0;
    this.t = 0;
    this.state = 'title';
    this.stateT = 0;
    this.playT = 0;
    this.introT = null;
    this.ships = [];
    this.nextId = 1;
    this.particles = [];
    this.pops = [];
    this.popId = 1;
    this.flares = [];
    this.score = 0;
    this.scoreFrom = 0;
    this.scoreAt = -10;
    this.chain = 0;
    this.chainAt = -10;
    this.lamps = MAX_LAMPS;
    this.lampLostAt = -10;
    this.flareCount = 2;
    this.flareProgress = 0;
    this.flaresUsed = 0;
    this.lastFlareT = -10;
    this.noFlareT = -10;
    this.flareGainT = -10;
    this.docked = 0;
    this.wrecked = 0;
    this.spawnTimer = 0;
    this.watch = -1;
    this.watchT = -10;
    this.aim = { x: GATE.x, z: -14 };
    this.aimTarget = { x: GATE.x, z: -14 };
    this.beamPower = 1;
    this.shake = 0;
    this.pendingOver = -1;
    this.overAt = -10;
  }

  // ---------------------------------------------------------------- input API
  setAim(x, z) {
    if (this.state !== 'play') return;
    this.aimTarget.x = clamp(x, WORLD.minX - 4, WORLD.maxX + 4);
    this.aimTarget.z = clamp(z, WORLD.aimMinZ, WORLD.aimMaxZ);
  }

  tap(p) {
    if (this.state === 'title') {
      if (this.stateT > 0.6) this.start();
      return;
    }
    if (this.state === 'over') {
      if (this.stateT > 1.4) this.start();
      return;
    }
    if (this.state === 'play' && p) this.fireFlare(p.x, p.z);
  }

  // ---------------------------------------------------------------- flow
  start() {
    const fromTitle = this.state === 'title';
    this.state = 'play';
    this.stateT = 0;
    this.playT = 0;
    if (fromTitle) this.introT = this.t;
    this.score = 0;
    this.scoreFrom = 0;
    this.scoreAt = -10;
    this.chain = 0;
    this.lamps = MAX_LAMPS;
    this.flareCount = 2;
    this.flareProgress = 0;
    this.flaresUsed = 0;
    this.docked = 0;
    this.wrecked = 0;
    this.watch = -1;
    this.pendingOver = -1;
    this.spawnTimer = 2.6;
    this.aimTarget.x = this.aim.x;
    this.aimTarget.z = this.aim.z;
    this.ships = this.ships.filter((s) => s.state !== 'wreck');
    this.spawnShip(-24, -12);
    this.spawnShip(-40, 20);
  }

  difficulty() {
    return clamp(this.playT / 170, 0, 1);
  }

  displayScore() {
    const k = clamp((this.t - this.scoreAt) / 0.7, 0, 1);
    const e = 1 - (1 - k) * (1 - k);
    return Math.round(lerp(this.scoreFrom, this.score, e));
  }

  addScore(pts) {
    this.scoreFrom = this.displayScore();
    this.score += pts;
    this.scoreAt = this.t;
  }

  pop(x, y, z, text, kind, delay = 0) {
    this.pops.push({ id: this.popId++, x, y, z, text, kind, t0: this.t + delay, dur: 1.7 });
  }

  // ---------------------------------------------------------------- ships
  spawnShip(z0, xHint = null) {
    if (this.ships.length >= MAX_SHIPS) return;
    const r = this.rng;
    const d = this.difficulty();
    const x = xHint !== null ? xHint : lerp(-38, 38, r());
    const spread = lerp(24, 40, d);
    const tx = clamp(GATE.x + (r() * 2 - 1) * spread, -44, 46);
    const hd = Math.atan2(tx - x, 30 - z0);
    const speed = lerp(3.3, 4.3, d) * (0.9 + 0.2 * r());
    this.ships.push({
      id: this.nextId++,
      x,
      z: z0,
      hd,
      speed,
      v: speed,
      type: r() < 0.55 ? 'sail' : 'trawler',
      color: Math.floor(r() * 5),
      phase: r() * Math.PI * 2,
      state: 'sail',
      stateT: 0,
      age: 0,
      lit: 0,
      danger: false,
      dangerT: 99,
      wasDanger: false,
      wakeT: 0,
      wreckSide: 1,
      dead: false,
    });
  }

  // Distance along heading until something solid; -1 if it reaches the harbor mouth.
  lookahead(x, z, hd, dist) {
    const sx = Math.sin(hd);
    const cz = Math.cos(hd);
    for (let d = 0.8; d <= dist; d += 0.8) {
      const px = x + sx * d;
      const pz = z + cz * d;
      for (const r of REEFS) {
        const dx = px - r.x;
        const dz = pz - r.z;
        if (dx * dx + dz * dz < (r.r + 0.9) * (r.r + 0.9)) return d;
      }
      if (pz > GATE.z - 0.8 && inGate(px)) return -1;
      if (pz > barrierZ(px)) return d;
    }
    return Infinity;
  }

  updateShip(s, dt) {
    s.age += dt;
    s.stateT += dt;
    const sx = Math.sin(s.hd);
    const cz = Math.cos(s.hd);

    if (s.state === 'sail') {
      let desired = null;
      let rate = 0;
      let flareLit = false;
      for (const f of this.flares) {
        if (!f.burst) continue;
        const dx = f.x - s.x;
        const dz = f.z - s.z;
        const d = Math.hypot(dx, dz);
        if (d < FLARE_R) {
          flareLit = true;
          if (d > 1.5) {
            desired = Math.atan2(dx, dz);
            rate = 1.75;
          }
        }
      }
      const beamOn = this.state === 'play' && this.beamPower > 0.5;
      const ax = this.aim.x - s.x;
      const az = this.aim.z - s.z;
      const ad = Math.hypot(ax, az);
      const inBeam = beamOn && ad < BEAM_R;
      s.lit = approach(s.lit, inBeam || flareLit ? 1 : 0, dt * 3.5);
      if (desired === null && inBeam && ad > 1.3) {
        desired = Math.atan2(ax, az);
        rate = 1.35;
      }
      if (desired === null) s.hd += Math.sin(s.age * 0.35 + s.phase) * 0.05 * dt;

      // The bay's edges gently turn ships back in.
      if (s.x < WORLD.minX) {
        desired = Math.atan2(1, 0.4);
        rate = Math.max(rate, 0.9);
      } else if (s.x > WORLD.maxX) {
        desired = Math.atan2(-1, 0.4);
        rate = Math.max(rate, 0.9);
      } else if (s.z < WORLD.farZ) {
        desired = 0;
        rate = Math.max(rate, 0.9);
      }
      if (desired !== null) s.hd += clamp(angleDiff(s.hd, desired), -rate * dt, rate * dt);

      s.v = approach(s.v, s.speed * (1 + 0.7 * s.lit), dt * 2.2);
      s.x += Math.sin(s.hd) * s.v * dt;
      s.z += Math.cos(s.hd) * s.v * dt;

      s.wakeT -= dt;
      if (s.wakeT <= 0) {
        s.wakeT = 0.06;
        this.emitWake(s);
      }

      for (const r of REEFS) {
        if (Math.hypot(s.x - r.x, s.z - r.z) < r.r + 0.85) {
          this.wreckShip(s);
          return;
        }
      }
      if (s.z > GATE.z - 0.8 && inGate(s.x)) {
        this.dockShip(s);
        return;
      }
      if (s.z > barrierZ(s.x)) {
        this.wreckShip(s);
        return;
      }

      const hit = this.lookahead(s.x, s.z, s.hd, s.v * 3.4 + 1.5);
      s.danger = hit > 0 && Number.isFinite(hit);
      s.dangerT = s.danger ? hit / Math.max(0.5, s.v) : 99;
      if (s.danger && s.dangerT < 2.0) s.wasDanger = true;
    } else if (s.state === 'dock') {
      s.hd += clamp(angleDiff(s.hd, 0), -1.4 * dt, 1.4 * dt);
      s.v = approach(s.v, 2.8, dt * 1.5);
      s.lit = approach(s.lit, 0, dt);
      s.x += sx * s.v * dt;
      s.z += cz * s.v * dt;
      s.wakeT -= dt;
      if (s.wakeT <= 0) {
        s.wakeT = 0.08;
        this.emitWake(s);
      }
      if (s.z > 46) s.dead = true;
    } else {
      s.v = approach(s.v, 0, dt * 5);
      s.lit = approach(s.lit, 0, dt * 2);
      s.x += sx * s.v * dt;
      s.z += cz * s.v * dt;
      const f = this.fxr;
      if (s.stateT < 2.8 && f() < 0.45) {
        this.emit(s.x + (f() - 0.5) * 2.4, 0.35, s.z + (f() - 0.5) * 2.4, (f() - 0.5) * 0.6, 0.3 + f() * 0.6, (f() - 0.5) * 0.6,
          0.9 + f() * 0.6, 0.35, 0.9, 0.7, 0.85, 0.95, 0.38, 0, 0.5);
      }
      if (s.stateT > 4.6) s.dead = true;
    }
  }

  dockShip(s) {
    s.state = 'dock';
    s.stateT = 0;
    s.danger = false;
    const f = this.fxr;
    for (let i = 0; i < 26; i++) {
      const a = f() * Math.PI * 2;
      const sp = 0.6 + f() * 1.8;
      this.emit(s.x + Math.cos(a) * 0.8, 0.8 + f(), s.z + Math.sin(a) * 0.8, Math.cos(a) * sp, 1.2 + f() * 2.2, Math.sin(a) * sp,
        0.9 + f() * 0.8, 0.45, 0.12, 1.0, 0.82, 0.5, 0.9, 0, 1.2);
    }
    if (this.state !== 'play') return;
    this.chain = Math.min(this.chain + 1, 9);
    this.chainAt = this.t;
    const rescue = s.wasDanger;
    const pts = 100 * this.chain + (rescue ? 50 : 0);
    this.addScore(pts);
    this.docked++;
    this.pop(s.x, 3.4, s.z, '+' + pts, 'score');
    if (this.chain >= 2) this.pop(s.x, 3.4, s.z, 'Chain ×' + this.chain, 'chain', 0.2);
    if (rescue) this.pop(s.x, 3.4, s.z, 'Rescue +50', 'good', 0.12);
    if (this.flareCount < MAX_FLARE_COUNT) {
      this.flareProgress += 1 / 3;
      if (this.flareProgress > 0.99) {
        this.flareProgress = 0;
        this.flareCount++;
        this.flareGainT = this.t;
        this.pop(s.x, 3.4, s.z, 'Flare ready', 'flare', 0.45);
      }
    }
  }

  wreckShip(s) {
    s.state = 'wreck';
    s.stateT = 0;
    s.danger = false;
    const f = this.fxr;
    s.wreckSide = f() < 0.5 ? -1 : 1;
    this.shake = Math.max(this.shake, 1);
    for (let i = 0; i < 34; i++) {
      const a = f() * Math.PI * 2;
      const sp = 1 + f() * 3;
      this.emit(s.x + Math.cos(a) * 0.6, 0.5, s.z + Math.sin(a) * 0.6, Math.cos(a) * sp, 3 + f() * 4.5, Math.sin(a) * sp,
        0.8 + f() * 0.7, 0.55, 0.25, 0.82, 0.92, 1.0, 0.7, 9.8, 0.4);
    }
    if (this.state !== 'play') return;
    this.lamps = Math.max(0, this.lamps - 1);
    this.lampLostAt = this.t;
    this.chain = 0;
    this.wrecked++;
    this.pop(s.x, 3.6, s.z, 'Ship lost', 'bad');
    if (this.lamps === 0 && this.pendingOver < 0) this.pendingOver = 1.6;
  }

  // ---------------------------------------------------------------- flares
  fireFlare(x, z) {
    if (this.t - this.lastFlareT < 0.35) return;
    if (this.flareCount < 1) {
      if (this.t - this.noFlareT > 0.8) this.pop(x, 2.2, z, 'No flares', 'bad');
      this.noFlareT = this.t;
      return;
    }
    if (this.flares.length >= MAX_FLARES) return;
    this.flareCount--;
    this.flaresUsed++;
    this.lastFlareT = this.t;
    this.flares.push({ tx: x, tz: z, t: 0, x: LAMP.x, y: LAMP.y + 0.6, z: LAMP.z, burst: false, burstT: 0, sway: this.fxr() * 6.28 });
  }

  stepFlares(dt) {
    const f = this.fxr;
    for (const fl of this.flares) {
      fl.t += dt;
      if (fl.t < FLIGHT) {
        const u = fl.t / FLIGHT;
        const e = 1 - (1 - u) * (1 - u);
        fl.x = lerp(LAMP.x, fl.tx, e);
        fl.z = lerp(LAMP.z, fl.tz, e);
        fl.y = lerp(LAMP.y + 0.6, 9.5, e) + Math.sin(u * Math.PI) * 7;
        this.emit(fl.x, fl.y, fl.z, (f() - 0.5) * 0.4, (f() - 0.5) * 0.4, (f() - 0.5) * 0.4, 0.55, 0.7, 0.15, 1.0, 0.62, 0.42, 0.7, 0, 0);
      } else {
        if (!fl.burst) {
          fl.burst = true;
          fl.burstT = this.t;
          this.shake = Math.max(this.shake, 0.35);
          for (let i = 0; i < 46; i++) {
            const a = f() * Math.PI * 2;
            const b = (f() - 0.3) * Math.PI;
            const sp = 4 + f() * 6;
            this.emit(fl.x, fl.y, fl.z, Math.cos(a) * Math.cos(b) * sp, Math.sin(b) * sp, Math.sin(a) * Math.cos(b) * sp,
              0.7 + f() * 0.9, 0.55, 0.1, 1.0, 0.7, 0.5, 0.95, 6, 1.4);
          }
        }
        const u = (fl.t - FLIGHT) / BURN;
        fl.y = 9.5 - 6.2 * u;
        fl.x = fl.tx + Math.sin(fl.t * 1.2 + fl.sway) * 0.7;
        fl.z = fl.tz + Math.cos(fl.t * 0.9 + fl.sway) * 0.4;
        if (f() < 0.55) {
          this.emit(fl.x + (f() - 0.5) * 0.4, fl.y - 0.2, fl.z + (f() - 0.5) * 0.4, (f() - 0.5) * 0.8, -0.6 - f(), (f() - 0.5) * 0.8,
            0.9 + f() * 0.8, 0.45, 0.08, 1.0, 0.55, 0.38, 0.8, 1.5, 0.3);
        }
      }
    }
    this.flares = this.flares.filter((fl) => fl.t < FLIGHT + BURN);
  }

  // ---------------------------------------------------------------- particles
  emit(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, grav = 0, drag = 0) {
    if (this.particles.length >= MAX_PARTICLES) return;
    this.particles.push({ x, y, z, vx, vy, vz, life, max: life, s0, s1, r, g, b, a, grav, drag });
  }

  emitWake(s) {
    const f = this.fxr;
    const sx = Math.sin(s.hd);
    const cz = Math.cos(s.hd);
    const bx = s.x - sx * 1.5;
    const bz = s.z - cz * 1.5;
    const side = f() < 0.5 ? -1 : 1;
    const px = cz * side;
    const pz = -sx * side;
    this.emit(bx + px * 0.3, 0.32, bz + pz * 0.3, px * 0.7, 0, pz * 0.7, 1.9, 0.9, 2.7, 0.62, 0.78, 0.86, 0.24, 0, 0.6);
  }

  stepParticles(dt) {
    const P = this.particles;
    let w = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.grav * dt;
      const k = Math.max(0, 1 - p.drag * dt);
      p.vx *= k;
      p.vy *= k;
      p.vz *= k;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.grav > 0 && p.y < 0.2) {
        p.y = 0.2;
        p.vy = 0;
        p.vx *= 0.9;
        p.vz *= 0.9;
      }
      P[w++] = p;
    }
    P.length = w;
  }

  // ---------------------------------------------------------------- main step
  step(dt) {
    this.frame++;
    this.t = this.frame * dt;
    this.stateT += dt;
    if (this.state === 'play') this.playT += dt;

    if (this.state === 'title') {
      const a = this.t * 0.42;
      this.aim.x = 8 + 30 * Math.sin(a);
      this.aim.z = -20 + 9 * Math.cos(a * 0.7);
      this.aimTarget.x = this.aim.x;
      this.aimTarget.z = this.aim.z;
    } else {
      const k = 1 - Math.exp(-dt * 16);
      this.aim.x += (this.aimTarget.x - this.aim.x) * k;
      this.aim.z += (this.aimTarget.z - this.aim.z) * k;
    }
    const over = this.state === 'over';
    this.beamPower = approach(this.beamPower, over ? 0 : 1, dt * (over ? 0.8 : 1.5));

    if (this.state === 'play') {
      while (this.watch + 1 < WATCHES.length && this.playT >= WATCHES[this.watch + 1].at) {
        this.watch++;
        this.watchT = this.t;
      }
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        const d = this.difficulty();
        const sailing = this.ships.filter((s) => s.state === 'sail').length;
        if (sailing < 4 + Math.floor(d * 5)) this.spawnShip(WORLD.spawnZ - this.rng() * 8);
        this.spawnTimer = lerp(4.8, 2.3, d) * (0.85 + 0.3 * this.rng());
      }
    }

    for (const s of this.ships) this.updateShip(s, dt);
    this.ships = this.ships.filter((s) => !s.dead);

    // Ships keep a little distance from each other.
    const sail = this.ships.filter((s) => s.state === 'sail');
    for (let i = 0; i < sail.length; i++) {
      for (let j = i + 1; j < sail.length; j++) {
        const a = sail[i];
        const b = sail[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d < 2.6 && d > 0.001) {
          const push = (2.6 - d) * 0.25;
          a.x -= (dx / d) * push;
          a.z -= (dz / d) * push;
          b.x += (dx / d) * push;
          b.z += (dz / d) * push;
        }
      }
    }

    this.stepFlares(dt);
    this.stepParticles(dt);
    this.pops = this.pops.filter((p) => this.t < p.t0 + p.dur);
    this.shake = Math.max(0, this.shake - dt * 1.8);

    if (this.pendingOver >= 0) {
      this.pendingOver -= dt;
      if (this.pendingOver < 0 && this.state === 'play') {
        this.state = 'over';
        this.stateT = 0;
        this.overAt = this.t;
      }
    }
  }
}
