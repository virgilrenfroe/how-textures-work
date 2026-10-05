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
    uReveal: { value: 0.38 },
    uCell: { value: 5.5 },
    uTime: { value: 0 },
    uRes: { value: new THREE.Vector2(HERO_RT_SIZE, HERO_RT_SIZE) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
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
      uniform float uReveal;
      uniform float uCell;
      uniform float uTime;
      uniform vec2 uRes;
      varying vec2 vUv;

      float glyph(vec2 p, float level) {
        // Simple density glyphs via bars/dots (ASCII-adjacent, not a font atlas)
        float d = 1.0;
        if (level < 0.12) return 0.0;
        if (level < 0.28) {
          d = step(0.42, abs(p.x)) * step(abs(p.y), 0.12); // :
        } else if (level < 0.45) {
          d = 1.0 - smoothstep(0.18, 0.28, length(p)); // .
        } else if (level < 0.62) {
          d = step(abs(p.x), 0.1) + step(abs(p.y), 0.1); // +
          d = clamp(d, 0.0, 1.0);
        } else if (level < 0.8) {
          d = step(abs(p.x), 0.12) + step(abs(p.y), 0.32) * step(abs(p.x), 0.32); // #
          d = clamp(d, 0.0, 1.0);
        } else {
          d = 1.0 - smoothstep(0.34, 0.42, max(abs(p.x), abs(p.y))); // block
        }
        return clamp(d, 0.0, 1.0);
      }

      void main() {
        vec4 src = texture2D(tDiffuse, vUv);
        float lum = dot(src.rgb, vec3(0.299, 0.587, 0.114));
        // Lift darks so terracotta / dark metals still print glyphs
        lum = clamp(pow(lum, 0.62) * 1.55 + 0.08, 0.0, 1.0);
        vec2 pix = vUv * uRes;
        vec2 cell = floor(pix / uCell);
        vec2 local = fract(pix / uCell) - 0.5;
        float g = glyph(local, lum);
        // Halftone underlay — denser fill like a data portrait
        float rad = mix(0.08, 0.48, pow(lum, 0.75));
        float dots = 1.0 - smoothstep(rad, rad + 0.05, length(local));
        float mark = max(g * 0.95, dots * 0.75);
        vec3 stylized = uAccent * (0.05 + mark * (0.55 + lum * 1.55));
        stylized += uAccent * 0.06 * sin(cell.x * 0.7 + cell.y * 1.1 + uTime * 0.6);
        // Soft vignette keeps energy on the form
        float vig = smoothstep(1.15, 0.35, length(vUv - 0.5) * 1.35);
        stylized *= 0.55 + 0.55 * vig;

        // Soft vertical reveal sweep (true PBR to the right of the line)
        float edge = 0.02;
        float reveal = smoothstep(uReveal - edge, uReveal + edge, vUv.x);
        // Thin scan line at the reveal edge
        float scan = smoothstep(0.0, 0.01, abs(vUv.x - uReveal)) * smoothstep(0.035, 0.0, abs(vUv.x - uReveal));
        vec3 col = mix(stylized, src.rgb, reveal);
        col += uAccent * scan * 1.4;
        gl_FragColor = vec4(col, 1.0);
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
    reveal: 0.38,
    pointerX: 0.55,
    dragging: false,
  };
}

// —— Procedural textures ——
function canvasTex(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return { canvas: c, ctx, tex };
}

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi);
  const b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1);
  const d = hash2(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
function fbm(x, y, oct = 4) {
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    v += a * noise2(x * f, y * f);
    a *= 0.5;
    f *= 2;
  }
  return v;
}

const uvGrid = canvasTex((ctx, s) => {
  ctx.fillStyle = '#1a1a22';
  ctx.fillRect(0, 0, s, s);
  const cells = 8;
  const cell = s / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const on = (x + y) % 2 === 0;
      ctx.fillStyle = on ? '#e8dfd0' : '#2a3344';
      ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.strokeStyle = '#ff5a1f';
      ctx.lineWidth = 2;
      ctx.strokeRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
      ctx.fillStyle = '#c8f542';
      ctx.font = `bold ${Math.floor(cell * 0.28)}px monospace`;
      ctx.fillText(`${x},${y}`, x * cell + 6, y * cell + cell * 0.55);
    }
  }
  // U/V axes hint
  ctx.fillStyle = '#7ec8ff';
  ctx.font = `bold ${Math.floor(s * 0.06)}px monospace`;
  ctx.fillText('U →', s * 0.78, s * 0.08);
  ctx.fillText('V ↑', s * 0.04, s * 0.92);
}, 512);

