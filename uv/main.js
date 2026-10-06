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
renderer.toneMappingExposure = 0.95;
renderer.setClearColor(0x080a12, 1);
renderer.domElement.style.pointerEvents = 'none';

const pmrem = new THREE.PMREMGenerator(renderer);
const room = new RoomEnvironment();
const envMap = pmrem.fromScene(room, 0.04).texture;
room.dispose?.();
pmrem.dispose();

const ACCENT = '#7b8cff';
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
      varying vec2 vUv;
      void main() {
        vec2 pix = vUv * uScreen;
        vec2 cellId = floor(pix / uCell);
        vec2 cUv = (cellId + 0.5) * uCell / uScreen;
        vec4 cs = texture2D(tDiffuse, cUv);
        float cover = smoothstep(0.15, 0.6, cs.a);
        float lum = dot(cs.rgb / max(cs.a, 0.001), vec3(0.299, 0.587, 0.114));
        lum = clamp(pow(lum, 0.65) * 1.3 + 0.04, 0.0, 1.0);
        vec2 local = fract(pix / uCell) - 0.5;
        float rad = mix(0.08, 0.56, lum) * cover;
        float aa = 1.2 / uCell;
        float dotm = 1.0 - smoothstep(rad - aa, rad + aa, length(local));
        dotm *= step(0.001, rad);
        vec3 dotCol = uAccent * (0.5 + 0.8 * lum);
        vec4 src = texture2D(tDiffuse, vUv);
        float minDim = min(uScreen.x, uScreen.y);
        float dl = length((vUv - uLens) * uScreen) / (uLensR * minDim);
        float lens = 1.0 - smoothstep(0.55, 1.0, dl);
        float ring = smoothstep(0.86, 0.97, dl) * (1.0 - smoothstep(0.97, 1.08, dl));
        ring *= smoothstep(0.05, 0.5, src.a) * 0.55;
        vec3 pre = mix(dotCol * dotm, src.rgb, lens) + uAccent * ring;
        float a = clamp(mix(dotm, src.a, lens) + ring, 0.0, 1.0);
        if (a < 0.01) discard;
        gl_FragColor = vec4(pre / a, a);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  return {
    rt, postScene, postCam, uniforms,
    lens: { x: 0.62, y: 0.48 },
    target: { x: 0.62, y: 0.48 },
    lastPointer: -1e9,
    dragging: false,
  };
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

function makeCheckerTex(cells = 8, size = 256, c0 = '#1a1f33', c1 = '#7b8cff') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const s = size / cells;
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    g.fillStyle = (x + y) % 2 === 0 ? c0 : c1;
    g.fillRect(x * s, y * s, s + 0.5, s + 0.5);
  }
  // thin grid so stretch is obvious
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.lineWidth = 1;
  for (let i = 0; i <= cells; i++) {
    g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, size); g.stroke();
    g.beginPath(); g.moveTo(0, i * s); g.lineTo(size, i * s); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

