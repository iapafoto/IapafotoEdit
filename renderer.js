'use strict';

// ================================================================
// WEBGL SHADERS (boilerplate + uniforms)
// ================================================================
// GLSL ES 3.00 (WebGL2) — enables the ZERO loop-index trick, bitwise ops,
// and the same dialect Shadertoy uses, so PT_HELPERS_SRC is shared verbatim.
const VERT_SRC = `#version 300 es
in vec2 aPos; void main(){gl_Position=vec4(aPos,0.,1.);}`;

// Fragment shader header — declares the editor-specific uniforms.
// Primitive SDFs + transforms come from compileSDF's `header` output.
const FRAG_HEADER = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec2  u_res;
uniform vec3  u_camPos, u_camFwd, u_camRight, u_camUp;
uniform float u_selMat;
uniform float u_time;
// Selected-node uniforms — live-editing without shader recompile.
uniform vec3  u_selPos;
uniform vec3  u_selRot;
uniform float u_selScale;       // uniform scalar (Phase 2)
uniform vec4  u_selParams;      // first 4 scalar params of selected node
uniform vec4  u_selParams2;     // next 4 (or overflow for modifiers)
uniform vec4  u_selParams3;     // capsule b endpoint / bezier p1
uniform vec4  u_selParams4;     // bezier p2
uniform float u_selK;           // smooth-op blend factor
uniform float u_focusDist;      // DOF focus plane distance
uniform float u_focalLen;       // effective focal length (zoom)
uniform float u_aperture;       // lens radius (0 = pinhole)
`;

// u_frame is a float (used as a weight in accumulation); cast to int for
// ZERO so the driver keeps the loop rolled — big compile-time win on
// complex SDFs. Any use-site including PT_HELPERS_SRC must define ZERO.
const FRAG_PT_EXTRA = `uniform sampler2D u_accum;
uniform float u_frame;
#define ZERO (int(min(u_frame,0.0)))
`;

// Path tracer helpers. Shared verbatim with exporter.js (Shadertoy target),
// so no renderer-specific uniforms here. ZERO must be defined upstream.
// Assumes sceneMap/shapeCol/shapeMat are in scope.
const PT_HELPERS_SRC = `
float seed_;
float ptHash(){ seed_=fract(sin(seed_*12.9898+78.233)*43758.5453); return seed_; }

vec3 envMap(vec3 rd){
    float t=clamp(rd.y*.5+.5,0.,1.);
    vec3 sky=mix(vec3(.15,.22,.45),vec3(.55,.65,.90),t);
    sky=mix(vec3(.85,.55,.30),sky,smoothstep(-.15,.05,rd.y));
    vec3 sunDir=normalize(vec3(1.4,2.2,1.1));
    float sun=pow(max(0.,dot(rd,sunDir)),256.);
    return sky+vec3(1.5,1.3,.9)*sun*6.;
}

// Tetrahedron normal. Loop-form uses ZERO so the driver won't unroll —
// saves compile time on complex SDFs. Requires GLSL ES 3.00 (bitshifts + ZERO).
vec3 calcNormal(vec3 p){
    vec3 n = vec3(0);
    for(int i=ZERO; i<4; i++) {
        vec3 e = .5773*(2.*vec3((((i+3)>>1)&1),((i>>1)&1),(i&1))-1.);
        n += e*sceneMap(p+.001*e).x;
    }
    return normalize(n);
}

vec2 trace(vec3 ro,vec3 rd){
    float t=.01;
    for(int i=ZERO;i<240;i++){
        vec2 s=sceneMap(ro+rd*t);
        if(s.x<.001) return vec2(t,s.y);
        if(t>30.) break;
        t+=s.x;
    }
    return vec2(-1.,-1.);
}

float calcAO(vec3 pos,vec3 nor){
    float occ=0.,sca=1.;
    for(int i=ZERO;i<5;i++){
        float h=.01+.12*float(i)/4.;
        float d=sceneMap(pos+h*nor).x;
        occ+=(h-d)*sca; sca*=.95;
    }
    return clamp(1.-3.*occ,0.,1.);
}

