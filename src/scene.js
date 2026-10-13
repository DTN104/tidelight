// Everything visual. All geometry is modelled in code; the only textures are
// small canvases drawn at startup. sync() derives every visual from game state
// (no hidden animation clocks), so captured frames are reproducible.
import * as THREE from 'three';
import { GATE, BREAKWATER, LIGHTHOUSE, LAMP, REEFS, shoreZ, landHeight, barrierZ, WORLD } from './layout.js';
import { mulberry32, clamp, lerp, smoothstep, waveHeight, WAVE_GLSL } from './util.js';
import { BEAM_R, FLARE_R, FLIGHT, BURN, MAX_PARTICLES, MAX_SHIPS, MAX_FLARES } from './game.js';

const FOG_HEX = 0x172a40;
const MOON_DIR = new THREE.Vector3(0.21, 0.052, -1).normalize();
const HULLS = [0x8e3a2f, 0xd8cdb8, 0x2f6276, 0x3e4d41, 0xb7843a];
const WATCH_FOG = [300, 250, 240, 225];

const disp = (hex) => new THREE.Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

function canvasTex(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function glowTexture() {
  return canvasTex(128, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.1, 'rgba(255,255,255,0.8)');
    gr.addColorStop(0.3, 'rgba(255,255,255,0.25)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.06)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
}

function dangerTexture() {
  return canvasTex(128, (g, s) => {
    const c = s / 2;
    const halo = g.createRadialGradient(c, c, 20, c, c, 64);
    halo.addColorStop(0, 'rgba(255,90,70,0.55)');
    halo.addColorStop(1, 'rgba(255,90,70,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, s, s);
    g.beginPath();
    g.arc(c, c, 30, 0, Math.PI * 2);
    g.fillStyle = '#e8483a';
    g.fill();
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(255,225,210,0.95)';
    g.stroke();
    g.fillStyle = '#fff';
    g.fillRect(c - 4.5, c - 19, 9, 24);
    g.beginPath();
    g.arc(c, c + 13, 5, 0, Math.PI * 2);
    g.fill();
  });
}

function moonTexture() {
  return canvasTex(256, (g, s) => {
    const c = s / 2;
    const r = 70;
    const disc = g.createRadialGradient(c - 18, c - 20, 10, c, c, r);
    disc.addColorStop(0, '#fff8e6');
    disc.addColorStop(0.75, '#f1e1c0');
    disc.addColorStop(1, '#d9c39b');
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.fillStyle = disc;
    g.fill();
    const rng = mulberry32(42);
    g.save();
    g.beginPath();
    g.arc(c, c, r, 0, Math.PI * 2);
    g.clip();
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const d = Math.sqrt(rng()) * r * 0.85;
      const rr = 5 + rng() * 18;
      g.beginPath();
      g.ellipse(c + Math.cos(a) * d, c + Math.sin(a) * d, rr, rr * (0.7 + rng() * 0.3), rng() * 3, 0, Math.PI * 2);
      g.fillStyle = `rgba(160,140,115,${0.12 + rng() * 0.16})`;
      g.fill();
    }
    g.restore();
  });
}

function glowSprite(tex, hex, scale, depthTest = true) {
  const m = new THREE.SpriteMaterial({
    map: tex,
    color: hex,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    depthTest,
    toneMapped: false,
    fog: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.set(scale, scale, 1);
  return s;
}

// Low-poly hull: a box tapered to a bow, narrowed at the keel, with sheer.
function hullGeometry(len, beam, depth) {
  const g = new THREE.BoxGeometry(beam, depth, len, 1, 1, 3);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const fz = z / (len / 2);
    let w = fz > 0 ? 1 - Math.pow(fz, 1.6) * 0.96 : 1 - Math.pow(-fz, 3) * 0.22;
    if (y < 0) w *= 0.55;
    p.setX(i, x * w);
    if (y > 0 && fz > 0.3) p.setY(i, y + (fz - 0.3) * 0.36);
  }
  g.computeVertexNormals();
  return g;
}

function triangleGeometry(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  const g = new THREE.ShapeGeometry(shape);
  g.rotateY(Math.PI / 2);
  return g;
}

// Icosahedron with consistent per-vertex jitter (shared corners stay welded).
function rockGeometry(rng, detail = 0) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.attributes.position;
  const offsets = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!offsets.has(key)) offsets.set(key, 0.72 + rng() * 0.5);
    const k = offsets.get(key);
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

// Gradient of waveH() (see util.js) plus a few small ripples, for shading only.
const WATER_NORMAL_GLSL = /* glsl */ `
vec2 swellGrad(vec2 p, float t) {
  float a = 0.21 * p.x + 0.9 * t;
  float b = 0.17 * p.y + 0.7 * t;
  float c = 0.37 * (0.6 * p.x + 0.8 * p.y) - 1.6 * t;
  float d = 0.55 * (-0.3 * p.x + p.y) - 2.2 * t;
  vec2 g = vec2(0.28 * 0.21 * cos(a) * cos(b), -0.28 * 0.17 * sin(a) * sin(b));
  g += 0.16 * 0.37 * cos(c) * vec2(0.6, 0.8);
  g += 0.08 * 0.55 * cos(d) * vec2(-0.3, 1.0);
  return g;
}
vec2 rippleGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  vec2 d1 = vec2(0.8, 0.6);     g += 0.045 * 1.3 * cos(1.3 * dot(d1, p) - 1.9 * t) * d1;
  vec2 d2 = vec2(-0.486, 0.874); g += 0.025 * 2.2 * cos(2.2 * dot(d2, p) - 2.6 * t) * d2;
  vec2 d3 = vec2(0.954, -0.301); g += 0.012 * 3.7 * cos(3.7 * dot(d3, p) - 3.3 * t) * d3;
  vec2 d4 = vec2(-0.196, -0.981); g += 0.006 * 5.9 * cos(5.9 * dot(d4, p) - 4.1 * t) * d4;
  return g;
}
`;

export class World {
  constructor(renderer) {
    this.renderer = renderer;
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(FOG_HEX, 40, 300);
    this.scene.background = new THREE.Color(FOG_HEX);
    this.camera = new THREE.PerspectiveCamera(46, 16 / 9, 0.5, 1400);
    this.rng = mulberry32(7);
    this.time = { value: 0 };
    this.tex = { glow: glowTexture(), danger: dangerTexture(), moon: moonTexture() };
    this.raycaster = new THREE.Raycaster();
    this.waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.vw = 1;
    this.vh = 1;
    this._v = new THREE.Vector3();
    this._ndc = new THREE.Vector2();
    this._look = new THREE.Vector3();
    this.bobbers = [];
    this.blinkers = [];

    this.buildMaterials();
    this.buildSky();
    this.buildLights();
    this.buildWater();
    this.buildLand();
    this.buildIslands();
    this.buildHarbor();
    this.buildLighthouse();
    this.buildTown();
    this.buildReefs();
    this.buildBeam();
    this.buildShips();
    this.buildParticles();
    this.buildFlares();
  }

  // ------------------------------------------------------------ materials
  buildMaterials() {
    const lam = (hex, extra = {}) => new THREE.MeshLambertMaterial({ color: hex, flatShading: true, ...extra });
    this.M = {
      concrete: lam(0x6f757d),
      concreteTop: lam(0x8a9097),
      rock: lam(0x3b4047),
      rockLight: lam(0x50565e),
      wood: lam(0x7d5c3e),
      cream: lam(0xe4dac4),
      white: lam(0xe9e4d8),
      dark: lam(0x262a31),
      red: lam(0xa8382c),
      sail: lam(0xf0e8d6, { side: THREE.DoubleSide }),
      sail2: lam(0xe2d6bd, { side: THREE.DoubleSide }),
      window: new THREE.MeshBasicMaterial({ color: 0xffc77a, toneMapped: false }),
      windowDim: new THREE.MeshBasicMaterial({ color: 0x3a3428, toneMapped: false }),
      island: lam(0x0f1a26),
    };
  }

  // ------------------------------------------------------------ sky
  buildSky() {
    this.skyGroup = new THREE.Group();
    this.scene.add(this.skyGroup);

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(600, 40, 24),
      new THREE.ShaderMaterial({
        uniforms: {
          uHorizon: { value: disp(FOG_HEX) },
          uMid: { value: disp(0x0d1b31) },
          uZenith: { value: disp(0x03070f) },
          uMoonDir: { value: MOON_DIR },
          uMoonGlow: { value: disp(0xe0c08e) },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 uHorizon, uMid, uZenith, uMoonDir, uMoonGlow;
          varying vec3 vDir;
          void main() {
            vec3 d = normalize(vDir);
            float h = d.y;
            vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.16, h));
            col = mix(col, uZenith, smoothstep(0.16, 0.7, h));
            float m = max(dot(d, uMoonDir), 0.0);
            col += uMoonGlow * (pow(m, 60.0) * 0.30 + pow(m, 10.0) * 0.10 + pow(m, 2.5) * 0.035) * smoothstep(-0.06, 0.01, h);
            col = mix(col, uHorizon, smoothstep(0.0, -0.06, h));
            float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
            col += (n - 0.5) / 255.0;
            gl_FragColor = vec4(col, 1.0);
          }`,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      })
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.skyGroup.add(sky);

    // Stars
    const N = 900;
    const pos = new Float32Array(N * 3);
    const size = new Float32Array(N);
    const phase = new Float32Array(N);
    const r = mulberry32(99);
    for (let i = 0; i < N; i++) {
      const th = r() * Math.PI * 2;
      const y = lerp(0.02, 1, Math.pow(r(), 0.8));
      const rr = Math.sqrt(1 - y * y);
      pos[i * 3] = Math.cos(th) * rr * 560;
      pos[i * 3 + 1] = y * 560;
      pos[i * 3 + 2] = Math.sin(th) * rr * 560;
      size[i] = 0.8 + Math.pow(r(), 5) * 2.8;
      phase[i] = r();
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uPR: { value: 1 } },
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aPhase;
        uniform float uTime; uniform float uPR;
        varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uPR;
          float h = normalize(position).y;
          vA = (0.55 + 0.45 * sin(uTime * (0.6 + aPhase * 1.7) + aPhase * 40.0)) * smoothstep(0.02, 0.22, h);
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d) * vA;
          gl_FragColor = vec4(vec3(0.86, 0.9, 1.0), a);
        }`,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(sg, this.starMat);
    stars.renderOrder = -9;
    stars.frustumCulled = false;
    this.skyGroup.add(stars);

    // Low, rising moon.
    const halo = glowSprite(this.tex.glow, 0x6d5d4a, 150);
    halo.position.copy(MOON_DIR).multiplyScalar(540);
    halo.renderOrder = -8;
    this.skyGroup.add(halo);
    const moon = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.tex.moon, transparent: true, depthWrite: false, fog: false, toneMapped: false })
    );
    moon.position.copy(MOON_DIR).multiplyScalar(540);
    moon.scale.set(48, 48, 1);
    moon.renderOrder = -7;
    this.skyGroup.add(moon);
  }

  // ------------------------------------------------------------ lights
  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight(0x6f8fc4, 0x0d1826, 2.0));
    const moon = new THREE.DirectionalLight(0xbfd0ff, 0.9);
    moon.position.set(0.21, 0.35, -1).multiplyScalar(100);
    s.add(moon);
    const fill = new THREE.DirectionalLight(0x4a6a9a, 0.4);
    fill.position.set(10, 40, 80);
    s.add(fill);

    this.spot = new THREE.SpotLight(0xffbd6e, 26, 0, 0.2, 0.6, 0);
    this.spot.position.set(LAMP.x, LAMP.y, LAMP.z);
    this.spotTarget = new THREE.Object3D();
    s.add(this.spotTarget);
    this.spot.target = this.spotTarget;
    s.add(this.spot);

    this.flareLight = new THREE.PointLight(0xff9a7a, 0, 45, 1);
    s.add(this.flareLight);
  }

  // ------------------------------------------------------------ water
  buildWater() {
    const geo = new THREE.PlaneGeometry(440, 330, 160, 120);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -95);
    const p = geo.attributes.position;
    const colors = new Float32Array(p.count * 3);
    const deep = new THREE.Color(0x0d3046);
    const far = new THREE.Color(0x0b2437);
    const shallow = new THREE.Color(0x1d5a6c);
    const foam = new THREE.Color(0x86b8c6);
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      let shore = barrierZ(x) - z;
      if (x > BREAKWATER.left && x < BREAKWATER.right && z > GATE.z) shore = 6;
      let reefD = 99;
      for (const r of REEFS) reefD = Math.min(reefD, Math.hypot(x - r.x, z - r.z) - r.r);
      c.copy(deep).lerp(far, smoothstep(-20, -150, z));
      c.lerp(shallow, Math.max(smoothstep(10, 0, shore), smoothstep(6, 0, reefD)));
      c.lerp(foam, Math.max(smoothstep(1.8, -0.6, shore), smoothstep(1.4, -0.4, reefD)) * 0.8);
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // Smooth, per-pixel wave normals: the analytic gradient of the swell plus
    // small fading ripples, so the surface never shows the mesh grid.
    const mat = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      vertexColors: true,
      shininess: 110,
      specular: 0x3e5a78,
    });
    const time = this.time;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader =
        'uniform float uTime;\nvarying vec3 vWPos;\n' +
        WAVE_GLSL +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n  transformed.y += waveH(position.xz, uTime);\n  vWPos = transformed;'
        );
      shader.fragmentShader =
        'uniform float uTime;\nvarying vec3 vWPos;\n' +
        WATER_NORMAL_GLSL +
        shader.fragmentShader.replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
  {
    float fadeR = smoothstep(220.0, 40.0, length(vViewPosition));
    vec2 gr = swellGrad(vWPos.xz, uTime) + rippleGrad(vWPos.xz, uTime) * fadeR;
    vec3 nW = normalize(vec3(-gr.x, 1.0, -gr.y));
    normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
  }`
        );
    };
    const water = new THREE.Mesh(geo, mat);
    water.frustumCulled = false;
    this.scene.add(water);
  }

  // ------------------------------------------------------------ land
  buildLand() {
    const sand = new THREE.Color(0x8a7b5d);
    const grass = new THREE.Color(0x2d4a33);
    const grassDark = new THREE.Color(0x1f3526);
    const rock = new THREE.Color(0x4a4e54);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, flatShading: true });
    const ds = [-2, 0, 0.9, 2, 3.4, 5.2, 8, 12, 17, 24, 34, 48];
    const piece = (x0, x1) => {
      const cols = Math.ceil((x1 - x0) / 2.2) + 1;
      const pos = [];
      const col = [];
      const idx = [];
      const c = new THREE.Color();
      for (let i = 0; i < cols; i++) {
        const x = lerp(x0, x1, i / (cols - 1));
        const sz = shoreZ(x);
        for (let j = 0; j < ds.length; j++) {
          const z = sz + ds[j] + (j > 1 ? Math.sin(x * 1.7 + j) * 0.4 : 0);
          const y = landHeight(x, z);
          pos.push(x, y, z);
          const n = 0.5 + 0.5 * Math.sin(x * 0.9 + z * 0.7) * Math.cos(x * 0.31 - z * 0.53);
          c.copy(sand).lerp(grass, smoothstep(0.15, 0.95, y));
          c.lerp(grassDark, n * smoothstep(0.8, 2.2, y));
          c.lerp(rock, smoothstep(0.62, 0.9, n) * smoothstep(1.2, 3, y) * 0.8);
          col.push(c.r, c.g, c.b);
        }
      }
      const R = ds.length;
      for (let i = 0; i < cols - 1; i++) {
        for (let j = 0; j < R - 1; j++) {
          const a = i * R + j;
          const b = i * R + j + 1;
          const cc = (i + 1) * R + j;
          const d = (i + 1) * R + j + 1;
          idx.push(a, b, cc, b, d, cc);
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      this.scene.add(new THREE.Mesh(g, mat));
    };
    piece(-140, BREAKWATER.left);
    piece(BREAKWATER.right, 140);
  }

  buildIslands() {
    const r = mulberry32(5);
    const spots = [
      [-150, -200, 70, 13, 24],
      [60, -225, 54, 9, 20],
      [185, -180, 64, 15, 26],
      [-60, -240, 40, 6, 16],
    ];
    for (const [x, z, sx, sy, sz] of spots) {
      const m = new THREE.Mesh(rockGeometry(r, 1), this.M.island);
      m.position.set(x, -3, z);
      m.scale.set(sx, sy, sz);
      this.scene.add(m);
    }
  }

  // ------------------------------------------------------------ harbor
  buildHarbor() {
    const s = this.scene;
    const M = this.M;
    const box = (w, h, d, x, y, z, mat) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      s.add(m);
      return m;
    };
    const gl = GATE.x - GATE.half; // 0.4
    const gr = GATE.x + GATE.half; // 7.6
    const L = BREAKWATER.left;
    const R = BREAKWATER.right;
    // Front arms
    box(gl - (L - 0.8), 2.2, 1.6, (gl + L - 0.8) / 2, 0.1, GATE.z + 0.8, M.concrete);
    box(R + 0.8 - gr, 2.2, 1.6, (R + 0.8 + gr) / 2, 0.1, GATE.z + 0.8, M.concrete);
    box(gl - (L - 0.8), 0.12, 1.2, (gl + L - 0.8) / 2, 1.26, GATE.z + 0.8, M.concreteTop);
    box(R + 0.8 - gr, 0.12, 1.2, (R + 0.8 + gr) / 2, 1.26, GATE.z + 0.8, M.concreteTop);
    // Quays running inland
    box(1.6, 2.2, 56, L, 0.1, GATE.z + 28, M.concrete);
    box(1.6, 2.2, 56, R, 0.1, GATE.z + 28, M.concrete);

    // Rubble along the seaward faces
    const r = mulberry32(11);
    const rubbleGeo = rockGeometry(r);
    const rubble = new THREE.InstancedMesh(rubbleGeo, M.rock, 90);
    const dummy = new THREE.Object3D();
    let n = 0;
    const put = (x, z) => {
      if (n >= 90) return;
      const sc = 0.45 + r() * 0.55;
      dummy.position.set(x, -0.35 + r() * 0.4, z);
      dummy.rotation.set(r() * 3, r() * 3, r() * 3);
      dummy.scale.set(sc * (1 + r() * 0.5), sc * 0.8, sc);
      dummy.updateMatrix();
      rubble.setMatrixAt(n++, dummy.matrix);
    };
    for (let x = L - 0.8; x < gl - 0.6; x += 1.15) put(x + r() * 0.4, GATE.z - 0.15 + r() * 0.3);
    for (let x = gr + 0.6; x < R + 0.8; x += 1.15) put(x + r() * 0.4, GATE.z - 0.15 + r() * 0.3);
    for (let z = GATE.z; z < 28; z += 1.2) {
      put(L - 1.1 - r() * 0.3, z + r() * 0.4);
      put(R + 1.1 + r() * 0.3, z + r() * 0.4);
    }
    rubble.count = n;
    rubble.instanceMatrix.needsUpdate = true;
    s.add(rubble);

    // Harbor-mouth towers: green to starboard, red to port when entering.
    const head = (x, bandMat, hex, period, offset) => {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.0, 3.2, 12), M.white);
      base.position.y = 0.6;
      g.add(base);
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.87, 0.9, 0.8, 12), bandMat);
      band.position.y = 1.7;
      g.add(band);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.5, 8), M.dark);
      cap.position.y = 2.45;
      g.add(cap);
      g.position.set(x, 0, GATE.z + 0.8);
      s.add(g);
      const light = glowSprite(this.tex.glow, hex, 3.2);
      light.position.set(x, 2.85, GATE.z + 0.8);
      s.add(light);
      this.blinkers.push({ sprite: light, period, offset, on: 0.6, base: 3.2 });
    };
    head(gl - 0.3, new THREE.MeshLambertMaterial({ color: 0x2f8f5a, flatShading: true }), 0x5cff9a, 3, 0);
    head(gr + 0.3, M.red, 0xff4a3a, 3, 1.5);

    // Quay lamps
    for (const x of [L + 2.5, gl - 3.5, gr + 3.5, R - 2.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.8, 6), M.dark);
      post.position.set(x, 2.1, GATE.z + 1.1);
      s.add(post);
      const g = glowSprite(this.tex.glow, 0xffc477, 2.0);
      g.position.set(x, 3.05, GATE.z + 1.1);
      s.add(g);
    }

    // A couple of boats already moored inside.
    const moored = [
      { x: L + 1.9, z: 22.5, hd: 0.06, type: 'trawler', color: 2 },
      { x: R - 1.9, z: 24.8, hd: -0.05, type: 'sail', color: 1 },
      { x: R - 1.9, z: 20.4, hd: 0.03, type: 'trawler', color: 0 },
    ];
    for (const m of moored) {
      const hullMat = new THREE.MeshLambertMaterial({ color: HULLS[m.color], flatShading: true });
      const boat = this.makeBoat(m.type, hullMat);
      boat.position.set(m.x, 0, m.z);
      boat.rotation.y = m.hd;
      s.add(boat);
      const lan = glowSprite(this.tex.glow, 0xffbf6a, 1.6);
      lan.position.set(0, m.type === 'sail' ? 1.12 : 2.2, m.type === 'sail' ? 0.6 : 0.35);
      boat.add(lan);
      this.bobbers.push({ obj: boat, x: m.x, z: m.z, hd: m.hd, k: 0.4 });
    }
  }

  // ------------------------------------------------------------ lighthouse
  buildLighthouse() {
    const s = this.scene;
    const M = this.M;
    const g = new THREE.Group();
    g.position.set(LIGHTHOUSE.x, LIGHTHOUSE.ground, LIGHTHOUSE.z);
    s.add(g);
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const r = mulberry32(23);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + r();
      const m = add(rockGeometry(r), i % 2 ? M.rock : M.rockLight, Math.cos(a) * 2.6, -0.3, Math.sin(a) * 2.6);
      m.scale.set(1.2 + r(), 0.8 + r() * 0.6, 1.2 + r());
    }
    add(new THREE.CylinderGeometry(2.5, 2.9, 1.2, 12), M.concrete, 0, 0.3, 0);
    const H = 11;
    add(new THREE.CylinderGeometry(1.35, 2.05, H, 20, 1), M.white, 0, 0.9 + H / 2, 0);
    const radiusAt = (y) => 2.05 - (0.7 * y) / H + 0.03;
    for (const [y0, y1] of [
      [2.6, 4.2],
      [6.4, 8.0],
    ]) {
      add(new THREE.CylinderGeometry(radiusAt(y1), radiusAt(y0), y1 - y0, 20), M.red, 0, 0.9 + (y0 + y1) / 2, 0);
    }
    const top = 0.9 + H;
    add(new THREE.CylinderGeometry(2.0, 2.0, 0.28, 20), M.dark, 0, top + 0.1, 0);
    const rail = add(new THREE.TorusGeometry(1.9, 0.05, 4, 24), M.dark, 0, top + 0.75, 0);
    rail.rotation.x = Math.PI / 2;
    this.lanternMat = new THREE.MeshBasicMaterial({ color: 0xffe6ad, toneMapped: false });
    add(new THREE.CylinderGeometry(1.05, 1.05, 1.6, 12), this.lanternMat, 0, top + 1.05, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(new THREE.BoxGeometry(0.1, 1.6, 0.1), M.dark, Math.cos(a) * 1.07, top + 1.05, Math.sin(a) * 1.07);
    }
    add(new THREE.ConeGeometry(1.4, 1.2, 12), M.red, 0, top + 2.45, 0);
    add(new THREE.SphereGeometry(0.18, 8, 6), M.dark, 0, top + 3.15, 0);
    // Door and windows (facing the sea/camera)
    add(new THREE.BoxGeometry(0.8, 1.4, 0.2), M.dark, 0, 1.6, 2.02);
    for (const y of [5.4, 9.4]) add(new THREE.BoxGeometry(0.35, 0.6, 0.1), M.window, 0, 0.9 + y, radiusAt(y) - 0.02);

    // Keeper's cottage
    const cot = new THREE.Group();
    cot.position.set(4.2, landHeight(LIGHTHOUSE.x + 4.2, LIGHTHOUSE.z + 2.2) - LIGHTHOUSE.ground - 0.15, 2.2);
    g.add(cot);
    const walls = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.2, 3), M.white);
    walls.position.y = 0.6;
    cot.add(walls);
    const roof = new THREE.Mesh(this.roofGeometry(4.3, 1.5, 3.4), M.red);
    roof.position.y = 2.2;
    cot.add(roof);
    for (const x of [-0.9, 0.9]) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.7), M.window);
      w.position.set(x, 1.2, -1.52);
      w.rotation.y = Math.PI;
      cot.add(w);
    }

    // Lamp glare
    this.glare = glowSprite(this.tex.glow, 0xffd8a0, 10, false);
    this.glare.position.set(LAMP.x, LAMP.y, LAMP.z);
    this.glare.renderOrder = 7;
    s.add(this.glare);
    this.streak = glowSprite(this.tex.glow, 0xffc98a, 1, false);
    this.streak.renderOrder = 7;
    this.streak.scale.set(30, 1.0, 1);
    this.streak.position.set(LAMP.x, LAMP.y, LAMP.z);
    s.add(this.streak);
  }

  roofGeometry(w, h, d) {
    const shape = new THREE.Shape();
    shape.moveTo(-w / 2, 0);
    shape.lineTo(w / 2, 0);
    shape.lineTo(0, h);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
    g.translate(0, 0, -d / 2);
    return g;
  }

  // ------------------------------------------------------------ town
  buildTown() {
    const r = mulberry32(31);
    const walls = [0xcdb99d, 0x9fb0b8, 0xb98f7a, 0xd8cfba, 0x8f9f8c].map(
      (h) => new THREE.MeshLambertMaterial({ color: h, flatShading: true })
    );
    const roofs = [0x7d3328, 0x3f4a55, 0x5a3b2d].map((h) => new THREE.MeshLambertMaterial({ color: h, flatShading: true }));
    const spots = [
      [-14, 30.5], [-18.6, 31.8], [-33.5, 29.5], [-39.5, 32], [-45, 30], [-51, 31.5],
      [22, 30.5], [26.8, 32], [33, 29.8], [38.6, 31.6], [44.5, 30], [50, 32],
    ];
    for (const [x, z] of spots) {
      const w = 2.6 + r() * 1.6;
      const h = 2.0 + r() * 1.4;
      const d = 2.4 + r() * 1.2;
      const y = landHeight(x, z) - 0.2;
      const house = new THREE.Group();
      house.position.set(x, y, z);
      house.rotation.y = (r() - 0.5) * 0.25;
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), walls[Math.floor(r() * walls.length)]);
      body.position.y = h / 2;
      house.add(body);
      const roof = new THREE.Mesh(this.roofGeometry(w + 0.4, 1.0 + r() * 0.5, d + 0.3), roofs[Math.floor(r() * roofs.length)]);
      roof.position.y = h;
      house.add(roof);
      const nw = w > 3.2 ? 2 : 1;
      for (let i = 0; i < nw; i++) {
        const lit = r() < 0.75;
        const win = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.65), lit ? this.M.window : this.M.windowDim);
        win.position.set(nw === 1 ? 0 : (i - 0.5) * w * 0.5, h * 0.55, -d / 2 - 0.02);
        win.rotation.y = Math.PI;
        house.add(win);
      }
      this.scene.add(house);
    }
  }

  // ------------------------------------------------------------ reefs
  buildReefs() {
    const r = mulberry32(17);
    this.foamMats = [];
    for (const reef of REEFS) {
      const n = 4 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2;
        const d = k === 0 ? 0 : (0.3 + r() * 0.4) * reef.r;
        const sc = (k === 0 ? 0.6 : 0.32 + r() * 0.25) * reef.r;
        const m = new THREE.Mesh(rockGeometry(r), r() < 0.5 ? this.M.rock : this.M.rockLight);
        m.position.set(reef.x + Math.cos(a) * d, -0.25 + r() * 0.3, reef.z + Math.sin(a) * d);
        m.scale.set(sc, sc * (0.55 + r() * 0.5), sc * (0.8 + r() * 0.4));
        m.rotation.set(r(), r() * 6, r());
        this.scene.add(m);
      }
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: this.time, uR: { value: reef.r }, uSeed: { value: r() * 10 } },
        vertexShader: /* glsl */ `
          varying vec2 vP;
          void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: /* glsl */ `
          uniform float uTime, uR, uSeed;
          varying vec2 vP;
          void main() {
            float r = length(vP);
            float ang = atan(vP.y, vP.x);
            float band = smoothstep(uR - 0.2, uR + 0.4, r) * smoothstep(uR + 2.0, uR + 0.6, r);
            float n = 0.5 + 0.5 * sin(ang * 7.0 + uTime * 1.3 + r * 3.0 + uSeed) * sin(ang * 3.0 - uTime * 0.9);
            float pulse = 0.6 + 0.4 * sin(uTime * 1.7 - r * 2.5 + uSeed);
            float a = band * (0.25 + 0.6 * n) * pulse * 0.38;
            gl_FragColor = vec4(0.78, 0.9, 0.98, a);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        toneMapped: false,
      });
      const ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.1, reef.r - 0.4), reef.r + 2.2, 48, 1), mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(reef.x, 0.42, reef.z);
      ring.renderOrder = 1;
      this.scene.add(ring);

      if (reef.r >= 2.9) {
        const bx = reef.x + reef.r * 0.75 + 0.9;
        const bz = reef.z - reef.r * 0.6 - 0.9;
        const buoy = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.0, 8), this.M.red);
        body.position.y = 0.3;
        buoy.add(body);
        const topm = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.5, 8), this.M.dark);
        topm.position.y = 1.05;
        buoy.add(topm);
        this.scene.add(buoy);
        this.bobbers.push({ obj: buoy, x: bx, z: bz, hd: 0, k: 1 });
        const light = glowSprite(this.tex.glow, 0xff5a44, 2.4);
        light.position.set(0, 1.5, 0);
        buoy.add(light);
        this.blinkers.push({ sprite: light, period: 2.5, offset: r() * 2.5, on: 0.45, base: 2.4 });
      }
    }
  }

  // ------------------------------------------------------------ beam
  buildBeam() {
    const g = new THREE.CylinderGeometry(0.07, 1, 1, 40, 10, true);
    g.translate(0, -0.5, 0);
    g.rotateX(-Math.PI / 2);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uPower: { value: 1 }, uColor: { value: disp(0xffd28a) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uPower; uniform vec3 uColor;
        varying vec2 vUv; varying vec3 vN; varying vec3 vV;
        void main() {
          float along = vUv.y;
          float rim = abs(dot(normalize(vN), normalize(vV)));
          float core = pow(rim, 2.0);
          float fall = mix(0.16, 1.0, pow(along, 1.5));
          float dust = 0.8 + 0.2 * sin(vUv.x * 62.83 + uTime * 0.7 + along * 9.0) * sin(vUv.x * 25.13 - uTime * 0.45 + along * 4.0);
          float a = core * fall * dust * uPower * 0.4;
          gl_FragColor = vec4(uColor, a);
        }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.beam = new THREE.Mesh(g, this.beamMat);
    this.beam.renderOrder = 3;
    this.beam.frustumCulled = false;
    this.scene.add(this.beam);

    const pg = new THREE.PlaneGeometry(2, 2);
    pg.rotateX(-Math.PI / 2);
    this.poolMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.time, uPower: { value: 1 }, uColor: { value: disp(0xffc77a) } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uPower; uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float a = smoothstep(1.0, 0.5, r) * 0.55 + smoothstep(0.5, 0.0, r) * 0.35;
          float edge = smoothstep(1.0, 0.94, r) * smoothstep(0.86, 0.95, r) * 0.35;
          a += edge;
          a *= 0.92 + 0.08 * sin(r * 16.0 - uTime * 3.0);
          gl_FragColor = vec4(uColor, a * uPower);
        }`,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    this.pool = new THREE.Mesh(pg, this.poolMat);
    this.pool.renderOrder = 2;
    this.pool.scale.setScalar(BEAM_R);
    this.scene.add(this.pool);
  }

  // ------------------------------------------------------------ ships
  makeBoat(type, hullMat) {
    const M = this.M;
    const G = this.boatGeo || (this.boatGeo = {
      hullSail: hullGeometry(3.2, 1.15, 0.72),
      hullTrawler: hullGeometry(3.0, 1.3, 0.85),
      deck: new THREE.BoxGeometry(0.8, 0.06, 1.7),
      cabinSail: new THREE.BoxGeometry(0.75, 0.45, 0.9),
      mast: new THREE.CylinderGeometry(0.045, 0.06, 2.6, 6),
      mainSail: triangleGeometry([[0, 0], [0, 2.0], [1.3, 0.08]]),
      jib: triangleGeometry([[0, 0.35], [0, 2.3], [-1.35, 0.15]]),
      wheelhouse: new THREE.BoxGeometry(0.95, 0.8, 1.0),
      windows: new THREE.BoxGeometry(0.97, 0.17, 1.02),
      roof: new THREE.BoxGeometry(1.08, 0.08, 1.12),
      shortMast: new THREE.CylinderGeometry(0.05, 0.06, 1.8, 6),
      boom: new THREE.CylinderGeometry(0.03, 0.03, 1.7, 5),
    });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    if (type === 'sail') {
      add(G.hullSail, hullMat, 0, 0.1, 0);
      add(G.deck, M.wood, 0, 0.48, -0.1);
      add(G.cabinSail, M.cream, 0, 0.7, -0.55);
      add(G.mast, M.dark, 0, 1.75, 0.25);
      add(G.mainSail, M.sail, 0, 0.98, 0.22);
      add(G.jib, M.sail2, 0, 0.6, 0.3);
    } else {
      add(G.hullTrawler, hullMat, 0, 0.12, 0);
      add(G.deck, M.wood, 0, 0.56, 0.2);
      add(G.wheelhouse, M.white, 0, 0.95, -0.55);
      add(G.windows, M.window, 0, 1.12, -0.55);
      add(G.roof, M.dark, 0, 1.39, -0.55);
      add(G.shortMast, M.dark, 0, 1.9, 0.35);
      const boom = add(G.boom, M.dark, 0, 1.55, 0.95);
      boom.rotation.x = 0.85;
    }
    return g;
  }

  buildShips() {
    this.slots = [];
    const ringGeo = new THREE.RingGeometry(1.9, 2.25, 48);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_SHIPS; i++) {
      const hullMat = new THREE.MeshLambertMaterial({ color: HULLS[0], flatShading: true });
      const group = new THREE.Group();
      const sail = this.makeBoat('sail', hullMat);
      const trawler = this.makeBoat('trawler', hullMat);
      group.add(sail, trawler);
      const lantern = glowSprite(this.tex.glow, 0xffbf6a, 2.4);
      group.add(lantern);
      group.visible = false;
      this.scene.add(group);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xffd28a,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          fog: false,
        })
      );
      ring.renderOrder = 4;
      ring.visible = false;
      this.scene.add(ring);
      const danger = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.tex.danger, transparent: true, depthWrite: false, depthTest: false, toneMapped: false, fog: false })
      );
      danger.renderOrder = 6;
      danger.visible = false;
      this.scene.add(danger);
      this.slots.push({ group, sail, trawler, hullMat, lantern, ring, danger, color: -1 });
    }
  }

  // ------------------------------------------------------------ particles
  buildParticles() {
    const N = MAX_PARTICLES;
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(N * 3);
    this.pCol = new Float32Array(N * 3);
    this.pA = new Float32Array(N);
    this.pS = new Float32Array(N);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.pA, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.pS, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.pGeo = g;
    this.pMat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aAlpha; attribute float aSize;
        uniform float uScale;
        varying vec3 vC; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 256.0);
          vC = aColor; vA = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d) * vA;
          gl_FragColor = vec4(vC, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
    });
    const pts = new THREE.Points(g, this.pMat);
    pts.frustumCulled = false;
    pts.renderOrder = 5;
    this.scene.add(pts);
  }

  // ------------------------------------------------------------ flares
  buildFlares() {
    this.flareSlots = [];
    const ringGeo = new THREE.RingGeometry(0.94, 1, 72);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < MAX_FLARES; i++) {
      const core = glowSprite(this.tex.glow, 0xffe4d6, 3.2);
      const halo = glowSprite(this.tex.glow, 0xff6f4e, 16);
      const streak = glowSprite(this.tex.glow, 0xff9b7a, 1);
      const ring = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          color: 0xff9a7a,
          transparent: true,
          depthWrite: false,
          depthTest: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          fog: false,
        })
      );
      ring.renderOrder = 4;
      for (const o of [core, halo, streak, ring]) {
        o.visible = false;
        this.scene.add(o);
      }
      this.flareSlots.push({ core, halo, streak, ring });
    }
  }

  // ------------------------------------------------------------ camera
  updateCamera(game, vw, vh) {
    this.vw = vw;
    this.vh = vh;
    const aspect = vw / Math.max(1, vh);
    const t = game.t;
    // p: 0 = landscape framing, 1 = tall phone portrait (steeper, top-down view).
    const p = smoothstep(1.25, 0.5, aspect);
    const k = clamp(1 + (1.6 - aspect) * 0.55, 1, 1.25);
    const fov = lerp(46, 60, p);

    const lookL = new THREE.Vector3(0, 3, -22);
    const lookP = lookL.clone().lerp(new THREE.Vector3(0, 0, -21), p);
    const posP = new THREE.Vector3(0, 32, 66).sub(lookL).multiplyScalar(k).add(lookL).lerp(new THREE.Vector3(0, 122, 46), p);
    const posT = new THREE.Vector3(-12 + Math.sin(t * 0.07) * 1.5, 9.5 + Math.sin(t * 0.11) * 0.3, 52).lerp(new THREE.Vector3(-8, 11, 70), p);
    const lookT = new THREE.Vector3(2, 6 + Math.sin(t * 0.09) * 0.4, -40).lerp(new THREE.Vector3(-30, 6, -40), p);
    const fovT = lerp(52, 66, p);

    let b = 1;
    if (game.state === 'title') b = 0;
    else if (game.introT !== null) b = smoothstep(0, 2.4, t - game.introT);
    const pos = posT.lerp(posP, b);
    const look = lookT.lerp(lookP, b);

    pos.x += Math.sin(t * 0.13) * 0.8 * b;
    pos.y += Math.sin(t * 0.21) * 0.4 * b;
    if (game.state === 'over') {
      const o = smoothstep(0, 6, game.stateT);
      pos.lerp(look, o * 0.08);
    }
    const sh = game.shake * game.shake;
    if (sh > 0) {
      pos.x += Math.sin(t * 53.1) * 0.35 * sh;
      pos.y += Math.sin(t * 47.3 + 1) * 0.3 * sh;
      look.x += Math.sin(t * 41.7 + 2) * 0.2 * sh;
    }
    const cam = this.camera;
    cam.position.copy(pos);
    cam.lookAt(look);
    cam.fov = lerp(fovT, fov, b);
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  screenToWater(x, y) {
    this._ndc.set((x / this.vw) * 2 - 1, -(y / this.vh) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const ray = this.raycaster.ray;
    let px;
    let pz;
    if (ray.direction.y < -0.01 && ray.intersectPlane(this.waterPlane, this._v)) {
      px = this._v.x;
      pz = this._v.z;
    } else {
      const k = (WORLD.aimMinZ - ray.origin.z) / Math.min(-0.001, ray.direction.z);
      px = ray.origin.x + ray.direction.x * k;
      pz = WORLD.aimMinZ;
    }
    return { x: clamp(px, WORLD.minX - 4, WORLD.maxX + 4), z: clamp(pz, WORLD.aimMinZ, WORLD.aimMaxZ) };
  }

  worldToScreen(x, y, z) {
    this._v.set(x, y, z).project(this.camera);
    return { x: ((this._v.x + 1) / 2) * this.vw, y: ((1 - this._v.y) / 2) * this.vh, behind: this._v.z > 1 };
  }

  // ------------------------------------------------------------ per-frame sync
  sync(game) {
    const t = game.t;
    this.time.value = t;
    const cam = this.camera;
    this.skyGroup.position.copy(cam.position);
    this.starMat.uniforms.uPR.value = this.renderer.getPixelRatio();
    this.pMat.uniforms.uScale.value = (this.vh * this.renderer.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));

    // Fog thickens with each watch.
    let far = WATCH_FOG[0];
    if (game.watch >= 0) {
      const prev = WATCH_FOG[Math.max(0, game.watch - 1)];
      const cur = WATCH_FOG[Math.min(WATCH_FOG.length - 1, game.watch)];
      far = lerp(prev, cur, smoothstep(0, 5, t - game.watchT));
    }
    this.scene.fog.far = far;

    // Beam
    const P = game.beamPower;
    const flick = game.state === 'over' ? 0.75 + 0.25 * Math.sin(t * 31) * Math.sin(t * 17) : 1;
    const power = P * flick;
    const ax = game.aim.x;
    const az = game.aim.z;
    const len = Math.hypot(ax - LAMP.x, 0.4 - LAMP.y, az - LAMP.z);
    this.beam.position.set(LAMP.x, LAMP.y, LAMP.z);
    this.beam.lookAt(ax, 0.4, az);
    this.beam.scale.set(BEAM_R * 0.92, BEAM_R * 0.92, len * 1.03);
    this.beam.visible = power > 0.01;
    this.beamMat.uniforms.uPower.value = power;
    this.pool.position.set(ax, 0.55, az);
    this.pool.visible = power > 0.01;
    this.poolMat.uniforms.uPower.value = power;
    this.spot.intensity = 15 * power;
    this.spot.angle = Math.atan(BEAM_R / len) * 1.25;
    this.spotTarget.position.set(ax, 0, az);
    this.spotTarget.updateMatrixWorld();
    this.lanternMat.color.setRGB(lerp(0.09, 1.0, power), lerp(0.07, 0.86, power), lerp(0.06, 0.6, power));
    this.glare.material.opacity = 0.15 + 0.85 * power;
    this.glare.scale.setScalar(6 + 5 * power);
    this.streak.material.opacity = 0.55 * power;

    // Blinking aids to navigation
    for (const b of this.blinkers) {
      const ph = ((t + b.offset) % b.period) / b.period;
      const on = ph < b.on / b.period ? 1 : 0;
      const tail = ph < b.on / b.period + 0.08 ? smoothstep(b.on / b.period + 0.08, b.on / b.period, ph) : 0;
      const k = Math.max(on, tail);
      b.sprite.material.opacity = 0.12 + 0.88 * k;
      b.sprite.scale.setScalar(b.base * (0.6 + 0.4 * k));
    }
    for (const b of this.bobbers) {
      const h = waveHeight(b.x, b.z, t);
      b.obj.position.set(b.x, h * 0.6 * b.k + (b.k < 1 ? 0.05 : 0), b.z);
      b.obj.rotation.set(Math.sin(t * 1.1 + b.x) * 0.04 * b.k, b.hd, Math.sin(t * 0.9 + b.z) * 0.06 * b.k, 'YXZ');
    }

    this.syncShips(game);
    this.syncParticles(game);
    this.syncFlares(game);
  }

  syncShips(game) {
    const t = game.t;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const s = game.ships[i];
      if (!s) {
        slot.group.visible = false;
        slot.ring.visible = false;
        slot.danger.visible = false;
        continue;
      }
      slot.group.visible = true;
      const isSail = s.type === 'sail';
      slot.sail.visible = isSail;
      slot.trawler.visible = !isSail;
      if (slot.color !== s.color) {
        slot.hullMat.color.setHex(HULLS[s.color]);
        slot.color = s.color;
      }
      const fx = Math.sin(s.hd);
      const fz = Math.cos(s.hd);
      const sx = fz;
      const sz = -fx;
      const h = waveHeight(s.x, s.z, t);
      const hf = waveHeight(s.x + fx * 1.4, s.z + fz * 1.4, t);
      const hb = waveHeight(s.x - fx * 1.4, s.z - fz * 1.4, t);
      const hl = waveHeight(s.x + sx * 0.6, s.z + sz * 0.6, t);
      const hr = waveHeight(s.x - sx * 0.6, s.z - sz * 0.6, t);
      let pitch = -Math.atan2(hf - hb, 2.8) * 1.2;
      let roll = Math.atan2(hl - hr, 1.2) * 0.9 + Math.sin(t * 1.3 + s.phase) * 0.03;
      let y = h * 0.85 + 0.05;
      let lanternA = clamp(s.age / 1.6, 0, 1);
      if (s.state === 'wreck') {
        const k = smoothstep(0, 3.8, s.stateT);
        y -= k * 3.4;
        roll += k * 1.1 * s.wreckSide;
        pitch += k * 0.5;
        lanternA *= (1 - smoothstep(0.2, 1.6, s.stateT)) * (0.6 + 0.4 * Math.sin(s.stateT * 40));
      }
      slot.group.position.set(s.x, y, s.z);
      slot.group.rotation.set(pitch, s.hd, roll, 'YXZ');
      slot.group.scale.setScalar(1.25);

      slot.lantern.position.set(0, isSail ? 1.12 : 2.2, isSail ? 0.6 : 0.35);
      slot.lantern.material.opacity = lanternA;
      slot.lantern.scale.setScalar(2.2 + s.lit * 1.2);
      slot.lantern.material.color.setRGB(1, lerp(0.75, 0.86, s.lit), lerp(0.42, 0.6, s.lit));

      const sailing = s.state === 'sail';
      const pulse = 0.5 + 0.5 * Math.sin(t * 10);
      if (sailing && (s.danger || s.lit > 0.05)) {
        slot.ring.visible = true;
        slot.ring.position.set(s.x, 0.5, s.z);
        if (s.danger) {
          slot.ring.material.color.setHex(0xff5a44);
          slot.ring.material.opacity = 0.45 + 0.4 * pulse;
          slot.ring.scale.setScalar(1 + 0.08 * pulse);
        } else {
          slot.ring.material.color.setHex(0xffd28a);
          slot.ring.material.opacity = 0.55 * s.lit;
          slot.ring.scale.setScalar(1);
        }
      } else {
        slot.ring.visible = false;
      }
      if (sailing && s.danger && game.state === 'play') {
        slot.danger.visible = true;
        slot.danger.position.set(s.x, y + 4.6, s.z);
        slot.danger.scale.setScalar(2.5 * (1 + 0.08 * pulse));
        slot.danger.material.opacity = 0.85 + 0.15 * pulse;
      } else {
        slot.danger.visible = false;
      }
    }
  }

  syncParticles(game) {
    const P = game.particles;
    const n = Math.min(P.length, MAX_PARTICLES);
    for (let i = 0; i < n; i++) {
      const p = P[i];
      const u = 1 - p.life / p.max;
      const env = Math.min(1, u / 0.12) * (1 - u);
      this.pPos[i * 3] = p.x;
      this.pPos[i * 3 + 1] = p.y;
      this.pPos[i * 3 + 2] = p.z;
      this.pCol[i * 3] = p.r;
      this.pCol[i * 3 + 1] = p.g;
      this.pCol[i * 3 + 2] = p.b;
      this.pA[i] = p.a * env;
      this.pS[i] = lerp(p.s0, p.s1, u);
    }
    const g = this.pGeo;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  syncFlares(game) {
    const t = game.t;
    let lightI = 0;
    let lightPos = null;
    for (let i = 0; i < this.flareSlots.length; i++) {
      const slot = this.flareSlots[i];
      const f = game.flares[i];
      if (!f) {
        slot.core.visible = slot.halo.visible = slot.streak.visible = slot.ring.visible = false;
        continue;
      }
      const flick = 0.82 + 0.18 * Math.sin(t * 37 + i * 3) * Math.sin(t * 23 + i);
      const endFade = 1 - smoothstep(FLIGHT + BURN - 0.8, FLIGHT + BURN, f.t);
      const burning = f.burst ? 1 : 0.45;
      const k = flick * endFade * burning;
      slot.core.visible = slot.halo.visible = slot.streak.visible = true;
      slot.core.position.set(f.x, f.y, f.z);
      slot.halo.position.set(f.x, f.y, f.z);
      slot.streak.position.set(f.x, f.y, f.z);
      slot.core.scale.setScalar(f.burst ? 3.4 : 1.8);
      slot.core.material.opacity = Math.min(1, 0.3 + k);
      slot.halo.scale.setScalar(f.burst ? 18 : 6);
      slot.halo.material.opacity = 0.55 * k;
      slot.streak.scale.set(f.burst ? 22 : 8, 0.9, 1);
      slot.streak.material.opacity = 0.5 * k;
      if (f.burst) {
        const e = t - f.burstT;
        slot.ring.visible = true;
        slot.ring.position.set(f.x, 0.55, f.z);
        let r;
        let a;
        if (e < 0.7) {
          const u = e / 0.7;
          r = lerp(1.5, FLARE_R, 1 - (1 - u) * (1 - u) * (1 - u));
          a = 0.9 * (1 - u) + 0.18;
        } else {
          r = FLARE_R;
          a = (0.16 + 0.06 * Math.sin(t * 3.0)) * endFade;
        }
        slot.ring.scale.setScalar(r);
        slot.ring.material.opacity = a;
        if (k > lightI) {
          lightI = k;
          lightPos = f;
        }
      } else {
        slot.ring.visible = false;
      }
    }
    if (lightPos) {
      this.flareLight.position.set(lightPos.x, lightPos.y, lightPos.z);
      this.flareLight.intensity = 90 * lightI;
    } else {
      this.flareLight.intensity = 0;
    }
  }
}
