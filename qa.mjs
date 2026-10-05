/**
 * Thorough functional QA for How Textures Work
 */
import { chromium, webkit } from 'playwright';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const BASE = process.env.HSW_URL || 'https://how-textures-work-production.up.railway.app/';
const OUT = path.resolve('shots/qa');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function record(id, pass, detail = '') {
  results.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id}${detail ? ' — ' + detail : ''}`);
}


function sceneByName(store, name) {
  const scenes = store?.scenes || [];
  return scenes.find((s) => s.userData?.element?.dataset?.scene === name) || null;
}

function avgDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let sum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  return sum / (n * 3);
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
    const pixels = [];
    let nonBlank = 0;
    let ink = 0;
    for (let gy = 1; gy <= grid; gy++) {
      for (let gx = 1; gx <= grid; gx++) {
        const vx = r.left + (r.width * gx) / (grid + 1);
        const vy = r.top + (r.height * gy) / (grid + 1);
        if (vx < 0 || vy < 0 || vx > canvas.clientWidth || vy > canvas.clientHeight) continue;
        const cx = Math.floor(vx * sx);
        const cy = Math.floor((canvas.clientHeight - vy) * sy);
        const p = new Uint8Array(4);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        pixels.push([...p]);
        const dark = p[0] < 28 && p[1] < 28 && p[2] < 28;
        if (dark) ink++;
        else nonBlank++;
      }
    }
    // also return a dense center patch for diffs
    const patch = [];
    const cx0 = r.left + r.width * 0.35;
    const cy0 = r.top + r.height * 0.4;
    const w = Math.min(48, r.width * 0.3);
    const h = Math.min(48, r.height * 0.3);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const vx = cx0 + (x / 15) * w;
        const vy = cy0 + (y / 15) * h;
        const cx = Math.floor(vx * sx);
        const cy = Math.floor((canvas.clientHeight - vy) * sy);
        const p = new Uint8Array(4);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        patch.push(p[0], p[1], p[2], p[3]);
      }
    }
    return {
      rect: { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
      nonBlank,
      ink,
      sampleCount: pixels.length,
      patch,
      mean: pixels.reduce((acc, p) => {
        acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2];
        return acc;
      }, [0, 0, 0]).map((v) => v / Math.max(1, pixels.length)),
    };
  }, { selector, grid });
}

async function waitReady(page) {
  await page.waitForFunction(() => window.__HTW && window.__HTW.scenes?.length >= 5, null, { timeout: 45000 });
  await page.waitForTimeout(800);
}

async function runSuite(browserType, label, launchOpts, viewportOpts) {
  const vw = viewportOpts.viewport?.width ?? viewportOpts.width; const vh = viewportOpts.viewport?.height ?? viewportOpts.height;
  console.log(`\n===== ${label} ${vw}x${vh} =====`);
  const browser = await browserType.launch(launchOpts);
  const context = await browser.newContext({
    ...viewportOpts,
    ignoreHTTPSErrors: false,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);

  const consoleMsgs = [];
  const failedReqs = [];
  const responses = [];
  let contextLost = false;

  page.on('console', (msg) => {
    consoleMsgs.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', (err) => {
    consoleMsgs.push({ type: 'pageerror', text: String(err) });
  });
  page.on('requestfailed', (req) => {
    failedReqs.push({ url: req.url(), err: req.failure()?.errorText });
  });
  page.on('response', (res) => {
    const url = res.url();
    if (
      url.includes('how-surfaces-work') ||
      url.includes('jsdelivr') ||
      url.includes('fonts.g') ||
      url.includes('googleapis') ||
      url.includes('gstatic')
    ) {
      responses.push({ url, status: res.status() });
    }
  });

  await page.addInitScript(() => {
    window.__qa = { frames: 0, lastFrame: 0, contextLost: false, renderedScenes: [] };
    const origRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) =>
      origRAF((t) => {
        window.__qa.frames += 1;
        window.__qa.lastFrame = t;
        return cb(t);
      });
  });

  // 1. Load
  const resp = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  record(`${label}:load-https`, resp && resp.ok() && BASE.startsWith('https'), `status=${resp?.status()}`);
  await waitReady(page);

  // Inject context-lost listener + render stats hook
  await page.evaluate(() => {
    const c = document.getElementById('c');
    c.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      window.__qa.contextLost = true;
    });
    // wrap renderer.render to count which scenes actually draw
    const H = window.__HSW;
    if (H && !H.__qaWrapped) {
      const orig = H.renderer.render.bind(H.renderer);
      let lastCount = 0;
      H.renderer.render = (scene, camera) => {
        lastCount += 1;
        window.__qa.lastRenderCount = lastCount;
        return orig(scene, camera);
      };
      H.__qaWrapped = true;
      // expose per-frame scene render tally via animate patch
      const scenes = H.scenes;
      scenes.forEach((s, i) => {
        const prev = s.userData.update;
        // tag
        s.userData.__qaIndex = i;
      });
    }
  });

  // Assets 200
  await page.waitForTimeout(500);
  const badAssets = responses.filter((r) => r.status >= 400);
  const fontOk = responses.some((r) => r.url.includes('fonts.g') || r.url.includes('gstatic') || r.url.includes('googleapis'));
  const threeOk = responses.some((r) => r.url.includes('three') && r.status === 200);
  record(`${label}:assets-200`, badAssets.length === 0 && threeOk, `bad=${badAssets.length} three=${threeOk} fontsSeen=${fontOk} totalTracked=${responses.length}`);
  record(`${label}:failed-network`, failedReqs.length === 0, JSON.stringify(failedReqs.slice(0, 5)));

  const errors = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'pageerror');
  const warnings = consoleMsgs.filter((m) => m.type === 'warning');
  record(`${label}:no-console-errors`, errors.length === 0, errors.map((e) => e.text).slice(0, 3).join(' | '));
  // warnings of note (WebGL, THREE)
  const notableWarn = warnings.filter((w) => /webgl|three|fail|deprecated/i.test(w.text));
  record(`${label}:no-notable-warnings`, notableWarn.length === 0, notableWarn.map((w) => w.text).slice(0, 2).join(' | '));

  // 2. One canvas / context
  const ctxInfo = await page.evaluate(() => {
    const canvases = document.querySelectorAll('canvas');
    // exclude any 2d canvases used only for matcap generation (those are not in DOM)
    const domCanvases = [...canvases].filter((c) => c.isConnected);
    return {
      domCanvases: domCanvases.length,
      ids: domCanvases.map((c) => c.id),
      hswCanvases: window.__HSW?.webglContexts?.() ?? null,
      scenes: window.__HSW?.scenes?.length,
    };
  });
  record(`${label}:one-canvas`, ctxInfo.domCanvases === 1 && ctxInfo.hswCanvases === 1, JSON.stringify(ctxInfo));

  // Hero specimen: present, non-blank, still one canvas
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
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
  // Mask check: outside the object's projected silhouette circle the hero must be page-coloured.
  // (Catches an inverted/unapplied mask where dots fill the whole rectangle.)
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
  // Layout: glossary, Series pill, Enter link, hero box, first specimen box never intersect
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
  const heroMeta = await page.evaluate(() => {
    const hero = document.querySelector('[data-scene="hero"]');
    const ticker = document.querySelector('.ticker');
    const track = document.querySelector('.ticker-track');
    const hsw = window.__HSW || window.__HTW;
    return {
      hero: !!hero,
      ticker: !!ticker,
      tickerPaused: track ? getComputedStyle(track).animationPlayState : null,
      heroPost: !!hsw?.heroPost,
      canvases: document.querySelectorAll('canvas').length,
      scenes: hsw?.scenes?.length ?? null,
    };
  });
  record(`${label}:hero-dom`, heroMeta.hero && heroMeta.ticker && heroMeta.heroPost && heroMeta.canvases === 1, JSON.stringify(heroMeta));

  // Audience lock: no developer/status words in visible learner text
  const devCopy = await page.evaluate(() => {
    const txt = [document.body.innerText, document.title,
      ...[...document.querySelectorAll('[aria-label],[alt],meta[name=description],meta[property^="og:"]')]
        .map((e) => e.getAttribute('aria-label') || e.getAttribute('alt') || e.getAttribute('content') || '')].join('\n');
    const bad = /webgl|three\.js|\bdpr\b|virgil|\bqa\b|reduced[- ]motion|safe mode|coarse pointer|\bfps\b|frame rate|pmrem|roomenvironment|\bcontext\b/i;
    return txt.split('\n').filter((l) => bad.test(l)).slice(0, 5);
  });
  record(`${label}:audience-copy`, devCopy.length === 0, JSON.stringify(devCopy));

  // 3. Scroll all specimens, non-blank + screenshots
  const specimens = [
    { id: 's01', view: '[data-scene="uvs"]', name: 'uvs' },
    { id: 's02', view: '[data-scene="maps"]', name: 'maps' },
    { id: 's03', view: '[data-scene="normal"]', name: 'normal' },
    { id: 's04', view: '[data-scene="weather"]', name: 'weather' },
  ];

  for (const sp of specimens) {
    await page.locator(`#${sp.id}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    const sample = await sampleView(page, sp.view);
    const ok = sample && sample.nonBlank >= 2;
    record(`${label}:render-${sp.name}`, ok, sample ? `nonBlank=${sample.nonBlank}/${sample.sampleCount} mean=${sample.mean?.map((n) => n.toFixed(0)).join(',')}` : 'null');
    const shotName = `${label}-${sp.name}.png`;
    await page.screenshot({ path: path.join(OUT, shotName) });
  }

  // screenshot displacement side while centerpiece is in view
  await page.locator('#s03').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const cmpDisp = await sampleView(page, '[data-scene="displace"]');
  record(`${label}:render-displace`, cmpDisp && cmpDisp.nonBlank >= 2, cmpDisp ? `nonBlank=${cmpDisp.nonBlank}` : 'null');
  await page.screenshot({ path: path.join(OUT, `${label}-displace.png`) });

  // Alignment check: scissor regions should match DOM rects (sample corners shouldn't bleed)
  // After scrolling to s02, s01 should be offscreen and not contributing; check that pixels outside s02 view toward top are page clear color or other
  await page.locator('#s02').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const align = await page.evaluate(() => {
    const canvas = document.getElementById('c');
    const view = document.querySelector('[data-scene="maps"]');
    const r = view.getBoundingClientRect();
    const cs = getComputedStyle(canvas);
    const intersectH = Math.min(r.bottom, canvas.clientHeight) - Math.max(r.top, 0);
    const intersectW = Math.min(r.right, canvas.clientWidth) - Math.max(r.left, 0);
    const visible = intersectH > 40 && intersectW > 40;
    // Sample a pixel that should be inside the visible intersection (not out in placard)
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const sx = canvas.width / canvas.clientWidth;
    const sy = canvas.height / canvas.clientHeight;
    let nonBlank = false;
    let pix = [0, 0, 0, 0];
    for (const fy of [0.35, 0.5, 0.65]) {
      for (const fx of [0.3, 0.5, 0.7]) {
        const vx = Math.max(r.left, 0) + Math.min(intersectW, r.width) * fx;
        const vy = Math.max(r.top, 0) + Math.min(intersectH, r.height) * fy;
        const cx = Math.floor(vx * sx);
        const cy = Math.floor((canvas.clientHeight - vy) * sy);
        const p = new Uint8Array(4);
        gl.readPixels(cx, cy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        pix = [...p];
        if (!(p[0] < 28 && p[1] < 28 && p[2] < 28)) { nonBlank = true; break; }
      }
      if (nonBlank) break;
    }
    return {
      visible,
      nonBlank,
      pix,
      position: cs.position,
      transform: cs.transform,
      canvasW: canvas.clientWidth,
      canvasH: canvas.clientHeight,
      view: { left: r.left, top: r.top, w: r.width, h: r.height },
      intersectH,
    };
  });
  record(`${label}:scissor-alignment`, align.position === 'fixed' && align.transform === 'none' && align.visible && align.nonBlank, JSON.stringify(align));

  // 4. Controls — MatCap
  await page.locator('#s01').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  const beforeFlat = await page.evaluate(() => {
    const scene = (window.__HTW.scenes || []).find((s) => s.userData?.element?.dataset?.scene === 'uvs');
    return scene?.userData?.meshes?.flat?.visible;
  });
  await page.locator('[data-uv="flat"]').click();
  await page.waitForTimeout(300);
  const afterFlat = await page.evaluate(() => {
    const scene = (window.__HTW.scenes || []).find((s) => s.userData?.element?.dataset?.scene === 'uvs');
    return scene?.userData?.meshes?.flat?.visible;
  });
  const beforeFocus = await sampleView(page, '[data-scene="uvs"]');
  await page.locator('[data-uv="box"]').click();
  await page.waitForTimeout(350);
  const afterFocus = await sampleView(page, '[data-scene="uvs"]');
  const focusDiff = avgDiff(beforeFocus?.patch, afterFocus?.patch);
  record(`${label}:ctrl-uv-flat`, beforeFlat === false && afterFlat === true, `flat ${beforeFlat}->${afterFlat}`);
  record(`${label}:ctrl-uv-focus`, focusDiff > 2, `diff=${focusDiff.toFixed(2)}`);

  // Albedo / roughness map toggles + preset
  await page.locator('#s02').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const mapsBefore = await sampleView(page, '[data-scene="maps"]');
  await page.locator('[data-map="albedo"]').click(); // turn off
  await page.waitForTimeout(300);
  const mapsNoAlb = await sampleView(page, '[data-scene="maps"]');
  const albDiff = avgDiff(mapsBefore?.patch, mapsNoAlb?.patch);
  record(`${label}:ctrl-albedo-toggle`, albDiff > 3, `diff=${albDiff.toFixed(2)}`);
  await page.locator('[data-map="albedo"]').click(); // back on
  await page.waitForTimeout(200);
  const mapsAlbOn = await sampleView(page, '[data-scene="maps"]');
  await page.locator('[data-map="rough"]').click(); // off
  await page.waitForTimeout(300);
  const mapsNoRough = await sampleView(page, '[data-scene="maps"]');
  const roughDiff = avgDiff(mapsAlbOn?.patch, mapsNoRough?.patch);
  record(`${label}:ctrl-rough-toggle`, roughDiff > 1.5, `diff=${roughDiff.toFixed(2)}`);
  await page.locator('[data-map="rough"]').click();
  await page.locator('[data-map="marble"]').click();
  await page.waitForTimeout(350);
  const mapsMarble = await sampleView(page, '[data-scene="maps"]');
  const presetDiff = avgDiff(mapsAlbOn?.patch, mapsMarble?.patch);
  record(`${label}:ctrl-preset-wood-marble`, presetDiff > 5, `diff=${presetDiff.toFixed(2)}`);
  await page.locator('[data-map="wood"]').click();

  // Centerpiece: silhouette + strength + orbit
  await page.locator('#s03').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const ndBefore = await sampleView(page, '[data-scene="normal"]');
  await page.locator('[data-nd="silhouette"]').click();
  await page.waitForTimeout(400);
  const ndSil = await sampleView(page, '[data-scene="normal"]');
  const silDiff = avgDiff(ndBefore?.patch, ndSil?.patch);
  record(`${label}:ctrl-silhouette`, silDiff > 5, `diff=${silDiff.toFixed(2)}`);
  await page.locator('[data-nd="silhouette"]').click(); // off
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const el = document.getElementById('nd-strength');
    el.value = '0.1';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const strengthLo = await page.evaluate(() => {
    const scene = (window.__HTW.scenes || []).find((s) => s.userData?.element?.dataset?.scene === 'displace');
    return scene?.userData?.meshes?.mat?.displacementScale;
  });
  await page.evaluate(() => {
    const el = document.getElementById('nd-strength');
    el.value = '0.9';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const strengthHi = await page.evaluate(() => {
    const scene = (window.__HTW.scenes || []).find((s) => s.userData?.element?.dataset?.scene === 'displace');
    return scene?.userData?.meshes?.mat?.displacementScale;
  });
  record(`${label}:ctrl-bump-strength`, strengthHi > strengthLo, `lo=${strengthLo} hi=${strengthHi}`);

  // Centerpiece orbit light
  await page.locator('#s03').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  // ensure orbit ON
  await page.evaluate(() => {
    const btn = document.querySelector('[data-nd="orbit"]');
    if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
  });
  await page.waitForTimeout(200);
  const ang1 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  await page.waitForTimeout(1200);
  const ang2 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  const deltaOn = Math.abs(ang2 - ang1);
  await page.evaluate(() => {
    const btn = document.querySelector('[data-nd="orbit"]');
    if (btn.getAttribute('aria-pressed') === 'true') btn.click();
  });
  await page.waitForTimeout(200);
  const ang3 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  await page.waitForTimeout(1200);
  const ang4 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  const deltaOff = Math.abs(ang4 - ang3);
  const orbitOn = await page.evaluate(() => window.__HTW.shared.orbitLight);
  record(
    `${label}:ctrl-orbit-light`,
    deltaOn > 0.05 && deltaOff < 0.02 && orbitOn === false,
    `deltaOn=${deltaOn.toFixed(3)} deltaOff=${deltaOff.toFixed(3)} orbitOn=${orbitOn}`
  );
  await page.evaluate(() => {
    const btn = document.querySelector('[data-nd="orbit"]');
    if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
  });

  // Weathering age slider
  await page.locator('#s04').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const ageBefore = await sampleView(page, '[data-scene="weather"]');
  await page.evaluate(() => {
    const el = document.getElementById('age');
    el.value = '0.05';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  const ageYoung = await sampleView(page, '[data-scene="weather"]');
  await page.evaluate(() => {
    const el = document.getElementById('age');
    el.value = '0.95';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  const ageOld = await sampleView(page, '[data-scene="weather"]');
  const ageDiff = avgDiff(ageYoung?.patch, ageOld?.patch);
  record(`${label}:ctrl-age-slider`, ageDiff > 5, `diff=${ageDiff.toFixed(2)}`);

  // Drag orbit (mouse or touch)
  await page.locator('#s01').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const dragView = page.locator('[data-scene="uvs"]');
  const box = await dragView.boundingBox();
  const beforeDrag = await sampleView(page, '[data-scene="uvs"]');
  if (box) {
    const x = box.x + box.width * 0.5;
    const y = box.y + box.height * 0.5;
    if (viewportOpts.hasTouch) {
      // Real touch drag for OrbitControls (pointer/touch listeners on the view element)
      await page.evaluate(({ x, y }) => {
        const el = document.querySelector('[data-scene="uvs"]');
        const fire = (type, x, y, id = 1) => {
          const opts = {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
            pointerId: id,
            pointerType: 'touch',
            isPrimary: true,
            buttons: type === 'pointerup' ? 0 : 1,
          };
          el.dispatchEvent(new PointerEvent(type, opts));
        };
        fire('pointerdown', x, y);
        fire('pointermove', x + 40, y + 10);
        fire('pointermove', x + 90, y + 25);
        fire('pointerup', x + 90, y + 25);
      }, { x, y });
    } else {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 110, y + 30, { steps: 15 });
      await page.mouse.up();
    }
    await page.waitForTimeout(400);
  }
  const afterDrag = await sampleView(page, '[data-scene="uvs"]');
  const dragDiff = avgDiff(beforeDrag?.patch, afterDrag?.patch);
  record(`${label}:ctrl-drag-orbit`, dragDiff > 2, `diff=${dragDiff.toFixed(2)}`);

  // Anchor link (clear hash first so re-click always scrolls)
  await page.evaluate(() => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForTimeout(800);
  await page.locator('.scroll-cue a[href="#s01"]').click({ force: true });
  await page.waitForTimeout(900);
  const scrolled = await page.evaluate(() => {
    const s01 = document.getElementById('s01');
    const r = s01.getBoundingClientRect();
    return { top: r.top, y: window.scrollY, hash: location.hash };
  });
  record(`${label}:anchor-enter-lab`, scrolled.top < 280 || scrolled.y > 60, JSON.stringify(scrolled));

  // 5. Resize desktop -> mobile alignment
  const deskW = viewportOpts.viewport?.width ?? viewportOpts.width ?? 1440;
  const deskH = viewportOpts.viewport?.height ?? viewportOpts.height ?? 900;
  if (deskW >= 1000) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    await page.locator('#s02').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const afterResize = await sampleView(page, '[data-scene="maps"]');
    const resizeAlign = await page.evaluate(() => {
      const canvas = document.getElementById('c');
      const view = document.querySelector('[data-scene="maps"]');
      const r = view.getBoundingClientRect();
      return {
        canvas: { w: canvas.clientWidth, h: canvas.clientHeight, bw: canvas.width, bh: canvas.height },
        viewIn: r.width > 0 && r.left >= -2 && r.right <= canvas.clientWidth + 2,
        dprCap: window.__HTW.renderer.getPixelRatio(),
      };
    });
    record(
      `${label}:resize-to-mobile`,
      afterResize?.nonBlank >= 2 && resizeAlign.viewIn && resizeAlign.canvas.w === 390,
      JSON.stringify({ nonBlank: afterResize?.nonBlank, ...resizeAlign })
    );
    // restore
    await page.setViewportSize({ width: deskW, height: deskH });
    await page.waitForTimeout(400);
  }

  // 6. prefers-reduced-motion — new page
  // tested in separate context below for chrome desktop only once

  // 7. Text / layout / fonts / teachers
  {
    const w = viewportOpts.viewport?.width ?? viewportOpts.width ?? 1440;
    const h = viewportOpts.viewport?.height ?? viewportOpts.height ?? 900;
    await page.setViewportSize({ width: w, height: h });
  }
  await page.locator('#teachers').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const layout = await page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const cs = getComputedStyle(body);
    const overflowHidden = /hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(getComputedStyle(doc).overflowX);
    const hScroll = !overflowHidden && (doc.scrollWidth > doc.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1);
    const teachers = document.getElementById('teachers');
    const tr = teachers.getBoundingClientRect();
    const fonts = [...document.fonts].filter((f) =>
      /Space Grotesk|Gabarito|JetBrains Mono/i.test(f.family)
    );
    const loaded = {
      display: fonts.some((f) => /Space Grotesk/i.test(f.family) && f.status === 'loaded'),
      body: fonts.some((f) => /Gabarito/i.test(f.family) && f.status === 'loaded'),
      mono: fonts.some((f) => /JetBrains Mono/i.test(f.family) && f.status === 'loaded'),
    };
    // overflow check on placards
    const overflows = [];
    document.querySelectorAll('.placard, .specimen-title, .lesson, .teachers').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 2) overflows.push(el.className || el.tagName);
    });
    return {
      hScroll,
      teachersVisible: tr.height > 100,
      teachersText: teachers.innerText.slice(0, 80),
      loaded,
      overflows,
      fontCount: fonts.length,
    };
  });
  record(`${label}:no-h-scroll`, !layout.hScroll, `scrollWidth check`);
  record(`${label}:fonts-loaded`, layout.loaded.display && layout.loaded.body && layout.loaded.mono, JSON.stringify(layout.loaded));
  record(`${label}:teachers-section`, layout.teachersVisible, layout.teachersText);
  // re-check teachers text properly
  const teachersText = await page.locator('#teachers').innerText();
  record(`${label}:teachers-readable`, /Learning objectives/i.test(teachersText) && /10-minute/i.test(teachersText) && /Art/i.test(teachersText), teachersText.slice(0, 120).replace(/\n/g, ' '));
  record(`${label}:no-text-overflow`, layout.overflows.length === 0, layout.overflows.join(','));

  // 8. Performance / offscreen skip
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  // At top, s04 should be offscreen — count how many scenes render by patching
  const perf = await page.evaluate(async () => {
    const H = window.__HSW;
    let draws = 0;
    const orig = H.renderer.render.bind(H.renderer);
    H.renderer.render = (s, c) => {
      draws += 1;
      return orig(s, c);
    };
    const t0 = performance.now();
    let frames = 0;
    await new Promise((resolve) => {
      const start = performance.now();
      function tick() {
        frames += 1;
        if (performance.now() - start > 1000) return resolve();
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    const t1 = performance.now();
    H.renderer.render = orig;
    // After 1s at hero, draws should be << 5 * frames (only onscreen views)
    return {
      frames,
      draws,
      drawsPerFrame: draws / Math.max(1, frames),
      ms: t1 - t0,
      fps: (frames / (t1 - t0)) * 1000,
    };
  });
  // At top of page, typically 0-1 specimen views visible (maybe none of the .view elements)
  record(
    `${label}:offscreen-skip`,
    perf.drawsPerFrame < 4.5,
    `draws/frame=${perf.drawsPerFrame.toFixed(2)} fps~${perf.fps.toFixed(1)} frames=${perf.frames}`
  );
  record(`${label}:fps-ballpark`, perf.fps > 15 || (perf.drawsPerFrame < 4.5 && perf.frames >= 1), `fps~${perf.fps.toFixed(1)} (SwiftShader may be slow)`);

  // context lost?
  const lost = await page.evaluate(() => window.__qa?.contextLost === true);
  record(`${label}:no-context-lost`, !lost && !contextLost, `lost=${lost}`);

  // mobile full page screenshot
  if ((viewportOpts.viewport?.width ?? viewportOpts.width ?? 1440) < 500) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${label}-fullpage.png`), fullPage: true });
  }

  await browser.close();
  return { consoleMsgs, failedReqs };
}

async function testReducedMotionAndVisibility() {
  console.log('\n===== reduced-motion + visibility =====');
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
  await waitReady(page);
  await page.locator('#s04').scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.locator('[data-nd="orbit"]').evaluate((el) => { if (el.getAttribute('aria-pressed') !== 'true') el.click(); });
  const rm = await page.evaluate(() => window.__HTW.reducedMotion);
  const ang1 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  const a = await sampleView(page, '[data-scene="displace"]');
  await page.waitForTimeout(1500);
  const ang2 = await page.evaluate(() => window.__HTW.shared.lightAngle);
  const b = await sampleView(page, '[data-scene="displace"]');
  const motionDiff = avgDiff(a?.patch, b?.patch);
  const angDelta = Math.abs(ang2 - ang1);
  record('reduced-motion:holds-still', rm === true && angDelta < 0.01 && motionDiff < 4, `rm=${rm} angDelta=${angDelta.toFixed(4)} diff=${motionDiff.toFixed(2)}`);

  // visibility pause
  const before = await page.evaluate(() => window.__HTW.frameCount);
  await page.waitForTimeout(400);
  const midRun = await page.evaluate(() => window.__HTW.frameCount);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(200);
  const mid = await page.evaluate(() => window.__HTW.frameCount);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => window.__HTW.frameCount);
  record('visibility:pauses-raf', midRun > before && after === mid, `before=${before} midRun=${midRun} mid=${mid} after=${after}`);

  await browser.close();
}

// Main
const chromiumOpts = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'] };
await runSuite(chromium, 'desk', chromiumOpts, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await runSuite(chromium, 'mob', chromiumOpts, {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

let webkitOk = false;
try {
  await runSuite(webkit, 'wk-mob', {}, {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  webkitOk = true;
} catch (e) {
  record('webkit:available', false, String(e).slice(0, 200));
}

await testReducedMotionAndVisibility();

const summary = {
  pass: results.filter((r) => r.pass).length,
  fail: results.filter((r) => !r.pass).length,
  webkitOk,
  results,
};
fs.writeFileSync(path.join(OUT, 'qa-report.json'), JSON.stringify(summary, null, 2));
console.log(`\n==== SUMMARY ${summary.pass} pass / ${summary.fail} fail ====`);
process.exit(summary.fail ? 1 : 0);
