'use strict';

// ================================================================
// UTILS — vec math + uuid
// ================================================================
const uuid = () => Math.random().toString(36).slice(2, 10);
const normalize3 = v => { const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); return l>0?[v[0]/l,v[1]/l,v[2]/l]:[0,1,0]; };
const cross3 = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3   = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub3   = (a,b) => [a[0]-b[0],a[1]-b[1],a[2]-b[2]];
const add3   = (a,b) => [a[0]+b[0],a[1]+b[1],a[2]+b[2]];
const scale3 = (a,s) => [a[0]*s,a[1]*s,a[2]*s];
const len3   = v => Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]);

// Rotate a local vector by (rx, ry, rz) applied in X→Y→Z order,
// matching the GLSL invT which inverses with rotZ*rotY*rotX.
// Used by gizmo code to compute world positions of control points.
function applyRotationXYZ(v, r) {
  let [x, y, z] = v;
  // rotX
  let cx=Math.cos(r[0]), sx=Math.sin(r[0]);
  let ny = y*cx - z*sx, nz = y*sx + z*cx;
  y = ny; z = nz;
  // rotY
  let cy=Math.cos(r[1]), sy=Math.sin(r[1]);
  let nx = x*cy + z*sy; nz = -x*sy + z*cy;
  x = nx; z = nz;
  // rotZ
  let cz=Math.cos(r[2]), sz=Math.sin(r[2]);
  nx = x*cz - y*sz; ny = x*sz + y*cz;
  x = nx; y = ny;
  return [x, y, z];
}
// Inverse rotation (transpose of XYZ chain)
function unapplyRotationXYZ(v, r) {
  let [x, y, z] = v;
  let cz=Math.cos(r[2]), sz=Math.sin(r[2]);
  let nx = x*cz + y*sz, ny = -x*sz + y*cz;
  x = nx; y = ny;
  let cy=Math.cos(r[1]), sy=Math.sin(r[1]);
  nx = x*cy - z*sy; let nz = x*sy + z*cy;
  x = nx; z = nz;
  let cx=Math.cos(r[0]), sx=Math.sin(r[0]);
  ny = y*cx + z*sx; nz = -y*sx + z*cx;
  y = ny; z = nz;
  return [x, y, z];
}
// World position of a local point on a node (applies scale → rotation → translation).
// Note: GLSL `invT` performs world→local with `applyRotationXYZ`-equivalent math
// (because GLSL rot*(-a) equals standard rot*(a) under this codebase's convention).
// So the forward direction — local→world — needs `unapplyRotationXYZ`.
function worldPoint(node, localPt) {
  const sc = (typeof node.scale === 'number') ? node.scale : 1;
  const scaled = [localPt[0]*sc, localPt[1]*sc, localPt[2]*sc];
  const rotated = unapplyRotationXYZ(scaled, node.rotation || [0,0,0]);
  return add3(node.position || [0,0,0], rotated);
}
// Inverse: given a world delta, return the equivalent local delta for a node.
function localDelta(node, worldDelta) {
  const sc = (typeof node.scale === 'number') ? node.scale : 1;
  const unrot = applyRotationXYZ(worldDelta, node.rotation || [0,0,0]);
  return [unrot[0]/sc, unrot[1]/sc, unrot[2]/sc];
}

// Ancestor chain of a node — [root, ..., parent]. `[]` if id is root, null if missing.
// Matches the way the compiler nests invT calls: each parent's transform wraps its children's.
function getAncestors(root, id) {
  if (!root) return null;
  if (root.id === id) return [];
  for (const c of (root.children||[])) {
    const sub = getAncestors(c, id);
    if (sub !== null) return [root, ...sub];
  }
  return null;
}
// Forward chain: node's own transform, then each ancestor from innermost parent to root.
// Use this to get the true world position of a point stored in a nested node's local frame.
function worldPointChain(ancestors, node, localPt) {
  let p = worldPoint(node, localPt);
  for (let i = (ancestors ? ancestors.length : 0) - 1; i >= 0; i--) {
    p = worldPoint(ancestors[i], p);
  }
  return p;
}
// Inverse rotation+scale only (no translation) through the ancestor chain, outermost first.
// Turns a world-space delta into a delta expressed in the node's *parent* frame.
function ancestorsInverseDelta(ancestors, worldDelta) {
  let d = worldDelta;
  if (!ancestors) return d;
  for (let i = 0; i < ancestors.length; i++) {
    const a = ancestors[i];
    const sc = (typeof a.scale === 'number') ? a.scale : 1;
    const unrot = applyRotationXYZ(d, a.rotation || [0,0,0]);
    d = [unrot[0]/sc, unrot[1]/sc, unrot[2]/sc];
  }
  return d;
}
// Full inverse chain: world delta → delta in node's own local frame.
function localDeltaChain(ancestors, node, worldDelta) {
  return localDelta(node, ancestorsInverseDelta(ancestors, worldDelta));
}

