// Display headings wear with the page Age, using the same logic as the toolbox:
// dirt settles where light can't reach (counters, inside joins), paint chips on
// convex corners and terminals first, then along edges: paint → primer → steel.
// The heading stays real DOM text; only its fill is replaced by a generated image.

const SEL = '.hero h1, .specimen-title, .rw-title.wear-type';
const STEPS = [0, 0.33, 0.66, 1];
const mqCoarse = window.matchMedia('(pointer: coarse)');
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');
const isStepped = () => mqCoarse.matches || mqReduce.matches || window.innerWidth < 700;

const state = { mode: 'off', age: 0, applied: -1, ready: false, renders: 0, headings: 0, error: null, maxLoss: 0 };
window.__TYPEWEAR = state;

const snap = (v) => STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), STEPS[0]);
const quant = (v) => (state.mode === 'stepped' ? snap(v) : Math.round(v * 50) / 50);

function hash(ix, iy, seed) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 982451653)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967295;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x, y, seed) {
  return (vnoise(x, y, seed) * 0.57 + vnoise(x * 2.03, y * 2.03, seed + 1) * 0.29 + vnoise(x * 4.1, y * 4.1, seed + 2) * 0.14);
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { const c = new OffscreenCanvas(w, h); if (c.getContext('2d')) return c; } catch (_) { /* fall through */ }
  }
  const c = document.createElement('canvas'); // detached: never added to the document
  c.width = w; c.height = h;
  return c;
}
function canvasToURL(c) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/png' }).then((b) => URL.createObjectURL(b));
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('blob'))), 'image/png'));
}

