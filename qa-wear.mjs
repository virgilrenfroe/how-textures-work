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
const L03 = 'https://how-surfaces-work-preview-production.up.railway.app/sheen/';
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

  const badCopy = await page.evaluate(() => {
    const parts = [document.body.innerText, document.title];
    document.querySelectorAll('[aria-label]').forEach((e) => parts.push(e.getAttribute('aria-label')));
    document.querySelectorAll('meta[content]').forEach((e) => parts.push(e.getAttribute('content')));
    const t = parts.join(' \n ').toLowerCase();
    const banned = [/webgl/, /\bdpr\b/, /three\.js/, /reduced[- ]motion/, /frame ?rate/, /\bfps\b/, /virgil/, /\bqa\b/, /context lost/, /shader/, /scissor/, /render target/, /onbeforecompile/];
    return banned.filter((b) => b.test(t)).map(String);
  });
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
  await setRange(page, '#cmp-age', 0.8);
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

  // —— Screenshots ——
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${label}-hero.png`) });
  for (const id of ['s01', 's02', 's03', 's04', 'teachers']) {
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

const only = process.env.ONLY || 'desk,phone,webkit,links';
if (only.includes('desk')) await runSuite(chromium, 'chromium-desk', { viewport: { width: 1440, height: 900 } });
if (only.includes('phone')) await runSuite(chromium, 'chromium-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
if (only.includes('webkit')) await runSuite(webkit, 'webkit-phone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
if (only.includes('links')) await checkSeriesLinks();

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
console.log(`\n==== SUMMARY: ${pass} pass / ${fail} fail / ${results.length} total ====`);
fs.writeFileSync(path.join(OUT, 'qa-summary.json'), JSON.stringify({ base: BASE, pass, fail, results }, null, 2));
process.exit(fail > 0 ? 1 : 0);
