# Example images

One capture run through every stage of the pipeline. Images are downscaled for
the web; the geometry is unchanged.

| File | Stage |
|------|-------|
| `example-360-equirectangular.jpg` | **Input** — a 360° equirectangular photo (2:1). Top half = sky, bottom half = ground. |
| `example-set-north-view.jpg` | **Set north** — the bottom hemisphere projected to a looking-down polar view; the operator sits in the outer ring and marks north. |
| `example-hemispherical.jpg` | **Projection** — north-up circular hemisphere. Center = zenith, edge = horizon; up = N, right = E, down = S, left = W. |
| `example-threshold-binary.jpg` | **Threshold** — sky (white) vs. obstruction (black), blue-channel + Otsu. |
| `example-solar-path.jpg` | **Sun path** — the sun's track for Mar 15 at this location. Yellow = open sky, red = blocked by obstruction. |

Capture location for this example: **lat 35.3102, lon -120.8326**; the north
reference sits at horizontal fraction **0.27353** across the equirectangular
width. Those are the values used in the `reference/hemi_pipeline.py` demo.
