'use strict';

// ================================================================
// GLSL number / vector formatting helpers
// ================================================================
// glslNum — compact float literal. forceFloat=true → always has '.'
//   0         -> "0"   (or "0." if forceFloat)
//   0.4       -> ".4"
//   -0.5      -> "-.5"
//   32        -> "32"  (or "32." if forceFloat)
// Integer literals are only legal inside a vecN(...) constructor; in scalar
// float contexts (mult/div/clamp args) we MUST keep the dot.
function glslNum(x, forceFloat = false) {
  const n = Number(x);
  if (!isFinite(n)) return forceFloat ? '0.' : '0';
  let s = parseFloat(n.toFixed(3)).toString();
  if (s.startsWith('0.'))       s = s.slice(1);
  else if (s.startsWith('-0.')) s = '-' + s.slice(2);
  if (forceFloat && !s.includes('.') && !s.includes('e') && !s.includes('E')) s += '.';
  return s;
}

// glslVec — emit vec2/3/4; collapse all-equal components to single-arg form.
// E.g. glslVec(3,[0,0,0]) -> "vec3(0)" ; glslVec(3,[0,.4,.2]) -> "vec3(0,.4,.2)"
function glslVec(n, arr) {
  const parts = arr.slice(0, n).map(v => glslNum(v, false));
  return parts.every(p => p === parts[0])
    ? `vec${n}(${parts[0]})`
    : `vec${n}(${parts.join(',')})`;
}

// ================================================================
// Smooth min / max / subtraction helpers (emitted on demand)
// ================================================================
// Polynomial (iq-style) smooth min/max/sub. `max(k,1e-8)` in the denominator
// keeps them branch-free AND safe at k=0 (h=0 → 0/1e-8 = 0 → pure hard min/max).
// This lets the compiler emit a single uniform call for every CSG op regardless
// of whether k is 0, a literal >0, or a uniform.
const SMIN_GLSL = `float smin(float a,float b,float k,inout float ma,float mb){
  ma=a<b?ma:mb;
  float h=max(k-abs(a-b),0.);
  return min(a,b)-h*h*.25/max(k,1e-8);
}`;
const SMAX_GLSL = `float smax(float a,float b,float k,inout float ma,float mb){
  ma=a>b?ma:mb;
  float h=max(k-abs(a-b),0.);
  return max(a,b)+h*h*.25/max(k,1e-8);
}`;
const SSUB_GLSL = `float ssub(float a,float b,float k){
  float h=max(k-abs(a+b),0.);
  return max(a,-b)+h*h*.25/max(k,1e-8);
}`;

// ================================================================
// SDF COMPILER  (tree → GLSL)
// ================================================================
// Emission strategy: the top-level accumulator (d, m) and a single scratch
// vec3 q carry the running result.
//   - Leaves write/update their destination (d, m) inline (direct assign for
//     the first child of a group, smin/smax/ssub for subsequent children).
//   - Groups that mutate the incoming point open a { vec3 pA=invT(p,...); ... }
//     block — no save/restore, just a fresh name that shadows nothing.
//   - Subsequent group children get their own `float dX, mX;` declared at the
//     enclosing scope, run inside a { vec3 pX=...; <subtree> } block, then
//     combine back via d=op(d, dX, k, m, mX).
//   - Depth-suffixed names (d/dA/dB..., m/mA/mB..., p/pA/pB...) keep every
//     variable unique across arbitrary sibling and nesting depth.
//
// Given a scene tree, produces:
//   - sceneFn   : `vec2 sceneMap(vec3 p)` returning (distance, materialId)
//   - colorFn   : `vec3 shapeCol(float mid)`
//   - matFn     : `vec4 shapeMat(float mid)` (refl, rough, spec, specPow)
//   - header    : GLSL helper header (deduplicated SDF primitives + transforms)
//   - extraFns  : per-node helper functions (profile_N, pT_N, dT_N)
//   - shapes    : all shape nodes with resolved { _mi, material }
//   - usedMaterials : deduplicated materials (length = size of u_matCol/u_matMat)
//
// When `selectedId` targets a shape/group, its transform and shape params are
// emitted as uniform references so the JS side updates them without a
// shader recompile (interactive editing).
//
// `opts.materialUniforms = true` → shapeCol/shapeMat read from
// `u_matCol[]`/`u_matMat[]` uniforms (editor fast-path). Otherwise the
// palette is baked as literals (Shadertoy export).

