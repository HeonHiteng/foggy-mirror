// GLSL for the fog simulation (state texture: R = condensation density, G = "dryness" of wiped water rims)
// and the final mirror composite.

const NOISE = /* glsl */ `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s / 0.9375; }
float fbm2(vec2 p){ return (vnoise(p) * 0.667 + vnoise(p * 2.03 + 17.1) * 0.333); }
`

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const COPY_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv; out vec4 o;
void main(){ o = texture(uTex, vUv); }
`

export const SIM_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform vec2 uRes;        // css px
uniform float uDt;        // seconds this frame
uniform float uDecayDt;   // evaporation time step (batched on 8-bit fallback)
uniform float uTime;
uniform vec3 uMouth;      // breath centre (css px) + radius
uniform float uBreath;    // 0..1 breath strength
uniform float uSeed;
uniform float uFill;      // one-shot uniform fog
uniform float uClear;     // extra evaporation per second
in vec2 vUv; out vec4 o;
${NOISE}
void main(){
  vec4 s = texture(uState, vUv);
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  float R = s.r;
  float dry = s.g;

  // Natural evaporation: thin fog goes first, edges retreat irregularly.
  float n = fbm2(p / 240.0 + vec2(uTime * 0.012, 3.7));
  R -= uDecayDt * (0.008 + 0.03 * R) * (0.3 + 1.4 * n);
  R -= uDt * uClear;
  dry = min(1.0, dry + uDecayDt * 0.025);

  // Warm breath condensing on cold glass: irregular, grainy blob that grows from the mouth.
  if (uBreath > 0.0) {
    float rad = uMouth.z;
    vec2 c = uMouth.xy - vec2(0.0, rad * 0.1);
    vec2 q = (p - c) * vec2(0.9, 1.1);
    float d = length(q) / rad;
    float wob = fbm(p / (rad * 0.42) + uSeed) - 0.5;
    float wob2 = fbm2(p / (rad * 0.13) + uSeed * 2.3) - 0.5;
    float edge = d + wob * 0.75 + wob2 * 0.22;
    float prof = 1.0 - smoothstep(0.25, 1.0, edge);
    float core = exp(-d * d * 5.0);
    float grain = 0.55 + 0.9 * fbm2(p / 22.0 + uSeed * 1.7);
    float add = uBreath * uDt * (prof * 0.6 + core * 1.3) * grain;
    R += add;
    dry = min(1.0, dry + add * 3.0);
  }
  if (uFill > 0.0) { R += uFill * (0.7 + 0.6 * fbm(p / 170.0 + 9.0)); dry = 1.0; }
  o = vec4(clamp(R, 0.0, 1.5), dry, 0.0, 1.0);
}
`

// Finger wipes are rendered as capsule quads with MIN blending:
// R -> 0 inside the stroke (crisp), G (dryness) -> low on the water rim just outside it.
export const WIPE_VS = /* glsl */ `#version 300 es
in vec2 aPos;   // css px
in vec4 aSeg;   // segment endpoints, css px
uniform vec2 uRes;
out vec4 vSeg;
void main(){
  vSeg = aSeg;
  vec2 ndc = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
}
`

