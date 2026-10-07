# How Textures Work

A materials lab on UV maps, albedo, roughness, normal vs displacement, and weathering — by Virgil Renfroe.

Companion to [How Surfaces Work](https://how-surfaces-work-production.up.railway.app/).

The live lesson states a short definition before the lab view, then “Where you see this” (five jobs) and a short FAQ, all in static HTML.

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
