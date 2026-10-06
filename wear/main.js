import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { initTypeWear } from './type-wear.js';

const errEl = document.getElementById('err');
function showErr(msg) {
  console.error(msg);
  errEl.style.display = 'block';
  errEl.textContent = 'The 3D views could not start. Reload the page, or try another browser.';
}
window.addEventListener('error', (e) => showErr(e.message || e.error || e));
window.addEventListener('unhandledrejection', (e) => showErr(e.reason));

let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
try {
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
    reducedMotion = e.matches;
  });
} catch (_) { /* older Safari */ }

const isNarrow = () => window.innerWidth < 700;
const pixelCap = () => {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, isNarrow() ? 1.5 : 2);
};

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  alpha: false,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(pixelCap());
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.setClearColor(0x0c0a08, 1);
renderer.domElement.style.pointerEvents = 'none';

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const envMap = pmrem.fromScene(room, 0.04).texture;
room.dispose?.();
pmrem.dispose();

/* —— Hero stylized post (one canvas, scissor + small RT) —— */
const HERO_RT_SIZE = 320;
function makeHeroPost(accentHex) {
  const accent = new THREE.Color(accentHex);
  const rt = new THREE.WebGLRenderTarget(HERO_RT_SIZE, HERO_RT_SIZE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    type: THREE.UnsignedByteType,
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const uniforms = {
    tDiffuse: { value: rt.texture },
    uAccent: { value: new THREE.Vector3(accent.r, accent.g, accent.b) },
    uLens: { value: new THREE.Vector2(0.62, 0.48) },
    uLensR: { value: 0.2 },
    uCell: { value: 9.0 },
    uScreen: { value: new THREE.Vector2(1, 1) },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(HERO_RT_SIZE, HERO_RT_SIZE) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tDiffuse;
      uniform vec3 uAccent;
      uniform vec2 uLens;
      uniform float uLensR;
      uniform float uCell;
      uniform vec2 uScreen;
      uniform float uTime;
      varying vec2 vUv;

      void main() {
        // Halftone grid in screen pixels; each dot samples the render at its cell centre
        vec2 pix = vUv * uScreen;
        vec2 cellId = floor(pix / uCell);
        vec2 cUv = (cellId + 0.5) * uCell / uScreen;
        vec4 cs = texture2D(tDiffuse, cUv);
        float cover = smoothstep(0.15, 0.6, cs.a);          // object mask (RT alpha)
        float lum = dot(cs.rgb / max(cs.a, 0.001), vec3(0.299, 0.587, 0.114));
        lum = clamp(pow(lum, 0.65) * 1.3 + 0.04, 0.0, 1.0);
        vec2 local = fract(pix / uCell) - 0.5;
        float rad = mix(0.08, 0.56, lum) * cover;           // dot size follows luminance
        float aa = 1.2 / uCell;
        float dotm = 1.0 - smoothstep(rad - aa, rad + aa, length(local));
        dotm *= step(0.001, rad);
        vec3 dotCol = uAccent * (0.5 + 0.8 * lum);

        // Soft lens around the pointer (or a slow drift): true PBR render inside
        vec4 src = texture2D(tDiffuse, vUv);                // premultiplied by coverage
        float minDim = min(uScreen.x, uScreen.y);
        float dl = length((vUv - uLens) * uScreen) / (uLensR * minDim);
        float lens = 1.0 - smoothstep(0.55, 1.0, dl);
        float ring = smoothstep(0.86, 0.97, dl) * (1.0 - smoothstep(0.97, 1.08, dl));
        ring *= smoothstep(0.05, 0.5, src.a) * 0.55;

        vec3 pre = mix(dotCol * dotm, src.rgb, lens) + uAccent * ring;
        float a = clamp(mix(dotm, src.a, lens) + ring, 0.0, 1.0);
        if (a < 0.01) discard;                              // page shows through around the shape
        gl_FragColor = vec4(pre / a, a);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  postScene.add(quad);
  return {
    rt,
    postScene,
    postCam,
    uniforms,
    lens: { x: 0.62, y: 0.48 },
    target: { x: 0.62, y: 0.48 },
    lastPointer: -1e9,
    dragging: false,
  };
}

// —— Small helpers ——
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function hashI(i, j, s) {
  let n = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(s, 982451653)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}
// Tileable value noise with integer period P
function pnoise(x, y, P, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (v) => ((v % P) + P) % P;
  const a = hashI(w(xi), w(yi), s), b = hashI(w(xi + 1), w(yi), s);
  const c = hashI(w(xi), w(yi + 1), s), d = hashI(w(xi + 1), w(yi + 1), s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function pfbm(u, v, P, oct, s) {
  let sum = 0, amp = 0.5, norm = 0, p = P;
  for (let o = 0; o < oct; o++) { sum += amp * pnoise(u * p, v * p, p, s + o); norm += amp; amp *= 0.5; p *= 2; }
  return sum / norm;
}

function contactShadow(scene, y, sx, sz, strength = 0.55) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  grd.addColorStop(0, `rgba(0,0,0,${strength})`);
  grd.addColorStop(0.55, `rgba(0,0,0,${strength * 0.45})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(sx, sz),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = y + 0.002;
  scene.add(m);
  return m;
}

// —— Wear shader (paint → primer → bare steel, AO dirt, dust) ——
const RUB_MAX = 40;
const GLSL_NOISE = `
float wh3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float wn3(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wh3(i), wh3(i + vec3(1,0,0)), f.x), mix(wh3(i + vec3(0,1,0)), wh3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(wh3(i + vec3(0,0,1)), wh3(i + vec3(1,0,1)), f.x), mix(wh3(i + vec3(0,1,1)), wh3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float wf3(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * wn3(p); p = p * 2.03 + 1.7; a *= 0.5; } return s / 0.9375; }
float wbox2(vec2 p, vec2 h){ return length(max(abs(p) - h, 0.0)); }
`;

function makeWearMaterial(opts) {
  const u = {
    uUse: { value: opts.use ?? 0 },
    uDirt: { value: opts.dirt ?? 0 },
    uPaintRough: { value: opts.paintRough ?? 0.3 },
    uFade: { value: opts.fade ?? 0 },
    uShowMask: { value: 0 },
    uOff: { value: opts.off.clone() },
    uGroundY: { value: opts.groundY },
    uPaint: { value: new THREE.Color(opts.paint) },
    uRub: { value: Array.from({ length: RUB_MAX }, () => new THREE.Vector4(0, -99, 0, 0)) },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.0, envMapIntensity: 1.0 });
  if (opts.toolbox) mat.defines = { WEAR_TOOLBOX: '' };
  mat.userData.u = u;
  mat.customProgramCacheKey = () => (opts.toolbox ? 'wear-toolbox' : 'wear-blocks');
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aCenter; attribute vec3 aHalf; attribute float aBand; attribute float aTouch;
varying vec3 vObj; varying vec3 vObjN; varying vec3 vPC; varying vec3 vPH; varying float vPB; varying float vTouch;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vObj = position; vObjN = normal; vPC = aCenter; vPH = aHalf; vPB = aBand; vTouch = aTouch;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uUse; uniform float uDirt; uniform float uPaintRough; uniform float uFade; uniform float uShowMask;
uniform vec3 uOff; uniform float uGroundY; uniform vec3 uPaint; uniform vec4 uRub[${RUB_MAX}];
varying vec3 vObj; varying vec3 vObjN; varying vec3 vPC; varying vec3 vPH; varying float vPB; varying float vTouch;
${GLSL_NOISE}
float wearAO(vec3 p, vec3 n){
  float ao = mix(0.42, 1.0, smoothstep(0.0, 0.24, p.y - uGroundY));
#ifdef WEAR_TOOLBOX
  float side = 1.0 - smoothstep(0.5, 0.8, abs(n.y));
  // lid seam
  ao *= mix(1.0, mix(0.1, 1.0, smoothstep(0.0, 0.075, abs(p.y - 0.168))), side);
  // body meets base strip
  float wb = smoothstep(-0.46, -0.44, p.y);
  float db = max(p.y + 0.44, 0.0) + max(max(abs(p.x) - 0.8, abs(p.z) - 0.36), 0.0);
  ao *= mix(1.0, mix(0.25, 1.0, smoothstep(0.0, 0.09, db)), wb);
  // handle posts on the lid, and the shade under the bar
  if (p.y > 0.33) {
    float dp = wbox2(vec2(abs(p.x) - 0.45, p.z), vec2(0.045, 0.05)) + max(p.y - 0.375, 0.0);
    ao *= mix(0.28, 1.0, smoothstep(0.0, 0.09, dp));
    if (abs(p.x) < 0.52 && p.y < 0.4) ao *= mix(0.62, 1.0, smoothstep(0.0, 0.14, abs(p.z) - 0.05));
    if (p.y > 0.5 && n.y < -0.5) ao *= 0.55;
  }
  // latches
  if (n.z > 0.5 && p.z < 0.385) {
    float dl = wbox2(vec2(abs(p.x) - 0.56, p.y - 0.19), vec2(0.075, 0.085));
    ao *= mix(0.3, 1.0, smoothstep(0.0, 0.055, dl));
  }
  // ribs
  if (abs(n.z) > 0.5 && abs(p.z) < 0.365 && abs(p.x) < 0.76) {
    ao *= mix(0.32, 1.0, smoothstep(0.0, 0.05, abs(p.y + 0.08) - 0.025));
  }
#endif
  return clamp(ao, 0.0, 1.0);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
vec3 wp = vObj + uOff;
vec3 wn = normalize(vObjN);
vec3 wq = abs(wp - vPC) - (vPH - vPB);
vec3 wa = clamp(wq / vPB, 0.0, 1.0);
float wEdge = min(wa.x * wa.y + wa.y * wa.z + wa.z * wa.x, 1.4);
float wN1 = wf3(wp * 9.0);
float wN2 = wf3(wp * 26.0 + 3.1);
float wRub = 0.0;
for (int i = 0; i < ${RUB_MAX}; i++) { vec3 d = wp - uRub[i].xyz; wRub += uRub[i].w * exp(-dot(d, d) / 0.010); }
float wT = mix(2.3, 0.42, uUse);
float wV = wEdge + (wN1 - 0.5) * 0.9 + (wN2 - 0.5) * 0.35;
wV += smoothstep(0.66, 0.92, wf3(wp * 4.0 + 7.0)) * 0.5 * uUse;
wV += vTouch * uUse * (1.0 + 0.6 * wN1);
float wRubV = wRub * (0.6 + wEdge) * (0.75 + 0.5 * wN2);
float wChip = max(smoothstep(wT, wT + 0.05, wV), smoothstep(0.5, 0.56, wRubV));
float wPrimer = max(smoothstep(wT - 0.17, wT - 0.11, wV), smoothstep(0.3, 0.36, wRubV)) * (1.0 - wChip);
float wAO = wearAO(wp, wn);
float wDirt = uDirt * smoothstep(0.04, 0.42, (1.0 - wAO) * (0.6 + 0.8 * wN1));
#ifdef WEAR_TOOLBOX
{ // grime runs down from the lid seam and the latches (gravity)
  float below = 0.16 - wp.y;
  float sideF = 1.0 - smoothstep(0.4, 0.7, abs(wn.y));
  float streak = smoothstep(0.5, 0.85, wn3(vec3(wp.x * 34.0, wp.y * 1.2, wp.z * 34.0)));
  float run = step(0.0, below) * exp(-below / 0.2) * sideF * streak;
  wDirt = max(wDirt, uDirt * 0.75 * run);
}
#endif
float wDust = uDirt * 0.55 * smoothstep(0.55, 0.95, wn.y) * smoothstep(0.3, 0.7, wf3(wp * 5.0 + 11.0));
vec3 wPaint = mix(uPaint, uPaint * 0.6 + vec3(0.05, 0.045, 0.035), uFade);
wPaint *= 0.92 + 0.16 * wN2;
vec3 wSteel = vec3(0.66, 0.65, 0.62) * (0.8 + 0.35 * wn3(wp * vec3(90.0, 6.0, 90.0)));
vec3 wCol = mix(wPaint, vec3(0.34, 0.075, 0.035), wPrimer);
wCol = mix(wCol, wSteel, wChip);
wCol = mix(wCol, vec3(0.2, 0.17, 0.13), wDust * (1.0 - wChip * 0.7));
wCol = mix(wCol, vec3(0.07, 0.045, 0.025), clamp(wDirt * 1.15, 0.0, 0.96));
diffuseColor.rgb = wCol;
float wRough = mix(uPaintRough + 0.08 * wN2, 0.2 + 0.25 * wn3(wp * vec3(80.0, 5.0, 80.0)), wChip);
wRough = mix(wRough, 0.95, clamp(max(wDirt, wDust * 0.8), 0.0, 1.0));
float wMetal = wChip * (1.0 - clamp(wDirt, 0.0, 1.0) * 0.85);
float wMask = clamp(wEdge, 0.0, 1.0);`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = wRough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = wMetal;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{ float wOcc = wAO; reflectedLight.indirectDiffuse *= wOcc; reflectedLight.indirectSpecular *= wOcc;
  reflectedLight.directDiffuse *= mix(1.0, wOcc, 0.6); reflectedLight.directSpecular *= mix(1.0, wOcc, 0.6); }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
if (uShowMask > 0.5) gl_FragColor = vec4(vec3(wMask), 1.0);`);
  };
  return mat;
}

// One merged mesh from rounded boxes; per-part box data drives the edge mask
function buildParts(parts) {
  const geos = parts.map((p) => {
    const g = new RoundedBoxGeometry(p.s[0], p.s[1], p.s[2], p.seg ?? 4, p.r);
    g.translate(p.c[0], p.c[1], p.c[2]);
    const n = g.attributes.position.count;
    const C = new Float32Array(n * 3), H = new Float32Array(n * 3), B = new Float32Array(n), T = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      C[i * 3] = p.c[0]; C[i * 3 + 1] = p.c[1]; C[i * 3 + 2] = p.c[2];
      H[i * 3] = p.s[0] / 2; H[i * 3 + 1] = p.s[1] / 2; H[i * 3 + 2] = p.s[2] / 2;
      B[i] = p.b; T[i] = p.t ?? 0;
    }
    g.setAttribute('aCenter', new THREE.BufferAttribute(C, 3));
    g.setAttribute('aHalf', new THREE.BufferAttribute(H, 3));
    g.setAttribute('aBand', new THREE.BufferAttribute(B, 1));
    g.setAttribute('aTouch', new THREE.BufferAttribute(T, 1));
    return g;
  });
  const geo = mergeGeometries(geos, false);
  geo.computeBoundingBox();
  const off = new THREE.Vector3();
  geo.boundingBox.getCenter(off);
  geo.translate(-off.x, -off.y, -off.z);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return { geo, off, minY: geo.boundingBox.min.y };
}

const TOOLBOX_PARTS = [
  { s: [1.6, 0.62, 0.72], c: [0, -0.15, 0], r: 0.05, b: 0.13 },        // body
  { s: [1.62, 0.2, 0.74], c: [0, 0.275, 0], r: 0.05, b: 0.075 },       // lid
  { s: [1.66, 0.07, 0.78], c: [0, -0.475, 0], r: 0.02, b: 0.035 },     // base strip
  { s: [0.09, 0.24, 0.1], c: [-0.45, 0.47, 0], r: 0.025, b: 0.04 },    // handle posts
  { s: [0.09, 0.24, 0.1], c: [0.45, 0.47, 0], r: 0.025, b: 0.04 },
  { s: [1.02, 0.08, 0.1], c: [0, 0.585, 0], r: 0.035, b: 0.04, t: 1 }, // handle bar (hands)
  { s: [0.15, 0.17, 0.05], c: [-0.56, 0.19, 0.37], r: 0.012, b: 0.025, t: 0.6 }, // latches (thumbs)
  { s: [0.15, 0.17, 0.05], c: [0.56, 0.19, 0.37], r: 0.012, b: 0.025, t: 0.6 },
  { s: [1.5, 0.05, 0.04], c: [0, -0.08, 0.36], r: 0.012, b: 0.02 },    // ribs
  { s: [1.5, 0.05, 0.04], c: [0, -0.08, -0.36], r: 0.012, b: 0.02 },
];
const TOOLBOX_GROUND = -0.51;
const toolbox = buildParts(TOOLBOX_PARTS);
const PAINT = 0x2f8f86;

function ageParams(age) {
  return { use: age, dirt: age, paintRough: 0.28 + 0.52 * age, fade: age * 0.85 };
}
function applyAge(mat, age) {
  const p = ageParams(age);
  const u = mat.userData.u;
  u.uUse.value = p.use; u.uDirt.value = p.dirt; u.uPaintRough.value = p.paintRough; u.uFade.value = p.fade;
}

function addToolboxLights(scene, rimColor = 0xffb02e) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.75;
  scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x2a1a10, 0.45));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.6);
  key.position.set(2.2, 3.4, 2.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(rimColor, 1.1);
  rim.position.set(-2.4, 1.2, -2.0);
  scene.add(rim);
  return key;
}

// —— Scenes ——
const scenes = [];
const shared = { orbitLight: false, lightAngle: 0, cmpSpin: true, cmpAngle: -0.55 };

function makeScene(element, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.bg ?? 0x14110e);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.45, opts.camZ ?? 3.3);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.5;
  controls.maxDistance = 6;
  controls.target.set(0, 0.05, 0);
  controls.update();
  scene.userData = { element, camera, controls, update: null, meshes: {} };
  scenes.push(scene);
  return scene;
}

function addFloor(scene, y = -1.05, r = 2.6) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(r, 64),
    new THREE.MeshStandardMaterial({ color: 0x1c1813, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = y;
  scene.add(floor);
  return floor;
}

// —— Hero: worn toolbox in brass dots ——
const heroEl = document.querySelector('[data-scene="hero"]');
if (!heroEl) throw new Error('Missing hero view [data-scene=hero]');
const heroPost = makeHeroPost('#ffb02e');
const heroScene = makeScene(heroEl, { bg: 0x050505, camZ: 3.05 });
{
  heroScene.background = null; // RT alpha = object mask
  const mat = makeWearMaterial({ paint: PAINT, toolbox: true, off: toolbox.off, groundY: TOOLBOX_GROUND, ...ageParams(0.82) });
  const mesh = new THREE.Mesh(toolbox.geo, mat);
  heroScene.add(mesh);
  addToolboxLights(heroScene, 0xffc46a);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-0.5, 2.2, 2.0);
  heroScene.add(fill);
  heroScene.userData.meshes = { mesh, mat };
  heroScene.userData.heroPost = heroPost;
  heroScene.userData.controls.enableZoom = false;
  heroScene.userData.controls.enableRotate = false;
  heroScene.userData.controls.enabled = false;
  heroScene.userData.controls.maxDistance = 20;
  mesh.rotation.y = -0.6;
  const heroFitRadius = toolbox.geo.boundingSphere.radius;
  heroScene.userData.update = (t, dt) => {
    const cam = heroScene.userData.camera;
    const R = heroFitRadius;
    const vf = (cam.fov * Math.PI) / 360;
    const hf = Math.atan(Math.tan(vf) * cam.aspect);
    const d = (R * 1.06) / Math.sin(Math.min(vf, hf));
    cam.position.set(0, d * 0.34, d * 0.94);
    heroScene.userData.controls.target.set(0, 0, 0);
    if (!reducedMotion) mesh.rotation.y += dt * 0.2;
  };
}

// —— Specimen 01: ambient occlusion on a ridged vase ——
const aoEl = document.querySelector('[data-scene="ao"]');
const aoScene = makeScene(aoEl, { camZ: 3.4 });
const vase = (() => {
  const yb = -0.8, yt = 0.75, H = yt - yb, yi = -0.68;
  const shape = (y) => {
    const t = (y - yb) / H;
    return 0.3 + 0.21 * Math.sin(Math.PI * (t * 0.82 + 0.1)) - 0.1 * smooth(0.7, 1.0, t) + 0.05 * smooth(0.94, 1.0, t);
  };
  const groove = (y) => {
    const t = (y - yb) / H;
    if (t < 0.07 || t > 0.86) return 0;
    const w = smooth(0.07, 0.11, t) * (1 - smooth(0.82, 0.86, t));
    const ph = ((t - 0.08) / 0.76) * 7 + 0.5;
    return 0.085 * smooth(0.3, 0.72, 0.5 + 0.5 * Math.cos(2 * Math.PI * ph)) * w;
  };
  const Ro = (y) => shape(y) - groove(y);
  const Ri = (y) => shape(y) - 0.06;
  const pts = [new THREE.Vector2(0.001, yb), new THREE.Vector2(Ro(yb) - 0.025, yb)];
  const NO = 360;
  for (let i = 0; i <= NO; i++) { const y = yb + 0.004 + (i / NO) * (yt - yb - 0.004); pts.push(new THREE.Vector2(Ro(y), y)); }
  pts.push(new THREE.Vector2((Ro(yt) + Ri(yt)) / 2, yt + 0.012));
  const NI = 90;
  for (let i = 0; i <= NI; i++) { const y = yt - (i / NI) * (yt - yi); pts.push(new THREE.Vector2(Ri(y), y)); }
  pts.push(new THREE.Vector2(0.001, yi));
  const geo = new THREE.LatheGeometry(pts, 120);

  // Bake AO along the profile: ray-march the solid of revolution plus the ground
  const solid = (x, y, z) => {
    if (y < yb) return true;
    if (y > yt + 0.015) return false;
    const rho = Math.hypot(x, z);
    if (rho > Ro(Math.min(yt, Math.max(yb, y)))) return false;
    if (y > yi && rho < Ri(Math.min(yt, y))) return false;
    return true;
  };
  const N = pts.length;
  const data = new Uint8Array(N * 4);
  const aoRaw = new Float32Array(N);
  const RAYS = 56, STEP = 0.009, MAXD = 0.42;
  let seed = 7;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let j = 0; j < N; j++) {
    const a = pts[Math.max(0, j - 1)], b = pts[Math.min(N - 1, j + 1)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nr = ty, ny = -tx; // outward (same rule as LatheGeometry)
    const px = pts[j].x, py = pts[j].y;
    let occ = 0;
    for (let k = 0; k < RAYS; k++) {
      const u1 = (k + rnd()) / RAYS, u2 = rnd();
      const r = Math.sqrt(u1), phi = 2 * Math.PI * u2;
      const lx = r * Math.cos(phi), lz = r * Math.sin(phi), ln = Math.sqrt(Math.max(0, 1 - u1));
      // basis: N=(nr,ny,0), T=(-ny,nr,0), B=(0,0,1)
      const dx = nr * ln - ny * lx, dy = ny * ln + nr * lx, dz = lz;
      for (let s = 0.012; s < MAXD; s += STEP) {
        if (solid(px + dx * s, py + dy * s, dz * s)) { occ += 1 - (s / MAXD) * 0.6; break; }
      }
    }
    let ao = 1 - occ / RAYS;
    ao = Math.min(1, Math.max(0, Math.pow(ao, 1.9) * 1.12));
    aoRaw[j] = ao;
  }
  for (let j = 0; j < N; j++) {
    let acc = 0, wsum = 0;
    for (let k = -2; k <= 2; k++) { const i = Math.min(N - 1, Math.max(0, j + k)); const w = 3 - Math.abs(k); acc += aoRaw[i] * w; wsum += w; }
    const v = Math.round((acc / wsum) * 255);
    data[j * 4] = data[j * 4 + 1] = data[j * 4 + 2] = v; data[j * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 1, N, THREE.RGBAFormat);
  tex.colorSpace = THREE.NoColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.repeat.set(1, (N - 1) / N);
  tex.offset.set(0, 0.5 / N);
  tex.needsUpdate = true;
  return { geo, tex, yb };
})();
const aoState = { on: true, view: false, intensity: 1 };
{
  aoScene.environment = envMap;
  aoScene.environmentIntensity = 1.0;
  aoScene.add(new THREE.HemisphereLight(0xdfe8ff, 0x3a2614, 0.9));
  const key = new THREE.DirectionalLight(0xfff0dc, 0.6);
  key.position.set(1.5, 3.5, 2.2);
  aoScene.add(key);
  const grime = { value: 0.95 };
  const mat = new THREE.MeshStandardMaterial({ color: 0xe9e2d4, roughness: 0.58, metalness: 0.0, aoMap: vase.tex, aoMapIntensity: 1 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrime = grime;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uGrime;')
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_AOMAP
{ float aoD = texture2D(aoMap, vAoMapUv).r;
  vec2 q = vAoMapUv * vec2(90.0, 260.0);
  vec2 qi = floor(q); vec2 qf = fract(q); qf = qf * qf * (3.0 - 2.0 * qf);
  float h00 = fract(sin(dot(qi, vec2(127.1, 311.7))) * 43758.5453);
  float h10 = fract(sin(dot(qi + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
  float h01 = fract(sin(dot(qi + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float h11 = fract(sin(dot(qi + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
  float gn = mix(mix(h00, h10, qf.x), mix(h01, h11, qf.x), qf.y);
  float g = (1.0 - smoothstep(0.3, 0.97, aoD)) * uGrime * aoMapIntensity * (0.7 + 0.6 * gn);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.11, 0.075, 0.045), clamp(g, 0.0, 0.93)); }
#endif`);
  };
  const viewMat = new THREE.MeshBasicMaterial({ map: vase.tex, toneMapped: false });
  const mesh = new THREE.Mesh(vase.geo, mat);
  aoScene.add(mesh);
  addFloor(aoScene, vase.yb, 2.4);
  contactShadow(aoScene, vase.yb, 1.4, 1.4, 0.7);
  aoScene.userData.camera.position.set(0, 0.55, 3.2);
  aoScene.userData.controls.target.set(0, -0.05, 0);
  aoScene.userData.controls.maxPolarAngle = Math.PI * 0.62;
  aoScene.userData.meshes = { mesh, mat, viewMat };
  aoScene.userData.update = (t, dt) => { if (!reducedMotion) mesh.rotation.y += dt * 0.12; };
}
function applyAO() {
  const { mesh, mat, viewMat } = aoScene.userData.meshes;
  const want = aoState.on ? vase.tex : null;
  if (mat.aoMap !== want) { mat.aoMap = want; mat.needsUpdate = true; }
  mat.aoMapIntensity = aoState.intensity;
  mesh.material = aoState.view ? viewMat : mat;
}

// —— Specimen 02: edge wear from curvature ——
const edgeEl = document.querySelector('[data-scene="edges"]');
const edgeScene = makeScene(edgeEl, { camZ: 3.6 });
const BLOCK_PARTS = [
  { s: [0.7, 0.7, 0.7], c: [-0.78, -0.15, 0.1], r: 0.06, b: 0.16 },
  { s: [0.4, 1.0, 0.4], c: [0.12, 0.0, -0.25], r: 0.05, b: 0.13 },
  { s: [0.9, 0.24, 0.6], c: [0.72, -0.38, 0.3], r: 0.04, b: 0.1 },
];
const blocks = buildParts(BLOCK_PARTS);
const rub = { on: false, down: false, target: null, brush: null, n: 0 };
{
  const mat = makeWearMaterial({ paint: 0xd8682a, toolbox: false, off: blocks.off, groundY: -0.5, use: 0.45, dirt: 0, paintRough: 0.34 });
  const mesh = new THREE.Mesh(blocks.geo, mat);
  edgeScene.add(mesh);
  addToolboxLights(edgeScene);
  addFloor(edgeScene, blocks.minY, 2.6);
  contactShadow(edgeScene, blocks.minY, 2.9, 1.9, 0.6);
  edgeScene.userData.camera.position.set(0.9, 1.35, 3.1);
  edgeScene.userData.controls.target.set(0, -0.15, 0);
  edgeScene.userData.controls.maxPolarAngle = Math.PI * 0.48;
  edgeScene.userData.meshes = { mesh, mat };
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const hitAt = (e) => {
    const r = edgeEl.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, edgeScene.userData.camera);
    const h = ray.intersectObject(mesh, false)[0];
    if (!h) return null;
    return mesh.worldToLocal(h.point.clone()).add(blocks.off);
  };
  edgeEl.addEventListener('pointerdown', (e) => {
    if (!rub.on) return;
    rub.down = true;
    try { edgeEl.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    rub.target = hitAt(e);
    rub.brush = rub.target ? rub.target.clone() : null;
  });
  edgeEl.addEventListener('pointermove', (e) => {
    if (!(rub.on && rub.down)) return;
    const h = hitAt(e);
    if (!h) return;
    rub.target = h;
    if (rub.brush) stroke();
  });
  const up = () => { rub.down = false; };
  edgeEl.addEventListener('pointerup', up);
  edgeEl.addEventListener('pointercancel', up);
  const deposit = (p, s) => {
    const arr = mat.userData.u.uRub.value;
    let best = -1, bd = 1e9;
    for (let i = 0; i < rub.n; i++) { const d = p.distanceTo(new THREE.Vector3(arr[i].x, arr[i].y, arr[i].z)); if (d < bd) { bd = d; best = i; } }
    if (best >= 0 && bd < 0.05) { arr[best].w = Math.min(1.6, arr[best].w + s); return; }
    if (rub.n < RUB_MAX) { arr[rub.n].set(p.x, p.y, p.z, s); rub.n += 1; return; }
    let weakest = 0;
    for (let i = 1; i < RUB_MAX; i++) if (arr[i].w < arr[weakest].w) weakest = i;
    arr[weakest].set(p.x, p.y, p.z, s);
  };
  // The brush has weight: it trails the pointer, and the faster it moves the more it scuffs
  function stroke() {
    const prev = rub.brush.clone();
    rub.brush.lerp(rub.target, 0.35);
    const moved = prev.distanceTo(rub.brush);
    if (moved > 0.0005) deposit(rub.brush, Math.min(0.5, 0.1 + moved * 5));
  }
  edgeScene.userData.update = () => {
    if (rub.on && rub.down && rub.target && rub.brush) stroke();
  };
}

// —— Specimen 03: tiling and repetition ——
const tileEl = document.querySelector('[data-scene="tiles"]');
const tileScene = makeScene(tileEl, { bg: 0x14110e });
const tileTex = (() => {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const wrapD = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 1 - d); };
  const crack = [[0.56, 0.12], [0.6, 0.24], [0.58, 0.33], [0.66, 0.44], [0.7, 0.56], [0.77, 0.62]];
  const segD = (x, y, a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / (vx * vx + vy * vy)));
    return Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t);
  };
  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const u = px / S, v = py / S;
      const n = pfbm(u, v, 4, 5, 11);
      const fine = pnoise(u * 64, v * 64, 64, 3);
      const sp = hashI(px, py, 9);
      let l = 0.5 + (n - 0.5) * 0.42 + (fine - 0.5) * 0.08;
      if (sp > 0.982) l -= 0.16; else if (sp < 0.012) l += 0.1;
      let r = l * 1.0, gg = l * 0.98, b = l * 0.93;
      // oil stain
      const edgeN = (pfbm(u, v, 8, 3, 21) - 0.5) * 0.7;
      const d1 = Math.hypot(wrapD(u, 0.3), wrapD(v, 0.36)) / 0.14 + edgeN;
      const st = smooth(1.0, 0.45, d1);
      r *= 1 - 0.62 * st; gg *= 1 - 0.6 * st; b *= 1 - 0.55 * st;
      const ring = smooth(0.85, 1.0, d1) * (1 - smooth(1.0, 1.12, d1));
      r *= 1 - 0.25 * ring; gg *= 1 - 0.25 * ring; b *= 1 - 0.2 * ring;
      // small stain
      const d2 = Math.hypot(wrapD(u, 0.78), wrapD(v, 0.82)) / 0.055 + edgeN * 0.6;
      const st2 = smooth(1.0, 0.5, d2);
      r *= 1 - 0.45 * st2; gg *= 1 - 0.45 * st2; b *= 1 - 0.42 * st2;
      // crack
      let dc = 1;
      for (let i = 0; i < crack.length - 1; i++) dc = Math.min(dc, segD(u, v, crack[i], crack[i + 1]));
      const cw = 0.0035 + 0.003 * pnoise(u * 40, v * 40, 40, 5);
      const cr = smooth(cw, cw * 0.3, dc);
      r *= 1 - 0.7 * cr; gg *= 1 - 0.7 * cr; b *= 1 - 0.7 * cr;
      // yellow paint fleck
      const d3 = Math.hypot(wrapD(u, 0.2) * 1.0, wrapD(v, 0.8) * 2.2) / 0.06 + edgeN * 0.4;
      const pf = smooth(1.0, 0.85, d3);
      r = r + (0.92 - r) * pf; gg = gg + (0.7 - gg) * pf; b = b + (0.12 - b) * pf;
      const o = (py * S + px) * 4;
      img.data[o] = Math.max(0, Math.min(255, r * 255));
      img.data[o + 1] = Math.max(0, Math.min(255, gg * 255));
      img.data[o + 2] = Math.max(0, Math.min(255, b * 255));
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.repeat.set(6, 6);
  return tex;
})();
const tileU = { uBreak: { value: 0 } };
{
  tileScene.fog = new THREE.Fog(0x14110e, 6, 13);
  tileScene.environment = envMap;
  tileScene.environmentIntensity = 0.35;
  tileScene.add(new THREE.HemisphereLight(0xdfe6ff, 0x2a1a10, 0.7));
  const key = new THREE.DirectionalLight(0xfff0dc, 2.2);
  key.position.set(-2.5, 3.0, 1.5);
  tileScene.add(key);
  const mat = new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.86, metalness: 0.0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uBreak = tileU.uBreak;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uBreak;
float tn2h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tn2(vec2 x){ vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(tn2h(i), tn2h(i + vec2(1.0, 0.0)), f.x), mix(tn2h(i + vec2(0.0, 1.0)), tn2h(i + vec2(1.0, 1.0)), f.x), f.y); }
vec4 noTile(sampler2D s, vec2 uv){
  float k = tn2(uv * 0.9);
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  float l = k * 8.0; float f = fract(l);
  float ia = floor(l), ib = ia + 1.0;
  vec2 oa = sin(vec2(3.0, 7.0) * ia), ob = sin(vec2(3.0, 7.0) * ib);
  vec4 ca = textureGrad(s, uv + oa, dx, dy), cb = textureGrad(s, uv + ob, dx, dy);
  vec3 dd = ca.rgb - cb.rgb;
  return mix(ca, cb, smoothstep(0.2, 0.8, f - 0.1 * (dd.r + dd.g + dd.b)));
}`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
  vec4 sampledDiffuseColor = uBreak > 0.5 ? noTile(map, vMapUv) : texture2D(map, vMapUv);
  diffuseColor *= sampledDiffuseColor;
#endif`);
  };
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), mat);
  floor.rotation.x = -Math.PI / 2;
  tileScene.add(floor);
  tileScene.userData.camera.position.set(0, 2.5, 3.3);
  tileScene.userData.controls.target.set(0, 0, -0.6);
  tileScene.userData.controls.minPolarAngle = 0.25;
  tileScene.userData.controls.maxPolarAngle = 1.3;
  tileScene.userData.controls.minDistance = 2;
  tileScene.userData.controls.maxDistance = 6.5;
  tileScene.userData.meshes = { floor, mat };
}