export const WIPE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform float uHalfW;
uniform float uDpr;
uniform float uCanvasH; // device px
in vec4 vSeg; out vec4 o;
void main(){
  vec2 p = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uDpr;
  vec2 a = vSeg.xy, b = vSeg.zw;
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  float d = length(pa - ba * h);
  float core = smoothstep(uHalfW - 0.7, uHalfW + 0.5, d);
  float rd = d - uHalfW - 2.0;
  float rim = exp(-rd * rd / 6.0);
  o = vec4(core * 1.5, 1.0 - rim * 0.95, 9.0, 9.0);
}
`

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform sampler2D uVideo;
uniform vec2 uRes;
uniform vec2 uStateTexel;
uniform float uTime;
uniform vec4 uVRect;      // cover-fit rect of the reflection, css px
uniform float uMirror;
uniform float uHalfW;
uniform vec4 uCursor;     // x, y, radius, alpha
uniform float uCursorDraw;
uniform float uReveal;    // intro fade-in
in vec2 vUv; out vec4 o;
${NOISE}

vec2 vuv(vec2 p){
  float nx = (p.x - uVRect.x) / uVRect.z;
  if (uMirror > 0.5) nx = 1.0 - nx;
  return vec2(nx, (p.y - uVRect.y) / uVRect.w);
}
vec3 grade(vec3 c){
  // a real mirror: slightly darker, faintly cool-green glass tint
  c = pow(c, vec3(1.06)) * vec3(0.95, 0.975, 0.985);
  return c;
}
vec3 sharpAt(vec2 p){ return grade(texture(uVideo, vuv(p)).rgb); }
vec3 blurAt(vec2 p){
  vec3 s = textureLod(uVideo, vuv(p), 4.6).rgb * 2.0;
  s += textureLod(uVideo, vuv(p + vec2(15.0, 6.0)), 3.8).rgb;
  s += textureLod(uVideo, vuv(p + vec2(-6.0, 15.0)), 3.8).rgb;
  s += textureLod(uVideo, vuv(p + vec2(-15.0, -6.0)), 3.8).rgb;
  s += textureLod(uVideo, vuv(p + vec2(6.0, -15.0)), 3.8).rgb;
  return grade(s / 6.0);
}

// Droplet field: one bead per grid cell, kept inside its cell so only one cell is evaluated per pixel.
// Returns normalized offset inside the drop (xy), coverage*alpha (z), radius px (w).
vec4 drops(vec2 p, float cell, float prob, float rmin, float rmax, float seed){
  vec2 c = floor(p / cell);
  if (hash12(c * 1.37 + seed) > prob) return vec4(0.0);
  vec2 h = hash22(c + seed);
  float r = mix(rmin, rmax, pow(hash12(c + seed * 2.1), 2.2)) * cell;
  vec2 ctr = (c + 0.5) * cell + (h - 0.5) * (cell - 2.0 * r);
  vec2 d = (p - ctr) / r;
  float m = smoothstep(1.0, 0.8, length(d));
  return vec4(d, m * (0.45 + 0.55 * hash12(c - seed)), r);
}

vec3 shadeDrop(vec3 under, vec3 refr, vec4 dp, float lightAmt){
  vec2 d = dp.xy; float l = length(d);
  vec3 c = mix(under, refr, 0.75);
  c *= 1.0 - 0.3 * smoothstep(0.45, 1.0, l);                         // refractive dark rim
  float spec = exp(-dot(d - vec2(-0.32, -0.38), d - vec2(-0.32, -0.38)) * 22.0);
  float caus = exp(-((d.y - 0.5) * (d.y - 0.5) * 28.0 + d.x * d.x * 7.0));
  return c + vec3(1.0) * spec * (0.55 + 0.45 * lightAmt) + vec3(0.9, 0.95, 1.0) * caus * 0.22;
}

void main(){
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRes;
  vec2 sp = p / uRes;

  vec4 st = texture(uState, vUv);
  float R = st.r;

  // soft diffused light from the upper left (window), and gentle top fill
  float light = smoothstep(1.35, 0.0, length((sp - vec2(0.18, -0.08)) * vec2(1.0, 1.25)));
  light = 0.35 + 0.65 * light;

  vec3 sharp = sharpAt(p);
  vec3 col = sharp;

  float dv = R * (0.8 + 0.4 * fbm2(p / 140.0 + 2.0)) * (0.9 + 0.2 * vnoise(p / 2.5));
  float cover = min(1.0 - exp(-2.3 * dv), 0.87);

  if (dv > 0.002) {
    vec3 blur = blurAt(p);
    vec3 fogShadow = vec3(0.66, 0.71, 0.77);   // blue-grey
    vec3 fogLit = vec3(0.92, 0.94, 0.96);      // milky white
    vec3 fogCol = mix(fogShadow, fogLit, light);
    vec3 base = mix(sharp, blur * 1.04 + 0.02, smoothstep(0.0, 0.22, dv));
    col = mix(base, fogCol + (blur - 0.45) * 0.16, cover);

    // micro condensation: thousands of tiny beads
    vec4 t1 = drops(p, 3.4, 0.75, 0.22, 0.46, 3.1);
    float a1 = t1.z * smoothstep(0.05, 0.6, dv);
    if (a1 > 0.0) col = mix(col, shadeDrop(col * 0.93, col * 1.04, t1, light * 0.6), a1 * 0.4);

    // larger beads where condensation is dense
    vec4 t2 = drops(p, 11.0, 0.22, 0.14, 0.42, 7.7);
    float a2 = t2.z * smoothstep(0.45, 1.1, dv);
    if (a2 > 0.0) col = mix(col, shadeDrop(col * 0.88, mix(sharpAt(p - t2.xy * t2.w * 2.4), col, 0.45), t2, light), a2 * 0.75);
  }

  // wet rim beside wiped strokes (only where there was fog around it)
  float rimW = 1.0 - st.g;
  if (rimW > 0.01) {
    float nR = 0.0;
    float rr = uHalfW * 2.6;
    for (int i = 0; i < 6; i++) {
      float a = float(i) * 1.0472;
      nR += texture(uState, vUv + vec2(cos(a), -sin(a)) * rr * uStateTexel).r;
    }
    nR /= 6.0;
    float rim = rimW * smoothstep(0.06, 0.45, nR);
    vec3 fogCol = mix(vec3(0.7, 0.75, 0.8), vec3(0.95, 0.96, 0.98), light);
    col = mix(col, fogCol, rim * 0.28 * smoothstep(0.02, 0.5, R + 0.3));
    vec4 t3 = drops(p, 5.5, 0.6, 0.22, 0.46, 13.3);
    float a3 = t3.z * rim;
    if (a3 > 0.0) col = mix(col, shadeDrop(col * 0.9, mix(sharpAt(p - t3.xy * t3.w * 2.6), col, 0.3), t3, light), a3 * 0.85);
  }

  // glass: faint diagonal sheen, diffused light, vignette
  float sheen = pow(max(0.0, sin((sp.x * 1.1 + sp.y * 0.55) * 3.3 - 0.8)), 6.0);
  col += vec3(1.0) * sheen * 0.025;
  col += vec3(1.0, 0.98, 0.95) * 0.045 * light;
  float v = length((sp - vec2(0.5, 0.48)) * vec2(1.05, 1.0));
  col *= 1.0 - 0.42 * smoothstep(0.35, 0.85, v);

  // fingertip indicator
  if (uCursor.w > 0.0) {
    float cd = length(p - uCursor.xy);
    float ring = smoothstep(1.4, 0.0, abs(cd - uCursor.z)) * uCursor.w;
    float dot_ = smoothstep(2.4, 1.0, cd) * uCursor.w;
    float fill = smoothstep(uCursor.z, uCursor.z - 1.5, cd) * uCursorDraw * uCursor.w;
    col = mix(col, vec3(1.0), ring * 0.7 + dot_ * 0.85 + fill * 0.08);
  }

  col *= uReveal;
  o = vec4(col, 1.0);
}
`

