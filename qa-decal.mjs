/**
 * Full QA for Lesson 13 (/decal/): How Stickers Sit on Top
 * BASE=<url> node qa-decal.mjs   (ONLY=desk,phone,land,webkit to pick configs)
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(path.join(process.env.PW_ROOT || '/workspace/materials-demo', 'package.json'));
const { chromium, webkit, devices } = require('playwright');

const BASE = process.env.BASE || 'https://how-textures-work-l13-preview-production.up.railway.app/decal/';
const OUT = path.resolve(process.env.OUT || '/workspace/lesson13/shots');
fs.mkdirSync(OUT, { recursive: true });
const TITLE = 'How Stickers Sit on Top · Lesson 13 · Materials';
const NAV = [
  'https://how-surfaces-work-production.up.railway.app/',
  'https://how-textures-work-production.up.railway.app/',
  'https://how-surfaces-work-production.up.railway.app/sheen/',
  'https://how-textures-work-preview-production.up.railway.app/wear/',
  'https://how-surfaces-work-l05-preview-production.up.railway.app/fresnel/',
  'https://how-textures-work-l06-preview-production.up.railway.app/grain/',
  'https://how-surfaces-work-l07-preview-production.up.railway.app/refract/',
  'https://how-textures-work-l08-preview-production.up.railway.app/uv/',
  'https://how-surfaces-work-l09-preview-production.up.railway.app/scatter/',
  'https://how-textures-work-l10-preview-production.up.railway.app/mips/',
  'https://how-surfaces-work-l11-preview-production.up.railway.app/aniso/',
];
const SCENES = ['hero', 'place', 'blend', 'project', 'stack'];
const LEFTOVER = [/toolbox/, /how wear shows/, /edges turn to mirrors/, /soft surfaces shimmer/, /lesson 0[1-9] · materials/, /lesson 1[0-2] · materials/, /ambient occlusion/, /\bfresnel\b/, /velvet/, /\bsheen\b/, /\bprimer\b/, /\brust\b/, /\bage slider\b/, /specimen 05/, /growth ring/, /wood and stone get their patterns/, /how maps wrap/, /how detail holds/, /mipmap/, /triplanar/, /texel density/, /rings around a trunk/];
const BANNED = [/webgl/, /\bdpr\b/, /three\.js/, /reduced[- ]motion/, /frame ?rate/, /\bfps\b/, /virgil/, /\bqa\b/, /context lost/, /shader/, /scissor/, /render target/, /onbeforecompile/, /\bglsl\b/, /\btodo\b/, /lorem/, /\bpreview\b/, /\bdebug\b/];

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
  await page.waitForFunction(() => window.__HTW && window.__HTW.scenes?.length >= 5 && window.__HTW.frameCount > 5, null, { timeout: 90000 });
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


async function shotSection(page, id, file) {
  await page.evaluate((id) => document.getElementById(id).scrollIntoView({ block: 'start', behavior: 'instant' }), id);
  await page.waitForTimeout(900);
  await waitFrames(page, 4);
  await page.screenshot({ path: path.join(OUT, file) });
}

/** Real touch drag on a slider (CDP touch events in Chromium; WebKit gets a pointer drag) */
async function touchDrag(page, cdp, sel, fromFrac, toFrac) {
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center', behavior: 'instant' }), sel);
  await page.waitForTimeout(300);
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
  const y = r.y + r.h / 2;
  const x0 = r.x + r.w * fromFrac, x1 = r.x + r.w * toFrac;
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 12, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    await page.mouse.move(x0, y); await page.mouse.down();
    for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y); await page.waitForTimeout(16); }
    await page.mouse.up();
  }
  await page.waitForTimeout(200);
}