// —— Specimen 04: one age slider, new vs used ——
const cmpNewEl = document.querySelector('[data-scene="cmp-new"]');
const cmpUsedEl = document.querySelector('[data-scene="cmp-used"]');
const cmp = [];
for (const [el, age] of [[cmpNewEl, 0], [cmpUsedEl, 0.7]]) {
  const s = makeScene(el, { bg: 0x16120d });
  const mat = makeWearMaterial({ paint: PAINT, toolbox: true, off: toolbox.off, groundY: TOOLBOX_GROUND, ...ageParams(age) });
  const mesh = new THREE.Mesh(toolbox.geo, mat);
  s.add(mesh);
  addToolboxLights(s);
  addFloor(s, toolbox.minY, 2.6);
  contactShadow(s, toolbox.minY, 2.4, 1.3, 0.7);
  s.userData.camera.position.set(1.45, 1.05, 2.6);
  s.userData.controls.target.set(0, -0.05, 0);
  s.userData.controls.maxPolarAngle = Math.PI * 0.49;
  s.userData.meshes = { mesh, mat };
  cmp.push(s);
}
{
  let leader = 0;
  cmp.forEach((s, i) => s.userData.controls.addEventListener('start', () => { leader = i; }));
  cmp.forEach((s, i) => {
    s.userData.update = (t, dt) => {
      if (i === 0 && shared.cmpSpin && !reducedMotion) shared.cmpAngle += dt * 0.3;
      s.userData.meshes.mesh.rotation.y = shared.cmpAngle;
      if (leader !== i) {
        const L = cmp[leader].userData;
        s.userData.camera.position.copy(L.camera.position);
        s.userData.controls.target.copy(L.controls.target);
      }
    };
  });
}

