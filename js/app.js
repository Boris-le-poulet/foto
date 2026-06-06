/**
 * app.js — Aperture entry point.
 * Imports all modules and wires UI events.
 */

import { CameraManager }   from './camera.js';
import { captureFrame }    from './capture.js';
import { bindCapabilities, detectTier, renderTierBanner, renderCapabilityReport, estimateOpticalSnaps } from './capabilities.js';
import { ModeController }  from './modes.js';
import { OverlayManager }  from './overlays.js';
import { buildExifStr, injectExif } from './exif.js';
import { GalleryManager }  from './gallery.js';
import { updateCalculator } from './calculator.js';
import { LensManager, formatFocusDist, focusZoneLabel, normToMetres } from './lens.js';

// ---- State ----
const cam         = new CameraManager();
const overlays    = new OverlayManager();
const gallery     = new GalleryManager();
const lensManager = new LensManager();
let modeCtrl      = null;
let tierInfo      = {};

let currentMode        = 'photo';
let currentCaptureMode = 'single';
let gpsEnabled         = false;
let gpsPosition        = null;
let gpsWatcher         = null;
let isRecording        = false;
let looks              = { filmSim: 'none', vignetteAmount: 0, grainAmount: 0, watermarkText: '' };

// ---- Init ----

async function init() {
  await gallery.init();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then(r => console.log('SW registered, scope:', r.scope))
      .catch(e => console.warn('SW registration failed:', e.message));
  }

  setupUIBindings();

  const videoEl = document.getElementById('preview');
  overlays.init(videoEl, document.getElementById('overlayCanvas'));
  overlays.addTapFocusListener(cam);

  try {
    await cam.start(videoEl);
    onCameraReady();
  } catch (err) {
    showCameraError(err);
  }

  document.querySelectorAll('#calculatorModal input').forEach(el =>
    el.addEventListener('input', updateCalculator)
  );
  updateCalculator();

  window.addEventListener('ap:pinholePixels', e => {
    window._pinholePixelSpan = e.detail.pixels;
    updateCalculator();
  });
}

async function onCameraReady() {
  document.getElementById('cameraError')?.classList.add('d-none');

  const caps     = cam.getCapabilities();
  const settings = cam.getSettings();

  // Enumerate lenses first so detectTier gets numVideoDevices
  await lensManager.enumerateAll();
  const facingDevs = lensManager.facingDevices(cam.facingMode);
  tierInfo = bindCapabilities(caps, settings, facingDevs.length);

  renderTierBanner(tierInfo);

  modeCtrl = new ModeController(cam, onCapture);

  // Build & wire lens UI
  initLensUI(caps, settings);

  // Pinch-to-zoom on the viewfinder
  const viewfinder = document.getElementById('viewfinder');
  if (viewfinder && caps.zoom) {
    lensManager.initPinchZoom(viewfinder, caps.zoom, z => {
      cam.setZoom(z);
      lensManager.setCurrentZoom(z);
      updateZoomUI(z, caps.zoom);
    });
  }

  // Watch zoom changes from camera.js (triggered by setZoom)
  window.addEventListener('ap:zoomChanged', e => {
    updateZoomUI(e.detail.zoom, caps.zoom);
  });

  updateResolutionLabel();
  updateModeUI('photo', 'single');
  updateProUIFromSettings(settings);

  if (!tierInfo.hasMediaRecorder) {
    document.getElementById('modeVideo')?.classList.add('d-none');
  }
}

// ---- Lens UI init ----