float softShadow(vec3 ro,vec3 rd,float mint,float tmax){
    float res=1.,t=mint;
    for(int i=ZERO;i<16;i++){
        float h=sceneMap(ro+rd*t).x;
        res=min(res,8.*h/t);
        t+=clamp(h,.02,.1);
        if(h<.001||t>tmax) break;
    }
    return clamp(res,0.,1.);
}

vec3 doLighting(vec3 col,vec4 mat,vec3 pos,vec3 nor,vec3 rd){
    vec3 lig=normalize(vec3(1.4,2.2,1.1));
    float dif=clamp(dot(nor,lig),0.,1.);
    float sha=softShadow(pos+nor*1e-3,lig,.01,4.);
    float ao=calcAO(pos,nor);
    float amb=.35+.15*nor.y;
    float spe=pow(max(0.,dot(reflect(rd,nor),lig)),mat.w);
    vec3 ambCol=mix(vec3(.25,.32,.45),vec3(.48,.50,.55),nor.y*.5+.5);
    return col*(ambCol*amb*ao + vec3(1.,.95,.85)*dif*sha*ao)
         + vec3(1.,.95,.85)*spe*mat.z*sha*ao;
}

vec3 gaussianReflect(vec3 r, vec3 n, float k){
    float a=6.28318530718*ptHash();
    r=reflect(r,n);
    n=normalize(vec3(-r.z,0.,r.x));
    return normalize(r + k*sqrt(-2.*log(max(ptHash(),1e-6))) * (cos(a)*n + sin(a)*cross(r,n)));
}
`;

const PT_MAIN_SRC = `
void main(){
    seed_=dot(gl_FragCoord.xy,vec2(12.9898,78.233))+u_frame*1.1973+u_time*.013;
    seed_=fract(sin(seed_)*43758.5453);
    vec2 uv=(gl_FragCoord.xy-u_res*.5)/u_res.y;
    uv+=(vec2(ptHash(),ptHash())-.5)/u_res.y;
    vec3 ro=u_camPos;
    // Build ray with configurable focal length (zoom).
    vec3 rd=normalize(u_camFwd*u_focalLen + uv.x*u_camRight + uv.y*u_camUp);
    // Aperture bokeh: jitter origin on the lens, re-aim at the focus point.
    if(u_aperture>0.){
        float a=6.28318530718*ptHash();
        vec2 lens=u_aperture*sqrt(ptHash())*vec2(cos(a),sin(a));
        vec3 focus=ro+rd*u_focusDist;
        ro+=lens.x*u_camRight + lens.y*u_camUp;
        rd=normalize(focus-ro);
    }

    vec3 ctot=vec3(0.);
    float refContrib=1.;
    float firstHitMat=-1.;

    for(int i=ZERO;i<BOUNCE;i++){
        vec2 hit=trace(ro,rd);
        if(i==0) firstHitMat=hit.y;
        if(hit.x<0.){
            ctot=mix(ctot,envMap(rd),refContrib);
            break;
        }
        vec3 pos=ro+rd*hit.x;
        vec3 nor=calcNormal(pos);
        vec3 col=shapeCol(hit.y);
        vec4 mat=shapeMat(hit.y);
        vec3 sceneCol=doLighting(col,mat,pos,nor,rd);
        ctot=mix(ctot,clamp(sceneCol,0.,4.),refContrib);
        refContrib*=mat.x;
        if(refContrib<.005) break;
        rd=gaussianReflect(rd,nor,mat.y);
        ro=pos+nor*2e-3;
        if(dot(rd,nor)<=0.) break;
    }

    // Gold-tint the selected shape (u_selMat holds its material index).
    if(firstHitMat>=0. && u_selMat>=0. && abs(firstHitMat-u_selMat)<.5){
        ctot=mix(ctot, ctot*.5+vec3(1.,.85,.25)*.5, .35);
    }
    vec3 prev=texture(u_accum, gl_FragCoord.xy/u_res).rgb;
    float a=1./(u_frame+1.);
    fragColor=vec4(mix(prev,ctot,a),1.);
}`;

const PRESENT_FRAG_SRC = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform sampler2D u_tex;
uniform vec2  u_res;
void main(){
    vec2 uv=gl_FragCoord.xy/u_res;
    vec3 col=texture(u_tex,uv).rgb;
    vec2 q=uv-.5;
    col*=1.-dot(q,q)*.6;
    col=pow(clamp(col,0.,1.),vec3(.4545));
    fragColor=vec4(col,1.);
}`;