function makeStripeTex(bands = 12, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const w = size / bands;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 === 0 ? '#c6e05a' : '#1a1f33';
    g.fillRect(i * w, 0, w + 0.5, size);
  }
  // numbered tick near seam (U=0)
  g.fillStyle = '#7b8cff';
  g.fillRect(0, 0, 4, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

function makeRockTex(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#4a5568';
  g.fillRect(0, 0, size, size);
  // cheap value-noise-ish speckles
  for (let i = 0; i < 1800; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = 2 + Math.random() * 10;
    const lum = 40 + Math.random() * 90;
    g.fillStyle = `rgb(${lum},${lum * 0.95},${lum * 0.85})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // cracks
  g.strokeStyle = 'rgba(20,22,28,0.55)';
  g.lineWidth = 1.5;
  for (let i = 0; i < 14; i++) {
    g.beginPath();
    let x = Math.random() * size, y = Math.random() * size;
    g.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += (Math.random() - 0.5) * 40;
      y += (Math.random() - 0.5) * 40;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const scenes = [];
const shared = {
  uvMode: 'good',
  showNet: false,
  seamOff: 0,
  tripOn: true,
  tripSharp: 4,
  tripSpin: true,
  tripT: 0,
  texelScale: 1,
  basePPU: 64,
};

function makeScene(element, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.bg ?? 0x10131c);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.45, opts.camZ ?? 3.3);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = opts.minDistance ?? 1.5;
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
    new THREE.MeshStandardMaterial({ color: 0x151822, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = y;
  scene.add(floor);
  return floor;
}

function addStudioLights(scene, key = 1.4) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xb8c4ff, 0x1a1520, 0.35));
  const keyL = new THREE.DirectionalLight(0xfff2e0, key);
  keyL.position.set(2.2, 3.4, 2.5);
  scene.add(keyL);
  const rim = new THREE.DirectionalLight(0x7b8cff, 0.4);
  rim.position.set(-2.5, 1.5, -2);
  scene.add(rim);
}

function rockGeometry(detail = 2) {
  const geo = new THREE.IcosahedronGeometry(0.85, detail);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    const bump = 0.12 * Math.sin(n.x * 7.1 + n.y * 5.3) * Math.cos(n.z * 6.2 + n.x * 3.1)
      + 0.07 * Math.sin(n.y * 11.0 + n.z * 9.0);
    v.addScaledVector(n, bump);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Triplanar material: samples the same map from XYZ, blends by normal^sharp */
function makeTriplanarMaterial(map, sharpUniform) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.05,
    map,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSharp = sharpUniform;
    shader.uniforms.uTripOn = { value: 1 };
    shader.uniforms.uScale = { value: 1.6 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>\nvWP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvWN = normalize(mat3(modelMatrix) * normal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vWP;\nvarying vec3 vWN;\nuniform float uSharp;\nuniform float uTripOn;\nuniform float uScale;`)
      .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 sampledDiffuseColor;
  if (uTripOn > 0.5) {
    vec3 n = normalize(vWN);
    vec3 bn = pow(abs(n), vec3(uSharp));
    bn /= max(bn.x + bn.y + bn.z, 1e-4);
    vec4 cx = texture2D(map, vWP.zy * uScale);
    vec4 cy = texture2D(map, vWP.xz * uScale);
    vec4 cz = texture2D(map, vWP.xy * uScale);
    sampledDiffuseColor = cx * bn.x + cy * bn.y + cz * bn.z;
  } else {
    sampledDiffuseColor = texture2D(map, vMapUv);
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`);
  };
  mat.customProgramCacheKey = () => 'triplanar-v1';
  return mat;
}

// —— Hero: checker capsule / character-like form ——
const heroEl = document.querySelector('[data-scene="hero"]');
const heroScene = makeScene(heroEl, { bg: 0x080a12, camZ: 3.2 });
heroScene.background = null; // alpha for hero post
renderer.setClearAlpha(0);
addStudioLights(heroScene, 1.8);
const heroChecker = makeCheckerTex(10, 256, '#12162a', '#9aa8ff');
heroChecker.repeat.set(2, 2);
{
  // One mesh so the hero-mask QA sphere matches the silhouette (capsule reads as a simple wrapped form)
  const mat = new THREE.MeshStandardMaterial({ map: heroChecker, roughness: 0.52, metalness: 0.08 });
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.62, 0.95, 10, 28), mat);
  mesh.rotation.y = -0.4;
  mesh.rotation.z = 0.12;
  heroScene.add(mesh);
  heroScene.userData.meshes = { group: mesh };
  const box = new THREE.Box3().setFromObject(mesh);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  const cam = heroScene.userData.camera;
  const d = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov * 0.5));
  cam.position.set(0, sphere.center.y + d * 0.05, d * 0.98);
  heroScene.userData.controls.target.copy(sphere.center);
  heroScene.userData.controls.enabled = false;
  heroScene.userData.controls.update();
}
const heroPost = makeHeroPost(ACCENT);
heroScene.userData.heroPost = heroPost;

// —— Specimen 01: UV quality on a cylinder ——
const uvEl = document.querySelector('[data-scene="uv"]');
const uvScene = makeScene(uvEl, { camZ: 3.0 });
addStudioLights(uvScene, 1.3);
addFloor(uvScene, -1.0, 2.2);
contactShadow(uvScene, -1.0, 1.8, 1.2, 0.45);
{
  const checker = makeCheckerTex(8, 256);
  const geoGood = new THREE.CylinderGeometry(0.7, 0.7, 1.6, 48, 1, false);
  const geoStretch = geoGood.clone();
  // squash V on stretch geo so checkers look pulled vertically on the wall
  const uvAttr = geoStretch.attributes.uv;
  for (let i = 0; i < uvAttr.count; i++) {
    const u = uvAttr.getX(i);
    const v = uvAttr.getY(i);
    // radial faces: exaggerate V near mid-height; keep caps mostly ok
    uvAttr.setXY(i, u * 0.22 + 0.05, Math.pow(Math.min(1, Math.max(0, v)), 0.35) * 2.4 - 0.35);
  }
  uvAttr.needsUpdate = true;

  const mat = new THREE.MeshStandardMaterial({
    map: checker,
    roughness: 0.55,
    metalness: 0.06,
  });
  // seam highlight via shader when mode=seam
  const uSeam = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSeam = uSeam;
    mat.userData.shader = shader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uSeam;`)
      .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  diffuseColor *= sampledDiffuseColor;
  if (uSeam > 0.5) {
    float su = min(fract(vMapUv.x), 1.0 - fract(vMapUv.x));
    float band = 1.0 - smoothstep(0.0, 0.08, su);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.78, 0.88, 0.35), band * 0.98);
  }