// —— Per-heading static fields (rebuilt on resize / font load) ——
function buildFields(el, seed) {
  const box = el.getBoundingClientRect();
  const cssFont = parseFloat(getComputedStyle(el).fontSize) || 40;
  // Supersample small headings so corners and strokes are resolvable
  const s = Math.min(4, Math.max(Math.min(2, window.devicePixelRatio || 1), 110 / cssFont));
  const W = Math.ceil(box.width * s), H = Math.ceil(box.height * s);
  if (!W || !H || W * H > 8e6) return null;
  const cv = makeCanvas(W, H);
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.scale(s, s);
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let fontPx = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const cs = getComputedStyle(n.parentElement);
    fontPx = Math.max(fontPx, parseFloat(cs.fontSize));
    g.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    g.fillStyle = cs.color;
    const asc = g.measureText('H').fontBoundingBoxAscent;
    if (!(asc > 0)) throw new Error('metrics');
    const up = cs.textTransform === 'uppercase';
    const t = n.data;
    for (let i = 0; i < t.length; i++) {
      if (/\s/.test(t[i])) continue;
      range.setStart(n, i); range.setEnd(n, i + 1);
      const rr = range.getClientRects()[0];
      if (!rr) continue;
      g.fillText(up ? t[i].toUpperCase() : t[i], rr.left - box.left, rr.top - box.top + asc);
    }
  }
  const img = g.getImageData(0, 0, W, H).data;
  const N = W * H;
  const A = new Float32Array(N);
  for (let i = 0; i < N; i++) A[i] = img[i * 4 + 3] / 255;

  // Chamfer distance from each inside pixel to the outside
  const INF = 1e9;
  const D = new Float32Array(N);
  for (let i = 0; i < N; i++) D[i] = A[i] > 0.5 ? INF : 0;
  const R2 = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!D[i]) continue;
    let d = D[i];
    if (x > 0) d = Math.min(d, D[i - 1] + 1);
    if (y > 0) { d = Math.min(d, D[i - W] + 1); if (x > 0) d = Math.min(d, D[i - W - 1] + R2); if (x < W - 1) d = Math.min(d, D[i - W + 1] + R2); }
    D[i] = d;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!D[i]) continue;
    let d = D[i];
    if (x < W - 1) d = Math.min(d, D[i + 1] + 1);
    if (y < H - 1) { d = Math.min(d, D[i + W] + 1); if (x < W - 1) d = Math.min(d, D[i + W + 1] + R2); if (x > 0) d = Math.min(d, D[i + W - 1] + R2); }
    D[i] = d;
  }

  // Integral image for box blurs of coverage
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) { row += A[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
  }
  const boxAvg = (x, y, r) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
    const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
    const area = (x1 - x0) * (y1 - y0);
    // outside the image counts as empty space
    return sum / ((2 * r + 1) * (2 * r + 1)) + 0 * area;
  };

  const fp = fontPx * s;                // font size in image pixels
  const band = Math.max(2, fp * 0.085); // how far wear reaches in from an edge
  const rS = Math.max(2, Math.round(fp * 0.045));
  const rM = Math.max(3, Math.round(fp * 0.15));
  const rL = Math.max(3, Math.round(fp * 0.1));
  const chipScale = 1 / (fp * 0.11), fineScale = 1 / (fp * 0.035), dirtScale = 1 / (fp * 0.22);

  const idx = [];
  for (let i = 0; i < N; i++) if (A[i] > 0.02) idx.push(i);
  const K = idx.length;

  // Pass 1: raw convexity / concavity for each glyph pixel
  const CV = new Float32Array(N), CC = new Float32Array(N), M = new Float32Array(N);
  for (let k = 0; k < K; k++) {
    const i = idx[k], x = i % W, y = (i / W) | 0;
    const dd = Math.max(0, D[i] - 0.5);
    const bS = boxAvg(x, y, rS), bL = boxAvg(x, y, rL);
    const ex = Math.min(1, 0.5 + dd / (2 * rS + 1)), exL = Math.min(1, 0.5 + dd / (2 * rL + 1));
    // Relative to a straight edge at this depth: less ink around = convex corner/terminal, more = inside join
    const conv = Math.min(1, Math.max(0, (ex - bS - 0.04) / 0.14)) * 0.5 + Math.min(1, Math.max(0, (exL - bL - 0.03) / 0.16)) * 0.5;
    CV[i] = conv;
    CC[i] = Math.min(1, Math.max(0, (bS - ex - 0.04) / 0.14));
    M[i] = 1;
  }
  // Pass 2: mask-normalised blur so the fields are smooth (no geometric kernel shapes)
  const integ = (src) => {
    const T = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += src[y * W + x]; T[(y + 1) * (W + 1) + x + 1] = T[y * (W + 1) + x + 1] + row; } }
    return T;
  };
  const tsum = (T, x, y, r) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
    return T[y1 * (W + 1) + x1] - T[y0 * (W + 1) + x1] - T[y1 * (W + 1) + x0] + T[y0 * (W + 1) + x0];
  };
  const ICV = integ(CV), ICC = integ(CC), IM = integ(M);
  const rB = Math.max(2, Math.round(fp * 0.05));

  const score = new Float32Array(K), dirt = new Float32Array(K), tone = new Float32Array(K), speck = new Float32Array(K);
  const paint = new Uint8ClampedArray(K * 3), cov = new Float32Array(K);
  const inside = [];
  for (let k = 0; k < K; k++) {
    const i = idx[k], x = i % W, y = (i / W) | 0;
    const e = Math.min(1, Math.max(0, 1 - (D[i] - 0.5) / band));
    const m = Math.max(1, tsum(IM, x, y, rB));
    const conv = tsum(ICV, x, y, rB) / m;
    const conc = tsum(ICC, x, y, rB) / m;
    const n1 = fbm(x * chipScale, y * chipScale, seed);
    const n2 = vnoise(x * fineScale, y * fineScale, seed + 7);
    // chips: where edges stick out, shaped by noise (multiplicative, so outlines are organic)
    score[k] = Math.pow(e, 0.8) * (0.12 + 1.6 * conv) * (0.35 + 1.3 * n1) + (n2 - 0.5) * 0.1 * e;
    const bM = boxAvg(x, y, rM);
    const ao = sstep(0.47, 0.6, bM);                            // enclosed: counters, crowded joins
    const e2 = Math.min(1, Math.max(0, 1 - D[i] / (band * 2.2)));
    const n3 = fbm(x * dirtScale, y * dirtScale, seed + 13);
    dirt[k] = Math.min(1, Math.max(ao * (0.25 + 0.75 * e2), Math.min(1, conc * 2) * e2) * (0.45 + 1.0 * n3));
    tone[k] = vnoise(x * fineScale * 0.25, y * fineScale * 4, seed + 21); // brushed-metal streaks
    speck[k] = hash(x, y, seed + 31);
    paint[k * 3] = img[i * 4]; paint[k * 3 + 1] = img[i * 4 + 1]; paint[k * 3 + 2] = img[i * 4 + 2];
    cov[k] = A[i];
    if (A[i] > 0.5) inside.push(score[k]);
  }
  // Spalls (paint and letter edge both gone) are capped to a small share of the glyph area
  inside.sort((a, b) => a - b);
  const qs = Float32Array.from(inside);
  return { el, W, H, box: { w: box.width, h: box.height }, idx, score, dirt, tone, speck, paint, cov, qs, insideN: inside.length, sizeGain: cssFont < 70 ? 1.3 : 1, cache: new Map() };
}