// ================================================================
// WEBGL RENDERER
// ================================================================
// Two-pass ping-pong: trace → progressive float FBO; present → gamma+vignette.
class SDFRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
    if (!this.gl) throw new Error('WebGL2 not supported');
    this._progTrace   = null;
    this._progPresent = null;
    this._buf = null;
    this._initQuad();
    this._initFloatFormat();
    this._animId = null;
    this._onFrame = null;
    this.camera = { theta: 0.6, phi: 0.35, distance: 3.2 };
    this.selMat = -1;
    this.selectedId = null;
    this.selData = null;
    this.selType = null;  // cached to pick the right registry entry for uniformPack
    this.palette = DEFAULT_PALETTE;
    this._matCount = 0;
    this._matColArr = null; // Float32Array(3*N) → u_matCol[]
    this._matMatArr = null; // Float32Array(4*N) → u_matMat[]
    this.bounces   = 2;
    this.cameraParams = { focusDistance: 3.2, focalLen: 1.0, aperture: 0.0 };
    this.maxAccum  = 1024;
    this._lastTree = null;
    this._accumFrame = 0;
    this._fboA = null; this._fboB = null;
    this._fboW = 0;    this._fboH = 0;
    this._lastStateSig = '';
    this._compilePresent();
    this._compileScene({ id:'root', type:'union', children:[], params:{} }, DEFAULT_PALETTE);
    this._startLoop();
  }

  _initFloatFormat() {
    const gl = this.gl;
    // WebGL2: EXT_color_buffer_float enables RGBA32F render targets
    // (and implicitly RGBA16F). Fall back to half, then to byte.
    if (gl.getExtension('EXT_color_buffer_float')) {
      this._texInternal = gl.RGBA32F;
      this._texType = gl.FLOAT;
      this._texKind = 'float'; return;
    }
    if (gl.getExtension('EXT_color_buffer_half_float')) {
      this._texInternal = gl.RGBA16F;
      this._texType = gl.HALF_FLOAT;
      this._texKind = 'half'; return;
    }
    this._texInternal = gl.RGBA;
    this._texType = gl.UNSIGNED_BYTE;
    this._texKind = 'byte';
    console.warn('[SDF] Float color buffer unavailable — accumulation will band in RGBA8 mode.');
  }

  setSelection(node) {
    if (node) {
      this.selectedId = node.id;
      this.selData = { ...node };
      this.selType = node.type;
    } else {
      this.selectedId = null;
      this.selData = null;
      this.selType = null;
    }
  }

  updateSelectedData(node) {
    if (node && this.selectedId === node.id) {
      this.selData = { ...node };
      this.selType = node.type;
    }
  }

  // Pack selected-node params into u_selParams / u_selParams2 / _3 / _4.
  // Shapes: registry uniformPack. Modifiers: inline packing.
  _packSelUniforms(node) {
    const out = { params:[0,0,0,0], params2:[0,0,0,0], params3:[0,0,0,0], params4:[0,0,0,0] };
    const p = node.params || {};
    if (SHAPE_TYPES.includes(node.type)) {
      const reg = SHAPE_REGISTRY[node.type];
      if (reg && reg.uniformPack) {
        const packed = reg.uniformPack(p) || {};
        if (packed.params)  out.params  = packed.params;
        if (packed.params2) out.params2 = packed.params2;
        if (packed.params3) out.params3 = packed.params3;
        if (packed.params4) out.params4 = packed.params4;
      }
    } else if (node.type === 'mirror') {
      out.params  = [p.x?1:0, p.y?1:0, p.z?1:0, Math.max(0, p.eps||0)];
    } else if (node.type === 'repeat') {
      out.params  = [p.sx||1, p.sy||1, p.sz||1, 0];
      out.params2 = [Math.max(0,Math.floor(p.nx||0)), Math.max(0,Math.floor(p.ny||0)), Math.max(0,Math.floor(p.nz||0)), 0];
    } else if (node.type === 'repeat_angular') {
      const count = Math.max(1, p.count||6);
      const reps  = Math.max(0, Math.floor(p.reps||0));
      const clamped = reps > 0 && reps < count;
      const nMin = clamped ? -Math.floor(reps/2)   : -999;
      const nMax = clamped ?  Math.ceil(reps/2) - 1 :  999;
      out.params  = [count, nMin, nMax, 0];
    }
    return out;
  }

  _initQuad() {
    const gl = this.gl;
    this._buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
  }

  _buildShader(vsrc, fsrc) {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsrc); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) { console.error('VS:', gl.getShaderInfoLog(vs)); return null; }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('FS:', gl.getShaderInfoLog(fs)); return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { console.error('Link:', gl.getProgramInfoLog(prog)); return null; }
    return prog;
  }

  _compilePresent() {
    const prog = this._buildShader(VERT_SRC, PRESENT_FRAG_SRC);
    if (prog) this._progPresent = prog;
  }

  // Pack material list (deduplicated) → Float32Arrays uploaded each frame.
  _packMaterials(materials) {
    const N = materials.length;
    const cols = new Float32Array(N * 3);
    const mats = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      const m = materials[i];
      cols[i*3  ] = m.color[0];
      cols[i*3+1] = m.color[1];
      cols[i*3+2] = m.color[2];
      mats[i*4  ] = m.refl;
      mats[i*4+1] = m.rough;
      mats[i*4+2] = m.spec;
      mats[i*4+3] = m.specPow;
    }
    return { cols, mats };
  }

  // Fast path: no shader recompile. If the deduplicated material count
  // stayed the same, just push new arrays; otherwise fall back to recompile.
  updateMaterials(tree, palette) {
    const pal = (palette && palette.length) ? palette : DEFAULT_PALETTE;
    this.palette = pal;
    const { materials } = resolveUsedMaterials(tree, pal);
    if (materials.length !== this._matCount) {
      this._compileScene(tree, pal);
      return;
    }
    const { cols, mats } = this._packMaterials(materials);
    this._matColArr = cols;
    this._matMatArr = mats;
    this.resetAccum();
  }

  _compileScene(tree, palette) {
    this._lastTree = tree;
    const pal = (palette && palette.length) ? palette : DEFAULT_PALETTE;
    this.palette = pal;
    const { sceneFn, colorFn, matFn, header, extraFns, usedMaterials } =
      compileSDF(tree, this.selectedId, pal, { materialUniforms: true });
    this._matCount = usedMaterials.length;
    const { cols, mats } = this._packMaterials(usedMaterials);
    this._matColArr = cols;
    this._matMatArr = mats;
    const defs = `#define BOUNCE ${this.bounces}\n`;
    const fsrc = FRAG_HEADER + FRAG_PT_EXTRA + defs
               + header + '\n'
               + extraFns + '\n'
               + colorFn + '\n' + matFn + '\n' + sceneFn + '\n'
               + PT_HELPERS_SRC + '\n' + PT_MAIN_SRC;
    const newProg = this._buildShader(VERT_SRC, fsrc);
    if (newProg) {
      if (this._progTrace) this.gl.deleteProgram(this._progTrace);
      this._progTrace = newProg;
    } else {
      console.warn('[SDF] Shader compile failed — keeping previous program.\nSource:\n', fsrc);
    }
    this.resetAccum();
    return { usedMaterials };
  }

  updateScene(tree, palette) { return this._compileScene(tree, palette || this.palette); }

  setBounces(n) {
    const v = Math.max(1, Math.min(5, Math.round(n)));
    if (v === this.bounces) return;
    this.bounces = v;
    if (this._lastTree) this._compileScene(this._lastTree, this.palette);
    this.resetAccum();
  }

  resetAccum() { this._accumFrame = 0; }

  setCameraParams(p) {
    if (!p) return;
    const fd = Math.max(0.01, +p.focusDistance || this.cameraParams.focusDistance);
    const fl = Math.max(0.05, +p.focalLen      || this.cameraParams.focalLen);
    const ap = Math.max(0,    +p.aperture      || 0);
    if (fd === this.cameraParams.focusDistance &&
        fl === this.cameraParams.focalLen &&
        ap === this.cameraParams.aperture) return;
    this.cameraParams = { focusDistance: fd, focalLen: fl, aperture: ap };
    this.resetAccum();
  }

  _stateSig() {
    const c = this.camera, d = this.selData, p = this.cameraParams;
    const ds = d ? JSON.stringify([d.position, d.rotation, d.scale, d.params, d.type]) : '';
    return `${c.theta}|${c.phi}|${c.distance}|${this.selMat}|${this.selectedId||''}|${ds}|${this.bounces}|${p.focusDistance}|${p.focalLen}|${p.aperture}`;
  }

  _createFBO(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, this._texInternal, w, h, 0, gl.RGBA, this._texType, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
      if (this._texKind !== 'byte') {
        console.warn(`[SDF] ${this._texKind} FBO incomplete, falling back.`);
        this._texInternal = gl.RGBA;
        this._texType = gl.UNSIGNED_BYTE;
        this._texKind = 'byte';
        return this._createFBO(w, h);
      }
      throw new Error('FBO allocation failed');
    }
    gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  _resizeFBOs(w, h) {
    if (w === this._fboW && h === this._fboH && this._fboA && this._fboB) return;
    const gl = this.gl;
    if (this._fboA) { gl.deleteFramebuffer(this._fboA.fbo); gl.deleteTexture(this._fboA.tex); }
    if (this._fboB) { gl.deleteFramebuffer(this._fboB.fbo); gl.deleteTexture(this._fboB.tex); }
    this._fboA = this._createFBO(w, h);
    this._fboB = this._createFBO(w, h);
    this._fboW = w; this._fboH = h;
    this.resetAccum();
  }

  _drawQuad(prog) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._buf);
    const aPos = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  _bindSceneUniforms(prog, w, h) {
    const gl = this.gl;
    const { eye, fwd, right, up } = this.getCamVecs();
    const u = (n, fn, ...v) => { const l = gl.getUniformLocation(prog,n); if(l!==null) gl[fn](l,...v); };
    u('u_res','uniform2f',w,h);
    u('u_camPos','uniform3fv',eye);
    u('u_camFwd','uniform3fv',fwd);
    u('u_camRight','uniform3fv',right);
    u('u_camUp','uniform3fv',up);
    u('u_selMat','uniform1f',this.selMat);
    u('u_time','uniform1f',performance.now()/1000);
    const cp = this.cameraParams;
    u('u_focusDist','uniform1f', cp.focusDistance);
    u('u_focalLen','uniform1f',  cp.focalLen);
    u('u_aperture','uniform1f',  cp.aperture);
    if (this._matCount > 0 && this._matColArr && this._matMatArr) {
      const lc = gl.getUniformLocation(prog, 'u_matCol[0]');
      if (lc !== null) gl.uniform3fv(lc, this._matColArr);
      const lm = gl.getUniformLocation(prog, 'u_matMat[0]');
      if (lm !== null) gl.uniform4fv(lm, this._matMatArr);
    }
    if (this.selData) {
      const d = this.selData;
      u('u_selPos','uniform3fv', d.position||[0,0,0]);
      u('u_selRot','uniform3fv', d.rotation||[0,0,0]);
      u('u_selScale','uniform1f', (typeof d.scale === 'number') ? d.scale : 1);
      if (SHAPE_TYPES.includes(d.type) || MODIFIER_TYPES.includes(d.type)) {
        const packed = this._packSelUniforms(d);
        u('u_selParams', 'uniform4fv', packed.params);
        u('u_selParams2','uniform4fv', packed.params2);
        u('u_selParams3','uniform4fv', packed.params3);
        u('u_selParams4','uniform4fv', packed.params4);
      }
      if (d.type && OP_TYPES.includes(d.type)) {
        u('u_selK','uniform1f', (d.params && d.params.k) || 0);
      }
    }
  }

  getCamVecs() {
    const { theta, phi, distance } = this.camera;
    const x = distance * Math.cos(phi) * Math.sin(theta);
    const y = distance * Math.sin(phi);
    const z = distance * Math.cos(phi) * Math.cos(theta);
    const eye = [x, y, z];
    const fwd = normalize3([-x, -y, -z]);
    const right = normalize3(cross3(fwd, [0, 1, 0]));
    const up = cross3(right, fwd);
    return { eye, fwd, right, up };
  }

  projectToScreen(p, w, h) {
    const { eye, fwd, right, up } = this.getCamVecs();
    const fL = this.cameraParams.focalLen || 1;
    const v = sub3(p, eye);
    const vf = dot3(v, fwd);
    if (vf <= 0.01) return null;
    const vr = dot3(v, right);
    const vu = dot3(v, up);
    return { x: vr/vf * h * fL + w/2, y: h/2 - vu/vf * h * fL, depth: vf };
  }

  render() {
    const gl = this.gl;
    if (!this._progTrace || !this._progPresent) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(this.canvas.clientWidth * dpr);
    const h = Math.floor(this.canvas.clientHeight * dpr);
    if (w <= 0 || h <= 0) return;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
    this._resizeFBOs(w, h);

    const sig = this._stateSig();
    if (sig !== this._lastStateSig) { this.resetAccum(); this._lastStateSig = sig; }

    if (this._accumFrame < this.maxAccum && this._fboA && this._fboB) {
      const writeToA = (this._accumFrame % 2) === 0;
      const writeFBO = writeToA ? this._fboA : this._fboB;
      const readTex  = writeToA ? this._fboB.tex : this._fboA.tex;
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO.fbo);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this._progTrace);
      this._bindSceneUniforms(this._progTrace, w, h);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      const ul = n => gl.getUniformLocation(this._progTrace, n);
      gl.uniform1i(ul('u_accum'), 0);
      gl.uniform1f(ul('u_frame'), this._accumFrame);
      this._drawQuad(this._progTrace);
      this._accumFrame++;
    }

    const presentFBO = (this._accumFrame === 0)
        ? this._fboA
        : (((this._accumFrame - 1) % 2) === 0 ? this._fboA : this._fboB);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this._progPresent);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, presentFBO.tex);
    const upl = n => gl.getUniformLocation(this._progPresent, n);
    gl.uniform1i(upl('u_tex'), 0);
    gl.uniform2f(upl('u_res'), w, h);
    this._drawQuad(this._progPresent);

    if (this._onFrame) this._onFrame();
  }

  _startLoop() {
    const loop = () => { this.render(); this._animId = requestAnimationFrame(loop); };
    this._animId = requestAnimationFrame(loop);
  }

  destroy() {
    if (this._animId) cancelAnimationFrame(this._animId);
    const gl = this.gl;
    if (this._fboA) { gl.deleteFramebuffer(this._fboA.fbo); gl.deleteTexture(this._fboA.tex); }
    if (this._fboB) { gl.deleteFramebuffer(this._fboB.fbo); gl.deleteTexture(this._fboB.tex); }
    if (this._progTrace)   gl.deleteProgram(this._progTrace);
    if (this._progPresent) gl.deleteProgram(this._progPresent);
    if (this._buf)         gl.deleteBuffer(this._buf);
  }
}

Object.assign(window, {
  SDFRenderer,
  FRAG_HEADER, FRAG_PT_EXTRA, PT_HELPERS_SRC, PT_MAIN_SRC, VERT_SRC,
});
