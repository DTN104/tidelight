// DOM HUD. No CSS transitions/animations: every visual value is computed from
// simulation time here, so ?capture frames are exact.
import { smoothstep, clamp } from './util.js';
import { WATCHES, MAX_LAMPS, MAX_FLARE_COUNT } from './game.js';

const $ = (id) => document.getElementById(id);
// Screen-space stacking so simultaneous pops never overlap.
const POP_OFFSET = { score: 0, chain: -36, good: 30, flare: -66, bad: 0 };

function setText(el, text) {
  if (el._t !== text) {
    el._t = text;
    el.textContent = text;
  }
}
function setHTML(el, html) {
  if (el._h !== html) {
    el._h = html;
    el.innerHTML = html;
  }
}
function css(el, prop, value) {
  const key = '_' + prop;
  if (el[key] !== value) {
    el[key] = value;
    el.style[prop] = value;
  }
}
function cls(el, name, on) {
  const key = '_c_' + name;
  if (el[key] !== on) {
    el[key] = on;
    el.classList.toggle(name, on);
  }
}

export class Hud {
  constructor(capture) {
    this.capture = capture;
    this.root = $('hud');
    this.score = $('score');
    this.chain = $('chain');
    this.lampsEl = $('lamps');
    this.flaresEl = $('flares');
    this.watch = $('watch');
    this.watchName = $('watch-name');
    this.watchSub = $('watch-sub');
    this.hint = $('hint');
    this.pops = $('pops');
    this.title = $('title');
    this.titleItems = [...this.title.querySelectorAll('[data-in]')].map((el) => ({ el, d: parseFloat(el.dataset.in) }));
    this.startBtn = $('start-btn');
    this.over = $('over');
    this.overItems = [...this.over.querySelectorAll('[data-in]')].map((el) => ({ el, d: parseFloat(el.dataset.in) }));
    this.overBtn = $('over-btn');
    this.overScore = $('over-score');
    this.overDocked = $('over-docked');
    this.overBest = $('over-best');
    this.overBadge = $('over-badge');
    this.fade = $('fade');
    this.cursor = $('cursor');
    this.cursorArrow = $('cursor-arrow');
    this.ripple = $('cursor-ripple');
    if (capture) this.cursor.style.display = 'block';

    this.lamps = [];
    for (let i = 0; i < MAX_LAMPS; i++) {
      const el = document.createElement('i');
      el.className = 'lamp';
      this.lampsEl.appendChild(el);
      this.lamps.push(el);
    }
    this.pips = [];
    for (let i = 0; i < MAX_FLARE_COUNT; i++) {
      const el = document.createElement('i');
      el.className = 'pip';
      const fill = document.createElement('b');
      el.appendChild(fill);
      this.flaresEl.appendChild(el);
      this.pips.push({ el, fill });
    }
    this.popEls = [];
    for (let i = 0; i < 12; i++) {
      const el = document.createElement('div');
      el.className = 'pop';
      el.style.opacity = '0';
      this.pops.appendChild(el);
      this.popEls.push(el);
    }
  }

