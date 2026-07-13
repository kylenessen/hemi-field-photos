/*
 * Projection math — mirrors reference/hemi_pipeline.py.
 *
 * All functions are pure and operate on plain {data, width, height} RGBA
 * pixel buffers (ImageData-compatible), so they run both in the browser and
 * under Node for validation.
 *
 * Conventions (matching the reference):
 *   equirectangular input is 2:1; the top half is the sky hemisphere
 *   (rows 0..H/2-1 = zenith 0..90deg), the bottom half looks at the ground
 *   (rows H/2..H-1 = zenith 90..180deg). Column x spans azimuth -180..+180
 *   with the camera front at the center column.
 *
 *   Hemisphere output: center = zenith, edge = horizon,
 *   up = N, right = E, down = S, left = W (after the north offset is baked in).
 *
 *   Ground view output: center = nadir, edge = horizon, same compass
 *   handedness as the sky view (verified against the reference example).
 */
(function (global) {
  'use strict';

  var TWO_PI = 2 * Math.PI;

  // Bilinear sample of channel-interleaved RGBA `src` (w x h) at float (x, y),
  // clamping to borders like cv2.remap does for in-range maps.
  // Writes RGB into out[o..o+2].
  function bilinear(src, w, h, x, y, out, o) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    if (x0 < 0) x0 = 0; if (x0 > w - 1) x0 = w - 1;
    if (y0 < 0) y0 = 0; if (y0 > h - 1) y0 = h - 1;
    var x1 = x0 + 1 < w ? x0 + 1 : w - 1;
    var y1 = y0 + 1 < h ? y0 + 1 : h - 1;
    var fx = x - x0, fy = y - y0;
    if (fx < 0) fx = 0; if (fx > 1) fx = 1;
    if (fy < 0) fy = 0; if (fy > 1) fy = 1;

    var i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4;
    var i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy, w11 = fx * fy;

    out[o] = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
    out[o + 1] = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
    out[o + 2] = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
  }

  // Shared polar remap driver. `rowForZenithFrac(zf)` maps the radial
  // fraction (0 at center, 1 at edge) to a source row in `half`.
  function polarRemap(half, W, size, northAzimuthDeg, rowForRadialFrac) {
    var src = half.data, halfH = half.height;
    var out = new Uint8ClampedArray(size * size * 4);
    var c = Math.floor(size / 2);      // reference: cx = cy = radius = size // 2
    var radius = Math.floor(size / 2);
    var northRad = northAzimuthDeg * Math.PI / 180;

    for (var y = 0; y < size; y++) {
      var dy = y - c;
      for (var x = 0; x < size; x++) {
        var dx = x - c;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > radius) continue;                    // outside: transparent black
        var o = (y * size + x) * 4;
        var srcY = rowForRadialFrac(r / radius);
        // up (-y) maps to azimuth `northAzimuthDeg`; right = +90deg from it
        var azimuth = Math.atan2(dy, dx) + northRad + Math.PI / 2;
        var azFrac = ((azimuth + Math.PI) / TWO_PI) % 1;
        if (azFrac < 0) azFrac += 1;
        var srcX = azFrac * (W - 1);
        bilinear(src, W, halfH, srcX, srcY, out, o);
        out[o + 3] = 255;
      }
    }
    return { data: out, width: size, height: size };
  }

  // Project the TOP half of an equirectangular image to a north-up circular
  // hemisphere. `topHalf` = {data, width, height} of rows 0..H/2-1.
  // Reference: equirect_to_hemispherical().
  function equirectToHemispherical(topHalf, size, northAzimuthDeg) {
    var maxRow = topHalf.height - 1;
    return polarRemap(topHalf, topHalf.width, size, northAzimuthDeg, function (zf) {
      var v = zf * maxRow;               // 0 = zenith, edge = horizon
      return v > maxRow ? maxRow : v;
    });
  }

  // Project the BOTTOM half (rows H/2..H-1, zenith 90..180) to a looking-down
  // polar view: center = nadir, edge = horizon. Same compass handedness as
  // the sky view. Used for the "set north" step.
  function equirectToGroundView(bottomHalf, size, northAzimuthDeg) {
    var maxRow = bottomHalf.height - 1;
    return polarRemap(bottomHalf, bottomHalf.width, size, northAzimuthDeg, function (rf) {
      var v = (1 - rf) * maxRow;         // center = last row (nadir)
      return v < 0 ? 0 : v;
    });
  }

  // Horizontal fraction (0..1 across the equirect width) -> azimuth degrees.
  // Reference: north_frac_to_azimuth().
  function northFracToAzimuth(northFrac) {
    return northFrac * 360 - 180;
  }

  function azimuthToNorthFrac(azimuthDeg) {
    var f = (azimuthDeg + 180) / 360 % 1;
    return f < 0 ? f + 1 : f;
  }

  // Angle of a screen direction (atan2(dy,dx), y down) in the ground view
  // -> equirect azimuth in degrees, given the view was rendered with
  // `viewNorthDeg` baked in (0 for the raw view).
  function groundThetaToAzimuth(thetaRad, viewNorthDeg) {
    var az = thetaRad * 180 / Math.PI + viewNorthDeg + 90;
    az = ((az + 180) % 360 + 360) % 360 - 180;   // normalize to -180..180
    return az;
  }

  // Map sun altitude/azimuth (degrees, azimuth from north eastward) to a
  // pixel in the north-up hemisphere. Returns null below the horizon.
  // Reference: sun_position_to_pixel().
  function sunPositionToPixel(altitudeDeg, azimuthDeg, imgSize) {
    if (altitudeDeg <= 0) return null;
    var radius = Math.floor(imgSize / 2);
    var r = ((90 - altitudeDeg) / 90) * radius;
    var angle = (azimuthDeg - 90) * Math.PI / 180;   // N=up, E=right
    return [Math.round(radius + r * Math.cos(angle)),
            Math.round(radius + r * Math.sin(angle))];
  }

  var api = {
    equirectToHemispherical: equirectToHemispherical,
    equirectToGroundView: equirectToGroundView,
    northFracToAzimuth: northFracToAzimuth,
    azimuthToNorthFrac: azimuthToNorthFrac,
    groundThetaToAzimuth: groundThetaToAzimuth,
    sunPositionToPixel: sunPositionToPixel
  };

  global.HemiProjection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
