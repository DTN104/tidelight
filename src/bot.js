// Scripted cursor for ?capture. It watches the game like a player would and
// drives the SAME Input.move/down/up functions a mouse does. Fully deterministic:
// it only reads simulation state and sim time.
import { GATE, REEFS } from './layout.js';
import { clamp } from './util.js';
import { BEAM_R, FLARE_R } from './game.js';

export class Bot {
  constructor(game, input, world, viewport) {
    this.game = game;
    this.input = input;
    this.world = world;
    this.viewport = viewport;
    this.reset();
  }

  reset() {
    const { w, h } = this.viewport();
    this.x = w * 0.78;
    this.y = h * 0.82;
    this.vx = 0;
    this.vy = 0;
    this.queue = [];
    this.pressT = -1;
    this.target = null;
    this.aim = { x: GATE.x, z: -14 };
    this.nextThink = 0;
    this.lastState = null;
  }

  clickElement(id) {
    this.queue.push({
      t0: this.game.t,
      // Use untransformed layout (offset chain), not getBoundingClientRect:
      // CSS transforms depend on when the HUD was last drawn, and the
      // simulation must not depend on how often render() is called.
      screen: () => {
        const el = document.getElementById(id);
        let x = el.offsetWidth * 0.56;
        let y = el.offsetHeight * 0.58;
        for (let n = el; n; n = n.offsetParent) {
          x += n.offsetLeft;
          y += n.offsetTop;
        }
        return { x, y };
      },
    });
  }

  clickWorld(x, z) {
    this.queue.push({ t0: this.game.t, screen: () => this.world.worldToScreen(x, 0, z) });
  }

  // Waypoint that steers ship s towards the harbor mouth, around reefs.
  plan(s) {
    const g = this.game;
    const onCourse = g.lookahead(s.x, s.z, s.hd, 70) === -1;
    const dx = s.x - GATE.x;
    let gx = GATE.x;
    let gz;
    if (Math.abs(dx) < 1.6 && s.z > 2) gz = GATE.z + 8;
    else if (s.z > 2) gz = clamp(s.z - 3, 2, 7);
    else gz = 6;
    let hit = null;
    let bestT = 2;
    for (const r of REEFS) {
      const ax = gx - s.x;
      const az = gz - s.z;
      const L2 = ax * ax + az * az || 1;
      const tt = ((r.x - s.x) * ax + (r.z - s.z) * az) / L2;
      if (tt < 0 || tt > 1) continue;
      const px = s.x + ax * tt;
      const pz = s.z + az * tt;
      const dd = Math.hypot(r.x - px, r.z - pz);
      if (dd < r.r + 2.4 && tt < bestT) {
        bestT = tt;
        hit = { r, px, pz };
      }
    }
    if (hit) {
      let nx = hit.px - hit.r.x;
      let nz = hit.pz - hit.r.z;
      let nl = Math.hypot(nx, nz);
      if (nl < 0.01) {
        nx = -(gz - s.z);
        nz = gx - s.x;
        nl = Math.hypot(nx, nz) || 1;
      }
      gx = hit.r.x + (nx / nl) * (hit.r.r + 3.6);
      gz = hit.r.z + (nz / nl) * (hit.r.r + 3.6);
    }
    return { wx: gx, wz: gz, onCourse };
  }

  // A flare pulls every ship in range straight at it: only fire where no
  // pulled ship would be dragged across a reef or into the coast.
  flareSafe(fx, fz) {
    const g = this.game;
    for (const r of REEFS) if (Math.hypot(fx - r.x, fz - r.z) < r.r + 3) return false;
    if (fz > 10) return false;
    for (const s of g.ships) {
      if (s.state !== 'sail' || Math.hypot(s.x - fx, s.z - fz) > FLARE_R) continue;
      const ax = fx - s.x;
      const az = fz - s.z;
      const L2 = ax * ax + az * az || 1;
      for (const r of REEFS) {
        const tt = clamp(((r.x - s.x) * ax + (r.z - s.z) * az) / L2, 0, 1);
        if (Math.hypot(s.x + ax * tt - r.x, s.z + az * tt - r.z) < r.r + 1.6) return false;
      }
    }
    return true;
  }

  pickFlare(cx, cz, dirX, dirZ) {
    const base = Math.atan2(dirX, dirZ);
    for (const dist of [7, 5, 9]) {
      for (const da of [0, 0.4, -0.4, 0.8, -0.8]) {
        const fx = cx + Math.sin(base + da) * dist;
        const fz = cz + Math.cos(base + da) * dist;
        if (this.flareSafe(fx, fz)) return { x: fx, z: fz };
      }
    }
    return null;
  }

