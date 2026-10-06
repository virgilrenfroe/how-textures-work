/**
 * Full QA for Lesson 04 (/wear/) on the preview URL
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(path.join(process.env.PW_ROOT || '/workspace/materials-demo', 'package.json'));
const { chromium, webkit } = require('playwright');

const BASE = process.env.BASE || 'https://how-textures-work-preview-production.up.railway.app/wear/';
const ROOT = process.env.ROOT || 'https://how-textures-work-preview-production.up.railway.app/';
const L01 = 'https://how-surfaces-work-production.up.railway.app/';
const L03 = 'https://how-surfaces-work-production.up.railway.app/sheen/';
const OUT = path.resolve(process.env.OUT || '/workspace/lesson04/shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, pass, detail = '') {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}${detail ? ' — ' + detail : ''}`);
}

async function sampleView(page, selector, grid = 5) {
  return page.evaluate(({ selector, grid }) => {
    const el = document.querySelector(selector);
    const canvas = document.getElementById('c');
    if (!el || !canvas) return null;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return { error: 'no-gl' };
    const r = el.getBoundingClientRect();
    const sx = canvas.width / canvas.clientWidth;
    const sy = canvas.height / canvas.clientHeight;
    const p = new Uint8Array(4);
    let nonBlank = 0;
    for (let gy = 1; gy <= grid; gy++) for (let gx = 1; gx <= grid; gx++) {
      const vx = r.left + (r.width * gx) / (grid + 1);
      const vy = r.top + (r.height * gy) / (grid + 1);
      if (vx < 0 || vy < 0 || vx > canvas.clientWidth || vy > canvas.clientHeight) continue;
      gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      if (!(p[0] < 28 && p[1] < 28 && p[2] < 28)) nonBlank++;
    }
    // 24x24 patch over the central 70% of the view
    const patch = [];
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      const vx = r.left + r.width * (0.15 + 0.7 * (x / 23));
      const vy = r.top + r.height * (0.15 + 0.7 * (y / 23));
      gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      patch.push(p[0], p[1], p[2], p[3]);
    }
    return { nonBlank, patch, rect: { w: r.width, h: r.height } };
  }, { selector, grid });
}

function avgDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  const n = a.length / 4;
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  return sum / (n * 3);
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__HTW && window.__HTW.scenes?.length >= 6 && window.__HTW.frameCount > 5, null, { timeout: 90000 });
  await page.waitForTimeout(800);
}
async function setRange(page, sel, val) {
  await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error('missing ' + sel);
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, { sel, val });
}
async function clickChip(page, sel) {
  await page.evaluate((sel) => document.querySelector(sel).click(), sel);
}
async function waitFrames(page, n = 3) {
  const prev = await page.evaluate(() => window.__HSW.frameCount);
  await page.waitForFunction((p) => window.__HSW.frameCount > p, prev + n - 1, { timeout: 15000 });
}
async function ensureSceneVisible(page, scene) {
  await page.evaluate((scene) => {
    document.querySelector(`[data-scene="${scene}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, scene);
  await page.waitForTimeout(250);
  await waitFrames(page, 4);
}

/** Control changes the render: diff after the change must clearly exceed the idle frame-to-frame noise. */
async function ctrlTest(page, label, id, scene, act, minDiff = 1.5) {
  await ensureSceneVisible(page, scene);
  const a = await sampleView(page, `[data-scene="${scene}"]`);
  await waitFrames(page, 4);
  const b = await sampleView(page, `[data-scene="${scene}"]`);
  const noise = avgDiff(a?.patch, b?.patch);
  await act();
  await ensureSceneVisible(page, scene);
  await waitFrames(page, 4);
  const c = await sampleView(page, `[data-scene="${scene}"]`);
  const d = avgDiff(b?.patch, c?.patch);
  record(`${label}:ctrl-${id}`, d > Math.max(minDiff, noise * 2 + 0.5) && (c?.nonBlank ?? 0) >= 3, `diff=${d.toFixed(2)} noise=${noise.toFixed(2)}`);
  return d;
}


