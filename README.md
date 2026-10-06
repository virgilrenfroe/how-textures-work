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

## Lesson 04 · How Wear Shows (`/wear/`)

Lives in its own folder (`wear/index.html` + `wear/main.js`) and shares the series chrome (Space Grotesk + Gabarito + JetBrains Mono, Hero v3, ticker, grain, pill chips). The accent is brass `#ffb02e`, with teal paint `#6fd6c8` as the second colour. The only shared-file edits are the Dockerfile `COPY wear/ /srv/wear/` line and one series-nav link on the Lesson 02 page.

Specimens:

1. **Ambient occlusion**: a ridged lathe vase with seven U-shaped grooves and an inner cavity. The AO is baked on load by ray-marching the solid of revolution plus the ground plane: 56 cosine-weighted rays for each profile point, then a 5-tap blur. It goes into a 1×N `DataTexture` that lines up with the lathe's `v` coordinate through offset/repeat, so the AO is exact along the profile. It feeds the standard `aoMap`/`aoMapIntensity`, and a small `onBeforeCompile` adds noise-broken grime tied to the same AO (dirt goes where light can't). "Show the map" swaps in an unlit view of the texture.
2. **Edge wear**: three rounded boxes merged into one mesh. Each vertex carries its part's box centre, half-size, and edge band (`aCenter/aHalf/aBand`). The fragment shader builds an analytic curvature mask, `a = clamp((|p−c| − (h−band)) / band)`, `edge = a.x·a.y + a.y·a.z + a.z·a.x` (corners reach up to 1.4, so they chip first). Noise breaks it up, and a threshold driven by Use splits it into paint → red-oxide primer rim → bare steel (metal 1, rough ≈ 0.2–0.45, anisotropic noise). "Rub" raycasts drags into up to 40 object-space scuff points. The brush trails the pointer with a lerp, and faster strokes deposit more wear.
3. **Tiling**: a seamless 512² procedural concrete with deliberately recognisable features (oil stain, crack, yellow paint fleck). The repeat comes from `map.repeat`. "Break the grid" swaps `map_fragment` for Inigo Quilez's texture-repetition technique 3: a low-frequency value noise picks between two random UV offsets, blended with `textureGrad` so mips stay correct.
4. **Centerpiece**: the same merged toolbox (body, lid with seam, base strip, handle posts + bar, latches, ribs) in two scenes whose cameras stay in sync (the scene you drag leads). AO for the toolbox is analytic in part space: ground contact, lid seam, base step, post footprints, shade under the bar, latch outlines, ribs. It occludes indirect light (and partly direct). `age` drives Use (edge wear + face scuffs + touch wear on the handle and latches), AO dirt, top-face dust, paint fade, and paint roughness 0.28 → 0.80, all together.

Hero: the worn toolbox (age 0.82) through the shared Hero v3 halftone post (transparent RT → alpha mask, bounding-sphere auto-fit, soft lens reveal) in brass.

Constraints, the same as the rest of the series: one canvas `#c` with scissor regions, DPR cap 1.5 mobile / 2 desktop, offscreen skip, hidden-tab pause, live reduced motion, ACES + sRGB, procedural textures only, and sliders bound to both `input` and `change`.

QA: `qa-wear.mjs` (Playwright 1.63; Chromium desktop 1440×900, Chromium mobile 390×844 DPR3 touch, WebKit mobile). Run it with `BASE=<preview>/wear/ ROOT=<preview>/ node qa-wear.mjs`.

### "Where you see this" sections (Lessons 02 and 04)

Both lesson pages now carry a short real-world section (`#real-world`) between the last specimen and "For teachers": five entries, each naming a setting, a job title, and why the lesson's idea matters to that job. Entry text is plain DOM text and is never worn. On Lesson 04 the section heading (`.rw-title.wear-type`) joins the worn display headings driven by the Age pill. Layout is a 3-column grid on desktop, 2 under 1080px, and 1 under 640px. No new canvas. `qa-wear.mjs` checks placement, entry count and completeness, crisp entry text, no overflow, no horizontal scroll, and the audience-lock scan on both pages (`ONLY=root` runs the Lesson 02 checks alone).
