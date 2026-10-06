import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

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

const coarseMQ = window.matchMedia('(pointer: coarse)');
const isMobile = () => window.innerWidth < 700 || coarseMQ.matches;
const pixelCap = () => {
  const dpr = window.devicePixelRatio || 1;
  return Math.min(dpr, isMobile() ? 1.5 : 2);
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
renderer.localClippingEnabled = true;
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

// —— Scenes ——
const scenes = [];
const shared = { cutSpin: true, cutAngle: -0.6 };

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

// —— Lesson 06: procedural wood and stone ——
const coarse = isMobile();
const OCT = coarse ? 3 : 5; // fewer noise octaves on phones keeps the fragment shaders cheap

const GLSL_GRAIN = `
float grH(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float grN(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(grH(i), grH(i + vec3(1,0,0)), f.x), mix(grH(i + vec3(0,1,0)), grH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(grH(i + vec3(0,0,1)), grH(i + vec3(1,0,1)), f.x), mix(grH(i + vec3(0,1,1)), grH(i + vec3(1,1,1)), f.x), f.y), f.z); }
float grF(vec3 p){ float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < GR_OCT; i++) { s += a * grN(p); n += a; p = p * 2.03 + vec3(1.7, 9.2, 4.1); a *= 0.5; } return s / n; }
float grT(vec3 p){ float a = 0.5, s = 0.0;
  for (int i = 0; i < GR_OCT; i++) { s += a * abs(grN(p) * 2.0 - 1.0); p = p * 2.03 + vec3(5.3, 1.1, 7.7); a *= 0.5; } return s; }
float grH1(float n){ return fract(sin(n * 12.9898 + 4.1) * 43758.5453); }

// Wood: rings around a trunk line (the x axis), pushed sideways by noise
vec3 grWood(vec3 q, out float rough){
  float n1 = grF(q * vec3(0.45, 1.7, 1.7) + 3.7);
  float n2 = grN(q * vec3(1.2, 6.0, 6.0) + 11.0);
  vec2 d = q.yz - uTrunk;
  float r = length(d);
  float ang = atan(d.y, d.x);
  r += uWarp * ((n1 - 0.5) * 0.42 + (n2 - 0.5) * 0.05 + 0.02 * sin(ang * 3.0 + q.x * 0.9));
  float t = r * uRings;
  float id = floor(t);
  float f = fract(t);
  float hv = grH1(id);
  float lw = mix(0.2, 0.42, hv);
  float late = smoothstep(1.0 - lw, 1.0 - lw * 0.2, f);
  vec3 early = uEarly * (0.88 + 0.22 * hv);
  vec3 c = mix(early, uLate, late * 0.92);
  float fib = grN(q * vec3(1.5, 70.0, 70.0));
  c *= 0.88 + 0.22 * fib;
  float pore = smoothstep(0.74, 0.86, grN(q * vec3(9.0, 150.0, 150.0))) * (1.0 - late);
  c *= 1.0 - 0.3 * pore;
  c *= 0.9 + 0.2 * grN(q * vec3(0.3, 1.0, 1.0) + 20.0);
  rough = mix(0.42, 0.55, late) + 0.12 * pore;
  return c;
}

// Marble: straight bands, bent by turbulence; thin veins sit at the band edges
vec3 grMarble(vec3 p, out float rough){
  float tb = grT(p * 1.4);
  float v = dot(p, vec3(0.75, 1.5, 0.35)) * 4.6 + uTurb * tb * 5.2;
  float s = abs(sin(v));
  float w = 0.05 + 0.07 * grN(p * 2.5 + 5.0);
  float vein = 1.0 - smoothstep(0.0, w, s);
  float halo = pow(1.0 - smoothstep(0.0, 0.95, s), 2.0);
  float tb2 = grT(p * 2.6 + 7.0);
  float v2 = dot(p, vec3(-1.2, 0.4, 1.1)) * 5.5 + uTurb * tb2 * 4.5;
  float vein2 = (1.0 - smoothstep(0.0, 0.035, abs(sin(v2)))) * smoothstep(0.35, 0.6, grN(p * 1.2 + 2.0)) * smoothstep(0.05, 0.5, uTurb);
  vec3 base = vec3(0.7, 0.69, 0.66) * (0.95 + 0.05 * grN(p * 9.0));
  // soft grey clouds that follow the same folded bands
  float bands = 0.5 + 0.5 * sin(v * 0.5 + 1.3);
  float cloud = grF(p * 1.3 + 9.0) * 0.6 + bands * 0.4;
  base = mix(base, mix(base, uVein, 0.3), smoothstep(0.4, 0.85, cloud));
  vec3 c = mix(base, mix(base, uVein, 0.6), halo * 0.75);
  c = mix(c, uVein, clamp(max(vein * 0.85, vein2 * 0.6), 0.0, 1.0));
  rough = 0.1 + 0.08 * vein;
  return c;
}
`;

const woodShared = () => ({
  uRings: { value: 9 },
  uWarp: { value: 0.55 },
  uTrunk: { value: new THREE.Vector2(-0.7, -0.25) },
  uEarly: { value: new THREE.Color(0.36, 0.185, 0.075) },
  uLate: { value: new THREE.Color(0.115, 0.045, 0.018) },
  uTurb: { value: 0 },
  uVein: { value: new THREE.Color(0, 0, 0) },
});
const VEIN_GREY = new THREE.Color(0.12, 0.12, 0.13);
const VEIN_GOLD = new THREE.Color(0.42, 0.25, 0.08);

// kind: 'wood' (3D rule), 'painted' (a flat picture of wood on each face, by UV), 'marble'
function makePatternMaterial(kind, shared, opts = {}) {
  const u = { ...shared, uGOff: { value: new THREE.Vector3() }, uPaint: { value: new THREE.Vector3(1.6, 0.9, 0.3) } };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.5,
    metalness: 0,
    clearcoat: kind === 'marble' ? 0.7 : 0.25,
    clearcoatRoughness: kind === 'marble' ? 0.06 : 0.35,
    side: opts.side ?? THREE.FrontSide,
  });
  if (opts.clip) mat.clippingPlanes = opts.clip;
  mat.defines = { GR_OCT: String(OCT) };
  mat.userData.u = u;
  mat.customProgramCacheKey = () => `grain-${kind}-${OCT}`;
  const body = kind === 'marble'
    ? 'float gR; vec3 gC = grMarble(vGP, gR);'
    : kind === 'painted'
      ? 'float gR; vec3 gC = grWood(vGP, gR); if (!gl_FrontFacing) { gC = vec3(0.03, 0.028, 0.026); gR = 0.95; }'
      : 'float gR; vec3 gC = grWood(vGP, gR);';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uGOff;\nvarying vec3 vGP;\nvarying vec2 vGUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGP = position + uGOff;\nvGUv = uv;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uRings; uniform float uWarp; uniform vec2 uTrunk; uniform vec3 uEarly; uniform vec3 uLate;
