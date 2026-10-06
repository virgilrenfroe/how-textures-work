import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

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
renderer.setClearColor(0x0c0a06, 1);
renderer.domElement.style.pointerEvents = 'none';

const maxAniso = renderer.capabilities.getMaxAnisotropy();

const pmrem = new THREE.PMREMGenerator(renderer);
const envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const ACCENT = '#ffb020';
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

/** High-frequency herringbone / checker — designed to alias when minified without mips */
function makeHerringboneTex(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c0 = ((x >> 1) + (y >> 1)) & 1;
      const hbone = ((x + y) % 10 < 5) ? 1 : 0;
      const v = c0 ^ hbone;
      const i = (y * size + x) * 4;
      if (v) { d[i]=255; d[i+1]=176; d[i+2]=32; d[i+3]=255; }
      else { d[i]=22; d[i+1]=16; d[i+2]=6; d[i+3]=255; }
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 1;
  tex.needsUpdate = true;
  return tex;
}

function cloneTexSettings(src) {
  const t = src.clone();
  t.needsUpdate = true;
  return t;
}

const scenes = [];
const shared = {
  filterMode: 'nearest',
  filterDist: 0.35,
  mipsOn: true,
  mipsForce: false,
  mipsLevel: 0,
  mipsDist: 0.55,
  aniso: Math.min(8, maxAniso),
  anisoPitch: 0.55,
  comboDist: 0.65,
};

function makeScene(element, opts = {}) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.bg ?? 0x14110c);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 80);
  camera.position.set(0, opts.camY ?? 1.2, opts.camZ ?? 3.2);
  const controls = new OrbitControls(camera, element);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = opts.minDistance ?? 0.4;
  controls.maxDistance = 20;
  controls.target.set(0, 0, 0);
  controls.update();
  scene.userData = { element, camera, controls, update: null, meshes: {} };
  scenes.push(scene);
  return scene;
}

function addStudioLights(scene, key = 1.3) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.45;
  scene.add(new THREE.HemisphereLight(0xffe6c0, 0x1a1408, 0.4));
  const keyL = new THREE.DirectionalLight(0xfff2e0, key);
  keyL.position.set(2.5, 4, 2); scene.add(keyL);
  const rim = new THREE.DirectionalLight(0xffb020, 0.35);
  rim.position.set(-2, 1.5, -2); scene.add(rim);
}