function initLensUI(caps, settings) {
  const zoomCap = caps.zoom;

  // Build optical snap points
  const facingDevs = lensManager.facingDevices(cam.facingMode);
  lensManager.buildZoomSnaps(zoomCap, facingDevs.length);

  // Lens picker buttons
  _buildLensBtnRow(facingDevs, caps);

  // Quick-zoom bar on viewfinder
  _buildQuickZoomBar(lensManager.zoomSnaps, zoomCap);

  // Zoom snap buttons inside Pro accordion
  _buildZoomSnapRow(lensManager.zoomSnaps, zoomCap);

  // Show/hide quality bar
  const qualityWrap = document.getElementById('zoomQualityWrap');
  if (qualityWrap && zoomCap?.max > 1) {
    qualityWrap.classList.remove('d-none');
    const optMaxEl = document.getElementById('zoomOpticalMax');
    if (optMaxEl) optMaxEl.textContent = `${lensManager.opticalMax}×`;
  }

  // Configure zoom slider bounds
  const zoomSlider = document.getElementById('ctrlZoom');
  if (zoomSlider && zoomCap) {
    zoomSlider.min   = zoomCap.min ?? 1;
    zoomSlider.max   = zoomCap.max ?? 10;
    zoomSlider.step  = Math.max(0.05, (zoomCap.max - (zoomCap.min ?? 1)) / 200);
    zoomSlider.value = settings.zoom ?? zoomCap.min ?? 1;
    zoomSlider.disabled = false;
    lensManager.setCurrentZoom(settings.zoom ?? 1);
    updateZoomUI(settings.zoom ?? 1, zoomCap);
  }

  // Configure focus distance slider — real metres
  const focusCap   = caps.focusDistance;
  const focusSlider = document.getElementById('ctrlFocusDistance');
  if (focusSlider && focusCap) {
    focusSlider.min   = focusCap.min ?? 0;
    focusSlider.max   = focusCap.max ?? 10;
    focusSlider.step  = Math.max(0.01, (focusCap.max - focusCap.min) / 200);
    focusSlider.value = settings.focusDistance ?? focusCap.max ?? 10;
    focusSlider.disabled = false;
    _updateFocusDistUI(settings.focusDistance ?? focusCap.max, focusCap);
  }

  // AF lock / trigger buttons
  const hasFocusControl = !!(focusCap);
  document.getElementById('btnAFLock')?.toggleAttribute('disabled', !hasFocusControl);
  document.getElementById('btnAFTrigger')?.toggleAttribute('disabled', false);

  // Focus zone — disable if no pointsOfInterest support
  document.querySelectorAll('.ap-zone-btn').forEach(b => b.removeAttribute('disabled'));
}

function _buildLensBtnRow(facingDevs, caps) {
  const bar = document.getElementById('lensBar');
  if (!bar) return;
  bar.innerHTML = '';

  if (facingDevs.length === 0) {
    // Single-lens device — hide the bar so it doesn't waste space
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  const lenses = lensManager.buildLensList(cam.facingMode);

  lenses.forEach((lens, i) => {
    const btn = document.createElement('button');
    btn.className = `ap-lens-btn${i === 0 ? ' active' : ''}`;
    btn.dataset.deviceId = lens.deviceId;
    btn.dataset.mult     = lens.mult;
    btn.title = `${lens.name} — ${lens.profile.fov} FoV`;
    btn.innerHTML = `
      <span class="ap-lens-mult">${lens.mult}×</span>
      <span class="ap-lens-name">${lens.name}</span>
    `;
    btn.addEventListener('click', () => _selectLens(lens, caps));
    bar.appendChild(btn);
  });

  // Show info card for first lens
  if (lenses[0]) _showLensInfoCard(lenses[0], caps);
}

function _buildQuickZoomBar(snaps, zoomCap) {
  const bar = document.getElementById('zoomQuickBar');
  if (!bar) return;

  if (!zoomCap || snaps.length <= 1) {
    bar.classList.add('d-none');
    return;
  }

  bar.innerHTML = '';
  bar.classList.remove('d-none');

  snaps.forEach(z => {
    const btn = document.createElement('button');
    btn.className = 'ap-zoom-snap-btn';
    btn.dataset.zoom = z;
    btn.textContent  = `${z}×`;
    if (z === 1) btn.classList.add('active');
    btn.addEventListener('click', () => {
      cam.setZoom(z);
      lensManager.setCurrentZoom(z);
      updateZoomUI(z, zoomCap);
      document.getElementById('ctrlZoom').value = z;
      // Update active state
      bar.querySelectorAll('.ap-zoom-snap-btn').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.zoom) === z)
      );
    });
    bar.appendChild(btn);
  });
}

