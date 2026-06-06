/**
 * app.js — Aperture entry point.
 * Imports all modules and wires UI events.
 */

import { CameraManager }   from './camera.js';
import { captureFrame }    from './capture.js';
import { bindCapabilities, detectTier, renderTierBanner, renderCapabilityReport } from './capabilities.js';
import { ModeController }  from './modes.js';
import { OverlayManager }  from './overlays.js';
import { buildExifStr, injectExif } from './exif.js';
import { GalleryManager }  from './gallery.js';
import { updateCalculator } from './calculator.js';

// ---- State ----
const cam      = new CameraManager();
const overlays = new OverlayManager();
const gallery  = new GalleryManager();
let modeCtrl   = null;
let tierInfo   = {};

let currentMode        = 'photo';  // photo | pro | video
let currentCaptureMode = 'single'; // single | timer3 | timer10 | burst | hdr | longexp | timelapse | focusstack
let gpsEnabled         = false;
let gpsPosition        = null;
let gpsWatcher         = null;
let isRecording        = false;
let looks              = { filmSim: 'none', vignetteAmount: 0, grainAmount: 0, watermarkText: '' };

// ---- Init ----

async function init() {
  await gallery.init();

  // Register service worker
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

  // Calculator live update
  document.querySelectorAll('#calculatorModal input').forEach(el =>
    el.addEventListener('input', updateCalculator)
  );
  updateCalculator();

  // Pinhole pixel span from overlay measurement
  window.addEventListener('ap:pinholePixels', e => {
    window._pinholePixelSpan = e.detail.pixels;
    updateCalculator();
  });
}

function onCameraReady() {
  document.getElementById('cameraError')?.classList.add('d-none');
  document.getElementById('preview')?.classList.remove('d-none');

  const caps     = cam.getCapabilities();
  const settings = cam.getSettings();
  tierInfo = bindCapabilities(caps, settings);

  renderTierBanner(tierInfo);

  modeCtrl = new ModeController(cam, onCapture);

  updateResolutionLabel();
  updateModeUI('photo', 'single');
  updateProUIFromSettings(settings);

  // Hide Video tab if MediaRecorder unavailable
  if (!tierInfo.hasMediaRecorder) {
    document.getElementById('modeVideo')?.classList.add('d-none');
  }
}

// ---- Capture callback ----

async function onCapture(blob, mode, metadata) {
  let finalBlob = blob;

  // EXIF (JPEG only)
  if (blob.type === 'image/jpeg' || !blob.type) {
    const settings = cam.getSettings();
    const gps = gpsEnabled ? gpsPosition : null;
    const exifStr = buildExifStr({
      settings: {
        iso:         settings.iso,
        fNumber:     settings.fNumber,
        focalLength: settings.focalLength,
        width:       metadata.megapixels ? undefined : undefined,
      },
      gps,
      timestamp: new Date(),
    });
    if (exifStr) {
      finalBlob = await injectExif(blob, exifStr);
    }
  }

  await gallery.save(finalBlob, mode, metadata);

  const mpText = metadata.megapixels ? `${metadata.megapixels} MP` : '';
  const src    = metadata.source     ? `(${metadata.source})`      : '';
  showToast(`Saved — ${mpText} ${src}`.trim(), 'success');

  document.getElementById('statusMP')?.setAttribute('textContent', mpText);
  document.getElementById('statusSource')?.setAttribute('textContent', src);
}

// ---- UI bindings ----