#endif
`);
  };
  mat.customProgramCacheKey = () => 'uv-seam-v1';

  const mesh = new THREE.Mesh(geoGood, mat);
  mesh.position.y = -0.15;
  uvScene.add(mesh);
  uvScene.userData.meshes = { mesh, geoGood, geoStretch, mat, uSeam, checker };
  uvScene.userData.controls.enableRotate = true;
  uvScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y += dt * 0.25;
  };
}

function applyUvMode(mode) {
  shared.uvMode = mode;
  const { mesh, geoGood, geoStretch, uSeam, checker } = uvScene.userData.meshes;
  if (mode === 'stretch') {
    mesh.geometry = geoStretch;
    checker.repeat.set(1, 1);
    uSeam.value = 0;
    mesh.material.color.setHex(0xffffff);
  } else if (mode === 'seam') {
    mesh.geometry = geoGood;
    checker.repeat.set(1, 1);
    uSeam.value = 1;
    mesh.rotation.y = Math.PI; // put the seam on the front
    mesh.material.color.setHex(0xdde3ff); // slight lift so the mode is measurable even if the band is thin
  } else {
    mesh.geometry = geoGood;
    checker.repeat.set(1, 1);
    uSeam.value = 0;
    mesh.material.color.setHex(0xffffff);
  }
  if (mesh.material.userData.shader) mesh.material.userData.shader.uniforms.uSeam.value = uSeam.value;
}

// —— Specimen 02: seam offset ——
const seamEl = document.querySelector('[data-scene="seam"]');
const seamScene = makeScene(seamEl, { camZ: 3.0 });
addStudioLights(seamScene, 1.3);
addFloor(seamScene, -1.0, 2.2);
contactShadow(seamScene, -1.0, 1.8, 1.2, 0.45);
{
  const stripes = makeStripeTex(16, 256);
  const geo = new THREE.CylinderGeometry(0.7, 0.7, 1.6, 64, 1, false);
  const mat = new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.5, metalness: 0.05 });
  const uOff = { value: 0 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOff = uOff;
    mat.userData.shader = shader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uOff;`)
      .replace('#include <map_fragment>', `
#ifdef USE_MAP
  // Shift only the half of the unwrap past the cut (u near 0/1), so the seam itself misaligns
  float uu = vMapUv.x;
  float shift = uOff * (1.0 - smoothstep(0.02, 0.12, min(uu, 1.0 - uu)));
  // Stronger: offset one side of the seam edge
  vec2 suv = vec2(uu + (uu < 0.5 ? 0.0 : uOff * 0.55), vMapUv.y);
  vec4 sampledDiffuseColor = texture2D(map, suv);
  diffuseColor *= sampledDiffuseColor;
  // Mark the true seam with a thin accent when offset is large
  float seam = 1.0 - smoothstep(0.0, 0.02, min(uu, 1.0 - uu));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.48, 0.55, 1.0), seam * smoothstep(0.05, 0.25, uOff) * 0.85);
#endif
`);
  };
  mat.customProgramCacheKey = () => 'seam-off-v2';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.15;
  mesh.rotation.y = Math.PI; // face the seam toward the camera
  seamScene.add(mesh);
  seamScene.userData.meshes = { mesh, stripes, uOff };
  seamScene.userData.controls.enabled = false; // slider owns the lesson; auto-spin only
  seamScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y = Math.PI + Math.sin(t * 0.4) * 0.55;
  };
}