function _buildZoomSnapRow(snaps, zoomCap) {
  const row = document.getElementById('zoomSnapRow');
  if (!row) return;
  row.innerHTML = '';
  if (!zoomCap || snaps.length <= 1) return;

  snaps.forEach(z => {
    const btn = document.createElement('button');
    btn.className = 'ap-zoom-snap-chip';
    btn.dataset.zoom = z;
    btn.textContent  = `${z}×`;
    if (z === 1) btn.classList.add('active');
    btn.addEventListener('click', () => {
      cam.setZoom(z);
      lensManager.setCurrentZoom(z);
      updateZoomUI(z, zoomCap);
      const slider = document.getElementById('ctrlZoom');
      if (slider) slider.value = z;
      row.querySelectorAll('.ap-zoom-snap-chip').forEach(b =>
        b.classList.toggle('active', parseFloat(b.dataset.zoom) === z)
      );
    });
    row.appendChild(btn);
  });
}

async function _selectLens(lens, caps) {
  // Highlight selected button
  document.querySelectorAll('.ap-lens-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.deviceId === lens.deviceId)
  );
  _showLensInfoCard(lens, caps);

  // Switch to new device
  try {
    await cam.startWithDevice(lens.deviceId, document.getElementById('preview'));
    // Re-read capabilities for the new lens
    const newCaps     = cam.getCapabilities();
    const newSettings = cam.getSettings();
    bindCapabilities(newCaps, newSettings, lensManager.facingDevices(cam.facingMode).length);
    initLensUI(newCaps, newSettings);
    updateProUIFromSettings(newSettings);
    showToast(`Switched to ${lens.name} lens`, 'info');
  } catch (e) {
    showToast(`Lens switch failed: ${e.message}`, 'danger');
  }
}

function _showLensInfoCard(lens, caps) {
  const card = document.getElementById('lensInfoCard');
  if (!card) return;
  card.classList.remove('d-none');

  const focusCap = caps?.focusDistance;
  const minFocus = focusCap
    ? formatFocusDist(focusCap.min ?? 0)
    : '—';

  const photoCaps = caps?.photoWidth;
  const maxRes = photoCaps?.max && caps?.photoHeight?.max
    ? `${caps.photoWidth.max}×${caps.photoHeight.max}`
    : (caps?.width?.max ? `${caps.width.max}×${caps?.height?.max}` : '—');

  document.getElementById('lensInfoName').textContent   = `${lens.mult}× ${lens.name}`;
  document.getElementById('lensInfoFoV').textContent    = lens.profile.fov;
  document.getElementById('lensInfoFocal').textContent  = `~${lensManager.estimateFocalLength(lens.mult)} mm`;
  document.getElementById('lensInfoMinDist').textContent= minFocus;
  document.getElementById('lensInfoMaxRes').textContent = maxRes;
}

// ---- Zoom quality indicator ----

