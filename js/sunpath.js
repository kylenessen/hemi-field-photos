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
  // Returns [{minutes, date, altitude, azimuth}] (degrees).
  function solarPath(lat, lon, year, month, day, utcOffsetHours, stepMinutes) {
    var step = stepMinutes || 2;
    var out = [];
    for (var mins = 0; mins < 24 * 60; mins += step) {
      var hh = Math.floor(mins / 60), mm = mins % 60;
      var t = (utcOffsetHours == null)
        ? new Date(year, month - 1, day, hh, mm, 0)
        : new Date(Date.UTC(year, month - 1, day, hh, mm, 0) -
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

  var api = { solarPath: solarPath, classifyPath: classifyPath };

  global.HemiSunPath = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