function makeWood() {
  const albedo = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = fbm(x * 0.02, y * 0.08, 5);
        const grain = Math.sin((x + n * 40) * 0.15) * 0.5 + 0.5;
        const r = 110 + grain * 90 + n * 30;
        const g = 70 + grain * 50 + n * 20;
        const b = 35 + grain * 25;
        const i = (y * s + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, 512);
  const rough = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = fbm(x * 0.03, y * 0.05, 4);
        const worn = n > 0.55 ? 0.85 : 0.25;
        const v = Math.floor(worn * 255);
        const i = (y * s + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, 512);
  rough.tex.colorSpace = THREE.NoColorSpace;
  return { albedo, rough };
}

function makeMarble() {
  const albedo = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = fbm(x * 0.015, y * 0.015, 5);
        const vein = Math.abs(Math.sin((x * 0.04 + n * 6)));
        const base = 220 - n * 40;
        const r = base - vein * 80;
        const g = base - vein * 60;
        const b = base - vein * 40;
        const i = (y * s + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, 512);
  const rough = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = fbm(x * 0.04, y * 0.04, 3);
        const v = Math.floor((0.2 + n * 0.55) * 255);
        const i = (y * s + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, 512);
  rough.tex.colorSpace = THREE.NoColorSpace;
  return { albedo, rough };
}

const wood = makeWood();
const marble = makeMarble();

// Height / normal: shared regular grid of round studs (~10 across)
function makeHeightNormal(size = 512) {
  const heightData = new Float32Array(size * size);
  const cols = 10;
  const rows = 10;
  const cell = 1 / cols;
  const radius = cell * 0.38;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // nearest cell center (tileable)
      const cx = (Math.floor(u * cols) + 0.5) * cell;
      const cy = (Math.floor(v * rows) + 0.5) * cell;
      let dx = u - cx;
      let dy = v - cy;
      // wrap-aware shortest delta
      if (dx > 0.5) dx -= 1; if (dx < -0.5) dx += 1;
      if (dy > 0.5) dy -= 1; if (dy < -0.5) dy += 1;
      const d = Math.hypot(dx, dy);
      let h = 0.42; // base plateau
      if (d < radius) {
        const t = 1 - d / radius;
        // raised round stud with soft rim
        const dome = t * t * (3 - 2 * t);
        h = 0.42 + dome * 0.58;
      }
      heightData[y * size + x] = h;
    }
  }
  // mean for displacement bias (keep average radius matched to left)
  let sum = 0;
  for (let i = 0; i < heightData.length; i++) sum += heightData[i];
  const mean = sum / heightData.length;

  const height = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let i = 0; i < s * s; i++) {
      const v = Math.floor(THREE.MathUtils.clamp(heightData[i], 0, 1) * 255);
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, size);
  height.tex.colorSpace = THREE.NoColorSpace;
  height.tex.minFilter = THREE.LinearFilter;
  height.tex.magFilter = THREE.LinearFilter;

  const normal = canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    const strength = 12; // strong slopes so bumps read under raking light
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const hL = heightData[y * s + ((x - 1 + s) % s)];
        const hR = heightData[y * s + ((x + 1) % s)];
        const hD = heightData[((y - 1 + s) % s) * s + x];
        const hU = heightData[((y + 1) % s) * s + x];
        const dx = (hL - hR) * strength;
        const dy = (hD - hU) * strength;
        const dz = 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        const i = (y * s + x) * 4;
        img.data[i] = Math.floor(((dx / len) * 0.5 + 0.5) * 255);
        img.data[i + 1] = Math.floor(((dy / len) * 0.5 + 0.5) * 255);
        img.data[i + 2] = Math.floor(((dz / len) * 0.5 + 0.5) * 255);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, size);
  normal.tex.colorSpace = THREE.NoColorSpace;
  return { height, normal, heightData, size, mean };
}