// —— UI ——

// Hero reveal lens: follows the pointer, drifts slowly when idle
{
  const el = heroEl;
  const post = heroPost;
  el.style.touchAction = 'pan-y';
  const setTarget = (e) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    post.target.x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    post.target.y = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    post.lastPointer = performance.now();
  };
  el.addEventListener('pointerdown', (e) => { post.dragging = true; setTarget(e); });
  el.addEventListener('pointermove', setTarget);
  el.addEventListener('pointerup', () => { post.dragging = false; });
  el.addEventListener('pointercancel', () => { post.dragging = false; });
  el.addEventListener('pointerleave', () => { post.dragging = false; post.lastPointer = performance.now() - 1200; });
}

function bindRange(id, fn, digits = 2) {
  const el = document.getElementById(id);
  const out = document.getElementById(`${id}-out`);
  const h = () => {
    const v = Number(el.value);
    if (out) out.textContent = digits ? v.toFixed(digits) : String(Math.round(v));
    fn(v);
  };
  el.addEventListener('input', h);
  el.addEventListener('change', h);
  h();
}
function bindToggle(sel, fn) {
  const btn = document.querySelector(sel);
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    fn(on);
  });
}

bindToggle('[data-ao="on"]', (on) => { aoState.on = on; applyAO(); });
bindToggle('[data-ao="view"]', (on) => { aoState.view = on; applyAO(); });
bindRange('ao-int', (v) => { aoState.intensity = v; applyAO(); });