function applySeamOffset(v) {
  shared.seamOff = v;
  const { mesh, uOff } = seamScene.userData.meshes;
  uOff.value = v;
  if (mesh.material.userData.shader) mesh.material.userData.shader.uniforms.uOff.value = v;
}

// —— Specimen 03: triplanar vs UV (side by side) ——
const rockMap = makeRockTex(256);
rockMap.repeat.set(2, 2);

function buildTripScene(el, kind) {
  const sc = makeScene(el, { camZ: 2.8 });
  addStudioLights(sc, 1.25);
  addFloor(sc, -1.0, 2.0);
  contactShadow(sc, -1.0, 1.6, 1.2, 0.5);
  const geo = rockGeometry(isMobile() ? 1 : 2);
  const sharpU = { value: shared.tripSharp };
  let mat;
  if (kind === 'uv') {
    mat = new THREE.MeshStandardMaterial({ map: rockMap, roughness: 0.85, metalness: 0.04 });
    // Deliberately bad-ish UVs on a sphere-like rock: default icosahedron UVs show polar stretch
  } else {
    mat = makeTriplanarMaterial(rockMap.clone(), sharpU);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.05;
  sc.add(mesh);
  sc.userData.meshes = { mesh, sharpU, kind };
  sc.userData.controls.enableRotate = true;
  return sc;
}
const tripUvScene = buildTripScene(document.querySelector('[data-scene="trip-uv"]'), 'uv');
const tripTriScene = buildTripScene(document.querySelector('[data-scene="trip-tri"]'), 'tri');

function syncTripCameras() {
  // keep both views matching
  const a = tripUvScene.userData;
  const b = tripTriScene.userData;
  b.camera.position.copy(a.camera.position);
  b.camera.quaternion.copy(a.camera.quaternion);
  b.controls.target.copy(a.controls.target);
}
tripUvScene.userData.update = (t, dt) => {
  if (shared.tripSpin && !reducedMotion) {
    shared.tripT = (shared.tripT ?? 0) + dt;
    const ang = shared.tripT * 0.35;
    tripUvScene.userData.meshes.mesh.rotation.y = ang;
    tripTriScene.userData.meshes.mesh.rotation.y = ang;
  }
  syncTripCameras();
  // mirror controls from left to right each frame after left updates
};
tripTriScene.userData.controls.addEventListener('change', () => {
  // if user orbits the right view, push to left
  const a = tripUvScene.userData;
  const b = tripTriScene.userData;
  a.camera.position.copy(b.camera.position);
  a.camera.quaternion.copy(b.camera.quaternion);
  a.controls.target.copy(b.controls.target);
});

function applyTripSharp(v) {
  shared.tripSharp = v;
  const sh = tripTriScene.userData.meshes;
  sh.sharpU.value = v;
  if (sh.mesh.material.userData.shader) sh.mesh.material.userData.shader.uniforms.uSharp.value = v;
}
function applyTripOn(on) {
  shared.tripOn = on;
  const sh = tripTriScene.userData.meshes;
  const shader = sh.mesh.material.userData.shader;
  if (shader) shader.uniforms.uTripOn.value = on ? 1 : 0;
  // When off, still show the rock but with ordinary UV sampling of the same map
}

// —— Specimen 04: texel density ——
const texelEl = document.querySelector('[data-scene="texel"]');
const texelScene = makeScene(texelEl, { camZ: 3.2 });
addStudioLights(texelScene, 1.35);
addFloor(texelScene, -1.0, 2.2);
contactShadow(texelScene, -1.0, 2.0, 1.4, 0.5);
{
  const checker = makeCheckerTex(8, 256, '#1a1f33', '#c6e05a');
  // 256px texture, 8 cells → 32 px per cell; default UV covers ~1 unit on a face → 64 ppu at scale 1 with repeat 2
  const geo = new RoundedBoxGeometry(1.5, 1.1, 1.1, 2, 0.06);
  const mat = new THREE.MeshStandardMaterial({ map: checker, roughness: 0.48, metalness: 0.08 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -0.2;
  texelScene.add(mesh);
  texelScene.userData.meshes = { mesh, checker };
  texelScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y += dt * 0.22;
  };
}
function applyTexelScale(v) {
  shared.texelScale = v;
  const { checker } = texelScene.userData.meshes;
  checker.repeat.set(2 * v, 2 * v);
  const ppu = Math.round(shared.basePPU * v);
  const el = document.getElementById('texel-ppu');
  if (el) el.textContent = String(ppu);
}

// —— UI bindings ——
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
function bindToggle(sel, attr, fn) {
  document.querySelectorAll(sel).forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute(attr);
      fn(key, btn);
    });
  });
}