const bumpMaps = makeHeightNormal(512);

function makeRustMask(size = 256) {
  return canvasTex((ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const n = fbm(x * 0.035, y * 0.035, 5);
        const v = Math.floor(n * 255);
        const i = (y * s + x) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, size);
}
const rustMask = makeRustMask(256);
rustMask.tex.colorSpace = THREE.NoColorSpace;

// Weather albedo/rough/metal baked per age into DataTextures updated on slider
function updateWeatherMaps(age, targets) {
  const s = 256;
  const albedo = targets.albedoImg;
  const rough = targets.roughImg;
  const metal = targets.metalImg;
  const maskCtx = rustMask.ctx;
  // read mask from canvas
  const mask = maskCtx.getImageData(0, 0, s, s).data;
  for (let i = 0; i < s * s; i++) {
    const m = mask[i * 4] / 255;
    // rust appears where mask < age (grows from dark valleys)
    const rust = THREE.MathUtils.clamp((age - m) / 0.35, 0, 1);
    const cleanR = 140, cleanG = 148, cleanB = 158;
    const rustR = 130, rustG = 62, rustB = 28;
    const o = i * 4;
    albedo.data[o] = cleanR + (rustR - cleanR) * rust;
    albedo.data[o + 1] = cleanG + (rustG - cleanG) * rust;
    albedo.data[o + 2] = cleanB + (rustB - cleanB) * rust;
    albedo.data[o + 3] = 255;
    const rv = 0.18 + rust * 0.7;
    rough.data[o] = rough.data[o + 1] = rough.data[o + 2] = rv * 255;
    rough.data[o + 3] = 255;
    const mv = 1 - rust;
    metal.data[o] = metal.data[o + 1] = metal.data[o + 2] = mv * 255;
    metal.data[o + 3] = 255;
  }
  targets.albedoCtx.putImageData(albedo, 0, 0);
  targets.roughCtx.putImageData(rough, 0, 0);
  targets.metalCtx.putImageData(metal, 0, 0);
  targets.albedoTex.needsUpdate = true;
  targets.roughTex.needsUpdate = true;
  targets.metalTex.needsUpdate = true;
}

function makeWeatherTargets() {
  const s = 256;
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return { c, ctx, img, tex };
  };
  const a = mk();
  a.tex.colorSpace = THREE.SRGBColorSpace;
  const r = mk();
  r.tex.colorSpace = THREE.NoColorSpace;
  const m = mk();
  m.tex.colorSpace = THREE.NoColorSpace;
  const targets = {
    albedoImg: a.img, albedoCtx: a.ctx, albedoTex: a.tex,
    roughImg: r.img, roughCtx: r.ctx, roughTex: r.tex,
    metalImg: m.img, metalCtx: m.ctx, metalTex: m.tex,
  };
  updateWeatherMaps(0.45, targets);
  return targets;
}
const weather = makeWeatherTargets();

// —— Scenes ——
const scenes = [];

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

function addLights(scene, intensity = 2.2) {
  const hemi = new THREE.HemisphereLight(0xb8d4ff, 0x2a1a10, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe6d0, intensity);
  key.position.set(2.4, 3.2, 1.6);
  scene.add(key);
  return key;
}

function addFloor(scene, y = -1.05) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1714, roughness: 0.92, metalness: 0.05 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = y;
  scene.add(floor);
  return floor;
}

// Spec 01 UVs

