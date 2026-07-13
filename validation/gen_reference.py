"""Generate ground-truth data from the Python reference implementation for
validating the JS port (run compare.js afterwards).

Usage:
    pip install numpy opencv-python-headless pysolar
    python validation/gen_reference.py [outdir]

Writes to <outdir> (default validation/_truth):
    meta.json        image size, params, otsu value, openness metrics, sun path
    equirect.rgba    full equirect image as raw RGBA (input for the JS side)
    hemi.rgb         reference hemisphere as raw RGB
    binary.u8        reference sky mask (0/255)
"""
import json
import sys
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "reference"))
import hemi_pipeline as ref  # noqa: E402

IMAGE = ROOT / "examples" / "example-360-equirectangular.jpg"
NORTH_FRAC = 0.27353
LAT, LON, TZ = 35.3102, -120.8326, -7
DATE = datetime(2026, 3, 15)

out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "_truth"
out.mkdir(parents=True, exist_ok=True)

img = cv2.imread(str(IMAGE))
h, w = img.shape[:2]

rgba = np.dstack([cv2.cvtColor(img, cv2.COLOR_BGR2RGB),
                  np.full((h, w), 255, np.uint8)])
rgba.tofile(out / "equirect.rgba")

az = ref.north_frac_to_azimuth(NORTH_FRAC)
hemi = ref.equirect_to_hemispherical(img, north_azimuth_deg=az)
cv2.cvtColor(hemi, cv2.COLOR_BGR2RGB).tofile(out / "hemi.rgb")

# threshold_sky() but capturing the otsu value
b = cv2.split(hemi)[0]
blurred = cv2.GaussianBlur(b, (5, 5), 0)
otsu, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
size = hemi.shape[0]
c = r = size // 2
ys, xs = np.mgrid[0:size, 0:size]
binary[(xs - c) ** 2 + (ys - c) ** 2 > r ** 2] = 0
binary.tofile(out / "binary.u8")

metrics = ref.openness_by_ring(binary)

path = ref.solar_path(LAT, LON, DATE, TZ)
sun = []
for t, alt, azi in path:
    p = ref.sun_position_to_pixel(alt, azi, size)
    px, py = p if p else (None, None)
    is_open = bool(p and 0 <= px < size and 0 <= py < size and binary[py, px] > 127)
    sun.append({"minutes": t.hour * 60 + t.minute, "altitude": alt,
                "azimuth": azi, "x": px, "y": py, "open": is_open})

(out / "meta.json").write_text(json.dumps({
    "width": w, "height": h, "hemiSize": size,
    "northFrac": NORTH_FRAC, "northAzimuthDeg": az,
    "lat": LAT, "lon": LON, "tz": TZ, "date": DATE.strftime("%Y-%m-%d"),
    "otsu": float(otsu), "metrics": metrics, "sun": sun,
}, indent=1))

print(f"wrote ground truth to {out}/ (otsu={otsu}, "
      f"openness={metrics['total_openness']:.4f}, sun steps={len(sun)})")
