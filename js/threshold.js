/*
 * Sky/obstruction thresholding — mirrors threshold_sky() in the reference.
 *
 * Pipeline: blue channel -> 5x5 Gaussian blur -> Otsu threshold (or a manual
 * value) -> zero outside the hemisphere circle.
 *
 * The 5x5 kernel is [1,4,6,4,1]/16 separable — exactly what OpenCV uses for
 * GaussianBlur(ksize=5, sigma=0) on 8-bit images — with reflect-101 borders.
 * Otsu is computed over the FULL square image including the black corners,
 * matching the reference (the threshold lands in the same place).
 */
(function (global) {
  'use strict';

  // Extract the blue channel of an RGBA buffer as Uint8.
  function blueChannel(img) {
    var src = img.data, n = img.width * img.height;
    var out = new Uint8ClampedArray(n);
    for (var i = 0; i < n; i++) out[i] = src[i * 4 + 2];
    return out;
  }

  // Separable 5-tap binomial blur ([1,4,6,4,1]/16), reflect-101 borders.
  function gaussianBlur5(chan, w, h) {
    var tmp = new Float32Array(w * h);
    var out = new Uint8ClampedArray(w * h);
    var x, y, i;

    function refl(i, n) {              // BORDER_REFLECT_101: -1 -> 1, n -> n-2
      if (i < 0) return -i;
      if (i >= n) return 2 * n - 2 - i;
      return i;
    }

    for (y = 0; y < h; y++) {
      var row = y * w;
      for (x = 0; x < w; x++) {
        tmp[row + x] = (chan[row + refl(x - 2, w)] + 4 * chan[row + refl(x - 1, w)] +
                        6 * chan[row + x] + 4 * chan[row + refl(x + 1, w)] +
                        chan[row + refl(x + 2, w)]) / 16;
      }
    }
    for (y = 0; y < h; y++) {
      var ym2 = refl(y - 2, h) * w, ym1 = refl(y - 1, h) * w;
      var y0 = y * w, yp1 = refl(y + 1, h) * w, yp2 = refl(y + 2, h) * w;
      for (x = 0; x < w; x++) {
        var v = (tmp[ym2 + x] + 4 * tmp[ym1 + x] + 6 * tmp[y0 + x] +
                 4 * tmp[yp1 + x] + tmp[yp2 + x]) / 16;
        out[y0 + x] = v + 0.5;         // round like OpenCV's fixed-point path
      }
    }
    return out;
  }

  // Otsu's threshold over a 256-bin histogram of `chan`. Returns the
  // threshold t such that pixels > t are foreground (sky), like cv2.
  function otsuThreshold(chan) {
    var hist = new Float64Array(256);
    for (var i = 0; i < chan.length; i++) hist[chan[i]]++;
    var total = chan.length;

    var sumAll = 0;
    for (var v = 0; v < 256; v++) sumAll += v * hist[v];

    var sumB = 0, wB = 0, best = 0, bestVar = -1;
    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      var mB = sumB / wB, mF = (sumAll - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > bestVar) { bestVar = between; best = t; }
    }
    return best;
  }

  // Full thresholding step for a square hemisphere image.
  // Returns {mask, blurred, otsu} where mask is Uint8 (255 = sky, 0 =
  // obstruction/outside circle). Pass `manualThreshold` to override Otsu.
  function thresholdSky(hemiImg, manualThreshold) {
    var size = hemiImg.width;
    var blurred = gaussianBlur5(blueChannel(hemiImg), size, size);
    var otsu = otsuThreshold(blurred);
    var t = (manualThreshold == null) ? otsu : manualThreshold;
    var mask = applyThreshold(blurred, size, t);
    return { mask: mask, blurred: blurred, otsu: otsu, threshold: t };
  }

  // Re-threshold a cached blurred blue channel (fast path for the slider).
  function applyThreshold(blurred, size, t) {
    var mask = new Uint8ClampedArray(size * size);
    var c = Math.floor(size / 2), radius = Math.floor(size / 2);
    var r2 = radius * radius;
    for (var y = 0; y < size; y++) {
      var dy = y - c, row = y * size;
      for (var x = 0; x < size; x++) {
        var dx = x - c;
        if (dx * dx + dy * dy > r2) continue;        // outside circle -> 0
        if (blurred[row + x] > t) mask[row + x] = 255;
      }
    }
    return mask;
  }

  // Openness metrics from the mask — reference: openness_by_ring().
  // Returns {byRing: {"0-10": f, ...}, totalOpenness}.
  function opennessByRing(mask, size) {
    var c = Math.floor(size / 2), radius = Math.floor(size / 2);
    var ringSky = new Float64Array(9), ringN = new Float64Array(9);
    var skyTotal = 0, inTotal = 0;
    for (var y = 0; y < size; y++) {
      var dy = y - c, row = y * size;
      for (var x = 0; x < size; x++) {
        var dx = x - c;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > radius) continue;
        inTotal++;
        var sky = mask[row + x] > 127 ? 1 : 0;
        skyTotal += sky;
        var ring = Math.floor((r / radius) * 9);     // 10deg zenith bands
        if (ring > 8) ring = 8;
        ringN[ring]++;
        ringSky[ring] += sky;
      }
    }
    var byRing = {};
    for (var z = 0; z < 9; z++) {
      byRing[(z * 10) + '-' + (z * 10 + 10)] =
        ringN[z] ? Math.round(ringSky[z] / ringN[z] * 10000) / 10000 : 0;
    }
    return {
      byRing: byRing,
      totalOpenness: inTotal ? Math.round(skyTotal / inTotal * 10000) / 10000 : 0
    };
  }

  // Standard hemispherical-photography site factors from the sky mask.
  //
  // The image is an equidistant polar projection (zenith angle proportional
  // to radius), so image-pixel fractions over-weight the horizon. Weighting
  // each pixel by its solid angle (dOmega/dA ~ sin(theta)/r, finite at the
  // center) gives the true fraction of the sky dome that is open; adding a
  // cos(theta) incidence term gives the diffuse light reaching a horizontal
  // surface under a uniform sky — the Indirect Site Factor (ISF).
  // Both are ratios of open-sky sums to whole-dome sums, so the projection
  // constants cancel.
  function siteFactors(mask, size) {
    var c = Math.floor(size / 2), radius = Math.floor(size / 2);
    var halfPi = Math.PI / 2;
    var skySA = 0, allSA = 0, skyISF = 0, allISF = 0;
    for (var y = 0; y < size; y++) {
      var dy = y - c, row = y * size;
      for (var x = 0; x < size; x++) {
        var dx = x - c;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > radius) continue;
        var theta = (r / radius) * halfPi;
        var wSA = r > 1e-6 ? Math.sin(theta) / r : halfPi / radius;
        var wISF = wSA * Math.cos(theta);
        allSA += wSA; allISF += wISF;
        if (mask[row + x] > 127) { skySA += wSA; skyISF += wISF; }
      }
    }
    return {
      opennessSolidAngle: allSA ? skySA / allSA : 0,
      isf: allISF ? skyISF / allISF : 0
    };
  }

  var api = {
    thresholdSky: thresholdSky,
    siteFactors: siteFactors,
    applyThreshold: applyThreshold,
    otsuThreshold: otsuThreshold,
    gaussianBlur5: gaussianBlur5,
    blueChannel: blueChannel,
    opennessByRing: opennessByRing
  };

  global.HemiThreshold = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