// —— Compose one age into an image ——
function compose(f, age) {
  const { W, H, idx, score, dirt, tone, speck, paint, cov } = f;
  const out = new Uint8ClampedArray(W * H * 4);
  // Thresholds come from this heading's own score quantiles, so every size wears at the same rate:
  // about 5% of the glyph area is chipped at age 0.33 and about 20% at age 1, highest scores first.
  const qAt = (p) => (f.qs.length ? f.qs[Math.min(f.qs.length - 1, Math.max(0, Math.floor(p * (f.qs.length - 1))))] : 9);
  const frac = Math.min(0.34, 0.26 * Math.pow(age, 1.25) * f.sizeGain);
  const t = qAt(1 - frac);
  const tp = qAt(1 - frac - 0.035 * Math.min(1, age * 3)); // thin primer rim around each chip
  const lossT = age > 0.6 ? qAt(1 - 0.03 * (age - 0.6) / 0.4) : 99;
  const dull = 0.22 * age;
  let lost = 0, ins = 0;
  for (let k = 0; k < idx.length; k++) {
    const i4 = idx[k] * 4;
    const sc = score[k];
    let r = paint[k * 3], g = paint[k * 3 + 1], b = paint[k * 3 + 2];
    // paint dulls and greys a little with age
    r += (r * 0.78 + 14 - r) * dull; g += (g * 0.76 + 12 - g) * dull; b += (b * 0.74 + 10 - b) * dull;
    const pr = sstep(tp - 0.008, tp + 0.008, sc); // primer band
    r += (178 - r) * pr; g += (74 - g) * pr; b += (46 - b) * pr;
    const mt = sstep(t - 0.015, t + 0.015, sc); // bare steel
    const pol = sstep(t + 0.2, t + 0.35, sc);    // most-handled spots polish bright
    const m = 112 + 48 * tone[k] + 70 * pol;
    r += (m - r) * mt; g += (m + 4 - g) * mt; b += (m + 9 - b) * mt;
    // AO dirt in counters and joins, plus a few grime specks
    let d = Math.min(0.6, dirt[k] * age * f.sizeGain) * (1 - 0.45 * mt);
    if (speck[k] > 1 - 0.005 * age) d = Math.max(d, 0.45);
    r += (62 - r) * d; g += (44 - g) * d; b += (24 - b) * d;
    let a = cov[k];
    const loss = sstep(lossT, lossT + 0.02, sc);
    if (cov[k] > 0.5) { ins++; if (loss > 0.5) lost++; }
    a *= 1 - loss;
    out[i4] = r; out[i4 + 1] = g; out[i4 + 2] = b; out[i4 + 3] = a * 255;
  }
  state.maxLoss = Math.max(state.maxLoss, ins ? lost / ins : 0);
  const c = makeCanvas(W, H);
  c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
  return canvasToURL(c);
}

let fields = [];
let pending = null, busy = false, rebuildTimer = 0;