// —— Type wear helpers ——
const TYPE_OUT = path.join(OUT, 'type');
fs.mkdirSync(TYPE_OUT, { recursive: true });
const HEADINGS = ['.hero h1', '#s01 .specimen-title', '#s02 .specimen-title', '#s03 .specimen-title', '#s04 .specimen-title', '#real-world .rw-title'];
const RW_OUT = path.join(OUT, 'realworld');
fs.mkdirSync(RW_OUT, { recursive: true });
const BODY = ['.hero-sub', '#s01 .lesson p:first-child', '#s02 .try p', '#s04 .lesson p:nth-child(2)', '#s03 .lesson p:nth-child(2)'];

async function setAge(page, v) {
  const before = await page.evaluate(() => window.__TYPEWEAR.renders);
  const expect = await page.evaluate((v) => {
    const tw = window.__TYPEWEAR;
    const steps = [0, 0.33, 0.66, 1];
    const q = tw.mode === 'stepped' ? steps.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 0) : Math.round(v * 50) / 50;
    const el = document.getElementById('page-age');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return q;
  }, v);
  await page.waitForFunction(({ before, expect }) => {
    const tw = window.__TYPEWEAR;
    return tw.renders > before && Math.abs(tw.applied - expect) < 1e-6;
  }, { before, expect }, { timeout: 30000 });
  await page.waitForTimeout(250);
  return expect;
}
async function shotEl(page, sel, file) {
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
  await page.waitForFunction(() => new Promise((r) => { const y = scrollY; requestAnimationFrame(() => requestAnimationFrame(() => r(scrollY === y))); }));
  await page.waitForTimeout(250);
  return page.locator(sel).first().screenshot(file ? { path: file } : {});
}
async function pngDiff(helper, a, b) {
  return helper.evaluate(async ({ a, b }) => {
    const load = async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    };
    const A = await load(a), B = await load(b);
    if (A.width !== B.width || A.height !== B.height) return { sizeMismatch: true, mean: 999, changed: 1 };
    let sum = 0, changed = 0;
    const n = A.width * A.height;
    for (let i = 0; i < A.data.length; i += 4) {
      const d = (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2])) / 3;
      sum += d; if (d > 24) changed++;
    }
    return { mean: sum / n, changed: changed / n };
  }, { a: a.toString('base64'), b: b.toString('base64') });
}

