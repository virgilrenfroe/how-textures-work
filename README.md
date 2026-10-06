# How Textures Work

A materials lab on UV maps, albedo, roughness, normal vs displacement, and weathering — by Virgil Renfroe.

Companion to [How Surfaces Work](https://how-surfaces-work-production.up.railway.app/).

**Live preview:** https://how-textures-work-production.up.railway.app/

Repo: https://github.com/virgilrenfroe/how-textures-work

Single-page three.js exhibit. One shared WebGL context; specimens render via scissor/viewport into DOM regions.

## Specimens

1. **UVs** — checker / UV-grid on sphere and box; flat unwrap plane toggle
2. **Albedo & roughness** — procedural wood/marble; toggle each map
3. **Centerpiece** — normal map vs displacement under an orbiting light; silhouette mode
4. **Weathering** — noise mask ages clean metal into rust (age 0–1)

## Local

```bash
python3 -m http.server 8878
```

## Stack

- three.js `0.170.0` (CDN import map)
- Google Fonts: Bricolage Grotesque, Instrument Sans, Space Mono
- No backend; all textures procedural

## Technical notes (moved out of the learner UI)

These used to appear as on-page copy. The page now speaks only to students and teachers. The details live here.

- **Stack:** three.js 0.170 via CDN import map. Static `index.html` + `main.js`.
- **One shared WebGL canvas** (`canvas#c`, fixed, full viewport). Each specimen, plus the hero, is a scissor/viewport region aligned to a DOM `.view[data-scene]` box (three.js multiple-elements pattern). There is no second canvas or context.
- **Hero:** Studded sphere (shared stud height map → normal + displacement). Rendered into a small render target (320 px wide, sized to the hero aspect), then drawn into the hero scissor region with a fullscreen-quad glyph/halftone shader tinted mint #3dff9a. A reveal edge (slow sweep, or pointer drag/hover) shows the true PBR render. The post pass disables tone mapping, so ACES runs only once.
- **DPR cap:** about 1.5 on mobile/coarse pointers and about 2 on desktop.
- **Offscreen skip:** a region whose DOM box is outside the viewport is not drawn. This includes the hero once you scroll past it.
- **Visibility:** the animation loop pauses while the tab is hidden.
- **Reduced motion:** a live `prefers-reduced-motion` listener stops auto-rotation and orbit lights, freezes the hero sweep at a static frame, and pauses the CSS ticker.
- **Colour:** ACES Filmic tone mapping with sRGB output. Sliders listen to both `input` and `change`.
- All textures (checker, wood, marble, stud height/normal, rust mask) are procedural canvas textures; no image downloads.
- **QA hooks:** `window.__HSW` (and `window.__HTW` on Textures) exposes renderer, scenes, shared state, frameCount, heroPost, and webglContexts() for `qa.mjs` (Playwright). Run it with `HSW_URL=<url> node qa.mjs`. It checks a single canvas, a non-blank hero, specimen rendering, controls, scissor alignment, anchors, fonts, offscreen skip, reduced motion, and visibility.
- **Hosting:** Railway (Caddy static Dockerfile + Caddyfile + railway.toml), project `how-surfaces-work`.
- **Workflow (from now on):** new lesson work goes on a branch with a GitHub PR and a separate preview deploy, not straight to `main`/production.

## Lesson 06 · How Wood and Stone Get Their Patterns (`/grain/`)

Procedural textures: a small rule makes a pattern, and the same rule makes endless variations. Four specimens plus a hero, all on the one shared WebGL canvas (scissor regions aligned to DOM boxes).

- **Hero**: a turned wooden bowl drawn in rose halftone dots (hero v3: dots masked by render-target alpha, soft lens reveal that follows the pointer, bounding-sphere camera auto-fit). The bowl's wood is sampled in 3D from its object-space position.
- **01 Noise**: a full-bleed `ShaderMaterial` strip. Top: 2D value-noise fBm (quintic fade, rotated octaves). Bottom: a graph of one horizontal slice. `Octaves` 1–6 and `Scale` sliders. OrbitControls are disabled (the sliders own the view).
- **02 Wood**: `MeshPhysicalMaterial` with `onBeforeCompile`. Rings are `fract(length(p.yz − trunk) · rings)` around the x axis, with the radius pushed by 3D fBm (Warp). Ring id hashing varies latewood width; there are fine fibres and pores along the grain. `Ring spacing`, `Warp`, and `Turn` (rotates the block; OrbitControls disabled).
- **03 Marble**: straight bands `sin(dot(p, dir) · k + turbulence · Σ|noise|)`, thin veins at the band zero-crossings, a soft halo, and grey clouds that follow the bands. `Turbulence` 0–1 and a `Gold veins` toggle.
- **04 Cut the block**: two synced views. A clipping plane (`renderer.localClippingEnabled`) slices both boards. Left: a cap plane at the cut samples the same 3D wood function (`uGOff` offsets the cap into block space), so the cut face matches the sides. Right: the same wood is only a skin (DoubleSide; back faces shade as an empty interior) and has no cap, so cutting shows it is hollow. An accent outline marks the cut.

Phones (coarse pointer or < 700 px): DPR cap 1.5 (otherwise 2), 3D noise octaves drop from 5 to 3, sliders are 44 px tall. Reduced motion uses a live `matchMedia` listener; spins and the lens drift stop and the ticker halts. ACES tone mapping, sRGB output, RoomEnvironment PMREM. No image files: every pattern is GLSL.

QA: `node qa-grain.mjs` (BASE defaults to the l06 preview). It runs on Chromium 1440×900, Chromium 390×844 DPR3 touch (portrait and 844×390 landscape), and WebKit iPhone 13, plus a reduced-motion pass and series-link checks. Checks: one canvas, non-blank specimens, every control changes the render (including real CDP touch drags on sliders in Chromium phones; WebKit uses a pointer drag), the strict hero mask and no-overlap boxes, no horizontal scroll, the audience-lock scan, a leftover-copy scan for strings from other lessons, tab/og/twitter titles, the real-world section, 44 px sliders, and phone octaves. Screenshots go to `shots/`.