  think() {
    const g = this.game;
    const ships = g.ships.filter((s) => s.state === 'sail');
    if (!ships.length) {
      this.target = null;
      this.aim = { x: GATE.x + Math.sin(g.t * 0.5) * 12, z: -34 };
      return;
    }
    let best = null;
    let bestU = -1e9;
    for (const s of ships) {
      const plan = this.plan(s);
      let u = (s.z + 70) / 90;
      if (s.danger) u += 1.6 - Math.min(1.2, s.dangerT * 0.3);
      if (plan.onCourse) u -= 1.2;
      if (s === this.target) u += 0.45;
      if (s.age < 1.5) u -= 0.5;
      if (u > bestU) {
        bestU = u;
        best = { s, plan };
      }
    }
    const { s, plan } = best;
    this.target = s;
    const dx = plan.wx - s.x;
    const dz = plan.wz - s.z;
    const d = Math.hypot(dx, dz) || 1;
    const lead = clamp(d, 2.5, 4.8);
    this.aim = { x: s.x + (dx / d) * lead, z: s.z + (dz / d) * lead };

    // Flares: rescue a ship the beam can't reach in time, or show one off early.
    if (g.flareCount >= 1 && g.t - g.lastFlareT > 4 && !this.queue.length) {
      const victim = ships.find(
        (o) =>
          o !== s &&
          o.danger &&
          o.dangerT < 2.4 &&
          Math.hypot(o.x - this.aim.x, o.z - this.aim.z) > BEAM_R + 1 &&
          !g.flares.some((f) => Math.hypot(f.tx - o.x, f.tz - o.z) < FLARE_R)
      );
      if (victim) {
        const pv = this.plan(victim);
        const vx = pv.wx - victim.x;
        const vz = pv.wz - victim.z;
        const p = this.pickFlare(victim.x, victim.z, vx, vz);
        if (p) this.clickWorld(p.x, p.z);
      } else if (g.flaresUsed === 0 && g.playT > 16) {
        const far = ships.filter((o) => o !== s && o.z < -12);
        if (far.length >= 2) {
          let cx = 0;
          let cz = 0;
          for (const o of far) {
            cx += o.x;
            cz += o.z;
          }
          cx /= far.length;
          cz /= far.length;
          const tx = GATE.x - cx;
          const tz = 4 - cz;
          const p = this.pickFlare(cx, cz, tx, tz);
          if (p) this.clickWorld(p.x, p.z);
        }
      }
    }
  }

  update(dt) {
    const g = this.game;
    const { w, h } = this.viewport();
    if (g.state !== this.lastState) {
      this.lastState = g.state;
      this.queue = [];
      this.pressT = -1;
      if (this.input.isDown) this.input.up(this.x, this.y);
    }

    let tx;
    let ty;
    if (this.queue.length) {
      const a = this.queue[0];
      const p = a.screen();
      tx = p.x;
      ty = p.y;
      const d = Math.hypot(tx - this.x, ty - this.y);
      if (this.pressT < 0 && (d < 5 || g.t - a.t0 > 1.6)) {
        this.input.down(this.x, this.y, 'mouse');
        this.pressT = g.t;
      } else if (this.pressT >= 0 && g.t - this.pressT > 0.09) {
        this.input.up(this.x, this.y);
        this.pressT = -1;
        this.queue.shift();
      }
    } else if (g.state === 'title') {
      tx = w * 0.62 + Math.sin(g.t * 0.9) * 18;
      ty = h * 0.76 + Math.sin(g.t * 1.3) * 10;
      if (g.stateT > 2.3) this.clickElement('start-btn');
    } else if (g.state === 'over') {
      tx = w * 0.6;
      ty = h * 0.7;
      if (g.stateT > 2.8) this.clickElement('over-btn');
    } else {
      if (g.t >= this.nextThink) {
        this.nextThink = g.t + 0.15;
        this.think();
      }
      const p = this.world.worldToScreen(this.aim.x, 0, this.aim.z);
      tx = p.x;
      ty = p.y;
    }

    // Critically damped spring + a little hand tremor.
    const om = this.pressT >= 0 ? 4 : 10;
    this.vx += (om * om * (tx - this.x) - 2 * om * this.vx) * dt;
    this.vy += (om * om * (ty - this.y) - 2 * om * this.vy) * dt;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    const jx = Math.sin(g.t * 9.1) * 0.4 + Math.sin(g.t * 4.3 + 1) * 0.6;
    const jy = Math.sin(g.t * 7.7 + 2) * 0.4 + Math.sin(g.t * 3.1) * 0.5;
    this.input.move(clamp(this.x + jx, 2, w - 2), clamp(this.y + jy, 2, h - 2));
  }
}
