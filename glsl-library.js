'use strict';

// ================================================================
// GLSL LIBRARY — SDF primitives + transforms
// ================================================================
// Central catalog of GLSL helper functions. Each primitive in
// SHAPE_REGISTRY declares which headers it needs via `glslDeps`;
// the compiler deduplicates and emits only what's used.
const GLSL_LIBRARY = {
  // Transforms (always emitted — cheap, widely used)
  rotX: `mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1,0,0,0,c,-s,0,s,c);}`,
  rotY: `mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0,s,0,1,0,-s,0,c);}`,
  rotZ: `mat3 rotZ(float a){float c=cos(a),s=sin(a);return mat3(c,-s,0,s,c,0,0,0,1);}`,
  // 2D rotation (polar repeat, mirrors in-plane). Used as `p.xz *= rot2(a)` → rotates by -a.
  rot2: `mat2 rot2(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}`,
  // Uniform scale: single float. Proper SDF metric (no per-axis hack).
  invT: `vec3 invT(vec3 p,vec3 pos,vec3 rot,float sc){
    p-=pos;
    p=rotZ(-rot.z)*rotY(-rot.y)*rotX(-rot.x)*p;
    return p/sc;
  }`,
  // Primitives
  sdSphere:    `float sdSphere(vec3 p,float r){return length(p)-r;}`,
  sdRoundBox:  `float sdRoundBox(vec3 p,vec3 b,float r){vec3 q=abs(p)-b+r;return length(max(q,0.))+min(max(q.x,max(q.y,q.z)),0.)-r;}`,
  sdCylinder:  `float sdCylinder(vec3 p,vec2 rh){vec2 d=abs(vec2(length(p.xz),p.y))-rh;return min(max(d.x,d.y),0.)+length(max(d,0.));}`,
  sdTorus:     `float sdTorus(vec3 p,vec2 t){return length(vec2(length(p.xz)-t.x,p.y))-t.y;}`,
  // Capsule defined by two endpoints a,b (local coords) and radius.
  // Helper variant that also returns the curvilinear parameter k∈[0,1]
  // so the compiler can multiply r by profile(k) inline.
  sdCapsuleCP: `vec2 sdCapsuleCP(vec3 p,vec3 a,vec3 b,float r){
    vec3 pa=p-a, ba=b-a;
    float k=clamp(dot(pa,ba)/max(dot(ba,ba),1e-8),0.,1.);
    return vec2(length(pa-ba*k)-r, k);
  }`,
  // Quadratic Bézier (snippet provided by user). Returns vec2(distance, k).
  sdBezier: `float dot2(vec3 v ) { return dot(v,v); }
vec2 sdBezier(vec3 pos, vec3 A, vec3 B, vec3 C) {    
    vec3 a = B - A,
     b = A - 2.*B + C,
     c = a * 2.,
     d = A - pos;
    float kk = 1. / dot(b,b),
     kx = kk * dot(a,b),
     ky = kk * (2.*dot(a,a)+dot(d,b)) / 3.,
     kz = kk * dot(d,a);      
    vec2 res;
    float p = ky - kx*kx,
     p3 = p*p*p,
     q = kx*(2.0*kx*kx - 3.0*ky) + kz,
     q2 = q*q,
     h = q2 + 4.*p3;
    if(h >= 0.) { 
        h = sqrt(h);
        vec2 x = (vec2(h,-h)-q)/2.;
        if(abs(p)<.001 ) {
          //float k = p3/q;              // linear approx
            float k = (1.-p3/q2)*p3/q;  // quadratic approx 
            x = vec2(k,-k-q);  
        }
        vec2 uv = sign(x)*pow(abs(x), vec2(1./3.));
        float t = clamp(uv.x+uv.y-kx, 0., 1.);
        res = vec2(dot2(d+(c+b*t)*t),t);
    }
    else
    {
        float z = sqrt(-p),
         v = acos( q/(p*z*2.) ) / 3.,
         m = cos(v),
         n = sin(v)*1.732050808;
        vec3 t = clamp(vec3(m+m,-n-m,n-m)*z-kx, 0., 1.);
        float dis = dot2(d+(c+b*t.x)*t.x);
        res = vec2(dis,t.x);
        dis = dot2(d+(c+b*t.y)*t.y);
        if( dis<res.x ) res = vec2(dis,t.y );
    }
    res.x = sqrt(res.x);
    return res;
}`,
  sdPlane:     `float sdPlane(vec3 p,vec4 n){return dot(p,n.xyz)+n.w;}`,
  noise3D: `float noise3D(vec3 p){
    vec3 s=vec3(113,157,1),ip=floor(p);
    vec4 h=vec4(0,s.yz,s.y+s.z)+dot(ip,s);
    p-=ip; p=p*p*(3.-2.*p);
    h=mix(fract(sin(h)*43758.5453),fract(sin(h+s.x)*43758.5453),p.x);
    h.xy=mix(h.xz,h.yw,p.y);
    return mix(h.x,h.y,p.z);
  }`,
  fbm: `float fbm(in vec3 p){
    return .5333*noise3D(p)+.2667*noise3D(p*2.02)+.1333*noise3D(p*4.03)+.0667*noise3D(p*8.03);
  }`,
};