async function runSuite(browserType, label, ctxOpts) {
  const vw = ctxOpts.viewport.width, vh = ctxOpts.viewport.height;
  const isPhone = !!ctxOpts.isMobile || !!ctxOpts.hasTouch;
  console.log(`\n===== ${label} ${vw}x${vh} =====`);
  const isWebKit = browserType.name() === 'webkit';
  const browser = await browserType.launch({
    args: isWebKit ? [] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ ...ctxOpts });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const consoleMsgs = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleMsgs.push(msg.text()); });
  page.on('pageerror', (err) => consoleMsgs.push(String(err)));

  const resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
  record(`${label}:load`, !!(resp && resp.ok()), `status=${resp?.status()}`);
  await waitReady(page);

  // —— Page basics ——
  const nCanvas = await page.evaluate(() => document.querySelectorAll('canvas').length);
  record(`${label}:one-canvas`, nCanvas === 1, `count=${nCanvas}`);
  const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:no-hscroll`, !hScroll);
  const dpr = await page.evaluate(() => window.__HTW.renderer.getPixelRatio());
  const cap = isPhone || vw < 700 ? 1.5 : 2;
  record(`${label}:dpr-cap`, dpr <= cap + 1e-6, `pixelRatio=${dpr} cap=${cap}`);
  const titles = await page.evaluate(() => ({
    title: document.title,
    og: document.querySelector('meta[property="og:title"]')?.content,
    tw: document.querySelector('meta[name="twitter:title"]')?.content,
  }));
  record(`${label}:title-tab`, titles.title === TITLE, titles.title);
  record(`${label}:title-og`, titles.og === TITLE, titles.og);
  record(`${label}:title-twitter`, titles.tw === TITLE, titles.tw);
  const kicker = (await page.locator('.hero-kicker').textContent())?.trim();
  record(`${label}:kicker`, kicker === 'Lesson 13 · Materials', kicker);
  const copy = await page.evaluate(() => {
    const parts = [document.body.innerText, document.title];
    document.querySelectorAll('[aria-label]').forEach((e) => parts.push(e.getAttribute('aria-label')));
    document.querySelectorAll('meta[content]').forEach((e) => parts.push(e.getAttribute('content')));
    return parts.join(' \n ').toLowerCase();
  });
  const bad = BANNED.filter((b) => b.test(copy)).map(String);
  record(`${label}:audience-lock`, bad.length === 0, bad.join(','));
  const left = LEFTOVER.filter((b) => b.test(copy)).map(String);
  record(`${label}:no-leftover-copy`, left.length === 0, left.join(','));
  const fonts = await page.evaluate(async () => { await document.fonts.ready; return ['Space Grotesk', 'Gabarito', 'JetBrains Mono'].map((f) => document.fonts.check(`16px "${f}"`)); });
  record(`${label}:fonts`, fonts.every(Boolean), JSON.stringify(fonts));
  const sm = await page.evaluate(() => ['s01', 's02', 's03', 's04'].map((id) => getComputedStyle(document.getElementById(id)).scrollMarginTop));
  record(`${label}:scroll-margin`, sm.every((v) => parseFloat(v) > 0), sm.join(','));
  const nav = await page.evaluate(() => [...document.querySelectorAll('.series-nav a')].map((a) => a.href));
  record(`${label}:series-nav`, JSON.stringify(nav) === JSON.stringify(NAV), nav.join(' '));
  const ctl = await page.evaluate(() => Object.fromEntries(window.__HTW.scenes.map((s) => [s.userData.element.dataset.scene, s.userData.controls.enabled])));
  record(`${label}:orbit-off-where-slider-owns-view`, ctl.hero === false, JSON.stringify(ctl));
  if (isPhone || vw <= 700) {
    const hs = await page.evaluate(() => [...document.querySelectorAll('.ctrl input[type="range"]')].map((e) => Math.round(e.getBoundingClientRect().height)));
    record(`${label}:slider-44px`, hs.length >= 5 && hs.every((h) => h >= 44), hs.join(','));
  }
  const rw = await page.evaluate(() => {
    const sec = document.getElementById('real-world');
    if (!sec) return null;
    const items = [...sec.querySelectorAll('.rw-item')].map((li) => ({
      setting: li.querySelector('.rw-setting')?.textContent.trim(), job: li.querySelector('.rw-job')?.textContent.trim(), text: li.querySelector('p')?.textContent.trim(),
    }));
    const order = [...document.querySelectorAll('section')].map((s) => s.id);
    return { title: sec.querySelector('h2')?.textContent.trim(), items, afterSpecimens: order.indexOf('real-world') > order.indexOf('s04') };
  });
  record(`${label}:real-world-section`, !!rw && rw.title === 'Where you see this' && rw.afterSpecimens && rw.items.length >= 3 && rw.items.length <= 5 &&
    rw.items.every((i) => i.setting && i.job && /[.]$/.test(i.text) && i.text.split(/\s+/).length >= 15), rw ? `entries=${rw.items.length}` : 'missing');

  // —— Every specimen renders ——
  for (const name of SCENES) {
    await ensureSceneVisible(page, name);
    const s = await sampleView(page, `[data-scene="${name}"]`, name === 'hero' ? 8 : 5);
    const need = name === 'hero' ? 1 : 3; // hero post discards page colour; dots are sparse on a coarse grid
    record(`${label}:nonblank-${name}`, s && s.nonBlank >= need, s ? `nonBlank=${s.nonBlank}` : 'null');
  }

  // —— Strict hero checks ——
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await waitFrames(page, 6);
  const heroSample = await page.evaluate(() => {
    const el = document.querySelector('[data-scene="hero"]');
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const r = el.getBoundingClientRect();
    const sx = canvas.width / canvas.clientWidth, sy = canvas.height / canvas.clientHeight;
    const x0 = Math.max(0, r.left), x1 = Math.min(canvas.clientWidth, r.right);
    const y0 = Math.max(0, r.top), y1 = Math.min(canvas.clientHeight, r.bottom);
    let n = 0, ink = 0, bg = 0;
    const p = new Uint8Array(4);
    for (let gy = 0; gy < 24; gy++) for (let gx = 0; gx < 24; gx++) {
      const vx = x0 + ((x1 - x0) * (gx + 0.5)) / 24, vy = y0 + ((y1 - y0) * (gy + 0.5)) / 24;
      gl.readPixels(Math.floor(vx * sx), Math.floor((canvas.clientHeight - vy) * sy), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      n++; if (p[0] < 28 && p[1] < 28 && p[2] < 28) bg++; else ink++;
    }
    return { n, ink, bg, inkShare: ink / n, bgShare: bg / n };
  });
  record(`${label}:hero-nonblank`, heroSample.ink >= (label.includes('land') ? 8 : 20) && heroSample.inkShare >= (label.includes('land') ? 0.015 : 0.04), JSON.stringify(heroSample));
  record(`${label}:hero-background-share`, heroSample.bgShare >= 0.25, `bgShare=${heroSample.bgShare.toFixed(2)}`);
  const maskCheck = await page.evaluate(() => {
    const store = window.__HTW;
    const scene = store.scenes.find((s) => s.userData?.element?.dataset?.scene === 'hero');
    let mesh = null;
    scene.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    if (!mesh) return { error: 'no hero mesh' };
    const cam = scene.userData.camera;
    const el = scene.userData.element;
    const canvas = document.getElementById('c');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const r = el.getBoundingClientRect();
    mesh.geometry.computeBoundingSphere();
    mesh.updateWorldMatrix(true, false);
    const center = mesh.geometry.boundingSphere.center.clone().applyMatrix4(mesh.matrixWorld);
    const rad = mesh.geometry.boundingSphere.radius * 1.12;
    const c = center.clone().project(cam);
    const d = cam.position.distanceTo(center);
    const rNdc = rad / Math.sqrt(Math.max(1e-6, d * d - rad * rad)) / Math.tan((cam.fov * Math.PI) / 360);
    const cx = r.left + ((c.x + 1) / 2) * r.width, cy = r.top + ((1 - c.y) / 2) * r.height;
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
  record(`${label}:hero-mask-outside-object`, !maskCheck.error && maskCheck.out >= 20 && maskCheck.outBgShare >= 0.98 && maskCheck.inInkShare >= 0.08, JSON.stringify(maskCheck));
  const boxes = await page.evaluate(() => {
    const pick = { glossary: '.hero-gloss', seriesPill: '.series-nav', enterLink: '.scroll-cue a[href="#s01"]', heroBox: '[data-scene="hero"]', heroTitle: '.hero h1', firstSpecimen: '#s01 .view' };
    const out = {};
    for (const [k, s] of Object.entries(pick)) {
      const r = document.querySelector(s)?.getBoundingClientRect();
      out[k] = r ? { l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY } : null;
    }
    return out;
  });
  const keys = Object.keys(boxes), hits = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = boxes[keys[i]], b = boxes[keys[j]];
    if (!a || !b) { hits.push(`${keys[i]}|${keys[j]} missing`); continue; }
    if (a.l < b.r - 0.5 && b.l < a.r - 0.5 && a.t < b.b - 0.5 && b.t < a.b - 0.5) hits.push(`${keys[i]}×${keys[j]}`);
  }
  record(`${label}:hero-no-overlap`, hits.length === 0, hits.length ? hits.join(', ') : `${keys.length} boxes clear`);
  // Placard text must not overlap neighbouring views
  const placardHits = await page.evaluate(() => {
    const out = [];
    for (const sec of document.querySelectorAll('.specimen')) {
      const pl = sec.querySelector('.placard').getBoundingClientRect();
      for (const v of sec.querySelectorAll('.view')) {
        const r = v.getBoundingClientRect();
        if (pl.left < r.right - 0.5 && r.left < pl.right - 0.5 && pl.top < r.bottom - 0.5 && r.top < pl.bottom - 0.5) out.push(sec.id);
      }
    }
    return out;
  });
  record(`${label}:specimens-no-overlap`, placardHits.length === 0, placardHits.join(','));

  // Animation off for the control tests: idle drift and spin would hide small real changes
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await waitFrames(page, 6);
  // —— Hero lens follows the pointer ——
  // Sample while the pointer is still over the view. A later scrollIntoView would fire
  // pointerleave and, under reduced motion, snap the lens back to its resting spot.
  if (!isPhone) {
    await ensureSceneVisible(page, 'hero');
    const a = await sampleView(page, '[data-scene="hero"]');
    await waitFrames(page, 4);
    const b = await sampleView(page, '[data-scene="hero"]');
    const noise = avgDiff(a?.patch, b?.patch);
    const pts = await page.evaluate(() => {
      const el = document.querySelector('[data-scene="hero"]'); const box = el.getBoundingClientRect(); const out = [];
      for (let fx = 0.95; fx >= 0.4; fx -= 0.05) {
        const x = box.left + box.width * fx, y = box.top + box.height * 0.55;
        if (document.elementFromPoint(x, y) === el) out.push([x, y]);
      }
      return out;
    });
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.move(pts[pts.length - 1][0], pts[pts.length - 1][1], { steps: 8 });
    await page.waitForTimeout(400);
    await waitFrames(page, 4);
    const c = await sampleView(page, '[data-scene="hero"]');
    const d = avgDiff(b?.patch, c?.patch);
    record(`${label}:ctrl-hero-lens`, d > Math.max(1.0, noise * 2 + 0.5) && (c?.nonBlank ?? 0) >= 3, `diff=${d.toFixed(2)} noise=${noise.toFixed(2)}`);
    await page.mouse.move(5, 5);
  }

  // —— Controls change the render ——
  await ctrlTest(page, label, 'place-offset-x', 'place', () => setRange(page, '#place-x', 0.4));
  await setRange(page, '#place-x', 0);
  await ctrlTest(page, label, 'place-offset-y', 'place', () => setRange(page, '#place-y', -0.3));
  await setRange(page, '#place-y', 0.05);
  await ctrlTest(page, label, 'place-scale', 'place', () => setRange(page, '#place-scale', 1.3));
  await setRange(page, '#place-scale', 0.75);
  await ctrlTest(page, label, 'place-rotation', 'place', () => setRange(page, '#place-rot', 35), 1.0);
  await setRange(page, '#place-rot', 0);
  await ctrlTest(page, label, 'blend-opacity', 'blend', () => setRange(page, '#blend-op', 0.1));
  await setRange(page, '#blend-op', 0.75);
  await ctrlTest(page, label, 'blend-multiply', 'blend', () => clickChip(page, '[data-blend="multiply"]'));
  await clickChip(page, '[data-blend="cover"]');
  await ctrlTest(page, label, 'proj-angle', 'project', () => setRange(page, '#proj-angle', 65));
  await setRange(page, '#proj-angle', 15);
  await ctrlTest(page, label, 'stack-logo', 'stack', () => clickChip(page, '[data-stack="logo"]'));
  await clickChip(page, '[data-stack="logo"]'); // back on
  await ctrlTest(page, label, 'stack-scratch', 'stack', () => clickChip(page, '[data-stack="scratch"]'));
  await clickChip(page, '[data-stack="scratch"]');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // —— Real touch drag on sliders (phones) ——
  if (isPhone) {
    const cdp = isWebKit ? null : await context.newCDPSession(page);
    for (const [sel, scene, from, to] of [['#place-x', 'place', 0.2, 0.9], ['#blend-op', 'blend', 0.9, 0.1], ['#proj-angle', 'project', 0.1, 0.9]]) {
      await ensureSceneVisible(page, scene);
      const before = await page.evaluate((s) => document.querySelector(s).value, sel);
      const a = await sampleView(page, `[data-scene="${scene}"]`);
      await touchDrag(page, cdp, sel, from, to);
      await ensureSceneVisible(page, scene);
      const after = await page.evaluate((s) => document.querySelector(s).value, sel);
      const c = await sampleView(page, `[data-scene="${scene}"]`);
      const d = avgDiff(a?.patch, c?.patch);
      record(`${label}:touch-drag ${sel}`, before !== after && d > 1.2, `${before}→${after} diff=${d.toFixed(2)}${isWebKit ? ' (pointer drag)' : ' (touch)'}`);
    }
    await setRange(page, '#place-x', 0); await setRange(page, '#blend-op', 0.75); await setRange(page, '#proj-angle', 15);
  }
  const hScroll2 = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  record(`${label}:no-hscroll-after-interaction`, !hScroll2);

  // —— Screenshots ——
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${label}-hero.png`) });
  for (const id of ['s01', 's02', 's03', 's04', 'real-world', 'teachers']) await shotSection(page, id, `${label}-${id}.png`);
  if (!isPhone) {
    await setRange(page, '#place-x', 0.35); await setRange(page, '#place-y', -0.2);
    await setRange(page, '#place-scale', 1.15); await setRange(page, '#place-rot', 28);
    await shotSection(page, 's01', `${label}-s01-moved.png`);
    await setRange(page, '#place-x', 0); await setRange(page, '#place-y', 0.05);
    await setRange(page, '#place-scale', 0.75); await setRange(page, '#place-rot', 0);
    await setRange(page, '#blend-op', 0.25);
    await shotSection(page, 's02', `${label}-s02-soft.png`);
    await clickChip(page, '[data-blend="multiply"]');
    await setRange(page, '#blend-op', 0.85);
    await shotSection(page, 's02', `${label}-s02-multiply.png`);
    await clickChip(page, '[data-blend="cover"]');
    await setRange(page, '#blend-op', 0.75);
    await setRange(page, '#proj-angle', 65);
    await shotSection(page, 's03', `${label}-s03-steep.png`);
    await setRange(page, '#proj-angle', 15);
    await clickChip(page, '[data-stack="scratch"]'); // off
    await shotSection(page, 's04', `${label}-s04-logo-only.png`);
    await clickChip(page, '[data-stack="scratch"]'); // on
    await clickChip(page, '[data-stack="logo"]'); // off
    await shotSection(page, 's04', `${label}-s04-scratch-only.png`);
    await clickChip(page, '[data-stack="logo"]');
  }

  const realErrs = consoleMsgs.filter((t) => !/swiftshader|GroupMarkerNotSet|GPU stall|ReadPixels|Automatic fallback/i.test(t));
  record(`${label}:no-console-errors`, realErrs.length === 0, realErrs.slice(0, 3).join(' | '));
  await browser.close();
}