uniform float uTurb; uniform vec3 uVein; uniform vec3 uPaint;
varying vec3 vGP; varying vec2 vGUv;
${GLSL_GRAIN}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
${body}
diffuseColor.rgb = gC;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = gR;');
  };
  return mat;
}

function addStudioLights(scene, key = 1.5) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.5;
  scene.add(new THREE.HemisphereLight(0xfff4e8, 0x2a1d14, 0.25));
  const k = new THREE.DirectionalLight(0xfff0dc, key);
  k.position.set(2.2, 3.4, 2.4);
  scene.add(k);
  const rim = new THREE.DirectionalLight(0xffd9c2, 0.45);
  rim.position.set(-2.4, 1.2, -2.0);
  scene.add(rim);
}

// —— Hero: a turned wooden bowl in rose dots ——
const heroEl = document.querySelector('[data-scene="hero"]');
if (!heroEl) throw new Error('Missing hero view [data-scene=hero]');
const heroPost = makeHeroPost('#f08aa8');
const heroScene = makeScene(heroEl, { bg: 0x050505, camZ: 3.05 });
const bowlGeo = (() => {
  const pts = [new THREE.Vector2(0.001, -0.4), new THREE.Vector2(0.26, -0.4), new THREE.Vector2(0.29, -0.37)];
  const N = 48;
  const outer = (t) => new THREE.Vector2(0.29 + 0.64 * Math.pow(Math.sin((t * Math.PI) / 2), 0.85), -0.37 + 0.71 * t);
  for (let i = 1; i <= N; i++) pts.push(outer(i / N));
  pts.push(new THREE.Vector2(0.915, 0.355), new THREE.Vector2(0.885, 0.345));
  for (let i = N; i >= 0; i--) { const o = outer(i / N); pts.push(new THREE.Vector2(Math.max(0.001, (o.x - 0.05) * (0.75 + 0.25 * (i / N)) - 0.0), o.y + 0.0 + (1 - i / N) * 0.07 - 0.0)); }
  pts.push(new THREE.Vector2(0.001, -0.3 + 0.07));
  const g = new THREE.LatheGeometry(pts, 160);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
})();
{
  heroScene.background = null; // RT alpha = object mask
  const sh = woodShared();
  sh.uTrunk.value.set(0.95, 0.0);
  sh.uRings.value = 7.5;
  sh.uWarp.value = 0.6;
  sh.uEarly.value.setRGB(0.5, 0.29, 0.14);
  sh.uLate.value.setRGB(0.2, 0.09, 0.04);
  const mat = makePatternMaterial('wood', sh, { side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(bowlGeo, mat);
  const tilt = new THREE.Group();
  tilt.add(mesh);
  tilt.rotation.x = 0.3;
  heroScene.add(tilt);
  addStudioLights(heroScene, 2.2);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-0.5, 2.2, 2.0);
  heroScene.add(fill);
  heroScene.userData.meshes = { mesh, mat };
  heroScene.userData.heroPost = heroPost;
  heroScene.userData.controls.enabled = false;
  heroScene.userData.controls.maxDistance = 20;
  mesh.rotation.y = -0.6;
  const R = bowlGeo.boundingSphere.radius;
  heroScene.userData.update = (t, dt) => {
    const cam = heroScene.userData.camera;
    const vf = (cam.fov * Math.PI) / 360;
    const hf = Math.atan(Math.tan(vf) * cam.aspect);
    const d = (R * 1.04) / Math.sin(Math.min(vf, hf));
    cam.position.set(0, d * 0.22, d * 0.975);
    heroScene.userData.controls.target.set(0, 0, 0);
    if (!reducedMotion) mesh.rotation.y += dt * 0.18;
  };
}

// —— Specimen 01: a noise strip with a graph ——
const noiseEl = document.querySelector('[data-scene="noise"]');
const noiseScene = makeScene(noiseEl, { bg: 0x0c0a08 });
const noiseU = {
  uOct: { value: 3 },
  uScale: { value: 4 },
  uAspect: { value: 1 },
  uAccent: { value: new THREE.Vector3(0xf0 / 255, 0x8a / 255, 0xa8 / 255) },
};
{
  noiseScene.userData.controls.enabled = false;
  noiseScene.userData.controls.minDistance = 0.1;
  const mat = new THREE.ShaderMaterial({
    uniforms: noiseU,
    toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      precision highp float;
      uniform float uOct; uniform float uScale; uniform float uAspect; uniform vec3 uAccent;
      varying vec2 vUv;
      float h2(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
      float n2(vec2 x){ vec2 i = floor(x), f = fract(x); vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
        return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), u.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), u.x), u.y); }
      float fbm(vec2 p){ float s = 0.0, a = 0.5, n = 0.0;
        for (int i = 0; i < 6; i++) { if (float(i) >= uOct) break; s += a * n2(p); n += a; p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.3, 9.1); a *= 0.5; }
        return s / n; }
      void main(){
        float split = 0.4;
        float sliceY = split + (1.0 - split) * 0.5;
        vec3 col;
        if (vUv.y > split) {
          float v = fbm(vec2(vUv.x * uAspect, vUv.y) * uScale + 3.0);
          col = mix(vec3(0.07, 0.06, 0.055), vec3(0.95, 0.9, 0.82), smoothstep(0.2, 0.8, v));
          float px = fwidth(vUv.y);
          float sl = 1.0 - smoothstep(px * 0.6, px * 1.8, abs(vUv.y - sliceY));
          col = mix(col, uAccent, sl);
        } else {
          float gy = vUv.y / split;
          float v = fbm(vec2(vUv.x * uAspect, sliceY) * uScale + 3.0);
          float yv = 0.1 + 0.8 * clamp((v - 0.12) / 0.76, 0.0, 1.0);
          col = vec3(0.055, 0.05, 0.045);
          float gp = fwidth(gy);
          for (int k = 0; k < 3; k++) { float gl = 0.1 + 0.4 * float(k); col += vec3(0.06) * (1.0 - smoothstep(0.0, gp * 1.2, abs(gy - gl))); }
          col = mix(col, uAccent * 0.35 + col * 0.65, step(gy, yv) * 0.55);
          float d = gy - yv;
          float w = max(fwidth(d), 1e-4);
          float line = 1.0 - smoothstep(w * 1.0, w * 2.4, abs(d));
          col = mix(col, uAccent, line);
        }
        float sep = 1.0 - smoothstep(0.0, fwidth(vUv.y) * 1.5, abs(vUv.y - split));
        col = mix(col, vec3(0.3, 0.27, 0.25), sep);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  noiseScene.add(quad);
  const cam = noiseScene.userData.camera;
  cam.position.set(0, 0, 1);
  noiseScene.userData.controls.target.set(0, 0, 0);
  noiseScene.userData.update = () => {
    cam.position.set(0, 0, 1);
    cam.lookAt(0, 0, 0);
    const h = 2 * Math.tan((cam.fov * Math.PI) / 360);
    quad.scale.set(h * cam.aspect, h, 1);
    noiseU.uAspect.value = cam.aspect;
  };
  noiseScene.userData.meshes = { quad, mat };
}

