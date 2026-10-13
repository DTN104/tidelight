// The bay: coastline, harbor mouth, reefs, lighthouse. Pure data + functions,
// used by both the simulation (collisions) and the scene (geometry).
import { smoothstep } from './util.js';

// Harbor mouth between the two breakwater heads (ships dock by crossing it).
export const GATE = { x: 4, z: 17, half: 3.6 };
export const BREAKWATER = { left: -9.6, right: 17.6, z: 17 };

export const WORLD = { minX: -46, maxX: 46, spawnZ: -62, farZ: -78, aimMinZ: -76, aimMaxZ: 27 };

export const REEFS = [
  { x: -15, z: 3, r: 3.0 },
  { x: 13, z: -5, r: 3.4 },
  { x: -3, z: -19, r: 2.8 },
  { x: 26, z: 7, r: 2.8 },
  { x: -30, z: -7, r: 3.2 },
  { x: 31, z: -24, r: 3.0 },
  { x: -21, z: -34, r: 2.9 },
  { x: 15, z: -37, r: 3.0 },
  { x: -5, z: 8, r: 2.0 },
];

export const LIGHTHOUSE = { x: -26, z: 23 };

// z of the waterline for a given x (land is at larger z, towards the camera).
export function shoreZ(x) {
  return (
    27.5 +
    1.6 * Math.sin(x * 0.11 + 1.3) +
    1.0 * Math.sin(x * 0.23 + 0.4) -
    9 * Math.exp(-(((x - LIGHTHOUSE.x) / 6.5) ** 2))
  );
}

// z at which a ship at x runs into something solid (breakwater or coast).
export function barrierZ(x) {
  if (x > BREAKWATER.left - 0.7 && x < BREAKWATER.right + 0.7) return GATE.z - 0.7;
  return shoreZ(x) - 0.5;
}

export function inGate(x) {
  return Math.abs(x - GATE.x) < GATE.half - 1.1;
}

export function landHeight(x, z) {
  const d = z - shoreZ(x);
  let h = -0.9 + 1.9 * smoothstep(-1.0, 2.6, d);
  const hills = (0.55 + 0.45 * Math.sin(x * 0.13 + 0.7) * Math.cos(z * 0.19 - 0.4)) * 3.2;
  h += hills * smoothstep(2.0, 16.0, d);
  const hx = x - LIGHTHOUSE.x;
  const hz = z - LIGHTHOUSE.z;
  h += 1.6 * Math.exp(-(hx * hx + hz * hz) / 30) * smoothstep(0, 2.5, d);
  return h;
}

LIGHTHOUSE.ground = landHeight(LIGHTHOUSE.x, LIGHTHOUSE.z);
export const LAMP = { x: LIGHTHOUSE.x, y: LIGHTHOUSE.ground + 12.3, z: LIGHTHOUSE.z };
