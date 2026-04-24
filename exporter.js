'use strict';

// ================================================================
// SHADERTOY PATH-TRACED EXPORT (multi-pass)
// ================================================================
// Emits Buffer A (accumulating path tracer) + Image (gamma+vignette).
// Buffer A self-feedbacks via iChannel0 → Buffer A.
//
// The compiler is invoked with no selectedId and materialUniforms=false,
// so everything is baked as literals — no uniforms to wire in Shadertoy.
function exportShadertoyPathTraced(tree, palette, bounces=2) {
  const { sceneFn, colorFn, matFn, header, extraFns } =
    compileSDF(tree, null, palette, { materialUniforms: false });
  const B = Math.max(1, Math.min(5, Math.round(bounces)));

  const bufferA = `// ============================================================
// BUFFER A — progressive path tracer
// Set iChannel0 = Buffer A (self-feedback)
// ============================================================
#define BOUNCE ${B}
// Shadertoy's iFrame is int → ZERO stays int, no cast needed.
#define ZERO (min(iFrame,0))

// --- Primitives & transforms ---
${header}

// --- Per-node helpers (profile / pTransform / dTransform) ---
${extraFns || '// (none)'}

// --- Scene ---
${sceneFn}

// --- Materials ---
${colorFn}

${matFn}

// --- PT helpers (shared verbatim with the in-editor renderer) ---
${PT_HELPERS_SRC}

// --- Camera ---
mat3 basisMatrix(vec3 ww){
    vec3 uu=normalize(cross(ww,vec3(0,1,0)));
    vec3 vv=cross(uu,ww);
    return mat3(uu,vv,ww);
}
void camera(inout vec3 ro, inout vec3 rd, float focusDistance, float focalLen, float aperture, vec2 uv){
    vec3 ww=normalize(-ro);
    mat3 cam=basisMatrix(ww);
    rd=normalize(cam*vec3(uv,focalLen));
    // Aperture bokeh: jitter origin on the lens, re-aim at the focus point.
    float a=6.28318530718*ptHash();
    vec2 lens=aperture*sqrt(ptHash())*vec2(cos(a),sin(a));
    vec3 focus=ro+rd*focusDistance;
    ro+=cam*vec3(lens,0.);
    rd=normalize(focus-ro);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
    seed_=dot(fragCoord,vec2(12.9898,78.233))+float(iFrame)*1.1973+iTime*.013;
    seed_=fract(sin(seed_)*43758.5453);

    // Orbit camera — theta/phi from mouse, distance constant.
    vec4 mo=iMouse;
    float th=3.0 - mo.x/iResolution.x * 6.28318;
    float ph=0.35 + (mo.y/iResolution.y - .5) * 2.2;
    ph=clamp(ph,-1.5,1.5);
    float dist=3.2;
    vec3 ro=vec3(dist*cos(ph)*sin(th), dist*sin(ph), dist*cos(ph)*cos(th));

    vec2 uv=(2.*(fragCoord.xy + vec2(ptHash(),ptHash())-.5)-iResolution.xy)/iResolution.y;
    vec3 rd;
    camera(ro, rd, dist, 2.8, .1, uv);

    vec3 ctot=vec3(0.);
    float refContrib=1.;
    for(int i=ZERO;i<BOUNCE;i++){
        vec2 hit=trace(ro,rd);
        if(hit.x<0.){ ctot=mix(ctot,envMap(rd),refContrib); break; }
        vec3 pos=ro+rd*hit.x;
        vec3 nor=calcNormal(pos);
        vec3 col=shapeCol(hit.y);
        vec4 mat=shapeMat(hit.y);
        ctot=mix(ctot,clamp(doLighting(col,mat,pos,nor,rd),0.,4.),refContrib);
        refContrib*=mat.x;
        if(refContrib<.005) break;
        rd=gaussianReflect(rd,nor,mat.y);
        ro=pos+nor*2e-3;
        if(dot(rd,nor)<=0.) break;
    }

    // Weighted accumulation (sum + count-in-alpha). Mouse-down resets.
    vec4 col4=vec4(ctot,1.);
    vec4 lastCol=texelFetch(iChannel0,ivec2(fragCoord),0);
    if (iFrame > 0 && iMouse.z <= 0.) col4 += lastCol;
    fragColor=col4;
}`;

  const imageTab = `// ============================================================
// IMAGE — gamma + vignette
// Set iChannel0 = Buffer A
// ============================================================
void mainImage(out vec4 fragColor, in vec2 fragCoord){
    vec2 uv=fragCoord/iResolution.xy;
    vec4 t=texture(iChannel0,uv);
    vec3 col = t.rgb/max(t.w,1.);
    vec2 q=uv-.5;
    col*=1.-dot(q,q)*.6;
    col=pow(clamp(col,0.,1.),vec3(.4545));
    fragColor=vec4(col,1.);
}`;

  return `// ============================================================
// ============================================================
// >>> BUFFER A <<<    (paste into the "Buf A" tab)
// ============================================================

${bufferA}


// ============================================================
// >>> IMAGE <<<       (paste into the "Image" tab)
// ============================================================

${imageTab}
`;
}

Object.assign(window, { exportShadertoyPathTraced });