// Hero specimen — studded sphere + stylized reveal
const heroEl = document.querySelector('[data-scene="hero"]');
if (!heroEl) throw new Error('Missing hero view [data-scene=hero]');
const heroPost = makeHeroPost('#3dff9a');
const heroScene = makeScene(heroEl, { bg: 0x050505, camZ: 3.05 });
{
  heroScene.background = new THREE.Color(0x050505);
  heroScene.environment = envMap;
  heroScene.environmentIntensity = 0.35;
  const geo = new THREE.SphereGeometry(0.95, 160, 120);
  const strength = 1.0;
  const disp = 0.12 * strength;
  const mat = new THREE.MeshStandardMaterial({
    color: 0xd4895a,
    metalness: 0.55,
    roughness: 0.32,
    normalMap: bumpMaps.normal.tex,
    normalScale: new THREE.Vector2(1.45, 1.45),
    displacementMap: bumpMaps.height.tex,
    displacementScale: disp,
    displacementBias: -bumpMaps.mean * disp,
    envMapIntensity: 0.85,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(1.45);
  heroScene.add(mesh);
  const hemi = new THREE.HemisphereLight(0xa8c4e0, 0x3a2010, 0.55);
  heroScene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0dc, 3.2);
  key.position.set(2.4, 0.5, 1.4);
  heroScene.add(key);
  const rim = new THREE.DirectionalLight(0x88ffc8, 1.35);
  rim.position.set(-2.0, 0.8, -2.0);
  heroScene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.9);
  fill.position.set(-0.5, 2.2, 2.0);
  heroScene.add(fill);
  heroScene.userData.meshes = { mesh, mat, key };
  heroScene.userData.heroPost = heroPost;
  heroScene.userData.controls.enableZoom = false;
  heroScene.userData.controls.enableRotate = false;
  heroScene.userData.update = (t, dt) => {
    if (!reducedMotion) {
      mesh.rotation.y += dt * 0.22;
      key.position.x = Math.cos(t * 0.55) * 2.5;
      key.position.z = Math.sin(t * 0.55) * 2.0;
      key.position.y = 0.35;
    }
  };
}

const uvScene = makeScene(document.querySelector('[data-scene="uvs"]'), { bg: 0x12100e });
{
  const mat = new THREE.MeshStandardMaterial({
    map: uvGrid.tex,
    roughness: 0.65,
    metalness: 0.05,
  });
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.7, 48, 32), mat);
  sphere.position.set(-0.85, 0.1, 0);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), mat);
  box.position.set(0.95, 0.05, 0);
  const flat = new THREE.Mesh(
    new THREE.PlaneGeometry(1.35, 1.35),
    new THREE.MeshBasicMaterial({ map: uvGrid.tex, side: THREE.DoubleSide })
  );
  flat.position.set(0, -0.15, -1.35);
  flat.visible = false;
  uvScene.add(sphere, box, flat);
  addFloor(uvScene);
  addLights(uvScene, 1.15);
  uvScene.environment = envMap;
  uvScene.environmentIntensity = 0.45;
  uvScene.userData.meshes = { sphere, box, mat, flat };
  uvScene.userData.update = (t, dt) => {
    if (!reducedMotion) {
      sphere.rotation.y += dt * 0.25;
      box.rotation.y -= dt * 0.2;
    }
  };
}

// Spec 02 albedo/roughness
const mapsScene = makeScene(document.querySelector('[data-scene="maps"]'), { bg: 0x100e0c });
{
  mapsScene.environment = envMap;
  const mat = new THREE.MeshStandardMaterial({
    map: wood.albedo.tex,
    roughnessMap: wood.rough.tex,
    roughness: 1,
    metalness: 0.05,
    envMapIntensity: 0.55,
  });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.7, 0.24, 160, 28), mat);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.5, 48, 32), mat);
  sphere.position.set(1.4, -0.15, 0.15);
  knot.position.set(-0.3, 0.1, 0);
  mapsScene.add(knot, sphere);
  addFloor(mapsScene);
  const key = addLights(mapsScene, 1.5);
  mapsScene.userData.meshes = { knot, sphere, mat, key, preset: 'wood' };
  mapsScene.userData.flags = { albedo: true, rough: true };
  mapsScene.userData.update = (t, dt) => {
    if (!reducedMotion) {
      knot.rotation.y += dt * 0.22;
      sphere.rotation.y -= dt * 0.18;
    }
  };
}

function applyMapFlags() {
  const { mat, preset } = mapsScene.userData.meshes;
  const flags = mapsScene.userData.flags;
  const pack = preset === 'marble' ? marble : wood;
  mat.map = flags.albedo ? pack.albedo.tex : null;
  mat.roughnessMap = flags.rough ? pack.rough.tex : null;
  mat.color.set(flags.albedo ? 0xffffff : 0xb8a090);
  mat.roughness = flags.rough ? 1 : 0.35;
  mat.needsUpdate = true;
}

