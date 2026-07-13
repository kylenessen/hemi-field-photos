"""
Reference implementation of the core hemispherical-photo transforms.

This is a desktop prototype that documents the math the web app reimplements
in the browser. Given a 360deg equirectangular photo and a "north" direction,
it:

  1. Projects the upper hemisphere to a compass-aligned circular (fisheye)
     image, north-up.
  2. Thresholds sky vs. obstruction (Otsu on the blue channel).
  3. Traces the sun's path for a location/date and overlays it on the image,
     marking each step open (sky) or blocked (obstruction).
  4. Reports simple openness metrics (fraction of sky by zenith ring).

It is intentionally dependency-light and side-effect-free except for the CLI
demo at the bottom.

Deps: numpy, opencv-python(-headless), pysolar. (matplotlib only if you want
to add a viewer.)

CLI demo (runs on the bundled example):
    python hemi_pipeline.py \
        --image ../examples/example-360-equirectangular.jpg \
        --north-frac 0.27353 \
        --lat 35.3102 --lon -120.8326 \
        --date 2026-03-15 --tz -7 \
        --out /tmp/hemi_out

Coordinate conventions (output image):
    center = zenith (straight up), edge = horizon.
    up = north, right = east, down = south, left = west.
"""

import argparse
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cv2
import numpy as np
from pysolar.solar import get_altitude, get_azimuth


# --- Projection ------------------------------------------------------------