function updateZoomUI(zoom, zoomCap) {
  const quality   = lensManager.zoomQuality(zoom);
  const fillEl    = document.getElementById('zoomQualityFill');
  const labelEl   = document.getElementById('zoomQualityLabel');
  const typeEl    = document.getElementById('zoomTypeLabel');
  const valEl     = document.getElementById('valZoomLive');

  if (valEl) valEl.textContent = `${zoom.toFixed(1)}×`;

  // Sync quick-zoom-bar active state
  document.querySelectorAll('.ap-zoom-snap-btn').forEach(b =>
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.zoom) - zoom) < 0.2)
  );
  document.querySelectorAll('.ap-zoom-snap-chip').forEach(b =>
    b.classList.toggle('active', Math.abs(parseFloat(b.dataset.zoom) - zoom) < 0.2)
  );

  if (!fillEl || !zoomCap) return;
  const optMax = lensManager.opticalMax || zoomCap.max;
  const pct    = Math.min(100, (Math.min(zoom, optMax) / optMax) * 100);

  if (quality === 'optical') {
    fillEl.className = 'progress-bar bg-success';
    if (labelEl) labelEl.textContent = 'Optical';
    if (labelEl) labelEl.className = 'text-success';
    if (typeEl)  typeEl.textContent = '';
  } else if (quality === 'nearoptical') {
    fillEl.className = 'progress-bar bg-warning';
    if (labelEl) labelEl.textContent = 'Near optical';
    if (labelEl) labelEl.className = 'text-warning';
    if (typeEl)  typeEl.textContent = '(near optical)';
  } else {
    fillEl.className = 'progress-bar bg-danger';
    if (labelEl) labelEl.textContent = 'Digital zoom';
    if (labelEl) labelEl.className = 'text-danger';
    if (typeEl)  typeEl.textContent = '(digital)';
  }
  fillEl.style.width = `${pct}%`;
}

// ---- Focus distance real-unit display ----

function _updateFocusDistUI(value, focusCap) {
  const metres   = normToMetres(value, focusCap);
  const distEl   = document.getElementById('valFocusDistance');
  const zoneEl   = document.getElementById('valFocusZoneLabel');
  if (distEl) distEl.textContent = formatFocusDist(metres);
  if (zoneEl) zoneEl.textContent = focusZoneLabel(metres);
}

// ---- Capture callback ----

async function onCapture(blob, mode, metadata) {
  let finalBlob = blob;

  if (blob.type === 'image/jpeg' || !blob.type) {
    const settings = cam.getSettings();
    const gps      = gpsEnabled ? gpsPosition : null;
    const exifStr  = buildExifStr({
      settings: {
        iso:         settings.iso,
        fNumber:     settings.fNumber,
        focalLength: settings.focalLength,
      },
      gps,
      timestamp: new Date(),
    });
    if (exifStr) finalBlob = await injectExif(blob, exifStr);
  }

  await gallery.save(finalBlob, mode, metadata);

  const mpText = metadata.megapixels ? `${metadata.megapixels} MP` : '';
  const src    = metadata.source     ? `(${metadata.source})`      : '';
  showToast(`Saved — ${mpText} ${src}`.trim(), 'success');

  const mpEl  = document.getElementById('statusMP');
  const srcEl = document.getElementById('statusSource');
  if (mpEl)  mpEl.textContent  = mpText;
  if (srcEl) srcEl.textContent = src;
}

// ---- UI bindings ----