// —— Specimen 02: a wood block (ring spacing, warp, turn) ——
const woodEl = document.querySelector('[data-scene="wood"]');
const woodScene = makeScene(woodEl, { bg: 0x14110e });
const woodU = woodShared();
const woodMesh = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.55, 0.75, 4, 0.025), makePatternMaterial('wood', woodU));
{
  woodScene.userData.controls.enabled = false; // the Turn slider owns the view
  woodScene.userData.controls.minDistance = 0.1;
  woodScene.add(woodMesh);
  addStudioLights(woodScene);
  addFloor(woodScene, -0.275, 2.6);
  contactShadow(woodScene, -0.275, 2.4, 1.6, 0.6);
  const cam = woodScene.userData.camera;
  woodScene.userData.update = () => {
    cam.position.set(0, 0.95, 2.75);
    cam.lookAt(0, -0.02, 0);
  };
}

// —— Specimen 03: marble slab and sphere ——
const marbleEl = document.querySelector('[data-scene="marble"]');
const marbleScene = makeScene(marbleEl, { bg: 0x14110e });
const marbleU = woodShared();
marbleU.uTurb.value = 0.6;
marbleU.uVein.value.copy(VEIN_GREY);
{
  const mat = makePatternMaterial('marble', marbleU);
  const group = new THREE.Group();
  const slab = new THREE.Mesh(new RoundedBoxGeometry(2.0, 0.16, 1.25, 4, 0.02), mat);
  slab.position.y = -0.5;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 96, 64), mat);
  ball.position.set(0.25, -0.42 + 0.42, -0.05);
  group.add(slab, ball);
  marbleScene.add(group);
  addStudioLights(marbleScene, 1.4);
  addFloor(marbleScene, -0.58, 2.8);
  contactShadow(marbleScene, -0.58, 2.6, 1.8, 0.6);
  contactShadow(marbleScene, -0.42, 0.9, 0.9, 0.55).position.x = 0.25;
  marbleScene.userData.camera.position.set(0.6, 1.25, 2.7);
  marbleScene.userData.controls.target.set(0, -0.2, 0);
  marbleScene.userData.controls.maxPolarAngle = Math.PI * 0.47;
  marbleScene.userData.meshes = { group, mat };
  marbleScene.userData.update = (t, dt) => { if (!reducedMotion) group.rotation.y += dt * 0.08; };
}