  update(game, world, input, best) {
    const t = game.t;
    css(this.fade, 'opacity', (1 - smoothstep(0.05, 1.1, t)).toFixed(3));

    // ---- Title
    let titleA = 0;
    if (game.state === 'title') titleA = 1;
    else if (game.introT !== null && t - game.introT < 0.9) titleA = 1 - smoothstep(0, 0.75, t - game.introT);
    css(this.title, 'opacity', titleA.toFixed(3));
    css(this.title, 'visibility', titleA > 0.001 ? 'visible' : 'hidden');
    css(this.title, 'transform', `scale(${(1 + (1 - titleA) * 0.05).toFixed(4)})`);
    for (const it of this.titleItems) {
      const a = smoothstep(it.d, it.d + 0.8, t);
      css(it.el, 'opacity', a.toFixed(3));
      css(it.el, 'transform', `translateY(${((1 - a) * 16).toFixed(2)}px)`);
    }

    // ---- Game over
    let overA = 0;
    if (game.state === 'over') overA = smoothstep(0.7, 1.7, game.stateT);
    else if (game.state === 'play' && game.overAt > 0 && game.stateT < 0.8 && game.introT !== game.t - game.stateT) {
      overA = 1 - smoothstep(0, 0.6, game.stateT);
    }
    css(this.over, 'opacity', overA.toFixed(3));
    css(this.over, 'visibility', overA > 0.001 ? 'visible' : 'hidden');
    if (game.state === 'over') {
      for (const it of this.overItems) {
        const a = smoothstep(it.d, it.d + 0.8, game.stateT);
        css(it.el, 'opacity', a.toFixed(3));
        css(it.el, 'transform', `translateY(${((1 - a) * 14).toFixed(2)}px)`);
      }
      setText(this.overScore, game.score.toLocaleString('en-US'));
      setText(this.overDocked, String(game.docked));
      setText(this.overBest, Math.max(best, game.score).toLocaleString('en-US'));
      css(this.overBadge, 'display', game.score > 0 && game.score >= best ? 'inline-block' : 'none');
    }

    // ---- Buttons react to the (real or scripted) pointer
    for (const [btn, vis] of [[this.startBtn, titleA], [this.overBtn, overA]]) {
      let hover = false;
      if (input.x != null && vis > 0.001) {
        const r = btn.getBoundingClientRect();
        hover = input.x >= r.left && input.x <= r.right && input.y >= r.top && input.y <= r.bottom;
      }
      cls(btn, 'hover', hover);
      cls(btn, 'press', hover && input.isDown);
    }

    // ---- HUD
    let hudA = 0;
    if (game.state === 'play') hudA = game.introT !== null && t - game.introT < 3 ? smoothstep(1.2, 2.2, t - game.introT) : 1;
    else if (game.state === 'over') hudA = 1 - smoothstep(0.3, 1.0, game.stateT);
    css(this.root, 'opacity', hudA.toFixed(3));

    setText(this.score, game.displayScore().toLocaleString('en-US'));
    const sBump = 1 - smoothstep(0, 0.35, t - game.scoreAt);
    css(this.score, 'transform', `scale(${(1 + sBump * 0.12).toFixed(4)})`);

    const showChain = game.chain >= 2;
    const cBump = 1 - smoothstep(0, 0.3, t - game.chainAt);
    css(this.chain, 'opacity', showChain ? '1' : '0');
    css(this.chain, 'transform', `scale(${(1 + cBump * 0.18).toFixed(4)})`);
    setHTML(this.chain, `Chain <b>×${game.chain}</b>`);

    for (let i = 0; i < this.lamps.length; i++) {
      const el = this.lamps[i];
      const lit = i < game.lamps;
      cls(el, 'out', !lit);
      let o = 1;
      let s = 1;
      if (i === game.lamps && t - game.lampLostAt < 1.0) {
        const k = t - game.lampLostAt;
        o = 0.4 + 0.6 * Math.abs(Math.sin(k * 14)) * (1 - k);
        s = 1 + 0.35 * (1 - smoothstep(0, 0.5, k));
      }
      css(el, 'opacity', o.toFixed(3));
      css(el, 'transform', `scale(${s.toFixed(3)})`);
    }
    for (let i = 0; i < this.pips.length; i++) {
      const p = this.pips[i];
      let fill = 0;
      if (i < game.flareCount) fill = 1;
      else if (i === game.flareCount) fill = game.flareProgress;
      css(p.fill, 'height', `${(fill * 100).toFixed(1)}%`);
      cls(p.el, 'full', fill >= 1);
      let s = 1;
      if (i === game.flareCount - 1 && t - game.flareGainT < 0.6) s = 1 + 0.5 * (1 - smoothstep(0, 0.6, t - game.flareGainT));
      if (i === game.flareCount && t - game.noFlareT < 0.6) s = 1 + 0.3 * Math.abs(Math.sin((t - game.noFlareT) * 20));
      css(p.el, 'transform', `scale(${s.toFixed(3)})`);
    }

    // ---- Watch banner
    let wA = 0;
    if (game.watch >= 0 && game.state === 'play') {
      const w = WATCHES[game.watch];
      const age = t - game.watchT - (game.watch === 0 ? 1.4 : 0);
      wA = smoothstep(0, 0.6, age) * (1 - smoothstep(3.0, 3.8, age));
      setText(this.watchName, w.name);
      setText(this.watchSub, w.sub);
      css(this.watch, 'transform', `translateY(${((1 - smoothstep(0, 0.8, age)) * -10).toFixed(2)}px)`);
      css(this.watch, 'letterSpacing', `${(0.02 + smoothstep(0, 3.8, age) * 0.06).toFixed(3)}em`);
    }
    css(this.watch, 'opacity', wA.toFixed(3));

    // ---- Hints
    let hintA = 0;
    let hint = '';
    const touch = input.pointerType === 'touch';
    if (game.state === 'play') {
      const p = game.playT;
      if (p < 7.4) {
        hint = `${touch ? 'Drag' : 'Move'} to sweep the beam &nbsp;·&nbsp; <b>every ship steers toward your light</b>`;
        hintA = smoothstep(4.6, 5.2, p) * (1 - smoothstep(6.8, 7.4, p));
        if (game.introT === null || t - game.introT > 6) hintA = smoothstep(0.4, 1.0, p) * (1 - smoothstep(6.8, 7.4, p));
      } else if (p < 15 && game.flaresUsed === 0) {
        hint = `${touch ? 'Tap' : 'Click'} to fire a <b>flare</b> &nbsp;·&nbsp; it pulls in every ship around it`;
        hintA = smoothstep(7.8, 8.4, p) * (1 - smoothstep(14.2, 15, p));
      }
      if (t - game.noFlareT < 2.2) {
        hint = 'Out of flares &nbsp;·&nbsp; <b>harbor three ships</b> to earn one';
        hintA = 1 - smoothstep(1.6, 2.2, t - game.noFlareT);
      }
    }
    if (hint) setHTML(this.hint, hint);
    css(this.hint, 'opacity', hintA.toFixed(3));

    // ---- Floating text
    const list = game.pops.slice(-this.popEls.length);
    for (let i = 0; i < this.popEls.length; i++) {
      const el = this.popEls[i];
      const p = list[i];
      if (!p || t < p.t0) {
        css(el, 'opacity', '0');
        continue;
      }
      const age = t - p.t0;
      const a = smoothstep(0, 0.12, age) * (1 - smoothstep(p.dur - 0.5, p.dur, age));
      const sp = world.worldToScreen(p.x, p.y, p.z);
      if (sp.behind) {
        css(el, 'opacity', '0');
        continue;
      }
      const rise = age * 28 + (1 - smoothstep(0, 0.3, age)) * -6 - (POP_OFFSET[p.kind] || 0);
      const sc = 1 + 0.35 * (1 - smoothstep(0, 0.22, age));
      if (el._kind !== p.kind) {
        el._kind = p.kind;
        el.className = 'pop ' + p.kind;
      }
      setText(el, p.text);
      css(el, 'opacity', a.toFixed(3));
      css(el, 'transform', `translate(${sp.x.toFixed(1)}px, ${(sp.y - rise).toFixed(1)}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`);
    }

    // ---- Scripted cursor (capture only)
    if (this.capture) css(this.cursor, 'opacity', input.x != null ? smoothstep(0.4, 1.2, t).toFixed(3) : '0');
    if (this.capture && input.x != null) {
      css(this.cursor, 'transform', `translate(${input.x.toFixed(1)}px, ${input.y.toFixed(1)}px)`);
      css(this.cursorArrow, 'transform', `scale(${input.isDown ? 0.86 : 1})`);
      const ra = t - input.lastDownT;
      if (ra >= 0 && ra < 0.5) {
        const k = ra / 0.5;
        css(this.ripple, 'opacity', (0.9 * (1 - k)).toFixed(3));
        css(this.ripple, 'transform', `scale(${(0.35 + k * 1.6).toFixed(3)})`);
      } else {
        css(this.ripple, 'opacity', '0');
      }
    }
  }
}
