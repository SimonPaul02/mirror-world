/**
 * Generates an MQ-9 Reaper airframe as glTF 2.0 at its published dimensions:
 * 20.1 m wingspan, 11.0 m length, Y-tail (upward V plus ventral fin), pusher
 * turboprop. Geometry only — no weapons are modelled, just the hardpoint pylons
 * that give the airframe its silhouette.
 *
 * Built nose-along-+Z and +Y-up, which is the convention Cesium expects (it
 * maps glTF +Z onto its own +X), so the viewer's noseOffset of -90 deg applies.
 *
 * Run: npm run model:mq9
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const out = path.resolve(import.meta.dirname, "..", "public", "models");
mkdirSync(out, { recursive: true });

/** One mesh per material; each accumulates flat-shaded triangles. */
const groups = { body: mesh(), dark: mesh() };

function mesh() {
  return { positions: [], normals: [], indices: [] };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function norm(v) {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Adds a hexahedron from 8 corners: 0-3 are one face, 4-7 the opposite face in
 * matching order. Winding is derived from the centroid, so corner order only
 * has to be consistent, not hand-checked per face.
 */
function hexa(group, corners) {
  const g = groups[group];
  const c = [0, 1, 2].map((i) => corners.reduce((s, p) => s + p[i], 0) / 8);
  const faces = [
    [0, 1, 2, 3], [7, 6, 5, 4],
    [0, 4, 5, 1], [1, 5, 6, 2],
    [2, 6, 7, 3], [3, 7, 4, 0],
  ];

  for (const f of faces) {
    const p = f.map((i) => corners[i]);
    let n = norm(cross(sub(p[1], p[0]), sub(p[2], p[0])));
    const centre = [0, 1, 2].map((i) => (p[0][i] + p[1][i] + p[2][i] + p[3][i]) / 4);
    // Flip any face whose normal points back toward the solid's middle.
    const outward = dot(n, sub(centre, c)) >= 0;
    if (!outward) { n = [-n[0], -n[1], -n[2]]; p.reverse(); }

    const base = g.positions.length / 3;
    for (const v of p) { g.positions.push(...v); g.normals.push(...n); }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/** Axis-aligned slab tapering between two stations along Z. */
function taperZ(group, z0, z1, w0, h0, w1, h1, y = 0, x = 0) {
  hexa(group, [
    [x - w0 / 2, y - h0 / 2, z0], [x + w0 / 2, y - h0 / 2, z0],
    [x + w0 / 2, y + h0 / 2, z0], [x - w0 / 2, y + h0 / 2, z0],
    [x - w1 / 2, y - h1 / 2, z1], [x + w1 / 2, y - h1 / 2, z1],
    [x + w1 / 2, y + h1 / 2, z1], [x - w1 / 2, y + h1 / 2, z1],
  ]);
}

/** A lifting surface swept from a root station to a tip station. */
function panel(group, root, tip, rootChord, tipChord, rootThick, tipThick) {
  const sec = (c, chord, thick) => [
    [c[0], c[1] - thick / 2, c[2] - chord / 2],
    [c[0], c[1] - thick / 2, c[2] + chord / 2],
    [c[0], c[1] + thick / 2, c[2] + chord / 2],
    [c[0], c[1] + thick / 2, c[2] - chord / 2],
  ];
  hexa(group, [...sec(root, rootChord, rootThick), ...sec(tip, tipChord, tipThick)]);
}

// ---------------------------------------------------------------- airframe
// Fuselage: 11.0 m nose to tail.
taperZ("body", -4.6, 1.2, 0.58, 0.62, 0.95, 1.05);
taperZ("body", 1.2, 4.1, 0.95, 1.05, 1.02, 1.08);
// Nose radome, the Reaper's distinctive bulb.
taperZ("body", 4.1, 5.0, 1.02, 1.08, 0.78, 0.82);
taperZ("body", 5.0, 5.5, 0.78, 0.82, 0.34, 0.34);
// SATCOM fairing on the spine.
taperZ("body", 2.6, 3.9, 0.66, 0.5, 0.72, 0.56, 0.62);

// Wing: 20.1 m span, tapered, shoulder-mounted with slight dihedral.
for (const side of [-1, 1]) {
  panel("body", [0, 0.36, 0.42], [side * 3.4, 0.46, 0.42], 1.08, 0.92, 0.17, 0.14);
  panel("body", [side * 3.4, 0.46, 0.42], [side * 10.05, 0.72, 0.3], 0.92, 0.5, 0.14, 0.08);
}

// Y-tail: V-tail angled up and out, plus a ventral fin below.
for (const side of [-1, 1]) {
  panel("body", [side * 0.22, 0.24, -4.3], [side * 1.38, 1.95, -5.05], 1.5, 0.78, 0.13, 0.08);
}
panel("body", [0, -0.3, -4.1], [0, -1.3, -5.0], 1.25, 0.72, 0.13, 0.08);

// Engine exhaust shroud ahead of the pusher propeller.
taperZ("dark", -5.0, -4.6, 0.46, 0.5, 0.56, 0.6);

// Three-blade pusher propeller.
for (let i = 0; i < 3; i += 1) {
  const a = (i * 2 * Math.PI) / 3;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const blade = (r, halfWidth, halfThick) => [
    [ca * r - sa * -halfWidth, sa * r + ca * -halfWidth, -5.08 - halfThick],
    [ca * r - sa * halfWidth, sa * r + ca * halfWidth, -5.08 - halfThick],
    [ca * r - sa * halfWidth, sa * r + ca * halfWidth, -5.08 + halfThick],
    [ca * r - sa * -halfWidth, sa * r + ca * -halfWidth, -5.08 + halfThick],
  ];
  hexa("dark", [...blade(0.12, 0.09, 0.03), ...blade(0.95, 0.055, 0.015)]);
}

// Underwing hardpoint pylons — structural fairings, nothing mounted on them.
for (const side of [-1, 1]) {
  for (const x of [2.1, 3.5, 4.9]) {
    taperZ("dark", -0.25, 0.65, 0.17, 0.42, 0.2, 0.46, 0.08, side * x);
  }
}

// ------------------------------------------------------------- glTF output
const buffers = [];
let offset = 0;
const views = [];
const accessors = [];

function push(data, Type, target, type, componentType) {
  const typed = new Type(data);
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  // Accessor offsets must stay aligned to their component size.
  while (offset % 4 !== 0) { buffers.push(new Uint8Array([0])); offset += 1; }
  buffers.push(bytes);

  views.push({ buffer: 0, byteOffset: offset, byteLength: typed.byteLength, target });
  offset += typed.byteLength;

  const count = data.length / (type === "VEC3" ? 3 : 1);
  const accessor = { bufferView: views.length - 1, componentType, count, type };
  if (type === "VEC3") {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.length; i += 3) {
      for (let k = 0; k < 3; k += 1) {
        min[k] = Math.min(min[k], data[i + k]);
        max[k] = Math.max(max[k], data[i + k]);
      }
    }
    accessor.min = min;
    accessor.max = max;
  }
  accessors.push(accessor);
  return accessors.length - 1;
}

const primitives = [];
for (const [name, g] of Object.entries(groups)) {
  if (g.indices.length === 0) continue;
  const position = push(g.positions, Float32Array, 34962, "VEC3", 5126);
  const normal = push(g.normals, Float32Array, 34962, "VEC3", 5126);
  const index = push(g.indices, Uint32Array, 34963, "SCALAR", 5125);
  primitives.push({
    attributes: { POSITION: position, NORMAL: normal },
    indices: index,
    material: name === "body" ? 0 : 1,
  });
}

const total = Buffer.concat(buffers.map((b) => Buffer.from(b)));
const gltf = {
  asset: { version: "2.0", generator: "flight-lab make-mq9" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: "MQ-9_Reaper" }],
  meshes: [{ name: "MQ-9_Reaper", primitives }],
  materials: [
    {
      name: "airframe",
      pbrMetallicRoughness: {
        baseColorFactor: [0.74, 0.75, 0.76, 1],
        metallicFactor: 0.08,
        roughnessFactor: 0.62,
      },
    },
    {
      name: "details",
      pbrMetallicRoughness: {
        baseColorFactor: [0.21, 0.23, 0.25, 1],
        metallicFactor: 0.25,
        roughnessFactor: 0.45,
      },
    },
  ],
  accessors,
  bufferViews: views,
  buffers: [
    {
      byteLength: total.byteLength,
      uri: `data:application/octet-stream;base64,${total.toString("base64")}`,
    },
  ],
};

const file = path.join(out, "MQ-9_Reaper.gltf");
writeFileSync(file, JSON.stringify(gltf));
const tris = primitives.reduce((n, p) => n + accessors[p.indices].count / 3, 0);
console.log(`[mq9] wrote ${file} — ${tris} triangles, ${(total.byteLength / 1024).toFixed(0)} KB`);
