import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';

const errEl = document.getElementById('err');
function showErr(msg) {
  console.error(msg);
  errEl.style.display = 'block';
  errEl.textContent = 'The 3D views could not start. Reload the page, or try another browser.';
}
window.addEventListener('error', (e) => showErr(e.message || e.error || e));
window.addEventListener('unhandledrejection', (e) => showErr(e.reason));

const reduceMQ = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reduceMQ.matches;
const syncReduced = () => { reducedMotion = reduceMQ.matches; };
try { reduceMQ.addEventListener('change', syncReduced); }
catch (_) { try { reduceMQ.addListener(syncReduced); } catch (__) {} }

const coarseMQ = window.matchMedia('(pointer: coarse)');
const isMobile = () => window.innerWidth < 700 || coarseMQ.matches;
const pixelCap = () => Math.min(window.devicePixelRatio || 1, isMobile() ? 1.5 : 2);

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, powerPreference: 'high-performance',
  alpha: false, preserveDrawingBuffer: true,
});
renderer.setPixelRatio(pixelCap());
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.setClearColor(0x0c0610, 1);
renderer.domElement.style.pointerEvents = 'none';

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const ACCENT = '#ff4fd8';
const HERO_RT_SIZE = 320;

function makeHeroPost(accentHex) {
  const accent = new THREE.Color(accentHex);
  const rt = new THREE.WebGLRenderTarget(HERO_RT_SIZE, HERO_RT_SIZE, {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.UnsignedByteType,
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
    uniforms, transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.0,1.0); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tDiffuse; uniform vec3 uAccent; uniform vec2 uLens;
      uniform float uLensR; uniform float uCell; uniform vec2 uScreen; varying vec2 vUv;
      void main(){
        vec2 pix=vUv*uScreen; vec2 cellId=floor(pix/uCell); vec2 cUv=(cellId+0.5)*uCell/uScreen;
        vec4 cs=texture2D(tDiffuse,cUv); float cover=smoothstep(0.15,0.6,cs.a);
        float lum=dot(cs.rgb/max(cs.a,0.001),vec3(0.299,0.587,0.114));
        lum=clamp(pow(lum,0.65)*1.3+0.04,0.0,1.0);
        vec2 local=fract(pix/uCell)-0.5; float rad=mix(0.08,0.56,lum)*cover;
        float aa=1.2/uCell; float dotm=1.0-smoothstep(rad-aa,rad+aa,length(local));
        dotm*=step(0.001,rad); vec3 dotCol=uAccent*(0.5+0.8*lum);
        vec4 src=texture2D(tDiffuse,vUv); float minDim=min(uScreen.x,uScreen.y);
        float dl=length((vUv-uLens)*uScreen)/(uLensR*minDim);
        float lens=1.0-smoothstep(0.55,1.0,dl);
        float ring=smoothstep(0.86,0.97,dl)*(1.0-smoothstep(0.97,1.08,dl));
        ring*=smoothstep(0.05,0.5,src.a)*0.55;
        vec3 pre=mix(dotCol*dotm,src.rgb,lens)+uAccent*ring;
        float a=clamp(mix(dotm,src.a,lens)+ring,0.0,1.0);
        if(a<0.01) discard; gl_FragColor=vec4(pre/a,a);
      }`,
  });
  postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  return {
    rt, postScene, postCam, uniforms,
    lens: { x: 0.62, y: 0.48 }, target: { x: 0.62, y: 0.48 },
    lastPointer: -1e9, dragging: false,
  };
}

function contactShadow(scene, y, sx, sz, strength = 0.5) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 6, 64, 64, 64);
  grd.addColorStop(0, `rgba(0,0,0,${strength})`);
  grd.addColorStop(0.55, `rgba(0,0,0,${strength * 0.45})`);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(sx, sz),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2; m.position.y = y + 0.002; scene.add(m); return m;
}

function makeWoodTex(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#6b4a2e'; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 40; i++) {
    const y = (i / 40) * size;
    g.strokeStyle = `rgba(40,22,10,${0.15 + (i % 3) * 0.1})`;
    g.lineWidth = 1 + (i % 2);
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x < size; x += 8) g.lineTo(x, y + Math.sin(x * 0.04 + i) * 3);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  return t;
}

function makeMetalTex(size = 256) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, size, size);
  grd.addColorStop(0, '#8a9098'); grd.addColorStop(0.5, '#c5CAD0'); grd.addColorStop(1, '#6a7078');
  g.fillStyle = grd; g.fillRect(0, 0, size, size);
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
    g.fillRect(Math.random() * size, Math.random() * size, 2, 12);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeLogoTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  // transparent bg
  g.clearRect(0, 0, 256, 256);
  // rounded badge
  g.fillStyle = '#ff4fd8';
  roundRect(g, 24, 24, 208, 208, 28); g.fill();
  g.fillStyle = '#1a0614';
  roundRect(g, 40, 40, 176, 176, 20); g.fill();
  g.fillStyle = '#ff4fd8';
  g.font = 'bold 92px Space Grotesk, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('42', 128, 118);
  g.font = '600 22px JetBrains Mono, monospace';
  g.fillStyle = '#7ee0c8';
  g.fillText('UNIT', 128, 175);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeDirtTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  // soft blotches
  for (let i = 0; i < 18; i++) {
    const x = 40 + Math.random() * 176, y = 40 + Math.random() * 176;
    const r = 20 + Math.random() * 50;
    const grd = g.createRadialGradient(x, y, 2, x, y, r);
    grd.addColorStop(0, `rgba(40,28,18,${0.55 + Math.random() * 0.35})`);
    grd.addColorStop(1, 'rgba(40,28,18,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeScratchTex() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  // Deterministic thick scratches so toggle is obvious in screenshots and QA
  const strokes = [
    [28, 78, 90, 58, 160, 100, 232, 72],
    [24, 108, 95, 128, 155, 95, 236, 118],
    [32, 142, 100, 160, 165, 135, 228, 155],
    [36, 175, 110, 155, 170, 190, 230, 168],
  ];
  for (const [x0,y0,x1,y1,x2,y2,x3,y3] of strokes) {
    g.strokeStyle = 'rgba(245,245,250,0.95)';
    g.lineWidth = 7; g.lineCap = 'round';
    g.beginPath(); g.moveTo(x0,y0); g.bezierCurveTo(x1,y1,x2,y2,x3,y3); g.stroke();
    g.strokeStyle = 'rgba(15,12,18,0.55)';
    g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(x0,y0+2); g.bezierCurveTo(x1,y1+2,x2,y2+2,x3,y3+2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function makeCrate(size = 1.4) {
  const wood = makeWoodTex();
  const metal = makeMetalTex();
  const geo = new RoundedBoxGeometry(size, size * 0.85, size, 2, 0.04);
  const mat = new THREE.MeshStandardMaterial({
    map: wood, roughness: 0.78, metalness: 0.08, color: 0xffffff,
  });
  // mix metal bands via vertex colors? keep simple wood box with metal edge strips as children
  const mesh = new THREE.Mesh(geo, mat);
  const bandMat = new THREE.MeshStandardMaterial({ map: metal, roughness: 0.35, metalness: 0.75 });
  const mkBand = (sx, sy, sz, px, py, pz) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), bandMat);
    b.position.set(px, py, pz);
    mesh.add(b);
  };
  const s = size;
  mkBand(s * 1.02, 0.08, s * 1.02, 0, s * 0.32, 0);
  mkBand(s * 1.02, 0.08, s * 1.02, 0, -s * 0.32, 0);
  mkBand(0.08, s * 0.9, s * 1.02, s * 0.48, 0, 0);
  mkBand(0.08, s * 0.9, s * 1.02, -s * 0.48, 0, 0);
  return mesh;
}

function decalMaterial(map, { opacity = 1, multiply = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({
    map,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    roughness: multiply ? 0.9 : 0.55,
    metalness: 0.05,
    opacity,
    color: 0xffffff,
  });
  if (multiply) {
    mat.blending = THREE.MultiplyBlending;
    mat.transparent = true;
  }
  return mat;
}

function placeDecal(targetMesh, map, position, orientation, size, opts = {}) {
  const geo = new DecalGeometry(targetMesh, position, orientation, size);
  const mat = decalMaterial(map, opts);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = opts.order ?? 1;
  return mesh;
}

const scenes = [];
const shared = {
  place: { x: 0, y: 0.05, scale: 0.75, rot: 0 },
  blend: { op: 0.75, mode: 'cover' },
  proj: { angle: 15 },
  stack: { logo: true, scratch: true },
};

function makeScene(element, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.bg ?? 0x140c14);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.set(0, 0.55, opts.camZ ?? 3.2);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.4;
  controls.maxDistance = 6;
  controls.target.set(0, 0.05, 0);
  controls.update();
  scene.userData = { element, camera, controls, update: null, meshes: {} };
  scenes.push(scene);
  return scene;
}

function addStudioLights(scene, key = 1.35) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.5;
  scene.add(new THREE.HemisphereLight(0xffd6f0, 0x1a1018, 0.35));
  const keyL = new THREE.DirectionalLight(0xfff0e8, key);
  keyL.position.set(2.4, 3.5, 2.2); scene.add(keyL);
  const rim = new THREE.DirectionalLight(0xff4fd8, 0.4);
  rim.position.set(-2.2, 1.4, -2); scene.add(rim);
}

function addFloor(scene, y = -0.95) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 64),
    new THREE.MeshStandardMaterial({ color: 0x1a1018, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2; floor.position.y = y;
  scene.add(floor);
  return floor;
}

const logoTex = makeLogoTex();
const dirtTex = makeDirtTex();
const scratchTex = makeScratchTex();

// —— Hero ——
const heroEl = document.querySelector('[data-scene="hero"]');
const heroScene = makeScene(heroEl, { bg: 0x0c0610, camZ: 3.0 });
heroScene.background = null;
addStudioLights(heroScene, 1.8);
{
  const crate = makeCrate(1.35);
  crate.rotation.y = -0.35;
  heroScene.add(crate);
  const pos = new THREE.Vector3(0.05, 0.08, 0.68);
  const ori = new THREE.Euler(0, 0, 0);
  const dec = placeDecal(crate, logoTex, pos, ori, new THREE.Vector3(0.7, 0.7, 0.4), { opacity: 1, order: 2 });
  heroScene.add(dec);
  heroScene.userData.meshes = { group: crate };
  const box = new THREE.Box3().setFromObject(crate);
  const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere);
  const cam = heroScene.userData.camera;
  const d = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov * 0.5));
  cam.position.set(0.2, sphere.center.y + d * 0.08, d * 0.95);
  heroScene.userData.controls.target.copy(sphere.center);
  heroScene.userData.controls.enabled = false;
  heroScene.userData.controls.update();
  heroScene.userData.update = (t, dt) => {
    if (!reducedMotion) crate.rotation.y = -0.35 + Math.sin(t * 0.4) * 0.15;
  };
}
const heroPost = makeHeroPost(ACCENT);
heroScene.userData.heroPost = heroPost;

// —— Specimen 01: place ——
const placeEl = document.querySelector('[data-scene="place"]');
const placeScene = makeScene(placeEl, { camZ: 3.1 });
addStudioLights(placeScene, 1.3);
addFloor(placeScene);
contactShadow(placeScene, -0.95, 2.2, 1.6, 0.45);
{
  const crate = makeCrate(1.5);
  placeScene.add(crate);
  placeScene.userData.meshes = { crate, decal: null };
  placeScene.userData.controls.enabled = true;
  rebuildPlaceDecal();
}
function rebuildPlaceDecal() {
  const { crate } = placeScene.userData.meshes;
  const old = placeScene.userData.meshes.decal;
  if (old) {
    placeScene.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
  const p = shared.place;
  const pos = new THREE.Vector3(p.x, p.y, 0.76);
  const ori = new THREE.Euler(0, 0, THREE.MathUtils.degToRad(p.rot));
  const sz = 0.55 * p.scale;
  const dec = placeDecal(crate, logoTex, pos, ori, new THREE.Vector3(sz, sz, 0.5), { opacity: 1, order: 2 });
  placeScene.add(dec);
  placeScene.userData.meshes.decal = dec;
}

// —— Specimen 02: blend ——
const blendEl = document.querySelector('[data-scene="blend"]');
const blendScene = makeScene(blendEl, { camZ: 3.1 });
addStudioLights(blendScene, 1.3);
addFloor(blendScene);
contactShadow(blendScene, -0.95, 2.2, 1.6, 0.45);
{
  const crate = makeCrate(1.5);
  crate.rotation.y = 0.25;
  blendScene.add(crate);
  blendScene.userData.meshes = { crate, decal: null };
  rebuildBlendDecal();
}
function rebuildBlendDecal() {
  const { crate } = blendScene.userData.meshes;
  const old = blendScene.userData.meshes.decal;
  if (old) {
    blendScene.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
  const multiply = shared.blend.mode === 'multiply';
  const pos = new THREE.Vector3(0.05, -0.05, 0.76);
  const ori = new THREE.Euler(0, 0, 0.1);
  const dec = placeDecal(crate, dirtTex, pos, ori, new THREE.Vector3(1.1, 0.85, 0.5), {
    opacity: shared.blend.op, multiply, order: 2,
  });
  blendScene.add(dec);
  blendScene.userData.meshes.decal = dec;
}
function applyBlendOp(v) {
  shared.blend.op = v;
  const d = blendScene.userData.meshes.decal;
  if (d) d.material.opacity = v;
}

// —— Specimen 03: projection angle ——
const projEl = document.querySelector('[data-scene="project"]');
const projScene = makeScene(projEl, { camZ: 3.3 });
addStudioLights(projScene, 1.25);
addFloor(projScene, -0.9);
contactShadow(projScene, -0.9, 2.4, 1.8, 0.45);
{
  const crate = makeCrate(1.45);
  crate.rotation.y = 0.55; // show front and side
  projScene.add(crate);
  // projector arrow
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.1, 2.2), 1.4, 0xff4fd8, 0.22, 0.14
  );
  projScene.add(arrow);
  projScene.userData.meshes = { crate, decal: null, arrow };
  projScene.userData.controls.enabled = true;
  rebuildProjDecal();
}
function rebuildProjDecal() {
  const { crate, arrow } = projScene.userData.meshes;
  const old = projScene.userData.meshes.decal;
  if (old) {
    projScene.remove(old);
    old.geometry.dispose();
    old.material.dispose();
  }
  const ang = THREE.MathUtils.degToRad(shared.proj.angle);
  // Aim from in front, tilting downward toward the side — steep = more foreshortening on +X face
  const dir = new THREE.Vector3(Math.sin(ang), -0.05, -Math.cos(ang)).normalize();
  const hit = new THREE.Vector3(0.15 + Math.sin(ang) * 0.35, 0.05, 0.55 - Math.sin(ang) * 0.2);
  // Orientation: look along dir
  const ori = new THREE.Euler();
  const m = new THREE.Matrix4();
  m.lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0));
  ori.setFromRotationMatrix(m);
  // DecalGeometry uses orientation as the projector rotation
  const size = new THREE.Vector3(0.85, 0.85, 0.9);
  const dec = placeDecal(crate, logoTex, hit, ori, size, { opacity: 1, order: 2 });
  projScene.add(dec);
  projScene.userData.meshes.decal = dec;
  // Update arrow
  const origin = hit.clone().addScaledVector(dir, -1.6);
  arrow.position.copy(origin);
  arrow.setDirection(dir);
  const hint = document.getElementById('proj-hint');
  if (hint) {
    hint.textContent = shared.proj.angle < 25 ? 'square to the face'
      : shared.proj.angle < 50 ? 'tilted — starting to stretch'
        : 'steep — strong foreshortening';
  }
}

// —— Specimen 04: stack ——
const stackEl = document.querySelector('[data-scene="stack"]');
const stackScene = makeScene(stackEl, { camZ: 3.1 });
addStudioLights(stackScene, 1.3);
addFloor(stackScene);
contactShadow(stackScene, -0.95, 2.2, 1.6, 0.45);
{
  const crate = makeCrate(1.5);
  crate.rotation.y = -0.2;
  stackScene.add(crate);
  stackScene.userData.meshes = { crate, logo: null, scratch: null };
  rebuildStack();
}
function rebuildStack() {
  const { crate } = stackScene.userData.meshes;
  for (const key of ['logo', 'scratch']) {
    const old = stackScene.userData.meshes[key];
    if (old) {
      stackScene.remove(old);
      old.geometry.dispose();
      old.material.dispose();
      stackScene.userData.meshes[key] = null;
    }
  }
  if (shared.stack.logo) {
    const logo = placeDecal(
      crate, logoTex,
      new THREE.Vector3(0.02, 0.06, 0.76),
      new THREE.Euler(0, 0, -0.05),
      new THREE.Vector3(0.8, 0.8, 0.45),
      { opacity: 1, order: 2 }
    );
    stackScene.add(logo);
    stackScene.userData.meshes.logo = logo;
  }
  if (shared.stack.scratch) {
    const scratch = placeDecal(
      crate, scratchTex,
      new THREE.Vector3(0.05, 0.0, 0.77),
      new THREE.Euler(0, 0, 0.2),
      new THREE.Vector3(1.05, 0.7, 0.45),
      { opacity: 0.95, order: 3 }
    );
    stackScene.add(scratch);
    stackScene.userData.meshes.scratch = scratch;
  }
}

// —— UI ——
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

bindRange('place-x', (v) => { shared.place.x = v; rebuildPlaceDecal(); });
bindRange('place-y', (v) => { shared.place.y = v; rebuildPlaceDecal(); });
bindRange('place-scale', (v) => { shared.place.scale = v; rebuildPlaceDecal(); });
bindRange('place-rot', (v) => { shared.place.rot = v; rebuildPlaceDecal(); }, 0);

document.querySelectorAll('[data-blend]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-blend]').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    shared.blend.mode = btn.getAttribute('data-blend');
    rebuildBlendDecal();
  });
});
bindRange('blend-op', applyBlendOp);

bindRange('proj-angle', (v) => { shared.proj.angle = v; rebuildProjDecal(); }, 0);

document.querySelectorAll('[data-stack]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-stack');
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    shared.stack[key] = on;
    rebuildStack();
  });
});

// Hero lens
{
  const el = heroEl; const post = heroPost;
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

// —— Render ——
let frameCount = 0; let last = performance.now();
function render(now) {
  requestAnimationFrame(render);
  if (document.hidden) return;
  syncReduced();
  const dt = Math.min(0.05, (now - last) / 1000); last = now; frameCount += 1;
  const w = window.innerWidth, h = window.innerHeight, pr = pixelCap();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
    renderer.setPixelRatio(pr); renderer.setSize(w, h, false);
  }
  renderer.setScissorTest(false);
  renderer.setClearColor(0x0c0610, 1); renderer.clear();
  renderer.setScissorTest(true);

  for (const scene of scenes) {
    const el = scene.userData.element;
    const rect = el.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) continue;
    const width = Math.floor(rect.width), height = Math.floor(rect.height);
    if (width < 2 || height < 2) continue;
    const left = Math.floor(rect.left), bottom = Math.floor(h - rect.bottom);
    const cam = scene.userData.camera;
    cam.aspect = width / height; cam.updateProjectionMatrix();
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
        post.rt.setSize(rtW, rtH); post.uniforms.uRes.value.set(rtW, rtH);
      }
      renderer.setRenderTarget(post.rt);
      renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      post.uniforms.tDiffuse.value = post.rt.texture;
      post.uniforms.uLens.value.set(post.lens.x, post.lens.y);
      post.uniforms.uScreen.value.set(width * pr, height * pr);
      post.uniforms.uTime.value = tnow;
      renderer.setClearColor(0x0c0610, 1);
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
  scenes, renderer, shared,
  get frameCount() { return frameCount; },
  get reducedMotion() { syncReduced(); return reducedMotion; },
  rebuildPlaceDecal, rebuildBlendDecal, rebuildProjDecal, rebuildStack,
};