async function typeWearChecks(page, context, label, isPhone) {
  const tw0 = await page.waitForFunction(() => window.__TYPEWEAR?.ready && window.__TYPEWEAR.renders > 0, null, { timeout: 30000 }).then(() => page.evaluate(() => window.__TYPEWEAR)).catch(() => null);
  record(`${label}:type-ready`, !!tw0 && !tw0.error && tw0.headings === HEADINGS.length, JSON.stringify(tw0 && { mode: tw0.mode, headings: tw0.headings, error: tw0.error }));
  record(`${label}:type-mode`, tw0?.mode === (isPhone ? 'stepped' : 'live'), `mode=${tw0?.mode}`);
  const helper = await context.newPage();
  await helper.goto('about:blank');

  const texts0 = await page.evaluate((sels) => sels.map((s) => document.querySelector(s).innerText), HEADINGS);
  await setAge(page, 0);
  const h0 = [], b0 = [];
  for (const s of HEADINGS) h0.push(await shotEl(page, s));
  for (const s of BODY) b0.push(await shotEl(page, s));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(TYPE_OUT, `${label}-age0.png`) });
  if (!isPhone) {
    await shotEl(page, '.hero h1', path.join(TYPE_OUT, `${label}-hero-title-age0.png`));
    await setAge(page, 0.5);
    await shotEl(page, '.hero h1', path.join(TYPE_OUT, `${label}-hero-title-age0.5.png`));
  }
  await setAge(page, 1);
  const h1 = [], b1 = [];
  for (const s of HEADINGS) h1.push(await shotEl(page, s));
  for (const s of BODY) b1.push(await shotEl(page, s));
  for (let i = 0; i < HEADINGS.length; i++) {
    const d = await pngDiff(helper, h0[i], h1[i]);
    record(`${label}:type-heading-wears ${HEADINGS[i]}`, d.mean > 2 && d.changed > 0.01, `mean=${d.mean.toFixed(2)} changed=${(d.changed * 100).toFixed(1)}%`);
  }
  for (let i = 0; i < BODY.length; i++) {
    const same = Buffer.compare(b0[i], b1[i]) === 0;
    const d = same ? { mean: 0, changed: 0 } : await pngDiff(helper, b0[i], b1[i]);
    record(`${label}:type-body-identical ${BODY[i]}`, d.mean === 0 && d.changed === 0, `changedPx=${(d.changed * 100).toFixed(3)}%`);
  }
  if (!isPhone) {
    await shotEl(page, '.hero h1', path.join(TYPE_OUT, `${label}-hero-title-age1.png`));
    await shotEl(page, '#s02 .specimen-title', path.join(TYPE_OUT, `${label}-specimen-heading-age1.png`));
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(TYPE_OUT, `${label}-age1.png`) });

  const texts1 = await page.evaluate((sels) => sels.map((s) => document.querySelector(s).innerText), HEADINGS);
  record(`${label}:type-innertext-unchanged`, JSON.stringify(texts0) === JSON.stringify(texts1), texts1.map((t) => t.replace(/\s+/g, ' ')).join(' / '));
  const sel = await page.evaluate(() => {
    const h = document.querySelector('.hero h1');
    const r = document.createRange(); r.selectNodeContents(h);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const got = s.toString().replace(/\s+/g, ' ').trim();
    const ok = getComputedStyle(h).userSelect !== 'none' && getComputedStyle(h).pointerEvents !== 'none';
    s.removeAllRanges();
    return { got, ok };
  });
  record(`${label}:type-h1-selectable`, sel.got === 'How Wear Shows' && sel.ok, JSON.stringify(sel));
  const loss = await page.evaluate(() => window.__TYPEWEAR.maxLoss);
  record(`${label}:type-glyph-loss-cap`, loss <= 0.3, `maxLoss=${(loss * 100).toFixed(1)}%`);
  const nC = await page.evaluate(() => document.querySelectorAll('canvas').length);
  record(`${label}:type-one-canvas`, nC === 1, `count=${nC}`);

  // two-way sync between the page Age pill and the Specimen 04 slider
  const sync = await page.evaluate(() => {
    const pill = document.getElementById('page-age'), cmp = document.getElementById('cmp-age');
    pill.value = '0.3'; pill.dispatchEvent(new Event('input', { bubbles: true }));
    const a = [cmp.value, document.getElementById('cmp-age-out').textContent];
    cmp.value = '0.9'; cmp.dispatchEvent(new Event('input', { bubbles: true }));
    const b = [pill.value, document.getElementById('page-age-out').textContent];
    return { a, b };
  });
  record(`${label}:type-age-sync`, sync.a[0] === '0.3' && sync.a[1] === '0.30' && sync.b[0] === '0.9' && sync.b[1] === '0.90', JSON.stringify(sync));

  if (isPhone) {
    // stepped fallback: input alone does not re-render; release snaps to the nearest step
    await setAge(page, 0);
    const r0 = await page.evaluate(() => window.__TYPEWEAR.renders);
    await page.evaluate(() => { const el = document.getElementById('page-age'); el.value = '0.45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(700);
    const mid = await page.evaluate(() => ({ renders: window.__TYPEWEAR.renders, applied: window.__TYPEWEAR.applied }));
    await page.evaluate(() => { const el = document.getElementById('page-age'); el.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction(() => Math.abs(window.__TYPEWEAR.applied - 0.33) < 1e-6, null, { timeout: 20000 }).catch(() => null);
    const end = await page.evaluate(() => window.__TYPEWEAR.applied);
    record(`${label}:type-stepped-fallback`, mid.renders === r0 && mid.applied === 0 && Math.abs(end - 0.33) < 1e-6, `input→applied=${mid.applied} release→applied=${end}`);
  }
  await setAge(page, 0.65);
  await helper.close();
}

async function reducedMotionCheck(browserType, label, viewportOpts) {
  const isWebKit = browserType.name() === 'webkit';
  const browser = await browserType.launch({ args: isWebKit ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ ...viewportOpts, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForFunction(() => window.__TYPEWEAR?.ready && window.__TYPEWEAR.renders > 0, null, { timeout: 60000 });
  const r = await page.evaluate(() => {
    const els = ['.hero h1', '#s01 .specimen-title', '.age-dock', '.age-pill', '#page-age'].map((s) => document.querySelector(s));
    const dur = els.map((e) => getComputedStyle(e).transitionDuration);
    const anim = els.map((e) => getComputedStyle(e).animationName);
    return { mode: window.__TYPEWEAR.mode, dur, anim, applied: window.__TYPEWEAR.applied };
  });
  record(`${label}:reduced-motion-type-stepped`, r.mode === 'stepped' && [0, 0.33, 0.66, 1].includes(r.applied), `mode=${r.mode} applied=${r.applied}`);
  record(`${label}:reduced-motion-no-transitions`, r.dur.every((d) => d.split(',').every((x) => parseFloat(x) === 0)) && r.anim.every((a) => a === 'none'), JSON.stringify(r.dur));
  await browser.close();
}

async function audienceScan(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText, document.title];
    document.querySelectorAll('[aria-label]').forEach((e) => parts.push(e.getAttribute('aria-label')));
    document.querySelectorAll('meta[content]').forEach((e) => parts.push(e.getAttribute('content')));
    const t = parts.join(' \n ').toLowerCase();
    const banned = [/webgl/, /\bdpr\b/, /three\.js/, /reduced[- ]motion/, /frame ?rate/, /\bfps\b/, /virgil/, /\bqa\b/, /context lost/, /shader/, /scissor/, /render target/, /onbeforecompile/, /\btodo\b/, /lorem/];
    return banned.filter((b) => b.test(t)).map(String);
  });
}

async function realWorldChecks(page, label, pageName) {
  const r = await page.evaluate(() => {
    const sec = document.getElementById('real-world');
    if (!sec) return { exists: false };
    const all = [...document.querySelectorAll('main section, body section')];
    const idx = all.indexOf(sec);
    const specIdx = all.map((e, i) => (e.classList.contains('specimen') ? i : -1)).filter((i) => i >= 0);
    const teach = all.indexOf(document.getElementById('teachers'));
    const items = [...sec.querySelectorAll('.rw-item')].map((li) => {
      const p = li.querySelector('p');
      const cs = getComputedStyle(p);
      return {
        setting: li.querySelector('.rw-setting')?.textContent.trim() || '',
        job: li.querySelector('.rw-job')?.textContent.trim() || '',
        text: p?.textContent.trim() || '',
        overflow: li.scrollWidth > li.clientWidth + 1,
        crisp: cs.backgroundImage === 'none' && !/transparent|rgba\(0, 0, 0, 0\)/.test(cs.webkitTextFillColor || '') && !li.querySelector('.is-worn'),
        fontPx: parseFloat(cs.fontSize),
      };
    });
    const sr = sec.getBoundingClientRect();
    return {
      exists: true,
      title: sec.querySelector('h2')?.textContent.trim(),
      afterSpecimens: specIdx.length > 0 && idx > Math.max(...specIdx),
      beforeTeachers: teach < 0 || idx < teach,
      inViewportWidth: sr.left >= -1 && sr.right <= document.documentElement.clientWidth + 1,
      items,
    };
  });
  record(`${label}:rw-exists-${pageName}`, r.exists && r.title === 'Where you see this', r.title || 'missing');
  if (!r.exists) return;
  record(`${label}:rw-placement-${pageName}`, r.afterSpecimens && r.beforeTeachers, `afterSpecimens=${r.afterSpecimens} beforeTeachers=${r.beforeTeachers}`);
  const n = r.items.length;
  const complete = r.items.every((it) => it.setting && it.job && /[.!?]$/.test(it.text) && it.text.split(/\s+/).length >= 12);
  record(`${label}:rw-entries-${pageName}`, n >= 3 && n <= 5 && complete, `count=${n} complete=${complete}`);
  record(`${label}:rw-crisp-${pageName}`, r.items.every((it) => it.crisp && it.fontPx >= 14), r.items.map((it) => it.fontPx).join(','));
  record(`${label}:rw-no-overflow-${pageName}`, r.inViewportWidth && r.items.every((it) => !it.overflow));
  await page.evaluate(() => document.getElementById('real-world').scrollIntoView({ block: 'start', behavior: 'instant' }));
  await page.waitForTimeout(700);
  await page.locator('#real-world').screenshot({ path: path.join(RW_OUT, `${label}-${pageName}.png`) });
}

async function runRootSuite(browserType, label, viewportOpts) {
  console.log(`\n===== ${label} Lesson 02 root =====`);
  const isWebKit = browserType.name() === 'webkit';
  const browser = await browserType.launch({ args: isWebKit ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const context = await browser.newContext({ ...viewportOpts });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  const resp = await page.goto(ROOT, { waitUntil: 'networkidle', timeout: 90000 });
  record(`${label}:l02-load`, !!(resp && resp.ok()), `status=${resp?.status()}`);
  await page.waitForFunction(() => window.__HTW && window.__HTW.frameCount > 3, null, { timeout: 60000 }).catch(() => {});
  await page.evaluate(async () => { await document.fonts.ready; });
  const nC = await page.evaluate(() => document.querySelectorAll('canvas').length);
  record(`${label}:l02-one-canvas`, nC === 1, `count=${nC}`);
  const h = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:l02-no-hscroll`, !h);
  const bad = await audienceScan(page);
  record(`${label}:l02-audience-lock`, bad.length === 0, bad.join(','));
  await realWorldChecks(page, label, 'lesson02');
  const h2 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:l02-no-hscroll-after-scroll`, !h2);
  const realErrs = errs.filter((t) => !/swiftshader|GroupMarkerNotSet|GPU stall|ReadPixels|Automatic fallback/i.test(t));
  record(`${label}:l02-no-console-errors`, realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
  await browser.close();
}

async function runSuite(browserType, label, viewportOpts) {
  const vw = viewportOpts.viewport.width, vh = viewportOpts.viewport.height;
  console.log(`\n===== ${label} ${vw}x${vh} =====`);
  const isWebKit = browserType.name() === 'webkit';
  const browser = await browserType.launch({
    args: isWebKit ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ ...viewportOpts });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const consoleMsgs = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleMsgs.push(msg.text()); });
  page.on('pageerror', (err) => consoleMsgs.push(String(err)));

  const resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
  record(`${label}:load`, !!(resp && resp.ok()), `status=${resp?.status()}`);
  await waitReady(page);

  const nCanvas = await page.evaluate(() => document.querySelectorAll('canvas').length);
  record(`${label}:one-canvas`, nCanvas === 1, `count=${nCanvas}`);
  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:no-hscroll`, !hScroll);

  const dpr = await page.evaluate(() => window.__HTW.renderer.getPixelRatio());
  const cap = vw < 700 ? 1.5 : 2;
  record(`${label}:dpr-cap`, dpr <= cap + 1e-6, `pixelRatio=${dpr} cap=${cap}`);

  const badCopy = await audienceScan(page);
  record(`${label}:audience-lock`, badCopy.length === 0, badCopy.join(','));
  const kicker = (await page.locator('.hero-kicker').textContent())?.trim();
  record(`${label}:kicker`, kicker === 'Lesson 04 · Materials', kicker);
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return ['Space Grotesk', 'Gabarito', 'JetBrains Mono'].map((f) => document.fonts.check(`16px "${f}"`)); });
  record(`${label}:fonts`, fonts.every(Boolean), JSON.stringify(fonts));
  const sm = await page.evaluate(() => ['s01', 's02', 's03', 's04'].map((id) => getComputedStyle(document.getElementById(id)).scrollMarginTop));
  record(`${label}:scroll-margin`, sm.every((v) => parseFloat(v) > 0), sm.join(','));

  for (const name of ['hero', 'ao', 'edges', 'tiles', 'cmp-new', 'cmp-used']) {
    await ensureSceneVisible(page, name);
    const s = await sampleView(page, `[data-scene="${name}"]`);
    record(`${label}:nonblank-${name}`, s && s.nonBlank >= 3, s ? `nonBlank=${s.nonBlank}` : 'null');
  }

  // Strict hero mask checks (same as Surfaces main QA 327c350)
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-scene="hero"]');
    const canvas = document.getElementById('c');
    if (!el || !canvas) return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const sx = canvas.width / canvas.clientWidth, sy = canvas.height / canvas.clientHeight;
    const p = new Uint8Array(4);
    for (let i = 0; i < 36; i++) {
      const vx = r.left + r.width * ((i % 6) + 0.5) / 6;
      const vy = r.top + r.height * (Math.floor(i / 6) + 0.5) / 6;
      if (vx < 0 || vy < 0 || vx >= canvas.clientWidth || vy >= canvas.clientHeight) continue;
      gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      if (!(p[0] < 28 && p[1] < 28 && p[2] < 28)) return true;
    }
    return false;
  }, null, { timeout: 8000 }).catch(() => null);
  await page.waitForTimeout(200);
  const heroSample = await page.evaluate(() => {
    const el = document.querySelector('[data-scene="hero"]');
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const r = el.getBoundingClientRect();
    const sx = canvas.width / canvas.clientWidth;
    const sy = canvas.height / canvas.clientHeight;
    const x0 = Math.max(0, r.left), x1 = Math.min(canvas.clientWidth, r.right);
    const y0 = Math.max(0, r.top), y1 = Math.min(canvas.clientHeight, r.bottom);
    let n = 0, ink = 0, bg = 0;
    const p = new Uint8Array(4);
    for (let gy = 0; gy < 24; gy++) {
      for (let gx = 0; gx < 24; gx++) {
        const vx = x0 + ((x1 - x0) * (gx + 0.5)) / 24;
        const vy = y0 + ((y1 - y0) * (gy + 0.5)) / 24;
        gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        n++;
        if (p[0] < 28 && p[1] < 28 && p[2] < 28) bg++;
        else ink++;
      }
    }
    return { n, ink, bg, inkShare: ink / n, bgShare: bg / n };
  });
  record(`${label}:hero-nonblank`, heroSample.ink >= 20 && heroSample.inkShare >= 0.04, JSON.stringify(heroSample));
  record(`${label}:hero-background-share`, heroSample.bgShare >= 0.25, `bgShare=${heroSample.bgShare.toFixed(2)} (dots masked to the object)`);
  const maskCheck = await page.evaluate(() => {
    const store = window.__HSW || window.__HTW;
    const scene = (store.scenes || []).find((s) => s.userData?.element?.dataset?.scene === 'hero');
    const mesh = scene?.children.find((c) => c.isMesh);
    if (!mesh) return { error: 'no hero mesh' };
    const cam = scene.userData.camera;
    const el = scene.userData.element;
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const r = el.getBoundingClientRect();
    mesh.geometry.computeBoundingSphere();
    const rad = mesh.geometry.boundingSphere.radius * mesh.scale.x * 1.12;
    const c = mesh.position.clone().project(cam);
    const d = cam.position.distanceTo(mesh.position);
    const rNdc = rad / Math.sqrt(Math.max(1e-6, d * d - rad * rad)) / Math.tan((cam.fov * Math.PI) / 360);
    const cx = r.left + ((c.x + 1) / 2) * r.width;
    const cy = r.top + ((1 - c.y) / 2) * r.height;
    const rPx = (rNdc * r.height) / 2;
    const sx = canvas.width / canvas.clientWidth, sy = canvas.height / canvas.clientHeight;
    const p = new Uint8Array(4);
    let out = 0, outBg = 0, inn = 0, inInk = 0;
    for (let gy = 0; gy < 30; gy++) for (let gx = 0; gx < 30; gx++) {
      const vx = r.left + (r.width * (gx + 0.5)) / 30, vy = r.top + (r.height * (gy + 0.5)) / 30;
      if (vx < 0 || vy < 0 || vx >= canvas.clientWidth || vy >= canvas.clientHeight) continue;
      gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      const dark = p[0] < 28 && p[1] < 28 && p[2] < 28;
      if (Math.hypot(vx - cx, vy - cy) > rPx) { out++; if (dark) outBg++; } else { inn++; if (!dark) inInk++; }
    }
    return { out, outBgShare: out ? outBg / out : 1, inn, inInkShare: inn ? inInk / inn : 0, circle: { cx: Math.round(cx), cy: Math.round(cy), r: Math.round(rPx) } };
  });
  record(
    `${label}:hero-mask-outside-object`,
    !maskCheck.error && maskCheck.out >= 20 && maskCheck.outBgShare >= 0.98 && maskCheck.inInkShare >= 0.08,
    JSON.stringify(maskCheck)
  );
  const boxes = await page.evaluate(() => {
    const pick = {
      glossary: '.hero-gloss',
      seriesPill: '.series-nav a',
      enterLink: '.scroll-cue a[href="#s01"]',
      heroBox: '[data-scene="hero"]',
      firstSpecimen: '#s01 .view',
    };
    const out = {};
    for (const [k, s] of Object.entries(pick)) {
      const el = document.querySelector(s);
      const r = el?.getBoundingClientRect();
      out[k] = r ? { l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY } : null;
    }
    return out;
  });
  const keys = Object.keys(boxes);
  const hits = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = boxes[keys[i]], b = boxes[keys[j]];
      if (!a || !b) { hits.push(`${keys[i]}|${keys[j]} missing`); continue; }
      if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) hits.push(`${keys[i]}×${keys[j]}`);
    }
  }
  record(`${label}:hero-no-overlap`, hits.length === 0, hits.length ? hits.join(', ') : `${keys.length} boxes clear`);

  // —— Controls ——
  await ctrlTest(page, label, 'ao-map-toggle', 'ao', () => clickChip(page, '[data-ao="on"]'));
  await clickChip(page, '[data-ao="on"]');
  await ctrlTest(page, label, 'ao-strength', 'ao', () => setRange(page, '#ao-int', 0));
  await setRange(page, '#ao-int', 1);
  await ctrlTest(page, label, 'ao-show-map', 'ao', () => clickChip(page, '[data-ao="view"]'));
  await clickChip(page, '[data-ao="view"]');

  await ctrlTest(page, label, 'wear-use', 'edges', () => setRange(page, '#wear-use', 1));
  await setRange(page, '#wear-use', 0.55);
  await ctrlTest(page, label, 'edge-mask', 'edges', () => clickChip(page, '[data-edge="mask"]'));
  await clickChip(page, '[data-edge="mask"]');
  await setRange(page, '#wear-use', 0);
  await ctrlTest(page, label, 'rub', 'edges', async () => {
    await clickChip(page, '[data-rub="on"]');
    await ensureSceneVisible(page, 'edges');
    const box = await page.locator('[data-scene="edges"]').boundingBox();
    const y0 = box.y + box.height * 0.45;
    await page.mouse.move(box.x + box.width * 0.18, y0);
    await page.mouse.down();
    for (let i = 0; i <= 40; i++) {
      await page.mouse.move(box.x + box.width * (0.18 + 0.64 * (i / 40)), y0 + Math.sin(i * 0.5) * box.height * 0.08);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await clickChip(page, '[data-rub="on"]');
  }, 0.4);
  await setRange(page, '#wear-use', 0.55);

  await ctrlTest(page, label, 'tile-count', 'tiles', () => setRange(page, '#tile-count', 14));
  await ctrlTest(page, label, 'break-grid', 'tiles', () => clickChip(page, '[data-tile="break"]'));
  await ensureSceneVisible(page, 'tiles');
  await page.screenshot({ path: path.join(OUT, `${label}-s03-broken.png`) });
  await clickChip(page, '[data-tile="break"]');
  await setRange(page, '#tile-count', 6);

  await clickChip(page, '[data-cmp="spin"]'); // turntable off so Age is measured on a still frame
  await ctrlTest(page, label, 'cmp-age', 'cmp-used', () => setRange(page, '#cmp-age', 0));
  await ctrlTest(page, label, 'cmp-age-up', 'cmp-used', () => setRange(page, '#cmp-age', 1));
  await ensureSceneVisible(page, 'cmp-used');
  await page.screenshot({ path: path.join(OUT, `${label}-s04-age1.png`) });
  await setRange(page, '#cmp-age', 0.65);
  {
    await ensureSceneVisible(page, 'cmp-new');
    const a = await sampleView(page, '[data-scene="cmp-new"]');
    await page.waitForTimeout(500); await waitFrames(page, 4);
    const b = await sampleView(page, '[data-scene="cmp-new"]');
    const still = avgDiff(a?.patch, b?.patch);
    await clickChip(page, '[data-cmp="spin"]');
    await page.waitForTimeout(900); await waitFrames(page, 4);
    const c = await sampleView(page, '[data-scene="cmp-new"]');
    const spin = avgDiff(b?.patch, c?.patch);
    record(`${label}:ctrl-turntable`, spin > Math.max(1.0, still * 2 + 0.3), `off=${still.toFixed(2)} on=${spin.toFixed(2)}`);
  }

  await typeWearChecks(page, context, label, vw < 700);
  await realWorldChecks(page, label, 'lesson04');
  const hs2 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:no-hscroll-end`, !hs2);

  // —— Screenshots ——
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${label}-hero.png`) });
  for (const id of ['s01', 's02', 's03', 's04', 'real-world', 'teachers']) {
    await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start' }), id);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${label}-${id}.png`) });
  }

  const realErrs = consoleMsgs.filter((t) => !/swiftshader|GroupMarkerNotSet|GPU stall|ReadPixels|Automatic fallback/i.test(t));
  record(`${label}:no-console-errors`, realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
  await browser.close();
}