// Spec 03 normal vs displacement (centerpiece)
const shared = { lightAngle: 0.4, orbitLight: true, silhouette: false, strength: 0.85 };
const CP_COLOR = 0xb86a3c; // terracotta / copper mid-tone
const CP_RADIUS = 0.72;
const CP_DISP_MAX = 0.11; // world units at strength=1

function setupCenterpieceLights(scene) {
  // Dim ambient so raking key can cast bump shadows
  const hemi = new THREE.HemisphereLight(0x6a7a90, 0x2a1810, 0.28);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe2c4, 2.6);
  key.position.set(2.4, 0.45, 1.2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88aacc, 0.35);
  fill.position.set(-2.0, 0.8, -1.0);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xfff0e0, 0.9);
  rim.position.set(-1.2, 0.6, -2.4);
  scene.add(rim);
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffc878 })
  );
  scene.add(bulb);
  return { key, fill, rim, bulb, hemi };
}

function updateCenterpieceLight(pack, mesh) {
  const ang = shared.lightAngle;
  // Low raking orbit — grazes the equator so bumps catch light/shadow
  const x = Math.cos(ang) * 2.6;
  const z = Math.sin(ang) * 2.6;
  const y = 0.35 + Math.sin(ang * 0.5) * 0.15;
  pack.bulb.position.set(x, y, z);
  pack.key.position.set(x, y, z);
  pack.rim.position.set(-x * 0.6, 0.7, -z * 0.6);
  if (!reducedMotion) mesh.rotation.y += 0.012; // slow turn; overridden with dt below
}

const normalScene = makeScene(document.querySelector('[data-scene="normal"]'), { bg: 0x1a1511, camZ: 3.55 });
{
  normalScene.environment = envMap;
  normalScene.environmentIntensity = 0.18;
  normalScene.userData.camera.position.set(0, 0.08, 3.55);
  normalScene.userData.controls.target.set(0, 0, 0);
  normalScene.userData.controls.update();
  const geo = new THREE.SphereGeometry(CP_RADIUS, 96, 72);
  const mat = new THREE.MeshStandardMaterial({
    color: CP_COLOR,
    metalness: 0.22,
    roughness: 0.48,
    normalMap: bumpMaps.normal.tex,
    normalScale: new THREE.Vector2(shared.strength * 1.35, shared.strength * 1.35),
    envMapIntensity: 0.22,
  });
  const mesh = new THREE.Mesh(geo, mat);
  normalScene.add(mesh);
  // No floor — keeps silhouette clean and avoids clipping clutter
  const lights = setupCenterpieceLights(normalScene);
  normalScene.userData.meshes = { mesh, mat, ...lights };
  normalScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y += dt * 0.18;
    const ang = shared.lightAngle;
    const x = Math.cos(ang) * 2.6;
    const z = Math.sin(ang) * 2.6;
    const y = 0.35 + Math.sin(ang * 0.5) * 0.15;
    lights.bulb.position.set(x, y, z);
    lights.key.position.set(x, y, z);
    lights.rim.position.set(-x * 0.55, 0.65, -z * 0.55);
    lights.bulb.visible = !shared.silhouette;
  };
}