async function applyAge(age) {
  if (state.mode === 'off') return;
  if (age <= 0.005) {
    for (const f of fields) { f.el.classList.remove('is-worn'); f.el.style.backgroundImage = ''; }
    state.applied = 0; state.renders++;
    return;
  }
  const key = age.toFixed(2);
  const urls = await Promise.all(fields.map(async (f) => {
    let u = f.cache.get(key);
    if (!u) {
      u = await compose(f, age);
      f.cache.set(key, u);
      if (f.cache.size > 10) { const [k0, u0] = f.cache.entries().next().value; f.cache.delete(k0); URL.revokeObjectURL(u0); }
    }
    return u;
  }));
  await Promise.all(urls.map((u) => { const im = new Image(); im.src = u; return im.decode().catch(() => null); }));
  fields.forEach((f, j) => {
    f.el.style.backgroundImage = `url("${urls[j]}")`;
    f.el.style.backgroundSize = `${f.box.w}px ${f.box.h}px`;
    f.el.classList.add('is-worn');
  });
  state.applied = age; state.renders++;
}

function schedule(age) {
  pending = quant(age);
  if (busy) return;
  busy = true;
  requestAnimationFrame(async function run() {
    const a = pending; pending = null;
    try { await applyAge(a); } catch (err) { fallback(err); }
    if (pending !== null && state.mode !== 'off') requestAnimationFrame(run);
    else busy = false;
  });
}

function fallback(err) {
  state.mode = 'off'; state.error = String(err && err.message || err);
  for (const el of document.querySelectorAll(SEL)) { el.classList.remove('is-worn'); el.style.backgroundImage = ''; }
}

function rebuild() {
  for (const f of fields) for (const u of f.cache.values()) URL.revokeObjectURL(u);
  const els = [...document.querySelectorAll(SEL)];
  // measure clean (the fill swap never changes layout, but keep the build deterministic)
  fields = els.map((el, j) => buildFields(el, 101 + j * 17)).filter(Boolean);
  state.headings = fields.length;
}

function setMode() {
  if (state.mode === 'off' && state.error) return;
  state.mode = isStepped() ? 'stepped' : 'live';
  document.documentElement.dataset.typeWear = state.mode;
}

export function initTypeWear() {
  const pill = document.getElementById('page-age');
  const pillOut = document.getElementById('page-age-out');
  const cmp = document.getElementById('cmp-age');
  if (!pill || !cmp) return;
  const show = (v) => { if (pillOut) pillOut.textContent = Number(v).toFixed(2); };
  // Two-way sync: the page pill drives Specimen 04, and Specimen 04 drives the pill.
  const fromPill = (e) => {
    cmp.value = pill.value;
    cmp.dispatchEvent(new Event(e.type, { bubbles: true }));
  };
  pill.addEventListener('input', fromPill);
  pill.addEventListener('change', fromPill);
  const fromCmp = (e) => {
    pill.value = cmp.value;
    show(cmp.value);
    state.age = Number(cmp.value);
    if (state.mode === 'live' || (state.mode === 'stepped' && e.type === 'change')) schedule(state.age);
  };
  cmp.addEventListener('input', fromCmp);
  cmp.addEventListener('change', fromCmp);
  pill.value = cmp.value; show(cmp.value); state.age = Number(cmp.value);

  const hasClip = CSS.supports('(-webkit-background-clip: text)') || CSS.supports('(background-clip: text)');
  if (!hasClip || !document.fonts || !window.ImageData) { fallback('unsupported'); return; }
  const start = () => {
    try {
      setMode();
      rebuild();
      state.ready = true;
      schedule(state.age);
    } catch (err) { fallback(err); }
  };
  document.fonts.ready.then(start);
  const later = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (state.mode === 'off') return;
      try { setMode(); rebuild(); schedule(state.age); } catch (err) { fallback(err); }
    }, 180);
  };
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => { if (window.innerWidth !== lastW) { lastW = window.innerWidth; later(); } });
  document.fonts.addEventListener?.('loadingdone', later);
  for (const mq of [mqCoarse, mqReduce]) { try { mq.addEventListener('change', () => { setMode(); schedule(state.age); }); } catch (_) { /* old Safari */ } }
}
