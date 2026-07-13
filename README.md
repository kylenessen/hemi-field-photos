# Hemispherical Photo Tool

A browser-based tool that turns a **360° equirectangular photo** into a
**compass-aligned hemispherical (circular fisheye) image** and analyzes it —
thresholding sky vs. obstruction and overlaying the sun's path for a given
location and date. Runs entirely client-side.

> **Status:** spec + reference implementation. The web app is not built yet —
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

## Repository layout

```
SPEC.md               Full specification for the web app to build
examples/             Sample input + each pipeline stage's output
reference/
  hemi_pipeline.py    Desktop reference implementation of the core transforms
```

## Reference implementation

[`reference/hemi_pipeline.py`](reference/hemi_pipeline.py) is a small, runnable
prototype of the math the web app will reimplement in the browser (projection,
Otsu threshold, sun-path overlay, openness metrics). Run the demo on the bundled
example:

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

## Next steps

Build the client-side web app per [`SPEC.md`](SPEC.md): file upload, tap/drag
north, canvas/WebGL projection, an adjustable threshold slider, and a SunCalc-
driven sun-path overlay for today / Mar 15 / Dec 1.