function floorMesh(tex, w = 12, d = 12, seg = 1) {
  const geo = new THREE.PlaneGeometry(w, d, seg, seg);
  const mat = new THREE.MeshStandardMaterial({
    map: tex, roughness: 0.72, metalness: 0.04, color: 0xffffff,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

function patchMipBias(mat, uniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    mat.userData.shader = shader;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uForce;\nuniform float uLevel;`)
      .replace('#include <map_fragment>', `
#ifdef USE_MAP
  vec4 sampledDiffuseColor;
  if (uForce > 0.5) {
    sampledDiffuseColor = textureLod(map, vMapUv, uLevel);
  } else {
    sampledDiffuseColor = texture2D(map, vMapUv);
  }
  diffuseColor *= sampledDiffuseColor;
#endif
`);
  };
  mat.customProgramCacheKey = () => 'mip-bias-v1';
}

function setCamDistance(cam, controls, t, near = 1.1, far = 9.5, heightNear = 0.55, heightFar = 2.8) {
  // t=0 close, t=1 far
  const dist = near + (far - near) * t;
  const h = heightNear + (heightFar - heightNear) * t;
  cam.position.set(0, h, dist);
  controls.target.set(0, 0, -dist * 0.15);
  controls.update();
}

// —— Shared high-freq texture ——
const baseTex = makeHerringboneTex(512);
baseTex.repeat.set(24, 24);

// —— Hero ——
const heroEl = document.querySelector('[data-scene="hero"]');
const heroScene = makeScene(heroEl, { bg: 0x0c0a06, camZ: 2.8, camY: 0.9 });
heroScene.background = null;
addStudioLights(heroScene, 1.7);
{
  const tex = cloneTexSettings(baseTex);
  tex.repeat.set(6, 6);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(4, maxAniso);
  const mesh = new THREE.Mesh(
    new THREE.TorusKnotGeometry(0.55, 0.18, 120, 16),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, metalness: 0.12 })
  );
  mesh.rotation.x = 0.4; mesh.rotation.y = -0.5;
  heroScene.add(mesh);
  heroScene.userData.meshes = { group: mesh };
  const box = new THREE.Box3().setFromObject(mesh);
  const sphere = new THREE.Sphere(); box.getBoundingSphere(sphere);
  const cam = heroScene.userData.camera;
  const d = sphere.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov * 0.5));
  cam.position.set(0, sphere.center.y + d * 0.05, d * 0.98);
  heroScene.userData.controls.target.copy(sphere.center);
  heroScene.userData.controls.enabled = false;
  heroScene.userData.controls.update();
  heroScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y += dt * 0.25;
  };
}
const heroPost = makeHeroPost(ACCENT);
heroScene.userData.heroPost = heroPost;

// —— Specimen 01: Filtering ——
const filterEl = document.querySelector('[data-scene="filter"]');
const filterScene = makeScene(filterEl, { camZ: 3, camY: 1.2 });
addStudioLights(filterScene, 1.2);
{
  const tex = cloneTexSettings(baseTex);
  tex.repeat.set(20, 20);
  tex.generateMipmaps = false; // teach filtering without mips first
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const mesh = floorMesh(tex, 14, 14);
  filterScene.add(mesh);
  contactShadow(filterScene, -0.01, 10, 10, 0.35);
  filterScene.userData.meshes = { mesh, tex };
  filterScene.userData.controls.enabled = false;
  filterScene.userData.update = () => {
    setCamDistance(filterScene.userData.camera, filterScene.userData.controls, shared.filterDist, 1.0, 10, 0.5, 3.2);
  };
}

function applyFilterMode(mode) {
  shared.filterMode = mode;
  const { tex } = filterScene.userData.meshes;
  if (mode === 'nearest') {
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
  } else {
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
  }
  tex.needsUpdate = true;
}
function applyFilterDist(v) { shared.filterDist = v; }

// —— Specimen 02: Mipmaps ——
const mipsEl = document.querySelector('[data-scene="mips"]');
const mipsScene = makeScene(mipsEl, { camZ: 3, camY: 1.2 });
addStudioLights(mipsScene, 1.2);
{
  const tex = cloneTexSettings(baseTex);
  tex.repeat.set(22, 22);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const uForce = { value: 0 };
  const uLevel = { value: 0 };
  const mesh = floorMesh(tex, 14, 14);
  patchMipBias(mesh.material, { uForce, uLevel });
  mipsScene.add(mesh);
  contactShadow(mipsScene, -0.01, 10, 10, 0.35);
  mipsScene.userData.meshes = { mesh, tex, uForce, uLevel };
  mipsScene.userData.controls.enabled = false;
  mipsScene.userData.update = () => {
    setCamDistance(mipsScene.userData.camera, mipsScene.userData.controls, shared.mipsDist, 1.0, 11, 0.5, 3.4);
  };
}

function updateMipPyramid(level) {
  document.querySelectorAll('#mip-pyramid .mip-step').forEach((el) => {
    el.classList.toggle('active', Number(el.dataset.mip) === level);
  });
}

function applyMipsOn(on) {
  shared.mipsOn = on;
  const { tex, uForce } = mipsScene.userData.meshes;
  if (shared.mipsForce) {
    // forced mode owns filters
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    uForce.value = 1;
  } else if (on) {
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    uForce.value = 0;
  } else {
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    uForce.value = 0;
  }
  tex.needsUpdate = true;
  const sh = mipsScene.userData.meshes.mesh.material.userData.shader;
  if (sh) sh.uniforms.uForce.value = uForce.value;
}
function applyMipsForce(on) {
  shared.mipsForce = on;
  applyMipsOn(shared.mipsOn);
  if (on) {
    applyMipsLevel(shared.mipsLevel);
    updateMipPyramid(shared.mipsLevel);
  } else {
    updateMipPyramid(shared.mipsOn ? Math.round(shared.mipsDist * 3) : -1);
  }
}
function applyMipsLevel(v) {
  shared.mipsLevel = v;
  const { uLevel, mesh } = mipsScene.userData.meshes;
  uLevel.value = v;
  if (mesh.material.userData.shader) mesh.material.userData.shader.uniforms.uLevel.value = v;
  if (shared.mipsForce) updateMipPyramid(v);
}
function applyMipsDist(v) {
  shared.mipsDist = v;
  if (!shared.mipsForce) updateMipPyramid(shared.mipsOn ? Math.min(4, Math.round(v * 4)) : -1);
}

// —— Specimen 03: Anisotropy ——
const anisoEl = document.querySelector('[data-scene="aniso"]');
const anisoScene = makeScene(anisoEl, { camZ: 2.5, camY: 0.8 });
addStudioLights(anisoScene, 1.15);
{
  const tex = cloneTexSettings(baseTex);
  tex.repeat.set(16, 80); // long road, denser so aniso reads clearly
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = Math.min(8, maxAniso);
  tex.needsUpdate = true;
  const mesh = floorMesh(tex, 6, 40);
  mesh.position.z = -12;
  anisoScene.add(mesh);
  anisoScene.userData.meshes = { mesh, tex };
  anisoScene.userData.controls.enabled = false;
  anisoScene.userData.update = () => {
    const t = shared.anisoPitch;
    const cam = anisoScene.userData.camera;
    const ctl = anisoScene.userData.controls;
    // Grazing look-down a long plane
    const h = 0.22 + t * 1.4;
    const z = 5.2 - t * 1.2;
    cam.position.set(0, h, z);
    ctl.target.set(0, 0, -18);
    ctl.update();
  };
}
function applyAniso(n) {
  shared.aniso = n;
  const { tex } = anisoScene.userData.meshes;
  tex.anisotropy = Math.min(n, maxAniso);
  tex.needsUpdate = true;
}
function applyAnisoPitch(v) { shared.anisoPitch = v; }

// —— Specimen 04: Side by side (one scene, two floors) ——
const comboEl = document.querySelector('[data-scene="combo"]');
const comboScene = makeScene(comboEl, { camZ: 4, camY: 1.5 });
addStudioLights(comboScene, 1.2);
{
  const texOff = cloneTexSettings(baseTex);
  texOff.repeat.set(18, 18);
  texOff.generateMipmaps = false;
  texOff.minFilter = THREE.LinearFilter;
  texOff.magFilter = THREE.LinearFilter;
  texOff.needsUpdate = true;
  const texOn = cloneTexSettings(baseTex);
  texOn.repeat.set(18, 18);
  texOn.generateMipmaps = true;
  texOn.minFilter = THREE.LinearMipmapLinearFilter;
  texOn.magFilter = THREE.LinearFilter;
  texOn.needsUpdate = true;

  const left = floorMesh(texOff, 7, 12);
  left.position.x = -3.7;
  const right = floorMesh(texOn, 7, 12);
  right.position.x = 3.7;
  comboScene.add(left, right);

  // Labels via simple planes
  const makeLabel = (text, x) => {
    const c = document.createElement('canvas'); c.width = 512; c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(0,0,0,0)'; g.fillRect(0, 0, 512, 96);
    g.font = '600 36px Gabarito, sans-serif';
    g.fillStyle = '#ffb020'; g.textAlign = 'center';
    g.fillText(text, 256, 58);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 0.6), new THREE.MeshBasicMaterial({ map: t, transparent: true }));
    m.position.set(x, 0.02, 5.2); m.rotation.x = -Math.PI / 2;
    comboScene.add(m);
  };
  makeLabel('Copies off', -3.7);
  makeLabel('Copies on', 3.7);

  comboScene.userData.meshes = { left, right, texOff, texOn };
  comboScene.userData.controls.enabled = false;
  comboScene.userData.update = () => {
    setCamDistance(comboScene.userData.camera, comboScene.userData.controls, shared.comboDist, 2.2, 12, 1.0, 4.0);
  };
}
function applyComboDist(v) { shared.comboDist = v; }

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

document.querySelectorAll('[data-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    applyFilterMode(btn.getAttribute('data-filter'));
  });
});
bindRange('filter-dist', applyFilterDist);
applyFilterMode('nearest');

document.querySelectorAll('[data-mips]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-mips');
    if (key === 'on') {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      applyMipsOn(on);
    } else if (key === 'force') {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      applyMipsForce(on);
    }
  });
});
bindRange('mips-dist', applyMipsDist);
bindRange('mips-level', (v) => applyMipsLevel(Math.round(v)), 0);
applyMipsOn(true);
applyMipsLevel(0);
updateMipPyramid(2);

document.querySelectorAll('[data-aniso]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-aniso]').forEach((b) => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
    applyAniso(Number(btn.getAttribute('data-aniso')));
  });
});
bindRange('aniso-pitch', applyAnisoPitch);
applyAniso(Math.min(8, maxAniso));

bindRange('combo-dist', applyComboDist);

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
  renderer.setClearColor(0x0c0a06, 1); renderer.clear();
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
      renderer.setClearColor(0x0c0a06, 1);
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
  scenes, renderer, shared, maxAniso,
  get frameCount() { return frameCount; },
  get reducedMotion() { syncReduced(); return reducedMotion; },
  applyFilterMode, applyFilterDist,
  applyMipsOn, applyMipsForce, applyMipsLevel, applyMipsDist,
  applyAniso, applyAnisoPitch, applyComboDist,
};
