/**
 * calculator.js — pure lens & exposure calculation functions.
 * No imports, no side effects.
 *
 * Units: focal length mm, distance m, sensor width mm, aperture (f-number).
 * Default circle of confusion (CoC) is 0.029 mm for full-frame 35 mm.
 */

/** Hyperfocal distance in metres. */
export function hyperfocalDistance(fMM, N, cMM = 0.029) {
  return (fMM * fMM) / (N * cMM * 1000) + fMM / 1000;
}

/**
 * Depth of field.
 * @returns { near, far, total, isInfinite } in metres
 */
export function depthOfField(fMM, N, uM, cMM = 0.029) {
  const f = fMM / 1000; // metres
  const c = cMM / 1000;
  const H = (fMM * fMM) / (N * cMM * 1000) + f; // hyperfocal in m

  const near = (uM * (H - f)) / (H + uM - 2 * f);
  const far  = uM >= H
    ? Infinity
    : (uM * (H - f)) / (H - uM);

  const total = far === Infinity ? Infinity : far - near;
  return {
    near:       Math.max(0, near),
    far:        far,
    total:      total,
    isInfinite: uM >= H,
  };
}

/** Angle of view (diagonal) in degrees for given focal length and sensor width. */
export function angleOfView(fMM, sensorWMM = 36) {
  return 2 * Math.atan(sensorWMM / (2 * fMM)) * (180 / Math.PI);
}

/** Frame width (in metres) at subject distance for given angle-of-view. */
export function frameWidthAtDistance(aovDeg, distanceM) {
  return 2 * distanceM * Math.tan((aovDeg * Math.PI / 180) / 2);
}

/** Image magnification (image size / object size) at given distance. */
export function magnification(fMM, uM) {
  const f = fMM / 1000;
  return f / (uM - f);
}

/** Full-frame equivalent focal length. */
export function fullFrameEquiv(fMM, cropFactor) {
  return fMM * cropFactor;
}

/**
 * Exposure value at ISO 100.
 * EV = log2(N² / t) — log2(ISO / 100)
 */
export function ev100(N, tSec, ISO = 100) {
  if (tSec <= 0 || N <= 0) return null;
  return Math.log2((N * N) / tSec) - Math.log2(ISO / 100);
}

/** Human label for an EV₁₀₀ value (sunny-16 rule). */
export function sunnyLabel(ev100val) {
  const labels = {
    16: 'Full sun (Sunny-16)',
    15: 'Slightly hazy sun',
    14: 'Hazy / Bright overcast',
    13: 'Overcast',
    12: 'Heavy overcast / Open shade',
    11: 'Deep shade',
    10: 'Twilight',
     9: 'Deep dusk',
     8: 'Bright indoor / Neon',
     7: 'Indoor average',
  };
  const rounded = Math.round(ev100val);
  return labels[rounded] ?? `EV ${ev100val.toFixed(1)}`;
}

/**
 * Maximum shutter speed to avoid star trailing (500 rule).
 * @returns seconds
 */
export function maxShutter500Rule(focalMM, cropFactor = 1) {
  return 500 / (focalMM * cropFactor);
}

/**
 * New exposure time with an ND filter.
 * @param baseShutterSec  base exposure in seconds
 * @param ndStops         ND filter strength in stops (e.g. 10 for ND1000)
 * @returns seconds
 */
export function ndFilterExposure(baseShutterSec, ndStops) {
  return baseShutterSec * Math.pow(2, ndStops);
}

/**
 * Estimate distance to a subject using angular size.
 * @param apparentSizePx  measured pixel span of subject in the frame
 * @param realSizeMM      real physical size of subject in mm
 * @param fovDeg          horizontal field of view of the camera in degrees
 * @param imagePxWidth    full image width in pixels
 * @returns estimated distance in metres
 */
export function pinholeDistance(apparentSizePx, realSizeMM, fovDeg, imagePxWidth) {
  if (!apparentSizePx || !realSizeMM || !fovDeg || !imagePxWidth) return null;
  const pixelAngleDeg = fovDeg / imagePxWidth;
  const angularSizeRad = (apparentSizePx * pixelAngleDeg) * (Math.PI / 180);
  return (realSizeMM / 1000) / (2 * Math.tan(angularSizeRad / 2));
}

// ---- UI helpers ----

/** Format a distance in metres to a readable string. */
export function fmtDistance(m) {
  if (!isFinite(m) || m == null) return '∞';
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1)    return `${m.toFixed(2)} m`;
  return `${(m * 100).toFixed(1)} cm`;
}

/** Format seconds to a readable shutter string. */
export function fmtShutter(sec) {
  if (sec == null) return '—';
  if (sec >= 1) return `${sec.toFixed(sec >= 10 ? 0 : 1)}s`;
  return `1/${Math.round(1 / sec)}`;
}

/** Recalculate all outputs and update the DOM. */
export function updateCalculator() {
  const focal     = parseFloat(document.getElementById('calcFocal')?.value    || 50);
  const aperture  = parseFloat(document.getElementById('calcAperture')?.value || 1.8);
  const distance  = parseFloat(document.getElementById('calcDistance')?.value || 2);
  const crop      = parseFloat(document.getElementById('calcCrop')?.value     || 1);
  const iso       = parseFloat(document.getElementById('calcISO')?.value      || 100);
  const shutter   = parseFloat(document.getElementById('calcShutter')?.value  || 0.01);
  const ndStops   = parseFloat(document.getElementById('calcND')?.value       || 0);
  const subjMM    = parseFloat(document.getElementById('calcSubjectMM')?.value|| 1800);

  // CoC scales with crop factor
  const coc  = 0.029 / crop;
  const hyp  = hyperfocalDistance(focal, aperture, coc * 1000);
  const dof  = depthOfField(focal, aperture, distance, coc * 1000);
  const aov  = angleOfView(focal, 36 / crop);
  const fw   = frameWidthAtDistance(aov, distance);
  const mag  = magnification(focal, distance);
  const ffe  = fullFrameEquiv(focal, crop);
  const evVal= ev100(aperture, shutter, iso);
  const m500 = maxShutter500Rule(focal, crop);
  const ndExp= ndFilterExposure(shutter, ndStops);

  _set('rHyperfocal', fmtDistance(hyp));
  _set('rNear',       fmtDistance(dof.near));
  _set('rFar',        dof.isInfinite ? '∞' : fmtDistance(dof.far));
  _set('rTotalDoF',   dof.isInfinite ? '∞' : fmtDistance(dof.total));
  _set('rAoV',        `${aov.toFixed(1)}°`);
  _set('rFrameWidth', `${fw.toFixed(2)} m`);
  _set('rMagnification', `1:${(1 / Math.max(mag, 0.0001)).toFixed(1)}`);
  _set('rFFEquiv',    `${ffe.toFixed(1)} mm`);
  _set('rEV100',      evVal != null ? evVal.toFixed(1) : '—');
  _set('rSunny',      evVal != null ? sunnyLabel(evVal) : '—');
  _set('r500Rule',    fmtShutter(m500));
  _set('rNDExp',      fmtShutter(ndExp));

  // Pinhole — needs pixel measurement
  const pixels = parseFloat(window._pinholePixelSpan || 0);
  if (pixels > 0) {
    const video = document.getElementById('preview');
    const vw    = video?.videoWidth || 1280;
    const fovD  = aov;
    const dist  = pinholeDistance(pixels, subjMM, fovD, vw);
    _set('rPinholeDistance', dist != null ? fmtDistance(dist) : '—');
  }
}

function _set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