bindRange('wear-use', (v) => { edgeScene.userData.meshes.mat.userData.u.uUse.value = v; });
bindToggle('[data-edge="mask"]', (on) => { edgeScene.userData.meshes.mat.userData.u.uShowMask.value = on ? 1 : 0; });
bindToggle('[data-rub="on"]', (on) => {
  rub.on = on;
  rub.down = false;
  edgeScene.userData.controls.enabled = !on;
  edgeEl.classList.toggle('rubbing', on);
  edgeEl.style.touchAction = on ? 'none' : '';
});

bindRange('tile-count', (v) => { tileTex.repeat.set(v, v); }, 0);
bindToggle('[data-tile="break"]', (on) => { tileU.uBreak.value = on ? 1 : 0; });

bindRange('cmp-age', (v) => { applyAge(cmp[1].userData.meshes.mat, v); });
bindToggle('[data-cmp="spin"]', (on) => { shared.cmpSpin = on; });
try { initTypeWear(); } catch (err) { console.warn(err); }

// —— Render loop ——
let visible = !document.hidden;
document.addEventListener('visibilitychange', () => {
  visible = !document.hidden;
  if (visible) {
    last = performance.now();
    renderer.setAnimationLoop(animate);
  } else {
    renderer.setAnimationLoop(null);
  }
});