function setupUIBindings() {
  // Shutter
  document.getElementById('btnShutter')?.addEventListener('click', onShutter);

  // Switch camera
  document.getElementById('btnSwitchCamera')?.addEventListener('click', async () => {
    try {
      await cam.switchCamera();
      onCameraReady();
    } catch (e) {
      showToast('Camera switch failed', 'danger');
    }
  });

  // Retry camera
  document.getElementById('btnRetryCamera')?.addEventListener('click', async () => {
    try {
      await cam.start(document.getElementById('preview'));
      onCameraReady();
    } catch (e) {
      showCameraError(e);
    }
  });

  // Mode pills
  document.querySelectorAll('.ap-mode-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      setMode(mode);
    });
  });

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
    if (gpsEnabled) startGPS();
    else stopGPS();
  });

  // Pro offcanvas trigger
  document.getElementById('btnOpenPro')?.addEventListener('click', () => {
    const bsOff = new bootstrap.Offcanvas(document.getElementById('proOffcanvas'));
    bsOff.show();
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
      const name   = this.dataset.overlay;
      const active = overlays.toggle(name);
      this.classList.toggle('active', active);
    });
  });

  // Pro control ranges
  document.querySelectorAll('[data-cap]').forEach(el => {
    if (el.tagName === 'INPUT') {
      el.addEventListener('input', () => {
        const valEl = document.getElementById(`val${_capitalise(el.dataset.cap)}`);
        if (valEl) valEl.textContent = _fmtControlVal(el.dataset.cap, el.value);
        cam.applyConstraint(el.dataset.cap, parseFloat(el.value));
      });
    }
    if (el.tagName === 'SELECT') {
      el.addEventListener('change', () => {
        cam.applyConstraint(el.dataset.cap, el.value);
        // Show/hide colorTemperature for WB manual mode
        if (el.dataset.cap === 'whiteBalanceMode') {
          document.getElementById('grpColorTemperature')?.classList.toggle('d-none', el.value !== 'manual');
        }
      });
    }
  });

  // WB presets
  document.querySelectorAll('.ap-wb-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const wb = btn.dataset.wb;
      const sel = document.getElementById('ctrlWhiteBalanceMode');
      if (sel && !sel.disabled) {
        sel.value = wb;
        cam.applyConstraint('whiteBalanceMode', wb);
      }
    });
  });

  // Auto ISO checkbox
  document.getElementById('autoISO')?.addEventListener('change', function() {
    const ctrl = document.getElementById('ctrlISO');
    if (ctrl) ctrl.disabled = this.checked;
    if (this.checked) cam.applyConstraint('iso', 'auto').catch(() => {});
  });

  // Film sim
  document.getElementById('ctrlFilmSim')?.addEventListener('change', function() {
    looks.filmSim = this.value;
  });

  // Vignette
  document.getElementById('ctrlVignette')?.addEventListener('input', function() {
    looks.vignetteAmount = parseFloat(this.value);
    document.getElementById('valVignette').textContent = `${this.value}%`;
  });

  // Grain
  document.getElementById('ctrlGrain')?.addEventListener('input', function() {
    looks.grainAmount = parseFloat(this.value);
    document.getElementById('valGrain').textContent = `${this.value}%`;
  });

  // Watermark
  document.getElementById('ctrlWatermark')?.addEventListener('change', function() {
    document.getElementById('watermarkText')?.classList.toggle('d-none', !this.checked);
  });
  document.getElementById('watermarkText')?.addEventListener('input', function() {
    looks.watermarkText = this.value;
  });

  // Video record
  document.getElementById('btnRecordStart')?.addEventListener('click', startRecording);
  document.getElementById('btnRecordStop')?.addEventListener('click', () => {
    if (modeCtrl) modeCtrl.stopRecording();
  });

  // Focus stack
  document.getElementById('btnAddLayer')?.addEventListener('click', async () => {
    if (modeCtrl) {
      const n = await modeCtrl.addFocusLayer();
      showToast(`Layer ${n} captured`, 'info');
    }
  });
  document.getElementById('btnMergeStack')?.addEventListener('click', async () => {
    if (modeCtrl) {
      try {
        await modeCtrl.mergeFocusStack(captureOpts());
        showToast('Focus stack merged!', 'success');
      } catch (e) {
        showToast('Stack merge failed: ' + e.message, 'danger');
      }
    }
  });
  document.getElementById('btnClearStack')?.addEventListener('click', () => {
    if (modeCtrl) modeCtrl.clearFocusStack();
  });

  // Pinhole measure button
  document.getElementById('btnMeasureSubject')?.addEventListener('click', () => {
    new bootstrap.Modal(document.getElementById('calculatorModal')).hide();
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
      case 'single':
        await modeCtrl.capturePhoto(opts);
        break;
      case 'timer3':
        await modeCtrl.captureSelfTimer(3, opts);
        break;
      case 'timer10':
        await modeCtrl.captureSelfTimer(10, opts);
        break;
      case 'burst': {
        const count = parseInt(document.getElementById('burstCount')?.value || 5);
        await modeCtrl.captureBurst(count, opts);
        break;
      }
      case 'hdr': {
        const brackets   = parseInt(document.getElementById('hdrBrackets')?.value || 3);
        const evSpacing  = parseFloat(document.getElementById('hdrEVSpacing')?.value || 1);
        await modeCtrl.captureHDR(brackets, evSpacing, opts);
        break;
      }
      case 'longexp': {
        const count = parseInt(document.getElementById('longExpCount')?.value || 10);
        const mode  = document.getElementById('longExpMode')?.value || 'average';
        await modeCtrl.captureLongExposure(count, mode, opts);
        break;
      }
      case 'timelapse': {
        const interval = parseInt(document.getElementById('timelapseInterval')?.value || 5);
        const count    = parseInt(document.getElementById('timelapseCount')?.value || 30);
        modeCtrl.startTimelapse(interval, count, opts);
        showToast(`Timelapse started: ${count} frames every ${interval}s`, 'info');
        break;
      }
      case 'focusstack':
        // Focus stack uses explicit Add Layer button, shutter = add layer
        if (modeCtrl) {
          const n = await modeCtrl.addFocusLayer();
          showToast(`Layer ${n} captured`, 'info');
        }
        break;
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

  const shutterBtn = document.getElementById('btnShutter');
  shutterBtn?.classList.toggle('video-mode', mode === 'video');
  shutterBtn?.classList.toggle('photo-mode', mode !== 'video');

  document.getElementById('videoControls')?.classList.toggle('d-none', mode !== 'video');
  document.getElementById('captureModeRow')?.classList.toggle('d-none', mode === 'video');

  // Focus stack controls shown when cmode=focusstack
  updateCaptureControls();
}

function updateModeUI(mode, cmode) {
  setMode(mode);
  document.querySelectorAll('.ap-capture-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.cmode === cmode);
  });
  currentCaptureMode = cmode;
  updateCaptureControls();
}

