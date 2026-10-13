// Small math + deterministic helpers shared by simulation and rendering.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;

export function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function approach(v, target, step) {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step);
}

export function angleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// Ocean surface. The GLSL copy below MUST stay identical so boats sit on the waves.
export function waveHeight(x, z, t) {
  return (
    0.28 * Math.sin(0.21 * x + 0.9 * t) * Math.cos(0.17 * z + 0.7 * t) +
    0.16 * Math.sin(0.37 * (0.6 * x + 0.8 * z) - 1.6 * t) +
    0.08 * Math.sin(0.55 * (-0.3 * x + z) - 2.2 * t)
  );
}

export const WAVE_GLSL = /* glsl */ `
float waveH(vec2 p, float t) {
  return 0.28 * sin(0.21 * p.x + 0.9 * t) * cos(0.17 * p.y + 0.7 * t)
       + 0.16 * sin(0.37 * (0.6 * p.x + 0.8 * p.y) - 1.6 * t)
       + 0.08 * sin(0.55 * (-0.3 * p.x + p.y) - 2.2 * t);
}
`;