// ================================================================
// TYPE TABLES — shapes come from SHAPE_REGISTRY
// ================================================================
const SHAPE_TYPES    = Object.keys(SHAPE_REGISTRY);
const OP_TYPES       = ['union','subtraction','intersection'];
const MODIFIER_TYPES = ['mirror','repeat','repeat_angular'];
const isGroupType = t => OP_TYPES.includes(t) || MODIFIER_TYPES.includes(t);

const SHAPE_LABELS = Object.fromEntries(
  SHAPE_TYPES.map(t => [t, SHAPE_REGISTRY[t].label])
);
const SHAPE_ICONS = Object.fromEntries(
  SHAPE_TYPES.map(t => [t, SHAPE_REGISTRY[t].icon])
);

// Ops share a `k` blend factor; k=0 → hard CSG, k>0 → smooth blend.
const OP_DEFAULTS = {
  union:        { k: 0 },
  subtraction:  { k: 0 },
  intersection: { k: 0 },
};
// Mirror has an `eps` smoothing factor; eps=0 → hard |x|, eps>0 → sqrt(x²+eps).
const MODIFIER_DEFAULTS = {
  mirror:         { x: true,  y: false, z: false, eps: 0 },
  repeat:         { sx: 1.2,  sy: 1.2,  sz: 1.2, nx: 2, ny: 0, nz: 0 },
  repeat_angular: { count: 6, axis: 'y', reps: 0 },
};
const OP_LABELS       = { union:'Union', subtraction:'Subtraction', intersection:'Intersection' };
const MODIFIER_LABELS = { mirror:'Mirror', repeat:'Repeat', repeat_angular:'Polar Repeat' };
const OP_ICONS        = { union:'∪', subtraction:'∖', intersection:'∩' };
const MODIFIER_ICONS  = { mirror:'⇄', repeat:'▦', repeat_angular:'⊛' };

const SHAPE_COLORS = [
  [0.85,0.40,0.40], [0.40,0.72,0.50], [0.40,0.52,0.88],
  [0.88,0.78,0.32], [0.72,0.42,0.85], [0.35,0.72,0.82],
  [0.88,0.58,0.32], [0.55,0.85,0.60],
];

// Deep-copy shape defaults (so arrays like capsule.a/b aren't shared).
function cloneDefaults(d) {
  const out = {};
  for (const k in d) {
    out[k] = Array.isArray(d[k]) ? [...d[k]] : d[k];
  }
  return out;
}

function createNode(type, name) {
  const isShape = SHAPE_TYPES.includes(type);
  const isMod   = MODIFIER_TYPES.includes(type);
  const defaults = isShape ? SHAPE_REGISTRY[type].defaults
                : isMod    ? MODIFIER_DEFAULTS[type]
                :            OP_DEFAULTS[type];
  const label    = isShape ? SHAPE_LABELS[type]
                : isMod    ? MODIFIER_LABELS[type]
                :            OP_LABELS[type];
  return {
    id: uuid(), type, children: [],
    name: name || label,
    // Uniform scale (single float). Proper SDF metric.
    position: [0, 0, 0], rotation: [0, 0, 0], scale: 1,
    params: cloneDefaults(defaults),
    materialId: null, // null → inherit from ancestor group / palette[0]
    pTransform: '',   // optional GLSL: body of `vec3 pT_N(vec3 p){ ... }`
    dTransform: '',   // optional GLSL: body of `float dT_N(float d, vec3 p){ ... }`
  };
}