function setupUIBindings() {
  document.getElementById('btnShutter')?.addEventListener('click', onShutter);

  document.getElementById('btnSwitchCamera')?.addEventListener('click', async () => {
    try {
      lensManager.activeDeviceId = null;
      await cam.switchCamera();
      onCameraReady();
    } catch (e) {
      showToast('Camera switch failed', 'danger');
    }
  });

  document.getElementById('btnRetryCamera')?.addEventListener('click', async () => {
    try {
      await cam.start(document.getElementById('preview'));
      onCameraReady();
    } catch (e) {
      showCameraError(e);
    }
  });

  // Mode pills
  document.querySelectorAll('.ap-mode-pill').forEach(btn =>
    btn.addEventListener('click', () => setMode(btn.dataset.mode))
  );

  // Capture mode chips
  document.querySelectorAll('.ap-capture-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ap-capture-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentCaptureMode = btn.dataset.cmode;
      updateCaptureControls();
    });
  });

  // Gallery
  document.getElementById('btnGallery')?.addEventListener('click', openGallery);
  document.getElementById('btnCloseGallery')?.addEventListener('click', closeGallery);
  document.getElementById('btnClearGallery')?.addEventListener('click', async () => {
    if (!confirm('Delete all photos?')) return;
    await gallery.clearAll();
    document.getElementById('galleryGrid').innerHTML = '';
    document.getElementById('galleryCount').textContent = '0 items';
  });

  // Torch
  document.getElementById('btnTorch')?.addEventListener('click', async function() {
    const on = !this.classList.contains('active');
    this.classList.toggle('active', on);
    await cam.setTorch(on);
  });

  // GPS
  document.getElementById('btnGPS')?.addEventListener('click', function() {
    gpsEnabled = !gpsEnabled;
    this.dataset.active = gpsEnabled;
    if (gpsEnabled) startGPS(); else stopGPS();
  });

  // Pro offcanvas
  document.getElementById('btnOpenPro')?.addEventListener('click', () => {
    new bootstrap.Offcanvas(document.getElementById('proOffcanvas')).show();
  });

  // Calculator
  document.getElementById('btnCalculator')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('calculatorModal')).show();
    updateCalculator();
  });

  // Capability report
  document.getElementById('btnCapabilityReport')?.addEventListener('click', () => {
    renderCapabilityReport(cam.getCapabilities(), cam.getSettings(), tierInfo);
    new bootstrap.Modal(document.getElementById('capabilityModal')).show();
  });

  // Overlay toggles
  document.querySelectorAll('.ap-overlay-toggle').forEach(btn => {
    btn.addEventListener('click', function() {
      const active = overlays.toggle(this.dataset.overlay);
      this.classList.toggle('active', active);
    });
  });

  // Pro control ranges — special handling for zoom (throttled) and focusDistance (real units)
  document.querySelectorAll('[data-cap]').forEach(el => {
    if (el.tagName === 'INPUT') {
      el.addEventListener('input', () => {
        const cap = el.dataset.cap;
        const val = parseFloat(el.value);

        if (cap === 'zoom') {
          cam.setZoom(val);
          lensManager.setCurrentZoom(val);
          updateZoomUI(val, cam.getCapabilities().zoom);
          return;
        }

        if (cap === 'focusDistance') {
          cam.applyConstraint('focusDistance', val);
          _updateFocusDistUI(val, cam.getCapabilities().focusDistance);
          return;
        }

        const valEl = document.getElementById(`val${_capitalise(cap)}`);
        if (valEl) valEl.textContent = _fmtControlVal(cap, el.value);
        cam.applyConstraint(cap, val);
      });
    }
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        cam.applyConstraint(el.dataset.cap, el.value);
        if (el.dataset.cap === 'whiteBalanceMode') {
          document.getElementById('grpColorTemperature')?.classList.toggle('d-none', el.value !== 'manual');
        }
      });
    }
  });

  // WB presets
  document.querySelectorAll('.ap-wb-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = document.getElementById('ctrlWhiteBalanceMode');
      if (sel && !sel.disabled) { sel.value = btn.dataset.wb; cam.applyConstraint('whiteBalanceMode', btn.dataset.wb); }
    });
  });

  // Auto ISO
  document.getElementById('autoISO')?.addEventListener('change', function() {
    document.getElementById('ctrlISO').disabled = this.checked;
    if (this.checked) cam.applyConstraint('iso', 'auto').catch(() => {});
  });

  // ---- AF Lock ----
  document.getElementById('btnAFLock')?.addEventListener('click', async function() {
    const { locked, distance } = await cam.lockAF();
    this.classList.toggle('active', locked);
    this.textContent = locked ? 'AF-L ●' : 'AF‑L';

    const indicator = document.getElementById('afLockIndicator');
    const distVal   = document.getElementById('afLockDistVal');
    if (indicator) indicator.classList.toggle('d-none', !locked);
    if (distVal && locked && distance != null) {
      distVal.textContent = formatFocusDist(normToMetres(distance, cam.getCapabilities().focusDistance));
    }
    showToast(locked ? `AF locked at ${distVal?.textContent || '?'}` : 'AF unlocked', locked ? 'warning' : 'info');
  });

  // ---- AF Trigger ----
  document.getElementById('btnAFTrigger')?.addEventListener('click', async function() {
    this.textContent = 'AF…';
    this.disabled = true;
    try {
      await cam.triggerAF();
      const dist = cam.getSettings().focusDistance;
      const focusCap = cam.getCapabilities().focusDistance;
      if (dist != null) _updateFocusDistUI(dist, focusCap);
      showToast('Autofocus triggered', 'info');
    } catch (e) {
      showToast('AF trigger failed', 'warning');
    } finally {
      this.textContent = 'AF';
      this.disabled = false;
    }
  });

  // ---- Focus zone buttons ----
  document.querySelectorAll('.ap-zone-btn').forEach(btn => {
    btn.addEventListener('click', async function() {
      document.querySelectorAll('.ap-zone-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      await cam.setFocusZone(this.dataset.zone);
    });
  });

  // Film sim / vignette / grain / watermark
  document.getElementById('ctrlFilmSim')?.addEventListener('change', function() { looks.filmSim = this.value; });
  document.getElementById('ctrlVignette')?.addEventListener('input', function() {
    looks.vignetteAmount = parseFloat(this.value);
    document.getElementById('valVignette').textContent = `${this.value}%`;
  });
  document.getElementById('ctrlGrain')?.addEventListener('input', function() {
    looks.grainAmount = parseFloat(this.value);
    document.getElementById('valGrain').textContent = `${this.value}%`;
  });
  document.getElementById('ctrlWatermark')?.addEventListener('change', function() {
    document.getElementById('watermarkText')?.classList.toggle('d-none', !this.checked);
  });
  document.getElementById('watermarkText')?.addEventListener('input', function() {
    looks.watermarkText = this.value;
  });

  // Video
  document.getElementById('btnRecordStart')?.addEventListener('click', startRecording);
  document.getElementById('btnRecordStop')?.addEventListener('click', () => modeCtrl?.stopRecording());

  // Focus stack
  document.getElementById('btnAddLayer')?.addEventListener('click', async () => {
    if (modeCtrl) { const n = await modeCtrl.addFocusLayer(); showToast(`Layer ${n} captured`, 'info'); }
  });
  document.getElementById('btnMergeStack')?.addEventListener('click', async () => {
    try { await modeCtrl?.mergeFocusStack(captureOpts()); showToast('Focus stack merged!', 'success'); }
    catch (e) { showToast('Stack merge failed: ' + e.message, 'danger'); }
  });
  document.getElementById('btnClearStack')?.addEventListener('click', () => modeCtrl?.clearFocusStack());

  // Pinhole measure
  document.getElementById('btnMeasureSubject')?.addEventListener('click', () => {
    bootstrap.Modal.getInstance(document.getElementById('calculatorModal'))?.hide();
    overlays.startPinholeMeasure();
    showToast('Tap two points on the viewfinder to measure subject width', 'info');
    window.addEventListener('ap:pinholePixels', () => {
      new bootstrap.Modal(document.getElementById('calculatorModal')).show();
    }, { once: true });
  });
}

