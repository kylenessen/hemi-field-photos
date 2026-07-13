/*
 * Validate the browser math against the Python reference.
 *
 * Run gen_reference.py first, then:  node validation/compare.js
 *
 * Exits non-zero if any check falls outside tolerance. Tolerances allow for
 * OpenCV's fixed-point bilinear interpolation and pysolar-vs-SunCalc
 * differences (SunCalc is accurate to ~0.1-0.3 degrees; pysolar also applies
 * atmospheric refraction near the horizon).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = require('../js/projection.js');
const T = require('../js/threshold.js');
const S = require('../js/sunpath.js');

const truth = path.join(__dirname, '_truth');
const meta = JSON.parse(fs.readFileSync(path.join(truth, 'meta.json'), 'utf8'));
const { width: W, height: H, hemiSize: SIZE } = meta;

let failures = 0;
function check(name, value, limit, fmt) {
  const ok = value <= limit;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}: ${fmt || ''}${value.toFixed(4)} (limit ${limit})`);
}

// ---- projection -------------------------------------------------------------
const rgba = new Uint8ClampedArray(fs.readFileSync(path.join(truth, 'equirect.rgba')).buffer);
const halfH = Math.floor(H / 2);
const top = { data: rgba.subarray(0, W * halfH * 4), width: W, height: halfH };

const hemi = P.equirectToHemispherical(top, SIZE, meta.northAzimuthDeg);

const refHemi = new Uint8Array(fs.readFileSync(path.join(truth, 'hemi.rgb')).buffer);
let sumDiff = 0, maxDiff = 0, n = 0;
for (let i = 0; i < SIZE * SIZE; i++) {
  for (let ch = 0; ch < 3; ch++) {
    const d = Math.abs(hemi.data[i * 4 + ch] - refHemi[i * 3 + ch]);
    sumDiff += d;
    if (d > maxDiff) maxDiff = d;
    n++;
  }
}
console.log('projection (vs cv2.remap):');
check('mean abs pixel diff', sumDiff / n, 0.5);
check('max abs pixel diff', maxDiff, 16);

// ---- threshold --------------------------------------------------------------
const res = T.thresholdSky(hemi, null);
const refBinary = new Uint8Array(fs.readFileSync(path.join(truth, 'binary.u8')).buffer);
let mismatch = 0;
for (let i = 0; i < refBinary.length; i++) {
  if ((res.mask[i] > 127) !== (refBinary[i] > 127)) mismatch++;
}
console.log(`threshold (otsu js=${res.otsu} py=${meta.otsu}):`);
check('otsu threshold diff', Math.abs(res.otsu - meta.otsu), 1);
check('mask mismatch fraction', mismatch / refBinary.length, 0.002);

const m = T.opennessByRing(res.mask, SIZE);
console.log('openness:');
check('total openness diff', Math.abs(m.totalOpenness - meta.metrics.total_openness), 0.005);
let ringMax = 0;
for (const k of Object.keys(m.byRing)) {
  ringMax = Math.max(ringMax, Math.abs(m.byRing[k] - meta.metrics.by_ring[k]));
}
check('max ring openness diff', ringMax, 0.01);

// ---- sun path (SunCalc vs pysolar) -------------------------------------------
const [y, mo, d] = meta.date.split('-').map(Number);
const js = S.solarPath(meta.lat, meta.lon, y, mo, d, meta.tz, 2);
const byMin = new Map(js.map(s => [s.minutes, s]));
let altMax = 0, azMax = 0, pxMax = 0, matched = 0;
for (const ref of meta.sun) {
  const s = byMin.get(ref.minutes);
  if (!s) continue;
  matched++;
  altMax = Math.max(altMax, Math.abs(s.altitude - ref.altitude));
  azMax = Math.max(azMax, Math.abs(s.azimuth - ref.azimuth));
  const p = P.sunPositionToPixel(s.altitude, s.azimuth, SIZE);
  pxMax = Math.max(pxMax, Math.hypot(p[0] - ref.x, p[1] - ref.y));
}
console.log(`sun path (${matched}/${meta.sun.length} reference steps matched):`);
check('unmatched steps', meta.sun.length - matched, 3);
// pysolar applies atmospheric refraction (~0.57deg at the horizon); SunCalc's
// altitude is geometric, so low-sun steps differ by up to that much.
check('max altitude diff (deg)', altMax, 0.7);
check('max azimuth diff (deg)', azMax, 0.6);
check('max pixel distance', pxMax, SIZE * 0.006);

const cls = S.classifyPath(js.filter(s => s.minutes >= 300 && s.minutes <= 1200),
                           res.mask, SIZE);
const refOpen = meta.sun.filter(s => s.open).length;
console.log(`sun classification (js open=${cls.open}/${cls.open + cls.blocked}, py open=${refOpen}/${meta.sun.length}):`);
check('open-step count diff', Math.abs(cls.open - refOpen), 8);

// ---- rasterized path: every crossed pixel exactly once, no gaps ---------------
const fine = S.solarPath(meta.lat, meta.lon, y, mo, d, meta.tz, 0.25);
const raster = S.rasterizePath(fine, SIZE);
const keys = new Set(raster.map(p => p.y * SIZE + p.x));
let gaps = 0;
for (let i = 1; i < raster.length; i++) {
  if (Math.abs(raster[i].x - raster[i - 1].x) > 1 ||
      Math.abs(raster[i].y - raster[i - 1].y) > 1) gaps++;
}
const rcls = S.classifyPixels(raster, res.mask, SIZE);
console.log(`raster path (${raster.length} px, ${(100 * rcls.open / rcls.total).toFixed(1)}% open):`);
check('duplicate path pixels', raster.length - keys.size, 0);
check('non-adjacent consecutive pixels', gaps, 0);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
