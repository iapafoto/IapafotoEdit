'use strict';

// ================================================================
// SDF LIBRARY — user-extensible SDF primitives + subtree prefabs
// ================================================================
// Provides the schema management layer: parsing GLSL signatures,
// creating/updating library entries, and merging with builtins.
// The compiler (compiler.js) handles the actual GLSL emission.

// Parse a GLSL function signature to extract parameter metadata.
// Input: GLSL source string containing at least one function definition.
// Returns { glslFn, returnType, params, callTemplate } or null on failure.
//
// Example: "float sdFoo(vec3 p, float r, vec3 center)"
//   → { glslFn:"sdFoo", returnType:"float",
//       params:[{key:"r",type:"number",...},{key:"center",type:"vec3",...}],
//       callTemplate:"sdFoo({q},{r},{center})" }
function parseGlslSignature(src) {
  const m = (src || '').match(/\b(float|vec2|vec3|vec4)\s+(\w+)\s*\(([^)]*)\)/);
  if (!m) return null;
  const returnType = m[1];
  const glslFn = m[2];
  const rawList = m[3].trim();
  const rawParams = rawList ? rawList.split(',').map(s => s.trim()) : [];

  const params = [];
  const templateArgs = ['{q}'];
  let firstVec3Skipped = false;

  for (const rp of rawParams) {
    const pm = rp.match(/^(float|int|vec2|vec3|bool)\s+(\w+)$/);
    if (!pm) continue;
    const glslType = pm[1];
    const name = pm[2];
    // Skip the first vec3 (the query point p/pos/point)
    if (!firstVec3Skipped && glslType === 'vec3') { firstVec3Skipped = true; continue; }

    let uiType, defaultVal;
    switch (glslType) {
      case 'vec3': uiType = 'vec3';   defaultVal = [0, 0, 0]; break;
      case 'int':  uiType = 'number'; defaultVal = 0; break;
      default:     uiType = 'number'; defaultVal = 0;
    }
    params.push({
      key: name, label: name, type: uiType,
      default: defaultVal,
      step: glslType === 'int' ? 1 : 0.01,
    });
    templateArgs.push(`{${name}}`);
  }

  return { glslFn, returnType, params, callTemplate: `${glslFn}(${templateArgs.join(',')})` };
}

// Infer outputKind from a GLSL return type.
// vec2 defaults to 'dist_k' (capsule/bezier convention); caller may override to 'dist_mat'.
function outputKindFromReturnType(returnType) {
  return returnType === 'vec2' ? 'dist_k' : 'dist';
}

// Build a call template from a function name and param list.
function inferCallTemplate(glslFn, params) {
  return `${glslFn}(${['{q}', ...(params || []).map(p => `{${p.key}}`)].join(',')})`;
}

// Build the lookup Map<id, entry> for O(1) compiler access.
// Builtin SHAPE_REGISTRY entries are NOT included here — they're handled
// directly by the compiler via SHAPE_REGISTRY[node.type].
function mergeLibrary(userEntries) {
  const map = new Map();
  for (const e of (userEntries || [])) map.set(e.id, e);
  return map;
}

// Deep-clone a node tree with all-new UUIDs (safe for instantiation).
function deepCloneTree(node) {
  if (!node) return null;
  return { ...node, id: uuid(), children: (node.children || []).map(deepCloneTree) };
}

// Create a library entry from a scene sub-tree node.
function libraryEntryFromSubtree(node, label) {
  return {
    id: 'user_' + uuid(),
    label: label || node.name || 'Prefab',
    icon: '⬟',
    source: 'subtree',
    outputKind: 'dist',
    tree: deepCloneTree(node),
  };
}

// Create a new library entry for a user-defined GLSL SDF.
function createGlslLibraryEntry(glslSrc, label, outputKindOverride) {
  const parsed = parseGlslSignature(glslSrc);
  if (!parsed) return null;
  return {
    id: 'user_' + uuid(),
    label: label || parsed.glslFn,
    icon: '◉',
    source: 'glsl',
    outputKind: outputKindOverride || outputKindFromReturnType(parsed.returnType),
    glslFn: parsed.glslFn,
    glslSrc,
    callTemplate: parsed.callTemplate,
    params: parsed.params,
  };
}

// Update a GLSL library entry when its source is edited.
// Re-parses the signature and tries to preserve existing param default values.
function updateGlslLibraryEntry(entry, newSrc) {
  const parsed = parseGlslSignature(newSrc);
  if (!parsed) return entry;
  const oldParams = entry.params || [];
  const params = parsed.params.map(p => {
    const old = oldParams.find(o => o.key === p.key);
    return old ? { ...p, default: old.default } : p;
  });
  return {
    ...entry,
    glslFn: parsed.glslFn,
    glslSrc: newSrc,
    callTemplate: inferCallTemplate(parsed.glslFn, params),
    params,
  };
}

// Create a library_ref scene node pointing to a library entry.
// Per-instance params start at entry defaults and are read-only in the scene.
function createLibraryRef(entry) {
  const defaults = Object.fromEntries(
    (entry.params || []).map(p => [
      p.key,
      p.type === 'vec3' ? [...(p.default || [0, 0, 0])] : (p.default ?? 0),
    ])
  );
  return {
    id: uuid(),
    type: 'library_ref',
    libraryId: entry.id,
    name: entry.label,
    icon: entry.icon,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: 1,
    params: defaults,
    materialId: null,
    pTransform: '',
    dTransform: '',
    children: [],
  };
}

Object.assign(window, {
  parseGlslSignature,
  outputKindFromReturnType,
  inferCallTemplate,
  mergeLibrary,
  deepCloneTree,
  libraryEntryFromSubtree,
  createGlslLibraryEntry,
  updateGlslLibraryEntry,
  createLibraryRef,
});