const displaceScene = makeScene(document.querySelector('[data-scene="displace"]'), { bg: 0x1a1511, camZ: 3.55 });
{
  displaceScene.environment = envMap;
  displaceScene.environmentIntensity = 0.18;
  displaceScene.userData.camera.position.set(0, 0.08, 3.55);
  displaceScene.userData.controls.target.set(0, 0, 0);
  displaceScene.userData.controls.update();
  // Dense mesh so studs stay crisp, not lumpy
  const geo = new THREE.SphereGeometry(CP_RADIUS, 192, 128);
  const dispScale = CP_DISP_MAX * shared.strength;
  const mat = new THREE.MeshStandardMaterial({
    color: CP_COLOR,
    metalness: 0.22,
    roughness: 0.48,
    envMapIntensity: 0.22,
    displacementMap: bumpMaps.height.tex,
    displacementScale: dispScale,
    // Bias cancels mean height so average radius matches the left sphere
    displacementBias: -bumpMaps.mean * dispScale,
  });
  function applyDisplace(strength) {
    const s = CP_DISP_MAX * strength;
    mat.displacementScale = s;
    mat.displacementBias = -bumpMaps.mean * s;
  }
  const mesh = new THREE.Mesh(geo, mat);
  displaceScene.add(mesh);
  const lights = setupCenterpieceLights(displaceScene);
  displaceScene.userData.meshes = { mesh, mat, applyDisplace, geo, ...lights };
  displaceScene.userData.update = (t, dt) => {
    if (!reducedMotion) mesh.rotation.y += dt * 0.18;
    const ang = shared.lightAngle;
    const x = Math.cos(ang) * 2.6;
    const z = Math.sin(ang) * 2.6;
    const y = 0.35 + Math.sin(ang * 0.5) * 0.15;
    lights.bulb.position.set(x, y, z);
    lights.key.position.set(x, y, z);
    lights.rim.position.set(-x * 0.55, 0.65, -z * 0.55);
    lights.bulb.visible = !shared.silhouette;
  };
}

function setSilhouette(on) {
  shared.silhouette = on;
  for (const sc of [normalScene, displaceScene]) {
    const { mat, hemi, key, fill, rim } = sc.userData.meshes;
    if (on) {
      mat.color.set(0x14110e);
      mat.metalness = 0;
      mat.roughness = 1;
      mat.envMapIntensity = 0;
      mat.normalMap = null;
      // Flat unlit look via zero lights + dark emissive-ish through basic-like shading
      if (hemi) hemi.intensity = 0;
      if (key) key.intensity = 0;
      if (fill) fill.intensity = 0;
      if (rim) rim.intensity = 0;
      mat.emissive = new THREE.Color(0x0c0a08);
      mat.emissiveIntensity = 1;
      sc.background = new THREE.Color(0xf0e6d8);
      sc.environment = null;
    } else {
      mat.color.set(CP_COLOR);
      mat.metalness = 0.22;
      mat.roughness = 0.48;
      mat.envMapIntensity = 0.22;
      mat.emissive = new THREE.Color(0x000000);
      mat.emissiveIntensity = 0;
      if (hemi) hemi.intensity = 0.28;
      if (key) key.intensity = 2.6;
      if (fill) fill.intensity = 0.35;
      if (rim) rim.intensity = 0.9;
      if (sc === normalScene) {
        mat.normalMap = bumpMaps.normal.tex;
        const ns = shared.strength * 1.35;
        mat.normalScale.set(ns, ns);
      }
      sc.background = new THREE.Color(0x1a1511);
      sc.environment = envMap;
      sc.environmentIntensity = 0.18;
    }
    mat.needsUpdate = true;
  }
}

// Spec 04 weathering
const weatherScene = makeScene(document.querySelector('[data-scene="weather"]'), { bg: 0x100e0c });
{
  weatherScene.environment = envMap;
  const mat = new THREE.MeshStandardMaterial({
    map: weather.albedoTex,
    roughnessMap: weather.roughTex,
    metalnessMap: weather.metalTex,
    roughness: 1,
    metalness: 1,
    envMapIntensity: 0.55,
  });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.72, 0.24, 180, 32), mat);
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.52, 48, 32), mat);
  sphere.position.set(1.4, -0.12, 0.1);
  knot.position.set(-0.3, 0.12, 0);
  weatherScene.add(knot, sphere);
  addFloor(weatherScene);
  addLights(weatherScene, 1.4);
  weatherScene.userData.meshes = { knot, sphere, mat };
  weatherScene.userData.update = (t, dt) => {
    if (!reducedMotion) {
      knot.rotation.y += dt * 0.2;
      sphere.rotation.y -= dt * 0.16;
    }
  };
}

// —— UI ——