// ---- Shutter ----

async function onShutter() {
  const btn = document.getElementById('btnShutter');
  btn?.classList.add('capturing');
  const opts = captureOpts();

  try {
    switch (currentCaptureMode) {
      case 'single':   await modeCtrl.capturePhoto(opts); break;
      case 'timer3':   await modeCtrl.captureSelfTimer(3, opts); break;
      case 'timer10':  await modeCtrl.captureSelfTimer(10, opts); break;
      case 'burst': {
        const count = parseInt(document.getElementById('burstCount')?.value || 5);
        await modeCtrl.captureBurst(count, opts); break;
      }
      case 'hdr': {
        const brackets  = parseInt(document.getElementById('hdrBrackets')?.value || 3);
        const evSpacing = parseFloat(document.getElementById('hdrEVSpacing')?.value || 1);
        await modeCtrl.captureHDR(brackets, evSpacing, opts); break;
      }
      case 'longexp': {
        const count = parseInt(document.getElementById('longExpCount')?.value || 10);
        const mode  = document.getElementById('longExpMode')?.value || 'average';
        await modeCtrl.captureLongExposure(count, mode, opts); break;
      }
      case 'timelapse': {
        const interval = parseInt(document.getElementById('timelapseInterval')?.value || 5);
        const count    = parseInt(document.getElementById('timelapseCount')?.value || 30);
        modeCtrl.startTimelapse(interval, count, opts);
        showToast(`Timelapse: ${count} frames every ${interval}s`, 'info'); break;
      }
      case 'focusstack': {
        if (modeCtrl) { const n = await modeCtrl.addFocusLayer(); showToast(`Layer ${n} captured`, 'info'); } break;
      }
    }
  } catch (e) {
    console.error('Capture error:', e);
    showToast('Capture failed: ' + e.message, 'danger');
  } finally {
    setTimeout(() => btn?.classList.remove('capturing'), 300);
  }
}