async function checkSeriesLinks() {
  console.log('\n===== Series links =====');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('.series-nav a')].map((a) => a.href));
  record('series:wear-nav-has-3', hrefs.length === 3, hrefs.join(' '));
  const names = ['lesson01', 'lesson02', 'lesson03'];
  for (let i = 0; i < hrefs.length; i++) {
    const r = await page.goto(hrefs[i], { waitUntil: 'networkidle', timeout: 90000 }).catch((e) => null);
    const ok = !!(r && r.ok());
    const store = ok ? await page.waitForFunction(() => !!(window.__HSW || window.__HTW), null, { timeout: 45000 }).then(() => true).catch(() => false) : false;
    record(`series:${names[i]}-loads`, ok && store, `${hrefs[i]} status=${r?.status()}`);
  }
  await page.goto(ROOT, { waitUntil: 'networkidle', timeout: 60000 });
  const wearLink = await page.locator('a[href="/wear/"]').count();
  record('series:lesson02-has-wear-nav', wearLink > 0, `count=${wearLink}`);
  await browser.close();
}

const only = process.env.ONLY || 'desk,phone,webkit,root,links';
if (only.includes('desk')) await runSuite(chromium, 'chromium-desk', { viewport: { width: 1440, height: 900 } });
if (only.includes('phone')) await runSuite(chromium, 'chromium-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
if (only.includes('webkit')) await runSuite(webkit, 'webkit-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
if (only.includes('desk')) await reducedMotionCheck(chromium, 'chromium-desk-rm', { viewport: { width: 1440, height: 900 } });
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
if (only.includes('root')) {
  await runRootSuite(chromium, 'chromium-desk', { viewport: { width: 1440, height: 900 } });
  await runRootSuite(chromium, 'chromium-phone', PHONE);
  await runRootSuite(webkit, 'webkit-phone', PHONE);
}
if (only.includes('links')) await checkSeriesLinks();

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
console.log(`\n==== SUMMARY: ${pass} pass / ${fail} fail / ${results.length} total ====`);
fs.writeFileSync(path.join(OUT, 'qa-summary.json'), JSON.stringify({ base: BASE, pass, fail, results }, null, 2));
process.exit(fail > 0 ? 1 : 0);