function updateCaptureControls() {
  document.getElementById('focusStackControls')?.classList.toggle(
    'd-none',
    currentCaptureMode !== 'focusstack'
  );
}

// ---- GPS ----

function startGPS() {
  if (!navigator.geolocation) return;
  gpsWatcher = navigator.geolocation.watchPosition(
    pos => {
      gpsPosition = {
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        altitude: pos.coords.altitude,
      };
    },
    err => console.warn('GPS error:', err.message),
    { enableHighAccuracy: true, maximumAge: 30000 }
  );
}

function stopGPS() {
  if (gpsWatcher != null) {
    navigator.geolocation.clearWatch(gpsWatcher);
    gpsWatcher = null;
  }
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
  const errEl  = document.getElementById('cameraError');
  const msgEl  = document.getElementById('cameraErrorMsg');
  if (!errEl) return;
  errEl.classList.remove('d-none');
  if (msgEl) {
    if (err.name === 'NotAllowedError') {
      msgEl.textContent = 'Camera access denied. Please allow camera permission in your browser settings and reload.';
    } else if (err.name === 'NotFoundError') {
      msgEl.textContent = 'No camera found on this device.';
    } else {
      msgEl.textContent = `Camera error: ${err.message}`;
    }
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
    const mp = ((caps.photoWidth.max * caps.photoHeight.max) / 1e6).toFixed(1);
    mpEl.textContent = `${mp} MP`;
  } else if (mode === 'maxvideo' && caps.width?.max && caps.height?.max) {
    const mp = ((caps.width.max * caps.height.max) / 1e6).toFixed(1);
    mpEl.textContent = `${mp} MP`;
  } else {
    mpEl.textContent = '';
  }
}