function createDefaultScene() {
  const root = createNode('union', 'Root');
  root.params.k = 0.2;
  const s = createNode('sphere', 'Sphere');
  s.position = [-0.55, 0.1, 0]; s.params.radius = 0.42;
  s.materialId = 'mat-red';
  const b = createNode('box', 'Box');
  b.position = [0.55, 0, 0]; b.rotation = [0, 0.4, 0.2];
  b.params = { width: 0.55, height: 0.55, depth: 0.55, radius: 0 };
  b.materialId = 'mat-green';
  const t = createNode('torus', 'Torus');
  t.position = [0, -0.7, 0]; t.rotation = [0.3, 0, 0];
  t.materialId = 'mat-blue';
  root.children = [s, b, t];
  return root;
}

// ================================================================
// TREE HELPERS
// ================================================================
function findNode(root, id) {
  if (!root) return null;
  if (root.id === id) return root;
  for (const c of (root.children||[])) { const f = findNode(c, id); if (f) return f; }
  return null;
}
function findParent(root, id, parent=null) {
  if (!root) return null;
  if (root.id === id) return parent;
  for (const c of (root.children||[])) { const f = findParent(c, id, root); if (f) return f; }
  return null;
}
function mapTree(root, fn) {
  const node = fn({...root});
  node.children = (root.children||[]).map(c => mapTree(c, fn));
  return node;
}
function removeFromTree(root, id) {
  return { ...root, children: (root.children||[]).filter(c=>c.id!==id).map(c=>removeFromTree(c,id)) };
}
function insertChild(tree, parentId, newNode) {
  if (tree.id === parentId) return { ...tree, children: [...(tree.children||[]), newNode] };
  return { ...tree, children: (tree.children||[]).map(c => insertChild(c, parentId, newNode)) };
}
function moveNodeInTree(tree, dragId, targetId) {
  const dragged = findNode(tree, dragId);
  if (!dragged || dragId === targetId || findNode(dragged, targetId)) return tree;
  const withoutDrag = removeFromTree(tree, dragId);
  return insertChild(withoutDrag, targetId, dragged);
}
function insertSibling(tree, targetId, newNode, mode) {
  const children = tree.children || [];
  const idx = children.findIndex(c => c && c.id === targetId);
  if (idx >= 0) {
    const pos = mode === 'after' ? idx + 1 : idx;
    return { ...tree, children: [...children.slice(0,pos), newNode, ...children.slice(pos)] };
  }
  return { ...tree, children: children.map(c => insertSibling(c, targetId, newNode, mode)) };
}
function moveNodeAt(tree, dragId, targetId, mode) {
  const dragged = findNode(tree, dragId);
  if (!dragged || dragId === targetId || findNode(dragged, targetId)) return tree;
  if (mode === 'before' || mode === 'after') {
    if (tree.id === targetId) return tree;
  }
  const withoutDrag = removeFromTree(tree, dragId);
  if (mode === 'inside') return insertChild(withoutDrag, targetId, dragged);
  return insertSibling(withoutDrag, targetId, dragged, mode);
}
function flattenShapes(root) {
  if (!root) return [];
  if (SHAPE_TYPES.includes(root.type) || root.type === 'library_ref') return [root];
  return (root.children||[]).flatMap(flattenShapes);
}

Object.assign(window, {
  uuid, normalize3, cross3, dot3, sub3, add3, scale3, len3,
  applyRotationXYZ, unapplyRotationXYZ, worldPoint, localDelta,
  getAncestors, worldPointChain, ancestorsInverseDelta, localDeltaChain,
  SHAPE_TYPES, OP_TYPES, MODIFIER_TYPES, isGroupType,
  OP_DEFAULTS, MODIFIER_DEFAULTS,
  OP_LABELS, SHAPE_LABELS, MODIFIER_LABELS,
  SHAPE_ICONS, OP_ICONS, MODIFIER_ICONS, SHAPE_COLORS,
  createNode, createDefaultScene,
  findNode, findParent, mapTree, removeFromTree, flattenShapes,
  insertChild, insertSibling, moveNodeInTree, moveNodeAt,
});
