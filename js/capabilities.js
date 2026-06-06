/**
 * capabilities.js — feature detection and UI binding.
 *
 * Reads track.getCapabilities() output and:
 * - Enables/configures range inputs (data-cap="constraintName")
 * - Enables/configures selects
 * - Reports capability tier
 * - Returns a structured tier object for banner display
 */

const RANGE_CAPS = [
  'exposureCompensation',
  'iso',
  'brightness',
  'contrast',
  'saturation',
  'sharpness',
  'focusDistance',
  'zoom',
  'colorTemperature',
];

const SELECT_CAPS = [
  'focusMode',
  'whiteBalanceMode',
];

export function bindCapabilities(caps, settings, numDevices = 1) {
  // Range controls
  for (const name of RANGE_CAPS) {
    const cap = caps[name];
    const el  = document.querySelector(`[data-cap="${name}"]`);
    if (!el) continue;

    if (cap && typeof cap === 'object' && 'min' in cap && 'max' in cap) {
      el.min   = cap.min;
      el.max   = cap.max;
      el.step  = cap.step ?? ((cap.max - cap.min) / 100);
      el.value = settings[name] ?? cap.min;
      el.disabled = false;
      el.closest('.ap-ctrl-group')?.classList.remove('d-none');
    } else {
      el.disabled = true;
    }
  }

  // Select controls
  for (const name of SELECT_CAPS) {
    const cap = caps[name];
    const el  = document.querySelector(`[data-cap="${name}"]`);
    if (!el) continue;

    if (Array.isArray(cap) && cap.length > 0) {
      el.innerHTML = cap.map(v => `<option value="${v}">${_label(v)}</option>`).join('');
      el.value = settings[name] ?? cap[0];
      el.disabled = false;
    } else {
      el.disabled = true;
    }
  }

  // Torch
  const torchBtn = document.getElementById('btnTorch');
  if (torchBtn) {
    if (caps.torch === true) {
      torchBtn.classList.remove('d-none');
    } else {
      torchBtn.classList.add('d-none');
    }
  }

  // Show colorTemperature group only in manual WB mode
  const wbModeSelect = document.getElementById('ctrlWhiteBalanceMode');
  if (wbModeSelect) {
    wbModeSelect.addEventListener('change', () => {
      const grp = document.getElementById('grpColorTemperature');
      if (grp) {
        grp.classList.toggle('d-none', wbModeSelect.value !== 'manual');
      }
    });
  }

  return detectTier(caps, numDevices);
}

export function detectTier(caps, numVideoDevices = 1) {
  const hasImageCapture = 'ImageCapture' in window;
  const hasConstraints  = Object.keys(caps).length > 0;
  const hasMediaRecorder= typeof MediaRecorder !== 'undefined';
  const hasDeviceOrientation = 'DeviceOrientationEvent' in window;
  const hasShare        = !!navigator.share;
  const hasGeoLocation  = 'geolocation' in navigator;
  const hasZoom         = !!(caps.zoom);
  const hasISO          = !!(caps.iso);
  const hasTorch        = caps.torch === true;
  const hasFocusDist    = !!(caps.focusDistance);
  const hasMultipleLenses = numVideoDevices > 1;
  const opticalZoomMax  = caps.zoom?.max ?? 1;

  let tier;
  if (!hasImageCapture) tier = 'C';
  else if (!hasConstraints) tier = 'B';
  else tier = 'A';

  return {
    tier,
    hasImageCapture,
    hasConstraints,
    hasMediaRecorder,
    hasDeviceOrientation,
    hasShare,
    hasGeoLocation,
    hasZoom,
    hasISO,
    hasTorch,
    hasFocusDist,
    hasMultipleLenses,
    opticalZoomMax,
    numVideoDevices,
  };
}

/**
 * Estimate optical zoom snap points from the zoom capability range.
 * Returns sorted array of zoom values at likely optical transitions.
 */
export function estimateOpticalSnaps(zoomCap) {
  if (!zoomCap || !zoomCap.max) return [1];
  const max = zoomCap.max;
  const candidates = [0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 20.0, 30.0];
  return candidates.filter(z => z <= max * 1.02);
}

export function renderTierBanner(tierInfo) {
  const banner = document.getElementById('tierBanner');
  const text   = document.getElementById('tierText');
  if (!banner || !text) return;

  if (tierInfo.tier === 'A') {
    banner.classList.add('d-none');
    return;
  }

  if (tierInfo.tier === 'C') {
    text.textContent =
      'Limited device: no ImageCapture API. Preview-frame capture only; Pro controls unavailable. ' +
      'For full features use Chrome/Edge on Android.';
    banner.classList.remove('d-none');
  } else if (tierInfo.tier === 'B') {
    text.textContent =
      'Partial support: ImageCapture available but advanced hardware controls are limited.';
    banner.classList.remove('d-none');
  }
}

export function renderCapabilityReport(caps, settings, tier) {
  const pre = document.getElementById('capabilityDetails');
  const sum = document.getElementById('tierSummary');
  if (!pre) return;

  pre.textContent = JSON.stringify({ capabilities: caps, settings }, null, 2);

  if (sum) {
    const badges = [
      ['ImageCapture', tier.hasImageCapture],
      ['MediaRecorder', tier.hasMediaRecorder],
      ['Zoom', tier.hasZoom],
      ['ISO', tier.hasISO],
      ['Torch', tier.hasTorch],
      ['Manual Focus', tier.hasFocusDist],
      ['Multi-lens', tier.hasMultipleLenses],
      ['Web Share', tier.hasShare],
      ['GPS', tier.hasGeoLocation],
    ];
    sum.innerHTML = `<p class="mb-2 text-secondary small">Device Tier: <strong class="text-white">Tier ${tier.tier}</strong></p>` +
      badges.map(([label, ok]) =>
        `<span class="badge me-1 mb-1 ${ok ? 'text-bg-success' : 'text-bg-secondary'}">${ok ? '✓' : '✗'} ${label}</span>`
      ).join('');
  }
}

function _label(v) {
  const map = {
    auto: 'Auto',
    manual: 'Manual',
    'single-shot': 'Single Shot',
    continuous: 'Continuous',
    daylight: 'Daylight',
    'cloudy-daylight': 'Cloudy',
    tungsten: 'Tungsten',
    fluorescent: 'Fluorescent',
    shade: 'Shade',
    'flash': 'Flash',
  };
  return map[v] || v;
}
