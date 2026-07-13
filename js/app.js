/*
 * App wiring: upload -> set north -> hemisphere -> threshold -> sun path ->
 * export. All heavy math lives in projection.js / threshold.js / sunpath.js.
 *
 * Two resolutions are used (per SPEC): a downscaled working copy for all
 * interaction, and a larger copy decoded on demand for PNG exports.
 */
(function () {
  'use strict';

  var WORK_MAX_W = 4096;      // working equirect width (interaction)
  var HEMI_SIZE = 1400;       // interactive hemisphere diameter
  var GROUND_SIZE = 1000;     // set-north ground view size
  var EXPORT_MAX_W = 8192;    // equirect width for exports
  var EXPORT_HEMI = 2048;     // export hemisphere diameter
  var SUN_STEP_MIN = 2;       // sun path step (minutes), like the reference

  var P = window.HemiProjection, T = window.HemiThreshold, S = window.HemiSunPath;

  var $ = function (id) { return document.getElementById(id); };

  // ---- State ---------------------------------------------------------------
  var st = {
    file: null,               // original File (re-decoded for exports)
    equirect: null,           // working ImageData (<= WORK_MAX_W wide, 2:1)
    topHalf: null, bottomHalf: null,
    groundBase: null,         // brightened ground-view canvas (image only)
    groundZoom: 2.5,          // center magnification of the ground view
    northAz: null,            // azimuth deg (-180..180) of north, or null
    northHistory: [], northFuture: [],
    dragging: false,
    hemi: null,               // hemisphere ImageData (HEMI_SIZE)
    hemiCanvasCache: null,    // offscreen canvas of true-color hemisphere
    maskCanvasCache: null,
    blurred: null, otsu: null, threshold: null, userThreshold: false,
    mask: null, metrics: null, factors: null,
    view: 'color',
    sun: null,                // time-step classification {steps, open, blocked}
    sunRaster: null,          // per-pixel path classification {pixels, open, total}
    energy: null,             // clear-sky day integration
    datePreset: 'today', customDate: null,
    exportCache: null         // {key, equirect, hemi, blurred} for exports
  };

  // ---- Helpers ---------------------------------------------------------------
  function halfImage(imgData, top) {
    var w = imgData.width, h = imgData.height, hh = Math.floor(h / 2);
    var rows = top ? hh : h - hh;
    var out = new Uint8ClampedArray(w * rows * 4);
    var start = top ? 0 : hh * w * 4;
    out.set(imgData.data.subarray(start, start + w * rows * 4));
    return { data: out, width: w, height: rows };
  }

  function toCanvas(img) {
    var c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(
      new ImageData(img.data, img.width, img.height), 0, 0);
    return c;
  }

  function maskToCanvas(mask, size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(size, size);
    for (var i = 0; i < mask.length; i++) {
      var v = mask[i], o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Let the browser paint (status overlays) before a long synchronous job.
  function nextFrame() {
    return new Promise(function (res) {
      requestAnimationFrame(function () { requestAnimationFrame(res); });
    });
  }

  function unlock(id) { $(id).classList.remove('locked'); }

  // ---- 1 · Upload ------------------------------------------------------------
  var dropzone = $('dropzone'), fileInput = $('fileInput');

  dropzone.addEventListener('click', function () { fileInput.click(); });
  dropzone.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault(); dropzone.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) {
      e.preventDefault(); dropzone.classList.remove('dragover');
    });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      loadFile(e.dataTransfer.files[0]);
    }
  });
  fileInput.addEventListener('change', function () {
    if (fileInput.files[0]) loadFile(fileInput.files[0]);
  });

  // Decode `file` scaled to at most maxW wide; returns ImageData (2:1-ish).
  function decodeScaled(file, maxW) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    return new Promise(function (resolve, reject) {
      img.onload = function () {
        try {
          var w = Math.min(img.naturalWidth, maxW);
          var h = Math.round(img.naturalHeight * (w / img.naturalWidth));
          w = Math.floor(w / 2) * 2; h = Math.floor(h / 2) * 2; // even halves
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          var ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve({ data: ctx.getImageData(0, 0, w, h),
                    origW: img.naturalWidth, origH: img.naturalHeight });
        } catch (err) { reject(err); }
        finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('Could not decode this image.'));
      };
      img.src = url;
    });
  }

  async function loadFile(file) {
    var info = $('uploadInfo');
    info.hidden = false;
    info.className = 'info';
    info.textContent = 'Decoding photo…';
    try {
      var res = await decodeScaled(file, WORK_MAX_W);
    } catch (err) {
      info.className = 'info warn';
      info.textContent = 'Could not load that file: ' + err.message;
      return;
    }
    var ratio = res.origW / res.origH;
    var ratioOk = Math.abs(ratio - 2) < 0.1;
    info.className = ratioOk ? 'info' : 'info warn';
    info.innerHTML = res.origW + '×' + res.origH +
      ' (' + ratio.toFixed(2) + ':1)' +
      (res.origW > WORK_MAX_W
        ? ' — working on a ' + res.data.width + '×' + res.data.height + ' copy'
        : '') +
      (ratioOk ? '' : '<br><strong>Warning:</strong> not ~2:1 — this doesn’t look ' +
                      'like an equirectangular 360° photo. Results may be wrong.');

    st.file = file;
    st.equirect = { data: res.data.data, width: res.data.width, height: res.data.height };
    st.topHalf = halfImage(st.equirect, true);
    st.bottomHalf = halfImage(st.equirect, false);
    st.exportCache = null;

    // preview
    var pv = $('previewCanvas');
    pv.hidden = false;
    var pw = Math.min(st.equirect.width, 1200);
    var ph = Math.round(st.equirect.height * pw / st.equirect.width);
    pv.width = pw; pv.height = ph;
    pv.getContext('2d').drawImage(toCanvas(st.equirect), 0, 0, pw, ph);

    // reset downstream state
    st.northAz = null; st.northHistory = []; st.northFuture = [];
    st.hemi = null; st.sun = null; st.sunRaster = null; st.energy = null;
    st.userThreshold = false;
    updateNorthButtons();
    $('northReadout').textContent = 'north not set';

    renderGroundBase();
    drawGround();
    unlock('step-north');
  }

  // ---- 2 · Set north ----------------------------------------------------------
  var groundCanvas = $('groundCanvas');

  // Render the looking-down ground view (re-run on zoom change),
  // auto-brightened for visibility (the ground half is usually dark).
  function renderGroundBase() {
    var g = P.equirectToGroundView(st.bottomHalf, GROUND_SIZE, 0, st.groundZoom);
    // stretch levels to the 99th percentile of the max channel
    var hist = new Uint32Array(256), d = g.data, i, n = 0;
    for (i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      var m = Math.max(d[i], d[i + 1], d[i + 2]);
      hist[m]++; n++;
    }
    var target = n * 0.99, acc = 0, p99 = 255;
    for (i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) { p99 = i; break; } }
    var gain = p99 > 8 ? Math.min(4, 240 / p99) : 1;
    if (gain > 1.05) {
      for (i = 0; i < d.length; i += 4) {
        d[i] = Math.min(255, d[i] * gain);
        d[i + 1] = Math.min(255, d[i + 1] * gain);
        d[i + 2] = Math.min(255, d[i + 2] * gain);
      }
    }
    st.groundBase = toCanvas(g);
  }

  // Draw ground view + interaction overlay (arrow, handle, labels).
  function drawGround() {
    var c = groundCanvas, size = GROUND_SIZE;
    c.width = c.height = size;
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    if (st.groundBase) ctx.drawImage(st.groundBase, 0, 0);
    var cx = size / 2, cy = size / 2, R = size / 2;

    // outer ring (drag track)
    ctx.beginPath();
    ctx.arc(cx, cy, R - 4, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (st.northAz == null) return;

    // north direction: azimuth az appears at screen angle theta = az - 90
    // (raw view is rendered with no north offset)
    var th = (st.northAz - 90) * Math.PI / 180;
    var ux = Math.cos(th), uy = Math.sin(th);

    // arrow from center to ring
    ctx.beginPath();
    ctx.moveTo(cx + ux * 30, cy + uy * 30);
    ctx.lineTo(cx + ux * (R - 40), cy + uy * (R - 40));
    ctx.strokeStyle = '#ff5252';
    ctx.lineWidth = 5;
    ctx.stroke();
    var ah = 18;                                   // arrowhead
    ctx.beginPath();
    ctx.moveTo(cx + ux * (R - 18), cy + uy * (R - 18));
    ctx.lineTo(cx + ux * (R - 18 - ah) - uy * ah * 0.6, cy + uy * (R - 18 - ah) + ux * ah * 0.6);
    ctx.lineTo(cx + ux * (R - 18 - ah) + uy * ah * 0.6, cy + uy * (R - 18 - ah) - ux * ah * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#ff5252';
    ctx.fill();

    // drag handle on the ring
    ctx.beginPath();
    ctx.arc(cx + ux * (R - 4), cy + uy * (R - 4), 16, 0, 2 * Math.PI);
    ctx.fillStyle = '#ff5252';
    ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.stroke();

    // cardinal labels at their current screen positions
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(function (L) {
      var a = (st.northAz + L[1] - 90) * Math.PI / 180;
      var lx = cx + Math.cos(a) * (R - 60), ly = cy + Math.sin(a) * (R - 60);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 5;
      ctx.strokeText(L[0], lx, ly);
      ctx.fillStyle = L[0] === 'N' ? '#ff5252' : '#fff';
      ctx.fillText(L[0], lx, ly);
    });
  }

  function canvasPos(e) {
    var r = groundCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * GROUND_SIZE / r.width,
      y: (e.clientY - r.top) * GROUND_SIZE / r.height
    };
  }

  function setNorth(az, pushHistory) {
    az = ((az + 180) % 360 + 360) % 360 - 180;
    if (pushHistory) {
      if (st.northAz != null) st.northHistory.push(st.northAz);
      st.northFuture = [];
    }
    st.northAz = az;
    var frac = P.azimuthToNorthFrac(az);
    $('northReadout').textContent =
      'north azimuth ' + az.toFixed(1) + '° (frac ' + frac.toFixed(4) + ')';
    updateNorthButtons();
    drawGround();
  }

  function updateNorthButtons() {
    $('northUndo').disabled = st.northHistory.length === 0;
    $('northRedo').disabled = st.northFuture.length === 0;
    $('northReset').disabled = st.northAz == null;
  }

  groundCanvas.addEventListener('pointerdown', function (e) {
    if (!st.groundBase) return;
    e.preventDefault();
    var p = canvasPos(e);
    var cx = GROUND_SIZE / 2, R = GROUND_SIZE / 2;
    var dx = p.x - cx, dy = p.y - cx;
    var r = Math.hypot(dx, dy);
    if (r > R) return;

    // near the ring (or on the handle) -> drag mode
    if (r > R * 0.82) {
      st.dragging = true;
      groundCanvas.setPointerCapture(e.pointerId);
      setNorth(P.groundThetaToAzimuth(Math.atan2(dy, dx), 0), true);
      return;
    }
    if (r < 25) return;                            // too close to center: direction ambiguous

    // single tap: north is the direction from the center through the tap
    // (the azimuth of a point in this polar view depends only on its angle
    // around the center, so one tap fully determines it)
    setNorth(P.groundThetaToAzimuth(Math.atan2(dy, dx), 0), true);
    scheduleHemiRender();
  });

  groundCanvas.addEventListener('pointermove', function (e) {
    if (!st.dragging) return;
    var p = canvasPos(e);
    var c = GROUND_SIZE / 2;
    setNorth(P.groundThetaToAzimuth(Math.atan2(p.y - c, p.x - c), 0), false);
  });

  ['pointerup', 'pointercancel'].forEach(function (ev) {
    groundCanvas.addEventListener(ev, function () {
      if (!st.dragging) return;
      st.dragging = false;
      scheduleHemiRender();
    });
  });

  $('northUndo').addEventListener('click', function () {
    if (!st.northHistory.length) return;
    st.northFuture.push(st.northAz);
    setNorth(st.northHistory.pop(), false);
    updateNorthButtons();
    scheduleHemiRender();
  });
  $('northRedo').addEventListener('click', function () {
    if (!st.northFuture.length) return;
    st.northHistory.push(st.northAz);
    setNorth(st.northFuture.pop(), false);
    updateNorthButtons();
    scheduleHemiRender();
  });
  $('northReset').addEventListener('click', function () {
    st.northHistory = []; st.northFuture = [];
    st.northAz = null;
    $('northReadout').textContent = 'north not set';
    updateNorthButtons();
    drawGround();
  });

  // zoom slider: re-render the ground view, throttled to one per frame
  var zoomQueued = false;
  $('groundZoom').addEventListener('input', function () {
    st.groundZoom = +this.value;
    $('groundZoomValue').textContent = st.groundZoom.toFixed(2).replace(/\.?0+$/, '') + '×';
    if (zoomQueued) return;
    zoomQueued = true;
    requestAnimationFrame(function () {
      zoomQueued = false;
      if (!st.bottomHalf) return;
      renderGroundBase();
      drawGround();
    });
  });

  // ---- 3 · Hemisphere + threshold ----------------------------------------------
  var renderPending = false;

  function scheduleHemiRender() {
    if (st.northAz == null || renderPending) return;
    renderPending = true;
    renderHemisphere().finally(function () { renderPending = false; });
  }

  async function renderHemisphere() {
    $('hemiStatus').hidden = false;
    unlock('step-hemi');
    await nextFrame();

    st.hemi = P.equirectToHemispherical(st.topHalf, HEMI_SIZE, st.northAz);
    st.hemiCanvasCache = toCanvas(st.hemi);

    var res = T.thresholdSky(st.hemi, st.userThreshold ? st.threshold : null);
    st.blurred = res.blurred;
    st.otsu = res.otsu;
    st.threshold = res.threshold;
    st.mask = res.mask;
    st.maskCanvasCache = maskToCanvas(st.mask, HEMI_SIZE);
    st.exportCache = null;

    var slider = $('threshSlider');
    slider.disabled = false;
    slider.value = st.threshold;
    $('threshAuto').disabled = false;
    updateThreshReadout();

    updateMetrics();
    recomputeSun();
    drawHemi();

    $('hemiStatus').hidden = true;
    unlock('step-sun');
    unlock('step-stats');
    unlock('step-export');
    ['expHemi', 'expMask', 'expAnnotated', 'expJson'].forEach(function (id) {
      $(id).disabled = false;
    });
  }

  function updateThreshReadout() {
    $('threshValue').textContent =
      st.threshold + (st.userThreshold ? '' : ' (auto ' + st.otsu + ')');
  }

  $('threshSlider').addEventListener('input', function () {
    if (!st.blurred) return;
    st.userThreshold = true;
    st.threshold = +this.value;
    st.mask = T.applyThreshold(st.blurred, HEMI_SIZE, st.threshold);
    st.maskCanvasCache = maskToCanvas(st.mask, HEMI_SIZE);
    st.exportCache = null;
    updateThreshReadout();
    updateMetrics();
    recomputeSun();
    drawHemi();
  });

  $('threshAuto').addEventListener('click', function () {
    if (!st.blurred) return;
    st.userThreshold = false;
    st.threshold = st.otsu;
    $('threshSlider').value = st.threshold;
    st.mask = T.applyThreshold(st.blurred, HEMI_SIZE, st.threshold);
    st.maskCanvasCache = maskToCanvas(st.mask, HEMI_SIZE);
    st.exportCache = null;
    updateThreshReadout();
    updateMetrics();
    recomputeSun();
    drawHemi();
  });

  $('viewColor').addEventListener('click', function () { setView('color'); });
  $('viewMask').addEventListener('click', function () { setView('mask'); });
  function setView(v) {
    st.view = v;
    $('viewColor').classList.toggle('active', v === 'color');
    $('viewMask').classList.toggle('active', v === 'mask');
    drawHemi();
  }
  $('gridToggle').addEventListener('change', drawHemi);
  $('sunToggle').addEventListener('change', drawHemi);

  // Composite: base image + grid + sun path, onto any square canvas.
  function drawComposite(ctx, size, baseCanvas, opts) {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(baseCanvas, 0, 0, size, size);
    var c = size / 2, R = size / 2;
    var k = size / 1000;                           // scale factor for strokes

    if (opts.grid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = Math.max(1, k);
      [10, 30, 60].forEach(function (z) {          // zenith rings
        ctx.beginPath();
        ctx.arc(c, c, (z / 90) * R, 0, 2 * Math.PI);
        ctx.stroke();
      });
      ctx.beginPath();                             // horizon
      ctx.arc(c, c, R - Math.max(1, k), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.beginPath();                             // N-S / E-W crosshairs
      ctx.moveTo(c, 0); ctx.lineTo(c, size);
      ctx.moveTo(0, c); ctx.lineTo(size, c);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.stroke();

      ctx.font = 'bold ' + Math.round(30 * k) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      [['N', c, 22 * k], ['E', size - 22 * k, c],
       ['S', c, size - 22 * k], ['W', 22 * k, c]].forEach(function (L) {
        ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineWidth = 5 * k;
        ctx.strokeText(L[0], L[1], L[2]);
        ctx.fillStyle = L[0] === 'N' ? '#ff5252' : '#fff';
        ctx.fillText(L[0], L[1], L[2]);
      });
    }

    if (opts.sun && st.sunRaster && st.sunRaster.total) {
      // the rasterized track: every crossed pixel, drawn as a continuous
      // line — black underlay first, then each pixel in its open/blocked color
      var sc = size / HEMI_SIZE;
      var mr = Math.max(2.5, size * 0.0035);
      ctx.fillStyle = '#000';
      st.sunRaster.pixels.forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x * sc, p.y * sc, mr + Math.max(1, k), 0, 2 * Math.PI);
        ctx.fill();
      });
      st.sunRaster.pixels.forEach(function (p) {
        ctx.beginPath();
        ctx.arc(p.x * sc, p.y * sc, mr, 0, 2 * Math.PI);
        ctx.fillStyle = p.open ? '#ffd200' : '#eb2828';
        ctx.fill();
      });
    }
  }

  function drawHemi() {
    if (!st.hemiCanvasCache) return;
    var canvas = $('hemiCanvas');
    canvas.width = canvas.height = HEMI_SIZE;
    drawComposite(canvas.getContext('2d'), HEMI_SIZE,
      st.view === 'mask' ? st.maskCanvasCache : st.hemiCanvasCache,
      { grid: $('gridToggle').checked, sun: $('sunToggle').checked });
  }

  function updateMetrics() {
    st.metrics = T.opennessByRing(st.mask, HEMI_SIZE);
    st.factors = T.siteFactors(st.mask, HEMI_SIZE);
    var el = $('opennessSummary');
    el.hidden = false;
    el.textContent = 'Total openness: ' +
      (st.metrics.totalOpenness * 100).toFixed(1) + '% of the hemisphere is sky';
    $('ringDetails').hidden = false;
    var bars = $('ringBars');
    bars.innerHTML = '';
    Object.keys(st.metrics.byRing).forEach(function (ring) {
      var f = st.metrics.byRing[ring];
      var lbl = document.createElement('span');
      lbl.textContent = ring + '°';
      var bar = document.createElement('div');
      bar.className = 'ringbar';
      var fill = document.createElement('div');
      fill.style.width = (f * 100).toFixed(1) + '%';
      bar.appendChild(fill);
      var val = document.createElement('span');
      val.textContent = (f * 100).toFixed(0) + '%';
      bars.appendChild(lbl); bars.appendChild(bar); bars.appendChild(val);
    });
  }

  // ---- 4 · Sun path -------------------------------------------------------------
  function selectedDate() {
    var now = new Date();
    var presets = {
      oct15: { m: 10, d: 15 }, dec1: { m: 12, d: 1 },
      dec21: { m: 12, d: 21 }, mar15: { m: 3, d: 15 }
    };
    if (presets[st.datePreset]) {
      return { y: now.getFullYear(),
               m: presets[st.datePreset].m, d: presets[st.datePreset].d };
    }
    if (st.datePreset === 'custom' && st.customDate) {
      var p = st.customDate.split('-');
      return { y: +p[0], m: +p[1], d: +p[2] };
    }
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  }

  function recomputeSun() {
    var lat = parseFloat($('latInput').value);
    var lon = parseFloat($('lonInput').value);
    var summary = $('sunSummary');
    if (!isFinite(lat) || !isFinite(lon) || !st.mask) {
      st.sun = null; st.sunRaster = null; st.energy = null;
      summary.hidden = true;
      updateStats();
      return;
    }
    var tz = null;
    if ($('tzMode').value === 'manual') tz = parseFloat($('tzOffset').value) || 0;
    var d = selectedDate();

    // per-minute time steps: hours of direct sun + clear-sky energy
    var path = S.solarPath(lat, lon, d.y, d.m, d.d, tz, SUN_STEP_MIN);
    st.sun = S.classifyPath(path, st.mask, HEMI_SIZE);
    st.sun.date = d; st.sun.lat = lat; st.sun.lon = lon; st.sun.tz = tz;
    st.energy = S.clearSkyEnergy(path, st.mask, HEMI_SIZE,
                                 st.factors ? st.factors.isf : 0, SUN_STEP_MIN);

    // fine sampling + rasterization: every pixel the track crosses, once
    var fine = S.solarPath(lat, lon, d.y, d.m, d.d, tz, 0.25);
    st.sunRaster = S.classifyPixels(S.rasterizePath(fine, HEMI_SIZE),
                                    st.mask, HEMI_SIZE);

    summary.hidden = false;
    summary.textContent =
      d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0') +
      ': sun above horizon ' + st.energy.aboveHorizonHours.toFixed(1) +
      ' h — direct sun ≈ ' + st.energy.directSunHours.toFixed(1) + ' h — path ' +
      (st.sunRaster.total ? (100 * st.sunRaster.open / st.sunRaster.total).toFixed(0) : 0) +
      '% open';
    updateStats();
  }

  function fmtPct(f, digits) { return (f * 100).toFixed(digits == null ? 1 : digits) + '%'; }

  function updateStats() {
    if (st.factors) {
      $('statOpenness').textContent = fmtPct(st.factors.opennessSolidAngle);
      $('statOpennessSub').textContent = 'solid-angle share of the sky dome (' +
        fmtPct(st.metrics.totalOpenness) + ' of image pixels)';
      $('statIsf').textContent = st.factors.isf.toFixed(3);
    }
    var dash = '—';
    if (st.sunRaster && st.sunRaster.total) {
      $('statPathOpen').textContent = fmtPct(st.sunRaster.open / st.sunRaster.total);
      $('statPathOpenSub').textContent = st.sunRaster.open + ' of ' +
        st.sunRaster.total + ' path pixels over open sky';
    } else {
      $('statPathOpen').textContent = dash;
      $('statPathOpenSub').textContent = 'set a location in step 4';
    }
    if (st.energy) {
      $('statDsf').textContent = st.energy.dsf.toFixed(3);
      $('statGsf').textContent = st.energy.gsf.toFixed(3);
      $('statSunHours').textContent = st.energy.directSunHours.toFixed(1) + ' h';
      $('statSunHoursSub').textContent = 'of ' +
        st.energy.aboveHorizonHours.toFixed(1) + ' h above the horizon';
      $('statEnergy').innerHTML = (st.energy.siteWh / 1000).toFixed(2) +
        ' <span class="unit">kWh/m²</span>';
      $('statEnergySub').textContent = 'clear-sky est. — open ground would get ' +
        (st.energy.skyWh / 1000).toFixed(2) + ' kWh/m² (' +
        fmtPct(st.energy.gsf, 0) + ')';
    } else {
      ['statDsf', 'statGsf', 'statSunHours', 'statEnergy'].forEach(function (id) {
        $(id).textContent = dash;
      });
      $('statSunHoursSub').textContent = 'set a location in step 4';
      $('statEnergySub').textContent = 'set a location in step 4';
    }
  }

  function sunChanged() { recomputeSun(); drawHemi(); }

  ['latInput', 'lonInput', 'tzOffset'].forEach(function (id) {
    $(id).addEventListener('change', sunChanged);
  });
  $('tzMode').addEventListener('change', function () {
    $('tzOffsetLabel').hidden = this.value !== 'manual';
    sunChanged();
  });

  document.querySelectorAll('.datebtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      st.datePreset = btn.dataset.preset;
      document.querySelectorAll('.datebtn').forEach(function (b) {
        b.classList.toggle('active', b === btn);
      });
      sunChanged();
    });
  });
  $('dateInput').addEventListener('change', function () {
    if (!this.value) return;
    st.datePreset = 'custom';
    st.customDate = this.value;
    document.querySelectorAll('.datebtn').forEach(function (b) {
      b.classList.remove('active');
    });
    sunChanged();
  });

  $('geoBtn').addEventListener('click', function () {
    if (!navigator.geolocation) {
      alert('Geolocation is not available in this browser.');
      return;
    }
    var btn = this;
    btn.disabled = true; btn.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      $('latInput').value = pos.coords.latitude.toFixed(5);
      $('lonInput').value = pos.coords.longitude.toFixed(5);
      btn.disabled = false; btn.textContent = '◎ Use my location';
      sunChanged();
    }, function (err) {
      btn.disabled = false; btn.textContent = '◎ Use my location';
      alert('Could not get location: ' + err.message +
            '\n(Geolocation needs HTTPS or localhost.)');
    }, { enableHighAccuracy: true, timeout: 15000 });
  });

  // ---- 5 · Export ------------------------------------------------------------------
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  function exportStatus(msg) {
    var el = $('exportStatus');
    el.hidden = !msg;
    if (msg) el.textContent = msg;
  }

  // Build (and cache) the high-res render used by all PNG exports.
  async function exportBundle() {
    var key = [st.northAz, st.threshold].join('|');
    if (st.exportCache && st.exportCache.key === key) return st.exportCache;

    exportStatus('Rendering high-resolution export…');
    await nextFrame();

    var bundle = { key: key };
    try {
      var res = await decodeScaled(st.file, EXPORT_MAX_W);
      var eq = { data: res.data.data, width: res.data.width, height: res.data.height };
      var top = halfImage(eq, true);
      bundle.hemi = P.equirectToHemispherical(top, EXPORT_HEMI, st.northAz);
      bundle.size = EXPORT_HEMI;
    } catch (err) {
      // out of memory / decode limits -> fall back to the working-res render
      bundle.hemi = st.hemi;
      bundle.size = HEMI_SIZE;
    }
    bundle.hemiCanvas = toCanvas(bundle.hemi);
    var blurred = T.gaussianBlur5(T.blueChannel(bundle.hemi), bundle.size, bundle.size);
    bundle.mask = T.applyThreshold(blurred, bundle.size, st.threshold);
    bundle.maskCanvas = maskToCanvas(bundle.mask, bundle.size);
    st.exportCache = bundle;
    exportStatus('');
    return bundle;
  }

  function canvasPng(canvas, name) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        download(blob, name);
        resolve();
      }, 'image/png');
    });
  }

  $('expHemi').addEventListener('click', async function () {
    var b = await exportBundle();
    await canvasPng(b.hemiCanvas, 'hemispherical.png');
  });

  $('expMask').addEventListener('click', async function () {
    var b = await exportBundle();
    await canvasPng(b.maskCanvas, 'sky-mask.png');
  });

  $('expAnnotated').addEventListener('click', async function () {
    var b = await exportBundle();
    var c = document.createElement('canvas');
    c.width = c.height = b.size;
    drawComposite(c.getContext('2d'), b.size, b.hemiCanvas,
                  { grid: $('gridToggle').checked, sun: true });
    await canvasPng(c, 'sun-path.png');
  });

  $('expJson').addEventListener('click', function () {
    var d = st.sun && st.sun.date;
    var out = {
      generated: new Date().toISOString(),
      northAzimuthDeg: st.northAz,
      northFrac: st.northAz == null ? null : P.azimuthToNorthFrac(st.northAz),
      threshold: st.threshold,
      thresholdMode: st.userThreshold ? 'manual' : 'otsu',
      openness: st.metrics,
      siteFactors: st.factors ? {
        canopyOpennessSolidAngle: Math.round(st.factors.opennessSolidAngle * 10000) / 10000,
        isf: Math.round(st.factors.isf * 10000) / 10000,
        dsf: st.energy ? Math.round(st.energy.dsf * 10000) / 10000 : null,
        gsf: st.energy ? Math.round(st.energy.gsf * 10000) / 10000 : null
      } : null,
      sun: st.sun ? {
        lat: st.sun.lat, lon: st.sun.lon,
        utcOffsetHours: st.sun.tz == null ? 'device' : st.sun.tz,
        date: d.y + '-' + String(d.m).padStart(2, '0') + '-' + String(d.d).padStart(2, '0'),
        stepMinutes: SUN_STEP_MIN,
        openSteps: st.sun.open, blockedSteps: st.sun.blocked,
        directSunHours: Math.round(st.energy.directSunHours * 100) / 100,
        aboveHorizonHours: Math.round(st.energy.aboveHorizonHours * 100) / 100,
        pathPixels: st.sunRaster ? {
          open: st.sunRaster.open, total: st.sunRaster.total,
          openFraction: st.sunRaster.total
            ? Math.round(st.sunRaster.open / st.sunRaster.total * 10000) / 10000 : 0
        } : null,
        clearSkyEnergy: {
          model: 'Kasten-Young air mass; DNI = 1361 * 0.7^(AM^0.678) W/m2; DHI = 0.1 * DNI; horizontal surface',
          siteWhPerM2: Math.round(st.energy.siteWh),
          openSkyWhPerM2: Math.round(st.energy.skyWh)
        }
      } : null
    };
    download(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }),
             'hemi-metrics.json');
  });

})();