// —— Specimen 04: cut the block, solid 3D rule vs painted 2D picture ——
const BOARD = { x: 1.6, y: 0.6, z: 0.9 };
const cutEls = [document.querySelector('[data-scene="cut-solid"]'), document.querySelector('[data-scene="cut-painted"]')];
const cutU = woodShared();
cutU.uTrunk.value.set(-0.78, 0.32);
cutU.uRings.value = 10;
const cut = { c: BOARD.x / 2, views: [] };
cutEls.forEach((el, i) => {
  const s = makeScene(el, { bg: 0x16120d });
  const plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), BOARD.x / 2);
  const kind = i === 0 ? 'wood' : 'painted';
  const bodyMat = makePatternMaterial(kind, cutU, { clip: [plane], side: i === 0 ? THREE.FrontSide : THREE.DoubleSide });
  const capMat = makePatternMaterial('wood', cutU);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(BOARD.x, BOARD.y, BOARD.z), bodyMat);
  const capGeo = new THREE.PlaneGeometry(BOARD.z, BOARD.y);
  capGeo.rotateY(Math.PI / 2); // faces +x
  const cap = new THREE.Mesh(capGeo, capMat);
  if (i === 1) cap.userData.never = true; // a 2D picture has no inside to show
  const hz = BOARD.z / 2 + 0.004, hy = BOARD.y / 2 + 0.004;
  const ringGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, -hy, -hz), new THREE.Vector3(0, hy, -hz), new THREE.Vector3(0, hy, hz), new THREE.Vector3(0, -hy, hz),
  ]);
  const outline = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xf08aa8, toneMapped: false }));
  group.add(body, cap, outline);
  group.position.y = -0.1;
  s.add(group);
  addStudioLights(s);
  addFloor(s, -0.1 - BOARD.y / 2, 2.6);
  contactShadow(s, -0.1 - BOARD.y / 2, 2.4, 1.5, 0.6);
  s.userData.camera.position.set(2.2, 1.15, 1.7);
  s.userData.controls.target.set(0, -0.15, 0);
  s.userData.controls.maxPolarAngle = Math.PI * 0.49;
  s.userData.meshes = { group, body, cap, plane, capMat, outline };
  cut.views.push(s);
});
function setCut(v) {
  cut.c = BOARD.x / 2 - v * (BOARD.x * 0.82);
  for (const s of cut.views) {
    const { cap, capMat, outline } = s.userData.meshes;
    cap.position.x = cut.c;
    outline.position.x = cut.c + 0.002;
    const open = cut.c < BOARD.x / 2 - 0.005;
    cap.visible = open && !cap.userData.never;
    outline.visible = open;
    capMat.userData.u.uGOff.value.set(cut.c, 0, 0);
  }
}
{
  let leader = 0;
  cut.views.forEach((s, i) => s.userData.controls.addEventListener('start', () => { leader = i; }));
  const tmp = new THREE.Plane();
  cut.views.forEach((s, i) => {
    s.userData.update = (t, dt) => {
      if (i === 0 && shared.cutSpin && !reducedMotion) shared.cutT = (shared.cutT ?? 0) + dt;
      const { group, plane } = s.userData.meshes;
      group.rotation.y = shared.cutAngle + 0.5 * Math.sin((shared.cutT ?? 0) * 0.6);
      group.updateMatrixWorld(true);
      tmp.set(new THREE.Vector3(-1, 0, 0), cut.c).applyMatrix4(group.matrixWorld);
      plane.copy(tmp);
      if (leader !== i) {
        const L = cut.views[leader].userData;
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

bindRange('noise-oct', (v) => { noiseU.uOct.value = v; }, 0);
bindRange('noise-scale', (v) => { noiseU.uScale.value = v; }, 1);
bindRange('wood-spacing', (v) => { woodU.uRings.value = 9 / v; });
bindRange('wood-warp', (v) => { woodU.uWarp.value = v; });
bindRange('wood-turn', (v) => { woodMesh.rotation.y = -Math.PI / 2 + (v * Math.PI) / 180; }, 0);
bindRange('marble-turb', (v) => { marbleU.uTurb.value = v; });
bindToggle('[data-marble="gold"]', (on) => { marbleU.uVein.value.copy(on ? VEIN_GOLD : VEIN_GREY); });
bindRange('cut-depth', (v) => { setCut(v); });
bindToggle('[data-cut="spin"]', (on) => { shared.cutSpin = on; });

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
  octaves: OCT,
  cut,
};