function compileSDF(root, selectedId, palette, opts) {
  opts = opts || {};
  const materialUniforms = !!opts.materialUniforms;
  palette = (palette && palette.length) ? palette : [FALLBACK_MATERIAL];
  const libMap = mergeLibrary(opts.userLibrary);

  const usedMats = [];
  const matKeyToIdx = new Map();
  const matIndex = (mat) => {
    const k = mat.id || '__fb';
    if (!matKeyToIdx.has(k)) {
      matKeyToIdx.set(k, usedMats.length);
      usedMats.push(mat);
    }
    return matKeyToIdx.get(k);
  };

  let helperCnt = 0;      // unique id for pT_N / dT_N / profile_N helpers
  let shapeEmitCnt = 0;   // unique id for per-shape temp variables (capsule/bezier)
  const lines = [];
  const deps = new Set();
  const helperFns = [];
  const smoothFns = new Set();
  const shapes = [];
  const userGlslHeaders = [];   // user-defined GLSL sources emitted once in header
  const usedUserGlsl = new Set(); // prevent duplicate emission
  const libraryFnCache = new Map();   // key: entryId + '|' + (effectiveInherited||'')  →  fnName
  const libraryFnSrcs  = [];          // function bodies, append order (inner before outer)
  const libraryCompiling = new Set(); // cycle detection
  let   libraryFnCnt   = 0;

  // Evaluate a library entry's callTemplate substituting param literals and qVar.
  function evalCallTemplate(entry, nodeParams, qVar) {
    const params = entry.params || [];
    return (entry.callTemplate || '').replace(/\{(\w+)\}/g, (_, key) => {
      if (key === 'q') return qVar;
      const param = params.find(p => p.key === key);
      if (!param) return '0.';
      const val = (nodeParams || {})[key];
      if (param.type === 'vec3') {
        const arr = Array.isArray(val) ? val : (Array.isArray(param.default) ? param.default : [0, 0, 0]);
        return glslVec(3, arr);
      }
      const num = (val !== undefined && val !== null) ? val : (param.default || 0);
      return glslNum(num, true);
    });
  }

  // Uniform-ref variant: replaces param values with u_selParams slots so the
  // selected library_ref can be edited live without shader recompilation.
  // Slot assignment mirrors _packLibRefUniforms in renderer.js.
  function evalCallTemplateWithUniforms(entry, qVar) {
    const params = entry.params || [];
    const floatSlots = [
      'u_selParams.x','u_selParams.y','u_selParams.z','u_selParams.w',
      'u_selParams2.x','u_selParams2.y','u_selParams2.z','u_selParams2.w',
    ];
    const vec3Slots = ['u_selParams3','u_selParams4'];
    let fi = 0, vi = 0;
    const keySlot = {};
    for (const p of params) {
      if (p.type === 'vec3') { if (vi < vec3Slots.length) keySlot[p.key] = { kind:'vec3', u:vec3Slots[vi++] }; }
      else                   { if (fi < floatSlots.length) keySlot[p.key] = { kind:'float', u:floatSlots[fi++] }; }
    }
    return (entry.callTemplate || '').replace(/\{(\w+)\}/g, (_, key) => {
      if (key === 'q') return qVar;
      const slot = keySlot[key];
      if (!slot) return '0.';
      if (slot.kind === 'vec3') return `vec3(${slot.u}.x,${slot.u}.y,${slot.u}.z)`;
      return slot.u;
    });
  }

  // True if this library_ref resolves to a GLSL entry (leaf-like in emission).
  function isGlslRef(node) {
    if (node.type !== 'library_ref') return false;
    const e = libMap.get(node.libraryId);
    return !!(e && e.source === 'glsl');
  }

  // True if node is a "leaf" in the SDF emission sense.
  function isLeafNode(node) {
    return SHAPE_TYPES.includes(node.type) || isGlslRef(node);
  }

  // Baked or uniform expression for a single scalar param key.
  function makeParamExpr(node, isSelected, reg) {
    const params = node.params || {};
    const layout = reg.uniformLayout || {};
    return (key) => {
      if (isSelected && layout[key]) return layout[key];
      if (key in params && !Array.isArray(params[key])) {
        return glslNum(params[key], true);
      }
      const last = key.slice(-1);
      const axisIdx = { x:0, y:1, z:2 }[last];
      if (axisIdx !== undefined) {
        const base = key.slice(0, -1);
        const arr = params[base];
        if (Array.isArray(arr)) return glslNum(arr[axisIdx] || 0, true);
      }
      return '0.';
    };
  }

  // Wrap user GLSL so they don't have to write `return <var>;` themselves.
  function wrapBody(code, retVar) {
    const t = (code || '').trim();
    if (!t) return null;
    if (/\breturn\b/.test(t)) return t;
    if (t.endsWith(';') || t.endsWith('}')) return `${t}\nreturn ${retVar};`;
    return `return ${t};`;
  }

  function isIdentityTransform(node) {
    const p = node.position||[0,0,0], r = node.rotation||[0,0,0];
    const s = (typeof node.scale === 'number') ? node.scale : 1;
    return p[0]===0 && p[1]===0 && p[2]===0
        && r[0]===0 && r[1]===0 && r[2]===0
        && Math.abs(s - 1) < 1e-6;
  }
  const hasPT = node => !!(node.pTransform && node.pTransform.trim());
  const hasDT = node => !!(node.dTransform && node.dTransform.trim());

  // Emit the optimal inverse-transform expression for a shape, writing into
  // the global `q`. Returns { qVar, scaleMul }:
  //   - qVar:     the GLSL expression to feed into the primitive's emit()
  //               (either 'q' or pVar itself when the transform is identity)
  //   - scaleMul: if non-null, the distance must be multiplied by this after
  //               the primitive call (the shape shrunk `q` by 1/sc).
  // Shortcuts (when the shape is not selected):
  //   identity                → reuse pVar
  //   translation only        → q = p - vec3(...)
  //   translation + scale     → q = (p - vec3(...))/sc
  //   rotation present        → q = invT(p, pos, rot, sc)
  function emitShapeQ(node, pVar, isSel, indent) {
    if (isSel) {
      lines.push(`${indent}q=invT(${pVar},u_selPos,u_selRot,u_selScale);`);
      return { qVar: 'q', scaleMul: 'u_selScale' };
    }
    const pos = node.position || [0,0,0];
    const rot = node.rotation || [0,0,0];
    const sc  = (typeof node.scale === 'number') ? node.scale : 1;
    const posZero  = pos.every(v => Math.abs(v) < 1e-6);
    const rotZero  = rot.every(v => Math.abs(v) < 1e-6);
    const scaleOne = Math.abs(sc - 1) < 1e-6;

    if (posZero && rotZero && scaleOne) return { qVar: pVar, scaleMul: null };
    if (rotZero && scaleOne) {
      lines.push(`${indent}q=${pVar}-${glslVec(3,pos)};`);
      return { qVar: 'q', scaleMul: null };
    }
    if (rotZero) {
      const scStr = glslNum(sc, true);
      lines.push(posZero
        ? `${indent}q=${pVar}/${scStr};`
        : `${indent}q=(${pVar}-${glslVec(3,pos)})/${scStr};`);
      return { qVar: 'q', scaleMul: scStr };
    }
    lines.push(`${indent}q=invT(${pVar},${glslVec(3,pos)},${glslVec(3,rot)},${glslNum(sc,true)});`);
    return { qVar: 'q', scaleMul: scaleOne ? null : glslNum(sc, true) };
  }

  // Declare a fresh point-in-local-frame variable `newPName` initialized from
  // `srcPName` via the node's inverse transform — no save/restore of the outer p.
  // Follow-up pTransform / modifier lines then mutate newPName in place.
  // Returns { scaleMul } — the scale factor to multiply the subtree's final d by.
  function emitNewP(node, srcPName, newPName, isSel, indent) {
    let scaleMul = null;
    let initExpr = srcPName;  // default: identity → fresh copy of src
    if (isSel) {
      initExpr = `invT(${srcPName},u_selPos,u_selRot,u_selScale)`;
      scaleMul = 'u_selScale';
    } else if (!isIdentityTransform(node)) {
      const pos = node.position||[0,0,0];
      const rot = node.rotation||[0,0,0];
      const sc  = (typeof node.scale === 'number') ? node.scale : 1;
      const posZero  = pos.every(v => Math.abs(v) < 1e-6);
      const rotZero  = rot.every(v => Math.abs(v) < 1e-6);
      const scaleOne = Math.abs(sc - 1) < 1e-6;
      if (rotZero && scaleOne) {
        if (!posZero) initExpr = `${srcPName}-${glslVec(3,pos)}`;
      } else if (rotZero) {
        const scStr = glslNum(sc, true);
        initExpr = posZero
          ? `${srcPName}/${scStr}`
          : `(${srcPName}-${glslVec(3,pos)})/${scStr}`;
        scaleMul = scStr;
      } else {
        initExpr = `invT(${srcPName},${glslVec(3,pos)},${glslVec(3,rot)},${glslNum(sc,true)})`;
        if (!scaleOne) scaleMul = glslNum(sc, true);
      }
    }
    lines.push(`${indent}vec3 ${newPName}=${initExpr};`);
    if (hasPT(node)) {
      const name = `pT_${helperCnt++}`;
      helperFns.push(`vec3 ${name}(vec3 p){\n${wrapBody(node.pTransform, 'p')}\n}`);
      lines.push(`${indent}${newPName}=${name}(${newPName});`);
    }
    if (MODIFIER_TYPES.includes(node.type)) {
      for (const l of emitModifier(node, newPName, isSel)) lines.push(indent + l);
    }
    return { scaleMul };
  }

  // Suffix for depth-stacked variable names: 0→'', 1→'A', 2→'B', ...
  const suf = n => n === 0 ? '' : String.fromCharCode(64 + n);

  // Domain modifier GLSL (mirror / repeat / repeat_angular), mutating pVar.
  function emitModifier(node, pVar, useUniforms) {
    const p = node.params || {};
    const out = [];
    switch(node.type) {
      case 'mirror':
        if (useUniforms) {
          out.push(`${pVar}.x=mix(${pVar}.x,sqrt(${pVar}.x*${pVar}.x+u_selParams.w),step(.5,u_selParams.x));`);
          out.push(`${pVar}.y=mix(${pVar}.y,sqrt(${pVar}.y*${pVar}.y+u_selParams.w),step(.5,u_selParams.y));`);
          out.push(`${pVar}.z=mix(${pVar}.z,sqrt(${pVar}.z*${pVar}.z+u_selParams.w),step(.5,u_selParams.z));`);
        } else {
          const eps = Math.max(0, p.eps||0);
          if (eps > 1e-7) {
            const e = glslNum(eps, true);
            if (p.x) out.push(`${pVar}.x=sqrt(${pVar}.x*${pVar}.x+${e});`);
            if (p.y) out.push(`${pVar}.y=sqrt(${pVar}.y*${pVar}.y+${e});`);
            if (p.z) out.push(`${pVar}.z=sqrt(${pVar}.z*${pVar}.z+${e});`);
          } else {
            if (p.x) out.push(`${pVar}.x=abs(${pVar}.x);`);
            if (p.y) out.push(`${pVar}.y=abs(${pVar}.y);`);
            if (p.z) out.push(`${pVar}.z=abs(${pVar}.z);`);
          }
        }
        break;
      case 'repeat':
        if (useUniforms) {
          out.push(`if(u_selParams2.x>.5)${pVar}.x=${pVar}.x-u_selParams.x*clamp(floor(${pVar}.x/u_selParams.x+.5),-u_selParams2.x,u_selParams2.x);`);
          out.push(`if(u_selParams2.y>.5)${pVar}.y=${pVar}.y-u_selParams.y*clamp(floor(${pVar}.y/u_selParams.y+.5),-u_selParams2.y,u_selParams2.y);`);
          out.push(`if(u_selParams2.z>.5)${pVar}.z=${pVar}.z-u_selParams.z*clamp(floor(${pVar}.z/u_selParams.z+.5),-u_selParams2.z,u_selParams2.z);`);
        } else {
          const emitAxis = (axis, s, n) => {
            if (!n || n<=0) return;
            const sv = glslNum(s, true), nv = glslNum(n, true);
            out.push(`${pVar}.${axis}=${pVar}.${axis}-${sv}*clamp(floor(${pVar}.${axis}/${sv}+.5),-${nv},${nv});`);
          };
          emitAxis('x', p.sx||1, Math.max(0,Math.floor(p.nx||0)));
          emitAxis('y', p.sy||1, Math.max(0,Math.floor(p.ny||0)));
          emitAxis('z', p.sz||1, Math.max(0,Math.floor(p.nz||0)));
        }
        break;
      case 'repeat_angular': {
        const axis = p.axis || 'y';
        const [a, b, sw] = axis==='x' ? ['y','z','yz']
                         : axis==='z' ? ['x','y','xy']
                         :              ['x','z','xz'];
        deps.add('rot2');
        if (useUniforms) {
          // u_selParams.x = count, u_selParams.y = nMin, u_selParams.z = nMax (wide bounds = full circle).
          // Fold via column pre-multiply (rot2 in this lib = R(-a), so rot2(id*sec)*p rotates by -id*sec).
          out.push(`{float sec=6.28318530718/max(1.,u_selParams.x);float id=clamp(round(atan(${pVar}.${b},${pVar}.${a})/sec),u_selParams.y,u_selParams.z);${pVar}.${sw}=rot2(id*sec)*${pVar}.${sw};}`);
        } else {
          const count = Math.max(1, p.count||6);
          const sec = glslNum(6.28318530718/count, true);
          const reps = Math.max(0, Math.floor(p.reps||0));
          const clamped = reps > 0 && reps < count;
          let idExpr;
          if (clamped) {
            const nMin = -Math.floor(reps/2);
            const nMax = Math.ceil(reps/2) - 1;
            idExpr = `clamp(round(atan(${pVar}.${b},${pVar}.${a})/${sec}),${glslNum(nMin,true)},${glslNum(nMax,true)})`;
          } else {
            idExpr = `round(atan(${pVar}.${b},${pVar}.${a})/${sec})`;
          }
          out.push(`${pVar}.${sw}=rot2(${idExpr}*${sec})*${pVar}.${sw};`);
        }
        break;
      }
    }
    return out;
  }

  // Emit profile(k) helper for capsule/bezier if present.
  function maybeEmitProfile(node) {
    const body = wrapBody(node.params && node.params.profile, '1.0');
    if (!body) return null;
    const name = `profile_${helperCnt++}`;
    helperFns.push(`float ${name}(float k){\n${body}\n}`);
    return name;
  }

  // Build distance expression for a library_ref with source:'glsl'.
  // Emits the GLSL source into userGlslHeaders (once per entry), applies transform,
  // evaluates the callTemplate, and handles outputKind.
  function prepLibraryGlslExpr(node, pVar, indent) {
    const entry = libMap.get(node.libraryId);
    if (!entry || entry.source !== 'glsl') return '1e10';

    if (!usedUserGlsl.has(entry.id)) {
      usedUserGlsl.add(entry.id);
      userGlslHeaders.push(entry.glslSrc);
    }

    const isSel = selectedId && node.id === selectedId;
    let { qVar, scaleMul } = emitShapeQ(node, pVar, isSel, indent);

    if (hasPT(node)) {
      const name = `pT_${helperCnt++}`;
      helperFns.push(`vec3 ${name}(vec3 p){\n${wrapBody(node.pTransform, 'p')}\n}`);
      lines.push(`${indent}q=${name}(${qVar});`);
      qVar = 'q';
    }

    const callExpr = isSel
      ? evalCallTemplateWithUniforms(entry, qVar)
      : evalCallTemplate(entry, node.params, qVar);
    const sId = shapeEmitCnt++;
    let dExpr;
    if (entry.outputKind === 'dist_k' || entry.outputKind === 'dist_mat') {
      const tmp = `t${sId}_0`;
      lines.push(`${indent}vec2 ${tmp}=${callExpr};`);
      dExpr = `${tmp}.x`;
    } else {
      dExpr = callExpr;
    }

    const scaledD = scaleMul ? `(${dExpr})*${scaleMul}` : dExpr;
    if (hasDT(node)) {
      const name = `dT_${helperCnt++}`;
      helperFns.push(`float ${name}(float d, vec3 p){\n${wrapBody(node.dTransform, 'd')}\n}`);
      return `${name}(${scaledD},${qVar})`;
    }
    return scaledD;
  }

  // Build the shape's distance expression. Emits any preparatory lines
  // (q= assignment, capsule/bezier temp) and returns the GLSL distance expr
  // (already including scale multiplier and dTransform wrapping).
  // Does NOT emit the accumulator update — the caller decides assign vs combine.
  function prepLeafExpr(node, pVar, indent) {
    if (node.type === 'library_ref') return prepLibraryGlslExpr(node, pVar, indent);
    return prepShapeExpr(node, pVar, indent);
  }

  function prepShapeExpr(node, pVar, indent) {
    const reg = SHAPE_REGISTRY[node.type];
    if (!reg) return '1e10';
    for (const dep of (reg.glslDeps||[])) deps.add(dep);
    const isSel = selectedId && node.id === selectedId;

    let { qVar, scaleMul } = emitShapeQ(node, pVar, isSel, indent);

    if (hasPT(node)) {
      const name = `pT_${helperCnt++}`;
      helperFns.push(`vec3 ${name}(vec3 p){\n${wrapBody(node.pTransform, 'p')}\n}`);
      lines.push(`${indent}q=${name}(${qVar});`);
      qVar = 'q';
    }

    const pe = makeParamExpr(node, isSel, reg);
    const profileFn = maybeEmitProfile(node);
    const sId = shapeEmitCnt++;
    const preLines = [];
    let tmpN = 0;
    const ctx = { profileFn, preLines, tmpName: () => `t${sId}_${tmpN++}` };
    const { dExpr } = reg.emit(pe, qVar, ctx);
    for (const pl of preLines) lines.push(indent + pl.replace(/^\s*/, ''));

    const scaledD = scaleMul ? `(${dExpr})*${scaleMul}` : dExpr;
    if (hasDT(node)) {
      const name = `dT_${helperCnt++}`;
      helperFns.push(`float ${name}(float d, vec3 p){\n${wrapBody(node.dTransform, 'd')}\n}`);
      return `${name}(${scaledD},${qVar})`;
    }
    return scaledD;
  }

  // Register a shape's material and record it in `shapes`.
  function registerShapeMaterial(node, parentInherited) {
    const material = resolveMaterial(node.materialId, parentInherited, palette);
    const mi = matIndex(material);
    shapes.push({ ...node, _mi: mi, material });
    return mi;
  }

  // Emit a leaf shape as a first-child of its parent group — writes directly
  // into the destination accumulator (dName, mName).
  function emitFirstLeaf(node, pName, dName, mName, parentInherited, indent) {
    const mi = registerShapeMaterial(node, parentInherited);
    const dExpr = prepLeafExpr(node, pName, indent);
    lines.push(`${indent}${dName}=${dExpr}; ${mName}=${mi}.;`);
  }

  // Emit a leaf shape as a subsequent child — combines into (dName, mName) via
  // the parent group's op. Always uses smin/smax/ssub — the polynomial forms
  // handle k=0 natively, so one uniform call site covers every CSG case.
  function emitSubsequentLeaf(node, pName, dName, mName, parentInherited, combineOp, kExpr, indent) {
    const mi = registerShapeMaterial(node, parentInherited);
    const dExpr = prepLeafExpr(node, pName, indent);
    const matLit = `${mi}.`;
    switch (combineOp) {
      case 'union':
        smoothFns.add('smin');
        lines.push(`${indent}${dName}=smin(${dName},${dExpr},${kExpr},${mName},${matLit});`);
        break;
      case 'subtraction':
        smoothFns.add('ssub');
        lines.push(`${indent}${dName}=ssub(${dName},${dExpr},${kExpr});`);
        break;
      case 'intersection':
        smoothFns.add('smax');
        lines.push(`${indent}${dName}=smax(${dName},${dExpr},${kExpr},${mName},${matLit});`);
        break;
    }
  }

  // Emit `op` that combines `dChild, mChild` into `dName, mName`.
  function emitGroupCombine(combineOp, dName, mName, dChild, mChild, kExpr, indent) {
    switch (combineOp) {
      case 'union':
        smoothFns.add('smin');
        lines.push(`${indent}${dName}=smin(${dName},${dChild},${kExpr},${mName},${mChild});`);
        break;
      case 'subtraction':
        smoothFns.add('ssub');
        lines.push(`${indent}${dName}=ssub(${dName},${dChild},${kExpr});`);
        break;
      case 'intersection':
        smoothFns.add('smax');
        lines.push(`${indent}${dName}=smax(${dName},${dChild},${kExpr},${mName},${mChild});`);
        break;
    }
  }

  // Emit a group's children into (dName, mName). First child writes directly;
  // subsequent leaves combine inline; subsequent groups declare their own
  // `float dX, mX;` then emit the subtree into it, then combine:
  //   float dX, mX;
  //   <subtree writes into dX, mX — opens its own { vec3 pX=...; ... } if needed>
  //   dName = op(dName, dX, k, mName, mX);
  // Depth-suffixed names (dA, dB, ... / pA, pB, ...) keep everything unique
  // across arbitrary sibling and nesting depth.
  function emitChildren(children, pName, dName, mName, childInherited, combineOp, kExpr, indent, pDepth, aDepth) {
    if (children.length === 0) return;
    emitSubtree(children[0], pName, dName, mName, childInherited, indent, pDepth, aDepth);
    let accumSlot = aDepth;
    for (let i = 1; i < children.length; i++) {
      const child = children[i];
      if (isLeafNode(child)) {
        emitSubsequentLeaf(child, pName, dName, mName, childInherited, combineOp, kExpr, indent);
        continue;
      }
      accumSlot += 1;
      const dChild = 'd' + suf(accumSlot);
      const mChild = 'm' + suf(accumSlot);
      lines.push(`${indent}float ${dChild}, ${mChild};`);
      emitSubtree(child, pName, dChild, mChild, childInherited, indent, pDepth, accumSlot);
      emitGroupCombine(combineOp, dName, mName, dChild, mChild, kExpr, indent);
    }
  }

  // Compile a subtree library entry as a standalone GLSL function and return its
  // name. Returns null to signal the call site to fall back to inline expansion
  // (used for cycles or missing trees). The function takes `vec3 p` (already
  // transformed by the instance at the call site) and returns vec2(d, mid).
  function ensureLibraryFn(entry, effectiveInherited) {
    if (!entry || !entry.tree) return null;
    const key = entry.id + '|' + (effectiveInherited || '');
    const hit = libraryFnCache.get(key);
    if (hit) return hit;
    if (libraryCompiling.has(key)) return null;

    const fnName = 'lib_' + (libraryFnCnt++);
    libraryCompiling.add(key);
    const before = lines.length;
    try {
      emitSubtree(entry.tree, 'p', '_d', '_m', effectiveInherited, '  ', 0, 0);
    } finally {
      libraryCompiling.delete(key);
    }
    const body = lines.slice(before).join('\n');
    lines.length = before;

    libraryFnSrcs.push(
      `vec2 ${fnName}(vec3 p){\n  float _d=1e9, _m=0.;\n  vec3 q;\n${body}\n  return vec2(_d,_m);\n}`
    );
    libraryFnCache.set(key, fnName);
    return fnName;
  }

  // Emit a subtree rooted at `node`, writing its result into (dName, mName).
  // Groups that mutate p open a { vec3 pX=...; ... } block — no save/restore
  // of the outer p since we introduce a fresh name instead.
  function emitSubtree(node, pName, dName, mName, parentInherited, indent, pDepth, aDepth) {
    if (SHAPE_TYPES.includes(node.type)) {
      emitFirstLeaf(node, pName, dName, mName, parentInherited, indent);
      return;
    }

    // library_ref: GLSL source → leaf, subtree → expand inline
    if (node.type === 'library_ref') {
      if (isGlslRef(node)) {
        emitFirstLeaf(node, pName, dName, mName, parentInherited, indent);
      } else {
        // Subtree ref: emit the entry's tree as a shared GLSL function and call it.
        // Identical scheme as glsl-source refs: instance transform applied at the
        // call site (uniformized when this ref is the selected node), function body
        // shared across all instances of the same (entry, inherited-material) pair.
        const entry = libMap.get(node.libraryId);
        if (!entry || !entry.tree) {
          lines.push(`${indent}${dName}=1e9; ${mName}=0.;`);
          return;
        }
        const isSel = selectedId && node.id === selectedId;
        const childInherited = node.materialId || parentInherited;
        const fnName = ensureLibraryFn(entry, childInherited);

        if (fnName) {
          let { qVar, scaleMul } = emitShapeQ(node, pName, isSel, indent);
          if (hasPT(node)) {
            const ptName = `pT_${helperCnt++}`;
            helperFns.push(`vec3 ${ptName}(vec3 p){\n${wrapBody(node.pTransform, 'p')}\n}`);
            lines.push(`${indent}q=${ptName}(${qVar});`);
            qVar = 'q';
          }
          const sId = shapeEmitCnt++;
          lines.push(`${indent}vec2 t${sId}=${fnName}(${qVar});`);
          let dRhs = scaleMul ? `t${sId}.x*${scaleMul}` : `t${sId}.x`;
          if (hasDT(node)) {
            const dtName = `dT_${helperCnt++}`;
            helperFns.push(`float ${dtName}(float d, vec3 p){\n${wrapBody(node.dTransform, 'd')}\n}`);
            dRhs = `${dtName}(${dRhs},${qVar})`;
          }
          lines.push(`${indent}${dName}=${dRhs}; ${mName}=t${sId}.y;`);
        } else {
          // Cycle detected — fall back to inline expansion to keep GLSL valid.
          const mutatesP = isSel || !isIdentityTransform(node) || hasPT(node);
          let workPName = pName, workIndent = indent, newPDepth = pDepth;
          let scaleMul = null, blockOpened = false;
          if (mutatesP) {
            blockOpened = true; newPDepth = pDepth + 1;
            const newPName = 'p' + suf(newPDepth);
            lines.push(`${indent}{`); workIndent = indent + '  ';
            scaleMul = emitNewP(node, pName, newPName, isSel, workIndent).scaleMul;
            workPName = newPName;
          }
          emitSubtree(entry.tree, workPName, dName, mName, childInherited, workIndent, newPDepth, aDepth);
          if (scaleMul) lines.push(`${workIndent}${dName}*=${scaleMul};`);
          if (hasDT(node)) {
            const name = `dT_${helperCnt++}`;
            helperFns.push(`float ${name}(float d, vec3 p){\n${wrapBody(node.dTransform, 'd')}\n}`);
            lines.push(`${workIndent}${dName}=${name}(${dName},${workPName});`);
          }
          if (blockOpened) lines.push(`${indent}}`);
        }
      }
      return;
    }
    const isSel  = selectedId && node.id === selectedId;
    const isMod  = MODIFIER_TYPES.includes(node.type);
    const combineOp = isMod ? 'union' : node.type;
    const useUniformK = isSel && !isMod;
    const kVal = isMod ? 0 : ((node.params && node.params.k) || 0);
    const kExpr = useUniformK ? 'u_selK' : glslNum(kVal, true);
    const childInherited = node.materialId || parentInherited;
    const children = node.children || [];

    const mutatesP = isSel || !isIdentityTransform(node) || hasPT(node) || isMod;

    let workPName = pName;
    let workIndent = indent;
    let newPDepth = pDepth;
    let scaleMul = null;
    let blockOpened = false;

    if (mutatesP) {
      blockOpened = true;
      newPDepth = pDepth + 1;
      const newPName = 'p' + suf(newPDepth);
      lines.push(`${indent}{`);
      workIndent = indent + '  ';
      scaleMul = emitNewP(node, pName, newPName, isSel, workIndent).scaleMul;
      workPName = newPName;
    }

    if (children.length === 0) {
      lines.push(`${workIndent}${dName}=1e9; ${mName}=0.;`);
    } else {
      emitChildren(children, workPName, dName, mName, childInherited, combineOp, kExpr, workIndent, newPDepth, aDepth);
    }

    if (scaleMul) lines.push(`${workIndent}${dName}*=${scaleMul};`);
    if (hasDT(node)) {
      const name = `dT_${helperCnt++}`;
      helperFns.push(`float ${name}(float d, vec3 p){\n${wrapBody(node.dTransform, 'd')}\n}`);
      lines.push(`${workIndent}${dName}=${name}(${dName},${workPName});`);
    }
    if (blockOpened) lines.push(`${indent}}`);
  }

  // BUILD SCENE
  emitSubtree(root, 'p', 'd', 'm', null, '  ', 0, 0);

  // shapeCol / shapeMat — ternary chain over N used materials
  const buildTernary = (expr, fallback) => {
    const N = usedMats.length;
    if (N === 0) return `  return ${fallback};`;
    if (N === 1) return `  return ${expr(0)};`;
    const parts = [];
    for (let i = 0; i < N - 1; i++) parts.push(`mid<${i}.5? ${expr(i)} :`);
    parts.push(expr(N - 1));
    return `  return\n    ${parts.join('\n    ')};`;
  };

  let colorFn, matFn;
  if (materialUniforms && usedMats.length > 0) {
    const N = usedMats.length;
    const decls = `uniform vec3 u_matCol[${N}];\nuniform vec4 u_matMat[${N}];\n`;
    colorFn = `${decls}vec3 shapeCol(float mid){\n${buildTernary(i=>`u_matCol[${i}]`, 'vec3(.7)')}\n}`;
    matFn   = `vec4 shapeMat(float mid){\n${buildTernary(i=>`u_matMat[${i}]`, 'vec4(0,.5,.3,32.)')}\n}`;
  } else {
    colorFn = `vec3 shapeCol(float mid){\n${buildTernary(i=>glslVec(3, usedMats[i].color), 'vec3(.7)')}\n}`;
    matFn   = `vec4 shapeMat(float mid){\n${buildTernary(i=>{
      const m = usedMats[i];
      return glslVec(4, [m.refl, m.rough, m.spec, m.specPow]);
    }, 'vec4(0,.5,.3,32.)')}\n}`;
  }

  const sceneFn = `vec2 sceneMap(vec3 p){\n  float d=1e9, m=0.;\n  vec3 q;\n${lines.join('\n')}\n  return vec2(d,m);\n}`;
  const header  = buildGlslHeader(deps) + (userGlslHeaders.length ? '\n' + userGlslHeaders.join('\n') : '');
  const smoothSrc = [];
  if (smoothFns.has('smin')) smoothSrc.push(SMIN_GLSL);
  if (smoothFns.has('smax')) smoothSrc.push(SMAX_GLSL);
  if (smoothFns.has('ssub')) smoothSrc.push(SSUB_GLSL);
  const extraFns = [...smoothSrc, ...helperFns, ...libraryFnSrcs].join('\n');
  return {
    sceneFn, colorFn, matFn,
    header, extraFns,
    shapes,
    usedMaterials: usedMats,
  };
}

Object.assign(window, { compileSDF });