// ---- Video recording ----

async function startRecording() {
  if (!cam.stream || !modeCtrl) return;
  isRecording = true;
  document.getElementById('btnRecordStart')?.classList.add('d-none');
  document.getElementById('btnRecordStop')?.classList.remove('d-none');
  document.getElementById('btnShutter')?.classList.add('recording');

  const videoBlob = await modeCtrl.startRecording(cam.stream);

  isRecording = false;
  document.getElementById('btnRecordStart')?.classList.remove('d-none');
  document.getElementById('btnRecordStop')?.classList.add('d-none');
  document.getElementById('btnShutter')?.classList.remove('recording');

  if (videoBlob) {
    await gallery.save(videoBlob, 'video', { source: 'MediaRecorder' });
    showToast('Video saved', 'success');
  }
}

// ---- Mode switching ----

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.ap-mode-pill').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-selected', b.dataset.mode === mode);
  });
  document.getElementById('statusMode').textContent = mode.toUpperCase();
  document.getElementById('btnShutter')?.classList.toggle('video-mode', mode === 'video');
  document.getElementById('btnShutter')?.classList.toggle('photo-mode', mode !== 'video');
  document.getElementById('videoControls')?.classList.toggle('d-none', mode !== 'video');
  document.getElementById('captureModeRow')?.classList.toggle('d-none', mode === 'video');
  updateCaptureControls();
}

function updateModeUI(mode, cmode) {
  setMode(mode);
  document.querySelectorAll('.ap-capture-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.cmode === cmode)
  );
  currentCaptureMode = cmode;
  updateCaptureControls();
}

function updateCaptureControls() {
  document.getElementById('focusStackControls')?.classList.toggle('d-none', currentCaptureMode !== 'focusstack');
}

// ---- GPS ----

function startGPS() {
  if (!navigator.geolocation) return;
  gpsWatcher = navigator.geolocation.watchPosition(
    pos => { gpsPosition = { lat: pos.coords.latitude, lng: pos.coords.longitude, altitude: pos.coords.altitude }; },
    err => console.warn('GPS error:', err.message),
    { enableHighAccuracy: true, maximumAge: 30000 }
  );
}

function stopGPS() {
  if (gpsWatcher != null) { navigator.geolocation.clearWatch(gpsWatcher); gpsWatcher = null; }
  gpsPosition = null;
}

// ---- Gallery ----

async function openGallery() {
  document.getElementById('view-camera')?.classList.add('d-none');
  document.getElementById('view-gallery')?.classList.remove('d-none');
  await gallery.render(document.getElementById('galleryGrid'));
}
function closeGallery() {
  document.getElementById('view-gallery')?.classList.add('d-none');
  document.getElementById('view-camera')?.classList.remove('d-none');
}

// ---- Camera error ----

function showCameraError(err) {
  const errEl = document.getElementById('cameraError');
  const msgEl = document.getElementById('cameraErrorMsg');
  if (!errEl) return;
  errEl.classList.remove('d-none');
  if (msgEl) {
    if (err.name === 'NotAllowedError') msgEl.textContent = 'Camera access denied. Allow camera in browser settings and reload.';
    else if (err.name === 'NotFoundError') msgEl.textContent = 'No camera found on this device.';
    else msgEl.textContent = `Camera error: ${err.message}`;
  }
}