// Hero reveal pointer + auto sweep
{
  const el = heroEl;
  const post = heroPost;
  const setFromClientX = (clientX) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    post.pointerX = Math.min(0.95, Math.max(0.05, (clientX - r.left) / r.width));
    post.reveal = post.pointerX;
  };
  el.addEventListener('pointerdown', (e) => {
    post.dragging = true;
    el.setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  });
  el.addEventListener('pointermove', (e) => {
    if (post.dragging || e.buttons) setFromClientX(e.clientX);
    else if (!reducedMotion) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && e.clientY >= r.top && e.clientY <= r.bottom) {
        const target = (e.clientX - r.left) / r.width;
        post.reveal += (target - post.reveal) * 0.12;
      }
    }
  });
  el.addEventListener('pointerup', () => { post.dragging = false; });
  el.addEventListener('pointerleave', () => { post.dragging = false; });
}

const flatBadge = document.getElementById('flat-badge');
document.querySelectorAll('[data-uv]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.uv;
    if (mode === 'flat') {
      const on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(on));
      uvScene.userData.meshes.flat.visible = on;
      flatBadge.style.display = on ? 'block' : 'none';
      return;
    }
    document.querySelectorAll('[data-uv="sphere"],[data-uv="box"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const { sphere, box } = uvScene.userData.meshes;
    if (mode === 'sphere') {
      sphere.scale.setScalar(1.15);
      box.scale.setScalar(0.75);
      uvScene.userData.controls.target.set(-0.6, 0.1, 0);
    } else {
      box.scale.setScalar(1.15);
      sphere.scale.setScalar(0.75);
      uvScene.userData.controls.target.set(0.7, 0.05, 0);
    }
    uvScene.userData.controls.update();
  });
});

document.querySelectorAll('[data-map]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.map;
    if (kind === 'wood' || kind === 'marble') {
      mapsScene.userData.meshes.preset = kind;
      document.querySelectorAll('[data-map="wood"],[data-map="marble"]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      applyMapFlags();
      return;
    }
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (kind === 'albedo') mapsScene.userData.flags.albedo = on;
    if (kind === 'rough') mapsScene.userData.flags.rough = on;
    applyMapFlags();
  });
});

document.querySelectorAll('[data-nd]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const kind = btn.dataset.nd;
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (kind === 'silhouette') setSilhouette(on);
    if (kind === 'orbit') shared.orbitLight = on;
  });
});

const strengthEl = document.getElementById('nd-strength');
const strengthOut = document.getElementById('nd-strength-out');
function onStrength() {
  shared.strength = Number(strengthEl.value);
  strengthOut.textContent = shared.strength.toFixed(2);
  const nMat = normalScene.userData.meshes.mat;
  if (!shared.silhouette) {
    const ns = shared.strength * 1.35;
    nMat.normalScale.set(ns, ns);
  }
  displaceScene.userData.meshes.applyDisplace(shared.strength);
}
strengthEl.addEventListener('input', onStrength);
strengthEl.addEventListener('change', onStrength);

const ageEl = document.getElementById('age');
const ageOut = document.getElementById('age-out');
function onAge() {
  const age = Number(ageEl.value);
  ageOut.textContent = age.toFixed(2);
  updateWeatherMaps(age, weather);
}
ageEl.addEventListener('input', onAge);
ageEl.addEventListener('change', onAge);

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

  if (shared.orbitLight && !reducedMotion) shared.lightAngle += dt * 0.85;

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
      if (!post.dragging && !reducedMotion) {
        post.reveal = 0.5 + Math.sin(now * 0.00045) * 0.28;
      } else if (reducedMotion && !post.dragging) {
        post.reveal = 0.42;
      }
      const aspect = Math.max(0.5, width / height);
      const rtW = HERO_RT_SIZE;
      const rtH = Math.max(96, Math.round(HERO_RT_SIZE / aspect));
      if (post.rt.width !== rtW || post.rt.height !== rtH) {
        post.rt.setSize(rtW, rtH);
        post.uniforms.uRes.value.set(rtW, rtH);
      }
      // Render true PBR into small RT (ignore scissor for RT)
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, rtW, rtH);
      const prevTone = renderer.toneMappingExposure;
      renderer.setRenderTarget(post.rt);
      renderer.clear();
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setScissorTest(true);
      renderer.setViewport(left, bottom, width, height);
      renderer.setScissor(left, bottom, width, height);
      post.uniforms.uReveal.value = post.reveal;
      post.uniforms.uTime.value = now * 0.001;
      post.uniforms.uCell.value = Math.max(4.2, Math.min(9, width / 95));
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
