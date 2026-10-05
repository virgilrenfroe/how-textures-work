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