document.getElementById('resolutionSelector')?.addEventListener('change', updateResolutionLabel);

// ---- captureOpts from current UI state ----

function captureOpts() {
  const resSel = document.getElementById('resolutionSelector')?.value || 'fullsensor';
  const format = document.getElementById('captureFormat')?.value || 'image/jpeg';
  const aspect = document.getElementById('captureAspect')?.value || 'native';
  return {
    resolutionMode: resSel,
    format,
    aspect,
    filmSim:        looks.filmSim,
    vignetteAmount: looks.vignetteAmount,
    grainAmount:    looks.grainAmount,
    watermarkText:  looks.watermarkText,
  };
}

// ---- Update Pro sliders from camera settings ----

function updateProUIFromSettings(settings) {
  const fields = [
    ['ctrlExposureCompensation', 'valExposureCompensation', 'exposureCompensation', v => v],
    ['ctrlISO',                  'valISO',                  'iso',                  v => v],
    ['ctrlBrightness',           'valBrightness',           'brightness',           v => v],
    ['ctrlContrast',             'valContrast',             'contrast',             v => v],
    ['ctrlSaturation',           'valSaturation',           'saturation',           v => v],
    ['ctrlSharpness',            'valSharpness',            'sharpness',            v => v],
    ['ctrlZoom',                 'valZoom',                 'zoom',                 v => `${parseFloat(v).toFixed(1)}×`],
    ['ctrlFocusDistance',        'valFocusDistance',        'focusDistance',        v => parseFloat(v).toFixed(2)],
    ['ctrlColorTemperature',     'valColorTemperature',     'colorTemperature',     v => `${v}K`],
  ];
  for (const [inputId, valId, key, fmt] of fields) {
    const el = document.getElementById(inputId);
    const vl = document.getElementById(valId);
    if (el && settings[key] != null) {
      el.value = settings[key];
      if (vl) vl.textContent = fmt(settings[key]);
    }
  }
}

// ---- Toast ----

export function showToast(message, type = 'secondary') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const id = `toast_${Date.now()}`;
  const icon = { success: 'check-circle', danger: 'exclamation-circle', info: 'info-circle', warning: 'exclamation-triangle' }[type] || 'bell';
  const div = document.createElement('div');
  div.id = id;
  div.className = `toast align-items-center text-bg-${type} border-0`;
  div.setAttribute('role', 'alert');
  div.setAttribute('aria-live', 'assertive');
  div.innerHTML = `
    <div class="d-flex">
      <div class="toast-body d-flex align-items-center gap-2">
        <i class="bi bi-${icon}"></i> ${message}
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(div);
  const toast = new bootstrap.Toast(div, { delay: 2800 });
  toast.show();
  div.addEventListener('hidden.bs.toast', () => div.remove());
}

// ---- Helpers ----

function _capitalise(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function _fmtControlVal(cap, val) {
  const fmt = {
    zoom:              v => `${parseFloat(v).toFixed(1)}×`,
    colorTemperature:  v => `${v}K`,
    focusDistance:     v => parseFloat(v).toFixed(2),
    exposureCompensation: v => (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1),
  };
  return (fmt[cap] || (v => v))(val);
}

// ---- iOS orientation permission ----

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') console.warn('Orientation permission denied');
    } catch (e) {
      console.warn('Orientation permission error:', e);
    }
  }
}

document.querySelector('[data-overlay="level"]')?.addEventListener('click', requestOrientationPermission, { once: true });

// ---- Start ----
init().catch(e => {
  console.error('App init failed:', e);
  showCameraError(e);
});