// Lip print: a kiss pressed into the fog. Rendered full-screen with MIN blending (discarding outside the lips).
// Local units: x in [-1, 1] across the mouth, y down. Contact is imperfect: vertical lip creases and
// patchy pressure leave a little condensation behind, like a real print on steamed glass.
export const LIP_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 uCenter;   // css px
uniform float uSize;    // half mouth width, css px
uniform float uAngle;   // head roll, radians
uniform float uSeed;
uniform float uDpr;
uniform float uCanvasH;
out vec4 o;
${NOISE}
float upperTop(float x){
  float ax = abs(x);
  float t = -0.40 * pow(max(0.0, 1.0 - x * x), 0.75);
  t -= 0.07 * exp(-pow((ax - 0.28) / 0.14, 2.0)); // cupid's bow peaks
  t += 0.09 * exp(-pow(x / 0.09, 2.0));           // centre dip
  return t;
}
float mouthLine(float x){ return 0.03 + 0.05 * x * x - 0.04 * exp(-pow(x / 0.25, 2.0)); }
float lowerBot(float x){ return 0.46 * pow(max(0.0, 1.0 - x * x), 0.6); }
void main(){
  vec2 p = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y) / uDpr - uCenter;
  float c = cos(-uAngle), s = sin(-uAngle);
  vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) / uSize;
  if (abs(q.x) > 1.1 || abs(q.y) > 0.75) discard;
  float x = q.x, y = q.y;
  float gap = 0.035;
  float up = min(y - upperTop(x), mouthLine(x) - gap - y);
  float lo = min(y - (mouthLine(x) + gap), lowerBot(x) - y);
  float d = max(up, lo);                      // >0 inside a lip
  float cov = smoothstep(0.0, 0.03, d);
  float wav = vnoise(q * vec2(5.0, 18.0) + uSeed) * 3.0;
  float creases = smoothstep(0.72, 1.0, 0.5 + 0.5 * sin(x * 58.0 + wav));
  float pressure = smoothstep(0.0, 0.14, d);
  float patchy = smoothstep(0.6, 0.9, vnoise(q * 7.0 + uSeed * 1.3));
  float residual = creases * 0.6 + (1.0 - pressure) * 0.3 + patchy * 0.3;
  float R = mix(1.5, residual, cov);
  float rd = d + 0.025;
  float rim = exp(-rd * rd / 0.0012) * (1.0 - cov);
  if (cov <= 0.0 && rim < 0.01) discard;
  o = vec4(R, 1.0 - rim * 0.9, 9.0, 9.0);
}
`