// UV mode chips (exclusive except net)
bindToggle('[data-uv]', 'data-uv', (key, btn) => {
  if (key === 'net') {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    shared.showNet = on;
    document.getElementById('uv-net').classList.toggle('on', on);
    return;
  }
  document.querySelectorAll('[data-uv="good"],[data-uv="stretch"],[data-uv="seam"]').forEach((b) => {
    b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
  });
  applyUvMode(key);
});
applyUvMode('good');

bindRange('seam-off', applySeamOffset);
applySeamOffset(0);

bindRange('trip-sharp', applyTripSharp);
bindToggle('[data-trip]', 'data-trip', (key, btn) => {
  if (key === 'on') {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    applyTripOn(on);
  } else if (key === 'spin') {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    shared.tripSpin = on;
  }
});
applyTripOn(true);

bindRange('texel-scale', applyTexelScale);
applyTexelScale(1);

// Hero lens
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

// —— Render loop ——
let frameCount = 0;
let last = performance.now();
function render(now) {
  requestAnimationFrame(render);
  if (document.hidden) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  frameCount += 1;

  const w = window.innerWidth;
  const h = window.innerHeight;
  const pr = pixelCap();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
  }

  renderer.setScissorTest(false);
  renderer.setClearColor(0x080a12, 1);
  renderer.clear();
  renderer.setScissorTest(true);

  for (const scene of scenes) {
    const el = scene.userData.element;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) continue;
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    if (width < 2 || height < 2) continue;
    const left = Math.floor(rect.left);
    const bottom = Math.floor(h - rect.bottom);

    const cam = scene.userData.camera;
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
    scene.userData.controls?.update();
    scene.userData.update?.(now * 0.001, dt);

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
      const rtW = Math.round(Math.min(720, Math.max(240, width * pr * 0.5)));
      const rtH = Math.max(96, Math.round(rtW / aspect));
      if (post.rt.width !== rtW || post.rt.height !== rtH) {
        post.rt.setSize(rtW, rtH);
        post.uniforms.uRes.value.set(rtW, rtH);
      }
      renderer.setRenderTarget(post.rt);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      post.uniforms.tDiffuse.value = post.rt.texture;
      post.uniforms.uLens.value.set(post.lens.x, post.lens.y);
      post.uniforms.uScreen.value.set(width * pr, height * pr);
      post.uniforms.uTime.value = tnow;
      renderer.setClearColor(0x080a12, 1);
      renderer.render(post.postScene, post.postCam);
    } else {
      renderer.render(scene, cam);
    }
  }
}
requestAnimationFrame(render);

window.addEventListener('resize', () => {
  renderer.setPixelRatio(pixelCap());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

window.__HTW = window.__HSW = {
  scenes,
  renderer,
  shared,
  get frameCount() { return frameCount; },
  get reducedMotion() { return reducedMotion; },
  applyUvMode,
  applySeamOffset,
  applyTripOn,
  applyTripSharp,
  applyTexelScale,
};