async function reducedMotionCheck() {
  console.log('\n===== reduced motion (live listener) =====');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 90000 });
  await waitReady(page);
  const a = await page.evaluate(() => window.__HTW.reducedMotion);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(300);
  await waitFrames(page, 8);
  const b = await page.evaluate(() => window.__HTW.reducedMotion);
  await ensureSceneVisible(page, 'place');
  const s1 = await sampleView(page, '[data-scene="place"]');
  await page.waitForTimeout(1200); await waitFrames(page, 4);
  const s2 = await sampleView(page, '[data-scene="place"]');
  const still = avgDiff(s1?.patch, s2?.patch);
  const tick = await page.evaluate(() => getComputedStyle(document.querySelector('.ticker-track')).animationName);
  record('rm:live-listener', a === false && b === true, `before=${a} after=${b}`);
  record('rm:scenes-hold-still', still < 0.6, `diff=${still.toFixed(2)}`);
  record('rm:ticker-stops', tick === 'none', tick);
  await browser.close();
}

async function navLinksLoad() {
  console.log('\n===== series links =====');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  for (const url of NAV) {
    const r = await ctx.request.get(url).catch(() => null);
    record(`links:${url.replace(/^https:\/\//, '')}`, !!r && r.ok(), `status=${r?.status()}`);
  }
  await browser.close();
}

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true };
const only = process.env.ONLY || 'desk,phone,land,webkit,rm,links';
if (only.includes('desk')) await runSuite(chromium, 'chromium-desk', { viewport: { width: 1440, height: 900 } });
if (only.includes('phone')) await runSuite(chromium, 'chromium-phone', PHONE);
if (only.includes('land')) await runSuite(chromium, 'chromium-phone-land', { ...PHONE, viewport: { width: 844, height: 390 } });
if (only.includes('webkit')) {
  const { defaultBrowserType, ...iphone } = devices['iPhone 13'];
  await runSuite(webkit, 'webkit-iphone', iphone);
}
if (only.includes('rm')) await reducedMotionCheck();
if (only.includes('links')) await navLinksLoad();

const pass = results.filter((r) => r.pass).length;
const fail = results.filter((r) => !r.pass).length;
console.log(`\n==== SUMMARY: ${pass} pass / ${fail} fail / ${results.length} total ====`);
fs.writeFileSync(path.join(OUT, 'qa-summary.json'), JSON.stringify({ base: BASE, pass, fail, results }, null, 2));
process.exit(fail > 0 ? 1 : 0);
