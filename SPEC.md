# Specification — Hemispherical Photo Tool

## What this is

A browser-based tool that turns a **360° equirectangular photo** into a
**compass-aligned hemispherical (circular fisheye) image** and runs light/sky
analysis on it. Everything happens client-side — you upload a photo, tell the
tool which way is north, and it produces a north-up hemisphere you can threshold
and overlay a sun path onto.

The whole pipeline is: **upload → set north → project to hemisphere → threshold
sky vs. obstruction → overlay the sun's path for a location and date.**

A working desktop prototype of the core transforms lives in
[`reference/hemi_pipeline.py`](reference/hemi_pipeline.py); the web app
reimplements that math in-browser. Example inputs and outputs are in
[`examples/`](examples/).

## Goals & constraints

- **Client-side only.** No server, no upload of user photos anywhere. Runs as a
  static site (open the HTML, or host on GitHub Pages / Netlify).
- **Well-scoped, not production.** A clean single-purpose tool, not a platform.
- **Works on a tablet.** Touch-friendly (tap/drag), usable in the field on an
  iPad.
- **Metric, transparent math.** Every transform is documented and matches the
  reference implementation so results are reproducible.

## Inputs

| Input | How it's provided | Notes |
|-------|-------------------|-------|
| 360° photo | File picker / drag-drop | Equirectangular projection, 2:1 aspect (e.g. 15520×7760). The **top half** is the sky hemisphere; the **bottom half** looks down at the ground. |
| North direction | Tap/drag on the image | See "Set north" below. |
| Location | Lat/lon entry (or "use my location") | Needed for the sun path. |
| Date(s) | Preset buttons | **Today, Mar 15, Dec 1** by default; allow a custom date. |

## Pipeline / features

### 1. Upload & preview
Accept an equirectangular image, show it, and confirm it's ~2:1. Handle large
files (tens of MP) by working on a downscaled copy for interaction and the full
copy for the final render.

### 2. Set north (tap/drag)
The capture includes a visible north reference (e.g. the operator holding a
phone that points north). To make that reference easy to click, project the
**bottom** (ground) hemisphere to a looking-down polar view — the operator sits
in the outer ring — and let the user:

- **tap two points** (base of arm → phone) to define a direction, **or**
- **drag a compass handle** around the ring.

The direction sets a single number: the **north azimuth offset** (which
equirectangular column corresponds to north). See
`north_frac_to_azimuth()` and the ground-polar projection in the reference.
Undo/redo and a live direction arrow are expected. (`example-set-north-view.jpg`
shows this ground view.)

### 3. Project to hemisphere (north-up)
Remap the **upper** hemisphere to a circular image with the north offset baked
in: **center = zenith, edge = horizon, up = N, right = E, down = S, left = W.**
Reference: `equirect_to_hemispherical()`. Do the remap on a `<canvas>` /
WebGL; a per-pixel inverse map (output polar → source equirectangular column/row)
is exactly what the reference does with `cv2.remap`.
(Result: `example-hemispherical.jpg`.)

### 4. Threshold sky vs. obstruction (adjustable)
Classify each pixel inside the circle as **sky** or **obstruction**. Default to
an automatic threshold on the **blue channel** (Otsu), and expose a **slider**
for manual adjustment with a live preview. Show the binary mask and let the user
toggle between true-color and mask views. Reference: `threshold_sky()`.
(Result: `example-threshold-binary.jpg`.)

### 5. True-color hemisphere
Always keep the real-color hemisphere available (not just the mask) so the user
can visually check the projection and threshold. Overlays (grid rings at
10°/30°/60° zenith, cardinal labels N/E/S/W) are a plus.

### 6. Sun-path overlay
For the chosen location and date, compute the sun's track across the sky and
draw it on the hemisphere, coloring each step **open** (sun reaches the point —
sky) or **blocked** (obstruction in the way). Reference: `solar_path()`,
`sun_position_to_pixel()`, `overlay_solar_path()`.
(Result: `example-solar-path.jpg` — yellow = open, red = blocked.)

- Dates: **today, Mar 15, Dec 1** as presets; custom date allowed.
- In-browser, use a solar-position library (e.g. **SunCalc**) instead of pysolar.
- Handle the local UTC offset (incl. DST) for the location/date.

### 7. Openness metrics (optional but easy)
From the mask, report simple, model-free numbers: **total openness** (fraction
of sky pixels) and **openness by 10° zenith ring**. Reference:
`openness_by_ring()`. Optionally export the mask, the annotated hemisphere, and
a small JSON of metrics.

## Suggested tech

- Plain HTML + JS, `<canvas>` (or WebGL/regl for the remap) — no build step
  required; a small Vite/TS setup is fine if preferred.
- **SunCalc** (MIT) for sun altitude/azimuth in the browser.
- Otsu threshold in ~20 lines of JS over the blue-channel histogram.
- Keep it a single deployable static bundle.

## Projection math (summary)

Output hemisphere of diameter `D`, center `(cx, cy)`, radius `R = D/2`.
For each output pixel `(x, y)`:

```
dx, dy   = x - cx, y - cy
r        = hypot(dx, dy)                 # skip pixels with r > R
theta    = atan2(dy, dx)
zenith   = r / R                          # 0 at center, 1 at horizon
srcRow   = zenith * (H/2 - 1)             # H = equirect height
azimuth  = theta + northRad + PI/2        # northRad = deg2rad(north azimuth)
srcCol   = frac((azimuth + PI) / (2*PI)) * (W - 1)   # W = equirect width
color    = bilinear(equirectTopHalf, srcCol, srcRow)
```

Sun → pixel (north-up image):

```
if altitude <= 0: below horizon, skip
r     = (90 - altitude) / 90 * R
angle = radians(azimuth - 90)             # N=up, E=right, S=down, W=left
px, py = cx + r*cos(angle), cy + r*sin(angle)
open  = mask[py][px] is sky
```

## Non-goals

- No accounts, no cloud storage, no database.
- No batch processing UI (single photo at a time is fine).
- No claims of scientific calibration — the irradiance model in the reference is
  a simple clear-sky approximation and is optional for the web tool.

## Acceptance checklist

- [ ] Upload an equirectangular photo and see it previewed.
- [ ] Set north by tap/drag; a live arrow confirms the direction.
- [ ] Get a north-up circular hemisphere matching the reference output.
- [ ] Adjust the sky/obstruction threshold with a slider and live preview.
- [ ] Toggle true-color vs. binary mask.
- [ ] Enter a location and see the sun path for today / Mar 15 / Dec 1, with
      open vs. blocked steps colored.
- [ ] Everything runs offline in the browser with no server.