def equirect_to_hemispherical(equirect_img, north_azimuth_deg=0.0):
    """Project the upper half of an equirectangular image to a north-up
    circular hemisphere.

    ``north_azimuth_deg`` is the equirectangular azimuth (-180..+180) that
    should point up in the output; it is baked into the projection so no
    post-rotation is needed. center = zenith, edge = horizon.
    """
    h, w = equirect_img.shape[:2]
    top_half = equirect_img[:h // 2, :]

    size = w                      # output diameter = input width (full res)
    cx = cy = size // 2
    radius = size // 2

    ys, xs = np.mgrid[0:size, 0:size]
    dx = (xs - cx).astype(np.float32)
    dy = (ys - cy).astype(np.float32)
    r = np.sqrt(dx ** 2 + dy ** 2)
    theta = np.arctan2(dy, dx)

    # r=0 -> zenith, r=radius -> horizon
    zenith_frac = r / radius
    src_y = (zenith_frac * (h // 2 - 1)).astype(np.float32)

    # up (-y) should map to north_azimuth_deg
    north_rad = np.deg2rad(north_azimuth_deg)
    azimuth = theta + north_rad + np.pi / 2
    azimuth_frac = ((azimuth + np.pi) / (2 * np.pi)) % 1.0
    src_x = (azimuth_frac * (w - 1)).astype(np.float32)

    mask = r <= radius
    map_x = np.where(mask, src_x, 0).astype(np.float32)
    map_y = np.where(mask, src_y, 0).astype(np.float32)

    out = cv2.remap(top_half, map_x, map_y, cv2.INTER_LINEAR)
    out[~mask] = 0
    return out


def north_frac_to_azimuth(north_frac):
    """Convert a horizontal fraction (0..1 across the equirectangular width,
    where the north reference sits) to an azimuth offset in degrees.

    x=0 is the left edge (azimuth -180), center is 0 (camera front)."""
    return north_frac * 360.0 - 180.0


# --- Thresholding ----------------------------------------------------------

def threshold_sky(hemi_img):
    """Separate sky (255) from obstruction (0) using the blue channel + Otsu
    (Jonckheere et al. 2005). Pixels outside the circle are set to 0."""
    b, _g, _r = cv2.split(hemi_img)
    blurred = cv2.GaussianBlur(b, (5, 5), 0)
    _, binary = cv2.threshold(blurred, 0, 255,
                              cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    size = hemi_img.shape[0]
    cx = cy = size // 2
    radius = size // 2
    ys, xs = np.mgrid[0:size, 0:size]
    outside = (xs - cx) ** 2 + (ys - cy) ** 2 > radius ** 2
    binary[outside] = 0
    return binary


def openness_by_ring(binary):
    """Fraction of sky pixels in each 10deg zenith ring (0-10 ... 80-90) plus
    the overall openness. Pure image measure, no models."""
    size = binary.shape[0]
    cx = cy = size // 2
    radius = size // 2
    ys, xs = np.mgrid[0:size, 0:size]
    r = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
    zenith_deg = (r / radius) * 90.0
    is_sky = binary > 127
    in_circle = r <= radius

    rings = {}
    for z in range(0, 90, 10):
        m = in_circle & (zenith_deg >= z) & (zenith_deg < z + 10)
        n = int(m.sum())
        rings[f"{z}-{z + 10}"] = round(float((is_sky & m).sum() / n), 4) if n else 0.0
    total = float((is_sky & in_circle).sum() / in_circle.sum()) if in_circle.sum() else 0.0
    return {"by_ring": rings, "total_openness": round(total, 4)}


# --- Sun path --------------------------------------------------------------

def sun_position_to_pixel(altitude, azimuth, img_size):
    """Map sun altitude/azimuth to a pixel in the north-up hemisphere.
    Returns None if the sun is below the horizon."""
    if altitude <= 0:
        return None
    radius = img_size // 2
    cx = cy = radius
    r = ((90 - altitude) / 90.0) * radius
    angle = math.radians(azimuth - 90)   # N=up, E=right, S=down, W=left
    return int(round(cx + r * math.cos(angle))), int(round(cy + r * math.sin(angle)))


def solar_path(lat, lon, date, tz_offset_hours, step_minutes=2):
    """Sun positions (datetime, altitude, azimuth) above the horizon for a day.
    ``tz_offset_hours`` is the local UTC offset (e.g. -8 for PST, -7 for PDT)."""
    tz = timezone(timedelta(hours=tz_offset_hours))
    out = []
    for minutes in range(5 * 60, 20 * 60 + 1, step_minutes):
        t = date.replace(hour=minutes // 60, minute=minutes % 60,
                         second=0, tzinfo=tz)
        alt = get_altitude(lat, lon, t)
        if alt > 0:
            out.append((t, alt, get_azimuth(lat, lon, t)))
    return out


def overlay_solar_path(hemi_img, binary, path, marker_radius=6):
    """Draw the sun path on a copy of the hemisphere. Yellow = open sky,
    red = blocked. Returns (annotated_img, open_steps, blocked_steps)."""
    out = hemi_img.copy()
    size = out.shape[0]
    open_steps = blocked_steps = 0
    for _t, alt, azi in path:
        p = sun_position_to_pixel(alt, azi, size)
        if p is None:
            continue
        px, py = p
        is_open = (0 <= px < size and 0 <= py < size and binary[py, px] > 127)
        color = (0, 210, 255) if is_open else (40, 40, 235)   # BGR
        cv2.circle(out, (px, py), marker_radius, color, -1)
        cv2.circle(out, (px, py), marker_radius, (0, 0, 0), 1)
        open_steps += is_open
        blocked_steps += not is_open
    return out, open_steps, blocked_steps


# --- CLI demo --------------------------------------------------------------

def _main():
    ap = argparse.ArgumentParser(description="Reference hemispherical pipeline")
    ap.add_argument("--image", required=True, help="equirectangular 360 photo")
    ap.add_argument("--north-frac", type=float, default=0.0,
                    help="0..1 horizontal position of the north reference")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--date", default="2026-03-15", help="YYYY-MM-DD")
    ap.add_argument("--tz", type=float, default=-8, help="UTC offset hours")
    ap.add_argument("--out", default="hemi_out", help="output directory")
    args = ap.parse_args()

    import PIL.Image
    PIL.Image.MAX_IMAGE_PIXELS = None

    img = cv2.imread(args.image)
    if img is None:
        raise SystemExit(f"Could not read {args.image}")

    az = north_frac_to_azimuth(args.north_frac)
    hemi = equirect_to_hemispherical(img, north_azimuth_deg=az)
    binary = threshold_sky(hemi)
    y, m, d = (int(v) for v in args.date.split("-"))
    path = solar_path(args.lat, args.lon, datetime(y, m, d), args.tz)
    annotated, open_steps, blocked = overlay_solar_path(hemi, binary, path)
    metrics = openness_by_ring(binary)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out / "hemispherical.jpg"), hemi)
    cv2.imwrite(str(out / "binary.jpg"), binary)
    cv2.imwrite(str(out / "solar_path.jpg"), annotated)

    print(f"north azimuth: {az:.1f} deg")
    print(f"total openness: {metrics['total_openness']:.1%}")
    print(f"sun steps -> open: {open_steps}  blocked: {blocked}")
    print(f"wrote hemispherical.jpg, binary.jpg, solar_path.jpg to {out}/")


if __name__ == "__main__":
    _main()
