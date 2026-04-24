'use strict';

// ================================================================
// MATERIALS
// ================================================================
// A material = { id, name, color:[r,g,b], refl:0..1, rough:0..1,
//                spec:0..1, specPow:1..256 }
// Nodes reference a palette entry via `materialId`. `null` → inherit
// from the closest ancestor group with a materialId, fallback to palette[0].
const FALLBACK_MATERIAL = { id:'__fallback', name:'Fallback',
  color:[.7,.7,.7], refl:0, rough:0.5, spec:0.3, specPow:32 };

const DEFAULT_PALETTE = [
  { id:'mat-red',   name:'Red',   color:[0.85,0.40,0.40], refl:0.05, rough:0.60, spec:0.50, specPow:32 },
  { id:'mat-green', name:'Green', color:[0.40,0.72,0.50], refl:0.05, rough:0.60, spec:0.50, specPow:32 },
  { id:'mat-blue',  name:'Blue',  color:[0.40,0.52,0.88], refl:0.05, rough:0.60, spec:0.50, specPow:32 },
];

function makeMaterial(name='Material', color=[.7,.7,.7]) {
  return { id:uuid(), name, color:[...color], refl:0, rough:0.5, spec:0.5, specPow:32 };
}

// Cascade resolution: explicit id > inherited id > palette[0] > fallback.
function resolveMaterial(ownId, inheritedId, palette) {
  const id = ownId || inheritedId;
  if (id) {
    const m = (palette||[]).find(x => x.id === id);
    if (m) return m;
  }
  return (palette && palette[0]) || FALLBACK_MATERIAL;
}

// Walk the tree in pre-order, resolve each shape's material, and return
// the deduplicated list of USED materials along with the index each
// shape maps to. shapeCol/shapeMat lookups then have O(#distinct mats)
// branches instead of O(#shapes).
function resolveUsedMaterials(root, palette) {
  const pal = (palette && palette.length) ? palette : [FALLBACK_MATERIAL];
  const used = [];
  const keyToIdx = new Map(); // mat.id → index in `used`
  function walk(node, inh) {
    if (!node) return;
    if (SHAPE_TYPES.includes(node.type)) {
      const m = resolveMaterial(node.materialId, inh, pal);
      const key = m.id || '__fb';
      if (!keyToIdx.has(key)) {
        keyToIdx.set(key, used.length);
        used.push(m);
      }
      return;
    }
    const childInh = node.materialId || inh;
    (node.children||[]).forEach(c => walk(c, childInh));
  }
  walk(root, null);
  return { materials: used, indexOf: (mat) => keyToIdx.get(mat.id || '__fb') ?? 0 };
}

// How many nodes (shapes or groups) reference this materialId? Used to
// disable delete in the palette modal when a material is still in use.
function isMaterialReferenced(root, matId) {
  if (!root) return 0;
  let n = (root.materialId === matId) ? 1 : 0;
  for (const c of (root.children||[])) n += isMaterialReferenced(c, matId);
  return n;
}

Object.assign(window, {
  FALLBACK_MATERIAL, DEFAULT_PALETTE, makeMaterial,
  resolveMaterial, resolveUsedMaterials, isMaterialReferenced,
});