// Base headers always emitted (transforms used by every transformed node)
const GLSL_BASE_DEPS = ['rotX', 'rotY', 'rotZ', 'invT', 'noise3D', 'fbm'];

// Build a GLSL header string from a set of dependency names.
function buildGlslHeader(deps) {
  const all = new Set([...GLSL_BASE_DEPS, ...(deps || [])]);
  const out = [];
  for (const k of all) {
    if (GLSL_LIBRARY[k]) out.push(GLSL_LIBRARY[k]);
  }
  return out.join('\n');
}

// ================================================================
// SHAPE REGISTRY
// ================================================================
// Each primitive is ONE descriptor. The compiler, renderer, UI and
// Shadertoy export all consume this registry — adding a primitive
// means adding one entry here.
//
// Descriptor fields:
//   label, icon            — UI
//   defaults               — {key: value} used by createNode
//   params                 — [{key,label,type,...}] drives PropsPanel UI
//                            types: 'number', 'vec3', 'glsl'
//   glslDeps               — helper names needed from GLSL_LIBRARY
//   emit(pe, q, ctx)       — returns { dExpr, before? } — dExpr is the
//                            GLSL expression for distance at point `q`.
//                            `pe(key)` returns the GLSL expression for a
//                            scalar param (either a constant or a uniform
//                            reference). Shapes with curvilinear k (capsule,
//                            bezier) use `ctx.profileFn(k)` to apply the
//                            per-shape profile(k) function.
//   uniformPack(params)    — returns { params:[4 floats], params2?:[4],
//                            params3?:[4], params4?:[4] } for the selected
//                            fast-path uniforms.
//   uniformLayout          — { paramKey: 'u_selParamsX.yz' } mapping,
//                            used by the compiler to emit uniform refs
//                            when this node is selected.
// Vec3 params get three entries in uniformLayout, one per .x/.y/.z.
const SHAPE_REGISTRY = {
  sphere: {
    label: 'Sphere', icon: '●',
    outputKind: 'dist',
    defaults: { radius: 0.5 },
    params: [{ key:'radius', label:'Radius', type:'number', min:0.001, step:0.01 }],
    glslDeps: ['sdSphere'],
    emit: (pe, q) => ({ dExpr: `sdSphere(${q},${pe('radius')})` }),
    uniformPack: p => ({ params:[p.radius||0.5, 0, 0, 0] }),
    uniformLayout: { radius:'u_selParams.x' },
  },
  box: {
    label: 'Box', icon: '■',
    outputKind: 'dist',
    defaults: { width:0.5, height:0.5, depth:0.5, radius:0 },
    params: [
      { key:'width',  label:'Width',  type:'number', step:0.01, min:0.001 },
      { key:'height', label:'Height', type:'number', step:0.01, min:0.001 },
      { key:'depth',  label:'Depth',  type:'number', step:0.01, min:0.001 },
      { key:'radius', label:'Corner', type:'number', step:0.005, min:0 },
    ],
    glslDeps: ['sdRoundBox'],
    emit: (pe, q) => ({
      dExpr: `sdRoundBox(${q},vec3(${pe('width')}*.5,${pe('height')}*.5,${pe('depth')}*.5),${pe('radius')})`,
    }),
    uniformPack: p => ({ params:[p.width||0.5, p.height||0.5, p.depth||0.5, p.radius||0] }),
    uniformLayout: {
      width:'u_selParams.x', height:'u_selParams.y',
      depth:'u_selParams.z', radius:'u_selParams.w',
    },
  },
  cylinder: {
    label: 'Cylinder', icon: '⬡',
    outputKind: 'dist',
    defaults: { radius:0.3, height:0.6 },
    params: [
      { key:'radius', label:'Radius', type:'number', step:0.01, min:0.001 },
      { key:'height', label:'Height', type:'number', step:0.01, min:0.001 },
    ],
    glslDeps: ['sdCylinder'],
    emit: (pe, q) => ({ dExpr: `sdCylinder(${q},vec2(${pe('radius')},${pe('height')}*.5))` }),
    uniformPack: p => ({ params:[p.radius||0.3, p.height||0.6, 0, 0] }),
    uniformLayout: { radius:'u_selParams.x', height:'u_selParams.y' },
  },
  torus: {
    label: 'Torus', icon: '◎',
    outputKind: 'dist',
    defaults: { R:0.4, r:0.12 },
    params: [
      { key:'R', label:'Major R', type:'number', step:0.01, min:0.001 },
      { key:'r', label:'Minor r', type:'number', step:0.005, min:0.001 },
    ],
    glslDeps: ['sdTorus'],
    emit: (pe, q) => ({ dExpr: `sdTorus(${q},vec2(${pe('R')},${pe('r')}))` }),
    uniformPack: p => ({ params:[p.R||0.4, p.r||0.12, 0, 0] }),
    uniformLayout: { R:'u_selParams.x', r:'u_selParams.y' },
  },
  capsule: {
    label: 'Capsule', icon: '⊃',
    outputKind: 'dist_k',
    defaults: { a:[0,-0.2,0], b:[0,0.2,0], radius:0.15, profile:'' },
    params: [
      { key:'a',       label:'A',          type:'vec3',   step:0.01 },
      { key:'b',       label:'B',          type:'vec3',   step:0.01 },
      { key:'radius',  label:'Radius',     type:'number', step:0.005, min:0.001 },
      { key:'profile', label:'Profile f(k)', type:'glsl' },
    ],
    glslDeps: ['sdCapsuleCP'],
    emit: (pe, q, ctx) => {
      const ax=pe('ax'), ay=pe('ay'), az=pe('az');
      const bx=pe('bx'), by=pe('by'), bz=pe('bz');
      const r = pe('radius');
      const prof = ctx.profileFn; // null if no profile defined
      if (prof) {
        // Stash (length_to_segment, k) in a temp so we can use k to
        // evaluate profile(k) without recomputing the projection.
        const tmp = ctx.tmpName();
        ctx.preLines.push(`  vec2 ${tmp}=sdCapsuleCP(${q},vec3(${ax},${ay},${az}),vec3(${bx},${by},${bz}),0.);`);
        return { dExpr: `${tmp}.x - ${r}*${prof}(${tmp}.y)` };
      }
      return { dExpr: `sdCapsuleCP(${q},vec3(${ax},${ay},${az}),vec3(${bx},${by},${bz}),${r}).x` };
    },
    uniformPack: p => ({
      params:  [p.radius||0.15, 0, 0, 0],
      params2: [...(p.a || [0,-0.2,0]).slice(0,3), 0],
      params3: [...(p.b || [0,0.2,0]).slice(0,3), 0],
    }),
    uniformLayout: {
      radius:'u_selParams.x',
      ax:'u_selParams2.x', ay:'u_selParams2.y', az:'u_selParams2.z',
      bx:'u_selParams3.x', by:'u_selParams3.y', bz:'u_selParams3.z',
    },
  },
  bezier: {
    label: 'Bezier', icon: '⌒',
    outputKind: 'dist_k',
    defaults: { b0:[-0.3,0,0], b1:[0,0.4,0], b2:[0.3,0,0], radius:0.1, profile:'' },
    params: [
      { key:'b0',      label:'P0',           type:'vec3',   step:0.01 },
      { key:'b1',      label:'P1',           type:'vec3',   step:0.01 },
      { key:'b2',      label:'P2',           type:'vec3',   step:0.01 },
      { key:'radius',  label:'Radius',       type:'number', step:0.005, min:0.001 },
      { key:'profile', label:'Profile f(k)', type:'glsl' },
    ],
    glslDeps: ['sdBezier'],
    emit: (pe, q, ctx) => {
      const p0 = `vec3(${pe('b0x')},${pe('b0y')},${pe('b0z')})`;
      const p1 = `vec3(${pe('b1x')},${pe('b1y')},${pe('b1z')})`;
      const p2 = `vec3(${pe('b2x')},${pe('b2y')},${pe('b2z')})`;
      const r  = pe('radius');
      const prof = ctx.profileFn;
      const tmp = ctx.tmpName();
      ctx.preLines.push(`  vec2 ${tmp}=sdBezier(${q},${p0},${p1},${p2});`);
      if (prof) return { dExpr: `${tmp}.x - ${r}*${prof}(${tmp}.y)` };
      return { dExpr: `${tmp}.x - ${r}` };
    },
    uniformPack: p => ({
      params:  [p.radius||0.1, 0, 0, 0],
      params2: [...(p.b0 || [-0.3,0,0]).slice(0,3), 0],
      params3: [...(p.b1 || [ 0,0.4,0]).slice(0,3), 0],
      params4: [...(p.b2 || [ 0.3,0,0]).slice(0,3), 0],
    }),
    uniformLayout: {
      radius:'u_selParams.x',
      b0x:'u_selParams2.x', b0y:'u_selParams2.y', b0z:'u_selParams2.z',
      b1x:'u_selParams3.x', b1y:'u_selParams3.y', b1z:'u_selParams3.z',
      b2x:'u_selParams4.x', b2y:'u_selParams4.y', b2z:'u_selParams4.z',
    },
  },
  plane: {
    label: 'Plane', icon: '━',
    outputKind: 'dist',
    defaults: { offset:0 },
    params: [{ key:'offset', label:'Offset', type:'number', step:0.05 }],
    glslDeps: ['sdPlane'],
    emit: (pe, q) => ({ dExpr: `sdPlane(${q},vec4(0.,1.,0.,${pe('offset')}))` }),
    uniformPack: p => ({ params:[p.offset||0, 0, 0, 0] }),
    uniformLayout: { offset:'u_selParams.x' },
  },
};

Object.assign(window, {
  GLSL_LIBRARY, GLSL_BASE_DEPS, buildGlslHeader,
  SHAPE_REGISTRY,
});