function updateSize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = pixelCap();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
  }
}
window.addEventListener('resize', updateSize);

let last = performance.now();
let frameCount = 0;

function animate(now) {
  if (!visible) return;
  frameCount += 1;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  updateSize();


  renderer.setScissorTest(false);
  renderer.setClearColor(0x0c0a08, 1);
  renderer.clear();
  renderer.setScissorTest(true);

  for (const scene of scenes) {
    const element = scene.userData.element;
    const rect = element.getBoundingClientRect();
    const canvasH = renderer.domElement.clientHeight;
    const canvasW = renderer.domElement.clientWidth;
    if (
      rect.bottom < 0 || rect.top > canvasH ||
      rect.right < 0 || rect.left > canvasW ||
      rect.width === 0 || rect.height === 0
    ) continue;

    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    const left = rect.left;
    const bottom = canvasH - rect.bottom;
    const camera = scene.userData.camera;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (scene.userData.update) scene.userData.update(now * 0.001, dt, shared);
    scene.userData.controls.update();
    renderer.setViewport(left, bottom, width, height);
    renderer.setScissor(left, bottom, width, height);

    const post = scene.userData.heroPost;
    if (post) {
      const tnow = now * 0.001;
      const idle = !post.dragging && performance.now() - post.lastPointer > 1800;
      if (idle && reducedMotion) { post.target.x = 0.62; post.target.y = 0.48; }
      else if (idle) {
        post.target.x = 0.5 + 0.24 * Math.sin(tnow * 0.33);
        post.target.y = 0.5 + 0.16 * Math.sin(tnow * 0.51 + 1.0);
      }
      const k = reducedMotion ? 1 : 0.12;
      post.lens.x += (post.target.x - post.lens.x) * k;
      post.lens.y += (post.target.y - post.lens.y) * k;
      const aspect = Math.max(0.5, width / height);
      const pr = renderer.getPixelRatio();
      const rtW = Math.round(Math.min(720, Math.max(240, width * pr * 0.5)));
      const rtH = Math.max(96, Math.round(rtW / aspect));
      if (post.rt.width !== rtW || post.rt.height !== rtH) {
        post.rt.setSize(rtW, rtH);
        post.uniforms.uRes.value.set(rtW, rtH);
      }
      // Render true PBR into small RT (ignore scissor for RT)
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, rtW, rtH);
      const prevTone = renderer.toneMappingExposure;
      renderer.setRenderTarget(post.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x0c0a08, 1);
      renderer.setScissorTest(true);
      renderer.setViewport(left, bottom, width, height);
      renderer.setScissor(left, bottom, width, height);
      post.uniforms.uLens.value.set(post.lens.x, post.lens.y);
      post.uniforms.uScreen.value.set(width * pr, height * pr);
      post.uniforms.uTime.value = tnow;
      post.uniforms.uCell.value = Math.max(6, Math.min(11, width / 105)) * pr;
      const prevTM = renderer.toneMapping;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.autoClear = false;
      renderer.render(post.postScene, post.postCam);
      renderer.autoClear = true;
      renderer.toneMapping = prevTM;
      renderer.toneMappingExposure = prevTone;
    } else {
      renderer.render(scene, camera);
    }
  }
}

updateSize();
renderer.setAnimationLoop(animate);

window.__HTW = window.__HSW = {
  renderer,
  canvas,
  scenes,
  shared,
  get frameCount() { return frameCount; },
  get reducedMotion() { return reducedMotion; },
  webglContexts: () => document.querySelectorAll('canvas#c').length,
  heroPost,
};