// ---- Resolution label ----

function updateResolutionLabel() {
  const sel  = document.getElementById('resolutionSelector');
  const mpEl = document.getElementById('resMP');
  if (!sel || !mpEl) return;
  const caps = cam.getCapabilities();
  const mode = sel.value;
  if (mode === 'fullsensor' && caps.photoWidth?.max && caps.photoHeight?.max) {
    mpEl.textContent = `${((caps.photoWidth.max * caps.photoHeight.max) / 1e6).toFixed(1)} MP`;
  } else if (mode === 'maxvideo' && caps.width?.max && caps.height?.max) {
    mpEl.textContent = `${((caps.width.max * caps.height.max) / 1e6).toFixed(1)} MP`;
  } else {
    mpEl.textContent = '';
  }
}

document.getElementById('resolutionSelector')?.addEventListener('change', updateResolutionLabel);

// ---- Capture options ----

function captureOpts() {
  return {
    resolutionMode: document.getElementById('resolutionSelector')?.value || 'fullsensor',
    format:         document.getElementById('captureFormat')?.value || 'image/jpeg',
    aspect:         document.getElementById('captureAspect')?.value || 'native',
    filmSim:        looks.filmSim,
    vignetteAmount: looks.vignetteAmount,
    grainAmount:    looks.grainAmount,
    watermarkText:  looks.watermarkText,
  };
}

// ---- Update Pro sliders from live settings ----

function updateProUIFromSettings(settings) {
  const fields = [
    ['ctrlExposureCompensation', 'valExposureCompensation', 'exposureCompensation', v => (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1)],
    ['ctrlISO',                  'valISO',                  'iso',                  v => v],
    ['ctrlBrightness',           'valBrightness',           'brightness',           v => v],
    ['ctrlContrast',             'valContrast',             'contrast',             v => v],
    ['ctrlSaturation',           'valSaturation',           'saturation',           v => v],
    ['ctrlSharpness',            'valSharpness',            'sharpness',            v => v],
    ['ctrlColorTemperature',     'valColorTemperature',     'colorTemperature',     v => `${v}K`],
  ];
  for (const [inputId, valId, key, fmt] of fields) {
    const el = document.getElementById(inputId);
    const vl = document.getElementById(valId);
    if (el && settings[key] != null) { el.value = settings[key]; if (vl) vl.textContent = fmt(settings[key]); }
  }
}

// ---- Toast ----

export function showToast(message, type = 'secondary') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icon = { success: 'check-circle', danger: 'exclamation-circle', info: 'info-circle', warning: 'exclamation-triangle' }[type] || 'bell';
  const div = document.createElement('div');
  div.className = `toast align-items-center text-bg-${type} border-0`;
  div.setAttribute('role', 'alert');
  div.setAttribute('aria-live', 'assertive');
  div.innerHTML = `<div class="d-flex"><div class="toast-body d-flex align-items-center gap-2"><i class="bi bi-${icon}"></i> ${message}</div><button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
  container.appendChild(div);
  const toast = new bootstrap.Toast(div, { delay: 2800 });
  toast.show();
  div.addEventListener('hidden.bs.toast', () => div.remove());
}

// ---- Helpers ----

function _capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function _fmtControlVal(cap, val) {
  const fmt = {
    zoom:                 v => `${parseFloat(v).toFixed(1)}×`,
    colorTemperature:     v => `${v}K`,
    focusDistance:        v => formatFocusDist(normToMetres(parseFloat(v), cam.getCapabilities().focusDistance)),
    exposureCompensation: v => (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1),
  };
  return (fmt[cap] || (v => v))(val);
}

// ---- iOS orientation permission ----
document.querySelector('[data-overlay="level"]')?.addEventListener('click', async () => {
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    try { await DeviceOrientationEvent.requestPermission(); } catch (_) {}
  }
}, { once: true });

// ---- Start ----
init().catch(e => { console.error('App init failed:', e); showCameraError(e); });
