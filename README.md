# Hemispherical Photo Tool

A browser-based tool that turns a **360° equirectangular photo** into a
**compass-aligned hemispherical (circular fisheye) image** and analyzes it —
thresholding sky vs. obstruction and overlaying the sun's path for a given
location and date. Runs entirely client-side; photos never leave the device.

> **Status:** built. Open [`index.html`](index.html) in a browser (or host the
> repo as a static site — GitHub Pages / Netlify) and upload a photo.
> [`SPEC.md`](SPEC.md) is the blueprint.

## The pipeline

```
360° equirectangular  →  set north  →  north-up hemisphere  →  threshold sky
                                                                     ↓
                                             sun-path overlay (open vs. blocked)
```

| Stage | Example |
|-------|---------|
| Input: 360° equirectangular photo | `examples/example-360-equirectangular.jpg` |
| Set north (looking-down ground view) | `examples/example-set-north-view.jpg` |
| North-up hemisphere (true color) | `examples/example-hemispherical.jpg` |
| Sky vs. obstruction threshold | `examples/example-threshold-binary.jpg` |
| Sun-path overlay (yellow = open, red = blocked) | `examples/example-solar-path.jpg` |

## Using the app

1. **Upload** an equirectangular 360° photo (2:1 aspect). Large photos are
   downscaled to a working copy for interaction; exports re-render from a
   higher-resolution copy.
2. **Set north** on the looking-down ground view: tap two points (base of the
   north reference → its tip) or drag the ring handle. Undo/redo supported;
   a live arrow and compass labels confirm the direction.
3. **Hemisphere & threshold**: the north-up hemisphere renders automatically.
   The sky mask defaults to Otsu on the blue channel; adjust with the slider
   (live preview), toggle true color vs. mask, and read total / per-ring
   openness.
4. **Sun path**: enter lat/lon (or "use my location") and pick a date —
   Today, Mar 15, Dec 1, or custom. Each 2-minute sun step is drawn yellow
   (open sky) or red (blocked). Time zone defaults to the device's (incl.
   DST); a manual UTC offset is available for analyzing far-away locations.
5. **Export** the hemisphere, sky mask, and annotated sun-path PNGs
   (2048×2048, rendered from up to an 8192-wide copy of the original) plus a
   metrics JSON (north azimuth, threshold, openness, sun-step counts).

No build step, no server, no dependencies beyond the vendored
[SunCalc](https://github.com/mourner/suncalc) (MIT). To serve locally:
`python3 -m http.server` and open `http://localhost:8000`.

## Repository layout

```
index.html            The app (open directly or host statically)
css/, js/             App styles and logic (plain JS, no build step)
  js/projection.js      equirect → hemisphere / ground-view remap
  js/threshold.js       blue-channel Otsu threshold + openness metrics
  js/sunpath.js         SunCalc-based sun path + open/blocked classification
  js/app.js             UI wiring
  js/vendor/suncalc.js  vendored SunCalc 1.9.0 (MIT)
SPEC.md               Full specification the app was built to
examples/             Sample input + each pipeline stage's output
reference/
  hemi_pipeline.py    Desktop reference implementation of the core transforms
validation/           Checks the JS math against the Python reference
```

## Reference implementation & validation

[`reference/hemi_pipeline.py`](reference/hemi_pipeline.py) is a small, runnable
prototype of the math the web app reimplements in the browser (projection,
Otsu threshold, sun-path overlay, openness metrics). Run the demo on the
bundled example:

```bash
pip install numpy opencv-python-headless pysolar
cd reference
python hemi_pipeline.py \
  --image ../examples/example-360-equirectangular.jpg \
  --north-frac 0.27353 \
  --lat 35.3102 --lon -120.8326 \
  --date 2026-03-15 --tz -7 \
  --out out
```

It writes `hemispherical.jpg`, `binary.jpg`, and `solar_path.jpg` to `out/` and
prints total openness and open/blocked sun-step counts.

The JS port is validated against it pixel-for-pixel:

```bash
pip install numpy opencv-python-headless pysolar
python3 validation/gen_reference.py   # dump ground truth from the reference
node validation/compare.js            # run the JS math on the same input
```

On the bundled example the projection matches `cv2.remap` to within 1 gray
level, the Otsu threshold is identical, the sky mask differs on <0.1% of
pixels, and sun positions agree with pysolar to ≤0.3° in azimuth (altitude
differs by up to ~0.6° near the horizon because pysolar applies atmospheric
refraction and SunCalc's altitude is geometric).
