/*
 * Sun-path computation — mirrors solar_path() / overlay_solar_path() in the
 * reference, using SunCalc instead of pysolar.
 *
 * SunCalc returns altitude in radians and azimuth in radians measured from
 * SOUTH (westward positive); we convert to the reference convention of
 * degrees from NORTH (eastward positive).
 */
(function (global) {
  'use strict';

  var SunCalcLib = (typeof module !== 'undefined' && module.exports)
    ? require('./vendor/suncalc.js')
    : global.SunCalc;

  // Sun positions above the horizon for one local calendar day.
  //   utcOffsetHours: number -> fixed UTC offset for the location (like the
  //     reference's --tz); null/undefined -> the device's local timezone
  //     (incl. DST), which is correct when you're at the photo location.
  //   stepMinutes may be fractional (0.25 = 15 s) for fine sampling.
  // Returns [{minutes, date, altitude, azimuth}] (degrees).
  function solarPath(lat, lon, year, month, day, utcOffsetHours, stepMinutes) {
    var step = stepMinutes || 2;
    var out = [];
    for (var mins = 0; mins < 24 * 60; mins += step) {
      var secs = Math.round(mins * 60);
      var hh = Math.floor(secs / 3600), mm = Math.floor(secs / 60) % 60, ss = secs % 60;
      var t = (utcOffsetHours == null)
        ? new Date(year, month - 1, day, hh, mm, ss)
        : new Date(Date.UTC(year, month - 1, day, hh, mm, ss) -
                   utcOffsetHours * 3600 * 1000);
      var pos = SunCalcLib.getPosition(t, lat, lon);
      var altDeg = pos.altitude * 180 / Math.PI;
      if (altDeg > 0) {
        var azDeg = (pos.azimuth * 180 / Math.PI + 180) % 360;
        if (azDeg < 0) azDeg += 360;
        out.push({ minutes: mins, date: t, altitude: altDeg, azimuth: azDeg });
      }
    }
    return out;
  }

  // Classify each path step against the sky mask. Returns
  // [{x, y, open, ...step}] plus open/blocked counts.
  function classifyPath(path, mask, size) {
    var proj = (typeof module !== 'undefined' && module.exports)
      ? require('./projection.js')
      : global.HemiProjection;
    var steps = [], open = 0, blocked = 0;
    for (var i = 0; i < path.length; i++) {
      var p = proj.sunPositionToPixel(path[i].altitude, path[i].azimuth, size);
      if (!p) continue;
      var x = p[0], y = p[1];
      var isOpen = x >= 0 && x < size && y >= 0 && y < size &&
                   mask[y * size + x] > 127;
      steps.push({
        minutes: path[i].minutes, date: path[i].date,
        altitude: path[i].altitude, azimuth: path[i].azimuth,
        x: x, y: y, open: isOpen
      });
      if (isOpen) open++; else blocked++;
    }
    return { steps: steps, open: open, blocked: blocked };
  }

  function projLib() {
    return (typeof module !== 'undefined' && module.exports)
      ? require('./projection.js')
      : global.HemiProjection;
  }

  // Rasterize the day's sun track to the exact set of image pixels it
  // crosses — each pixel once, no gaps (Bresenham between consecutive
  // samples) and no double counting (consecutive duplicates collapse).
  // `path` should be finely sampled (<= ~0.5 min steps) so the line
  // segments are short. Returns [{x, y}] in track order.
  function rasterizePath(path, size) {
    var proj = projLib();
    var seen = new Set();
    var out = [];
    var px = null, py = null;

    function add(x, y) {
      var key = y * size + x;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x: x, y: y });
    }

    for (var i = 0; i < path.length; i++) {
      var p = proj.sunPositionToPixel(path[i].altitude, path[i].azimuth, size);
      if (!p) continue;
      var x = p[0], y = p[1];
      if (px === null) {
        add(x, y);
      } else if (Math.abs(x - px) <= 1 && Math.abs(y - py) <= 1) {
        if (x !== px || y !== py) add(x, y);
      } else {
        // Bresenham from (px,py) to (x,y), excluding the start pixel
        var dx = Math.abs(x - px), sx = px < x ? 1 : -1;
        var dy = -Math.abs(y - py), sy = py < y ? 1 : -1;
        var err = dx + dy, cx = px, cy = py;
        while (cx !== x || cy !== y) {
          var e2 = 2 * err;
          if (e2 >= dy) { err += dy; cx += sx; }
          if (e2 <= dx) { err += dx; cy += sy; }
          add(cx, cy);
        }
      }
      px = x; py = y;
    }
    return out;
  }

  // Classify rasterized path pixels against the sky mask.
  function classifyPixels(pixels, mask, size) {
    var out = [], open = 0;
    for (var i = 0; i < pixels.length; i++) {
      var px = pixels[i];
      var isOpen = px.x >= 0 && px.x < size && px.y >= 0 && px.y < size &&
                   mask[px.y * size + px.x] > 127;
      out.push({ x: px.x, y: px.y, open: isOpen });
      if (isOpen) open++;
    }
    return { pixels: out, open: open, total: out.length };
  }

  // ---- Clear-sky energy estimate ---------------------------------------------
  //
  // Simple, transparent clear-sky model (no calibration claimed):
  //   air mass       AM  = 1 / (cos Z + 0.50572 (96.07995 - Z)^-1.6364)
  //                        (Kasten & Young 1989, Z = zenith angle in degrees)
  //   direct normal  DNI = 1361 * 0.7^(AM^0.678) W/m^2  (Meinel & Meinel 1976)
  //   diffuse horiz. DHI = 0.10 * DNI                    (common rule of thumb)
  //
  // At the site, direct beam only arrives while the sun's pixel is open sky;
  // diffuse arrives scaled by the ISF. Integrating over `path` (one local
  // day at `stepMinutes` resolution) gives Wh/m^2 on a horizontal surface.
  function clearSkyEnergy(path, mask, size, isf, stepMinutes) {
    var proj = projLib();
    var dtH = stepMinutes / 60;
    var deg = Math.PI / 180;
    var siteWh = 0, skyWh = 0, dirSiteWh = 0, dirSkyWh = 0;
    var openSteps = 0;

    for (var i = 0; i < path.length; i++) {
      var alt = path[i].altitude;
      var Z = 90 - alt;
      var am = 1 / (Math.cos(Z * deg) + 0.50572 * Math.pow(96.07995 - Z, -1.6364));
      var dni = 1361 * Math.pow(0.7, Math.pow(am, 0.678));
      var dirH = dni * Math.sin(alt * deg);
      var dhi = 0.10 * dni;

      var p = proj.sunPositionToPixel(alt, path[i].azimuth, size);
      var open = p && p[0] >= 0 && p[0] < size && p[1] >= 0 && p[1] < size &&
                 mask[p[1] * size + p[0]] > 127;
      if (open) openSteps++;

      dirSkyWh += dirH * dtH;
      skyWh += (dirH + dhi) * dtH;
      dirSiteWh += (open ? dirH : 0) * dtH;
      siteWh += ((open ? dirH : 0) + isf * dhi) * dtH;
    }

    return {
      siteWh: siteWh, skyWh: skyWh,
      dsf: dirSkyWh > 0 ? dirSiteWh / dirSkyWh : 0,   // direct site factor
      gsf: skyWh > 0 ? siteWh / skyWh : 0,            // global site factor
      directSunHours: openSteps * dtH,
      aboveHorizonHours: path.length * dtH
    };
  }

  var api = {
    solarPath: solarPath,
    classifyPath: classifyPath,
    rasterizePath: rasterizePath,
    classifyPixels: classifyPixels,
    clearSkyEnergy: clearSkyEnergy
  };

  global.HemiSunPath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
