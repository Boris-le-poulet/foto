/**
 * lens.js — multi-lens enumeration, optical zoom snap points, pinch-to-zoom,
 * focus-distance-to-metres conversion, and per-lens metadata.
 *
 * Spec data tuned for Pixel 8 Pro (UW 0.5× · Wide 1× · Telephoto 5× + 30× Super Res).
 * Degrades gracefully on any device.
 */

// ---- Lens profiles keyed by approximate zoom multiplier ----
// aperture / sensor / minFocusCm / macro from Pixel 8 Pro spec where applicable.
const LENS_PROFILES = [
  { mult: 0.5,  name: 'Ultrawide', shortName: 'UW',   fov: '125°', focalEquiv: 12,  aperture: 'f/1.95', sensor: '48MP Sony',    minFocusCm: 2,   macro: true,  icon: 'bi-camera-reels'    },
  { mult: 0.6,  name: 'Ultrawide', shortName: 'UW',   fov: '110°', focalEquiv: 14,  aperture: '—',      sensor: '—',           minFocusCm: 3,   macro: false, icon: 'bi-camera-reels'    },
  { mult: 0.7,  name: 'Ultrawide', shortName: 'UW',   fov: '96°',  focalEquiv: 17,  aperture: '—',      sensor: '—',           minFocusCm: 4,   macro: false, icon: 'bi-camera-reels'    },
  { mult: 1.0,  name: 'Wide',      shortName: 'Wide', fov: '82°',  focalEquiv: 24,  aperture: 'f/1.68', sensor: '50MP Samsung', minFocusCm: 5,   macro: false, icon: 'bi-camera'          },
  { mult: 1.5,  name: '1.5×',      shortName: '1.5×', fov: '60°',  focalEquiv: 36,  aperture: '—',      sensor: '—',           minFocusCm: 8,   macro: false, icon: 'bi-camera'          },
  { mult: 2.0,  name: '2× Crop',   shortName: '2×',   fov: '50°',  focalEquiv: 48,  aperture: 'f/1.68', sensor: '50MP crop',   minFocusCm: 10,  macro: false, icon: 'bi-camera'          },
  { mult: 3.0,  name: '3×',        shortName: '3×',   fov: '32°',  focalEquiv: 72,  aperture: '—',      sensor: '—',           minFocusCm: 20,  macro: false, icon: 'bi-binoculars'      },
  { mult: 5.0,  name: 'Telephoto', shortName: 'Tele', fov: '30°',  focalEquiv: 120, aperture: 'f/2.8',  sensor: '48MP Samsung', minFocusCm: 25,  macro: false, icon: 'bi-binoculars-fill' },
  { mult: 10.0, name: '10× SRZ',   shortName: '10×',  fov: '13°',  focalEquiv: 240, aperture: 'f/2.8',  sensor: '48MP+SRZ',    minFocusCm: 100, macro: false, icon: 'bi-binoculars-fill' },
  { mult: 20.0, name: '20× SRZ',   shortName: '20×',  fov: '7°',   focalEquiv: 480, aperture: 'f/2.8',  sensor: '48MP+SRZ',    minFocusCm: 200, macro: false, icon: 'bi-binoculars-fill' },
  { mult: 30.0, name: '30× SRZ',   shortName: '30×',  fov: '5°',   focalEquiv: 720, aperture: 'f/2.8',  sensor: '48MP+SRZ',    minFocusCm: 300, macro: false, icon: 'bi-binoculars-fill' },
];

function nearestProfile(zoom) {
  return LENS_PROFILES.reduce((best, p) =>
    Math.abs(p.mult - zoom) < Math.abs(best.mult - zoom) ? p : best
  );
}

// ---- LensManager ----

export class LensManager {
  constructor() {
    this.allDevices       = [];
    this.activeDeviceId   = null;
    this.activeFacing     = 'environment';
    this.zoomSnaps        = [1];
    this.opticalMax       = 1;
    this.trueOpticalMults = [1];   // physical-lens transitions only (no in-sensor crops)
    this._zoomCap         = null;
    this._currentZoom     = 1;
    this._pinchStart      = null;
    this._wheelDebounce   = null;
    this.onZoomChange     = null;
  }

  /**
   * Enumerate all video input devices.
   * Must be called after getUserMedia() so labels are populated.
   */
  async enumerateAll() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.allDevices = devices.filter(d => d.kind === 'videoinput');
    } catch (_) {
      this.allDevices = [];
    }
    return this.allDevices;
  }

  /**
   * Return devices for the given facing mode.
   */
  facingDevices(facing = 'environment') {
    const isBack = facing === 'environment';
    return this.allDevices.filter(d => {
      if (!d.label) return true;
      const l = d.label.toLowerCase();
      return isBack
        ? (l.includes('back') || l.includes('rear') || l.includes('environment') || l.includes('facing back'))
        : (l.includes('front') || l.includes('user') || l.includes('selfie') || l.includes('facing front'));
    });
  }

  /**
   * Parse a device label to extract a display name and estimated focal multiplier.
   * Handles Pixel 8 Pro labels explicitly.
   */
  parseDevice(device, indexAmongFacing) {
    const label = (device.label || '').toLowerCase();

    // Pixel 8 Pro: "Back 5x Optical Zoom Camera"
    const pixelOptical = label.match(/back\s+(\d+\.?\d*)\s*[×x]\s+optical/i);
    if (pixelOptical) return _deviceMeta(device, parseFloat(pixelOptical[1]), indexAmongFacing);

    // Generic explicit multiplier in label: "0.6x", "3×", etc.
    const multMatch = label.match(/(\d+\.?\d*)\s*[×x]/i);
    if (multMatch) {
      const mult = parseFloat(multMatch[1]);
      // Reject implausible values (timestamps, serial numbers, etc.)
      if (mult >= 0.3 && mult <= 30) return _deviceMeta(device, mult, indexAmongFacing);
    }

    // Keyword hints
    if (/ultra[-\s]?wide/i.test(label))         return _deviceMeta(device, 0.5, indexAmongFacing);
    if (/periscope/i.test(label))                return _deviceMeta(device, 5,   indexAmongFacing);
    if (/tele(?:photo)?/i.test(label))           return _deviceMeta(device, 3,   indexAmongFacing);
    if (/macro/i.test(label))                    return _deviceMeta(device, 1,   indexAmongFacing, 'Macro');
    if (/wide/i.test(label))                     return _deviceMeta(device, 1,   indexAmongFacing);

    // camera2 N — Pixel 8 Pro back IDs: 0=Wide, 2=UW, 3=Tele (1=front, excluded earlier)
    const idxMatch = label.match(/camera\d*\s+(\d+)/i);
    if (idxMatch) {
      const hw = parseInt(idxMatch[1]);
      const pixelMap = { 0: 1.0, 2: 0.5, 3: 5.0 };
      const genericFallback = [1.0, 0.5, 2.0, 5.0];
      const guessedMult = pixelMap[hw] ?? genericFallback[hw] ?? 1.0;
      return _deviceMeta(device, guessedMult, indexAmongFacing);
    }

    // Fallback: single device = wide; second = tele
    return _deviceMeta(device, indexAmongFacing === 0 ? 1.0 : 2.0, indexAmongFacing);
  }

  /**
   * Build parsed lens descriptors for the current facing side,
   * sorted by ascending focal multiplier (wide → tele).
   */
  buildLensList(facing = 'environment') {
    return this.facingDevices(facing)
      .map((d, i) => this.parseDevice(d, i))
      .sort((a, b) => a.mult - b.mult);
  }

  /**
   * Compute zoom snap points and identify true optical transitions.
   * @param {object}   zoomCap       MediaTrackCapabilities.zoom
   * @param {number}   numDevices    count of physical back-camera devices
   * @param {number[]} detectedMults mults from actual physical lenses (from buildLensList)
   */
  buildZoomSnaps(zoomCap, numDevices = 1, detectedMults = []) {
    this._zoomCap = zoomCap;
    if (!zoomCap || !zoomCap.max) {
      this.zoomSnaps        = [1];
      this.opticalMax       = 1;
      this.trueOpticalMults = [1];
      return this.zoomSnaps;
    }

    const max = zoomCap.max;
    const candidates = [0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 20.0, 30.0];
    const snaps = candidates.filter(z => z <= max * 1.02);

    // True optical transitions: physical lenses only (no in-sensor crops)
    if (detectedMults.length > 0) {
      this.trueOpticalMults = detectedMults.filter(m => m <= max * 1.05);
    } else if (numDevices >= 3) {
      const uwMult   = snaps.find(s => s <= 0.7) ?? null;
      const teleMult = snaps.includes(5) ? 5 : snaps.includes(3) ? 3 : snaps.includes(2) ? 2 : null;
      this.trueOpticalMults = [
        ...(uwMult   ? [uwMult]   : []),
        1.0,
        ...(teleMult ? [teleMult] : []),
      ];
    } else if (numDevices === 2) {
      const teleMult = snaps.includes(3) ? 3 : snaps.includes(2) ? 2 : null;
      this.trueOpticalMults = [1.0, ...(teleMult ? [teleMult] : [])];
    } else {
      this.trueOpticalMults = [1.0];
    }

    this.opticalMax = Math.min(Math.max(...this.trueOpticalMults), max);
    this.zoomSnaps  = snaps;
    return snaps;
  }

  /**
   * Classify zoom quality:
   * 'optical'    — at a physical lens snap (crisp hardware transition)
   * 'nearoptical'— in-sensor crop on a high-MP sensor (50MP main up to 2×, 48MP tele up to ~10×)
   * 'digital'    — between lenses, noticeable quality loss
   */
  zoomQuality(zoom) {
    // Exactly at a real physical lens
    if (this.trueOpticalMults.some(m => Math.abs(zoom - m) < 0.15)) return 'optical';

    // In-sensor crop window: high-MP sensor stays clean up to ~2× crop
    for (const m of this.trueOpticalMults) {
      if (zoom > m && zoom <= m * 2.1 + 0.1) return 'nearoptical';
    }

    // At a named snap point that isn't a physical lens (e.g. 2× in-sensor crop)
    if (this.zoomSnaps.some(s => Math.abs(zoom - s) < 0.2)) return 'nearoptical';

    return 'digital';
  }

  /**
   * True when the given multiplier corresponds to the UW macro lens.
   */
  isMacroCapable(mult) {
    const profile = nearestProfile(mult ?? 1);
    return profile.macro === true && Math.abs(profile.mult - (mult ?? 1)) < 0.2;
  }

  setCurrentZoom(z) { this._currentZoom = z; }
  getCurrentZoom()  { return this._currentZoom; }

  /**
   * Attach pinch-to-zoom and scroll-wheel zoom to an element.
   */
  initPinchZoom(el, zoomCap, onZoom) {
    this._zoomCap     = zoomCap;
    this.onZoomChange = onZoom;

    el.addEventListener('touchstart', e => {
      if (e.touches.length === 2) {
        this._pinchStart = { dist: _pinchDist(e), base: this._currentZoom };
        e.preventDefault();
      }
    }, { passive: false });

    el.addEventListener('touchmove', e => {
      if (e.touches.length !== 2 || !this._pinchStart) return;
      e.preventDefault();
      const scale = _pinchDist(e) / this._pinchStart.dist;
      const z = _clampZoom(this._pinchStart.base * scale, zoomCap);
      this._currentZoom = z;
      this._fireZoom(z);
    }, { passive: false });

    el.addEventListener('touchend', e => {
      if (e.touches.length < 2) this._pinchStart = null;
    });

    el.addEventListener('wheel', e => {
      e.preventDefault();
      if (!zoomCap) return;
      const delta = e.deltaY > 0 ? -0.15 : 0.15;
      const z = _clampZoom(this._currentZoom + delta * Math.max(1, this._currentZoom * 0.3), zoomCap);
      this._currentZoom = z;
      this._fireZoom(z);
    }, { passive: false });
  }

  _fireZoom(z) {
    clearTimeout(this._wheelDebounce);
    this._wheelDebounce = setTimeout(() => {
      if (this.onZoomChange) this.onZoomChange(z);
    }, 40);
  }

  snapToNearest(zoom, tolerance = 0.12) {
    const close = this.zoomSnaps.find(s => Math.abs(s - zoom) <= tolerance * Math.max(1, s));
    return close ?? zoom;
  }

  /** FoV estimate using Pixel 8 Pro 1× = 82° reference. */
  estimateFoV(zoom, baseFoVDeg = 82) {
    return Math.max(1, baseFoVDeg / Math.max(0.1, zoom));
  }

  /** 35mm-equivalent focal length using Pixel 8 Pro 1× = 24 mm reference. */
  estimateFocalLength(zoom, baseFocalMM = 24) {
    return Math.round(zoom * baseFocalMM);
  }
}

// ---- Focus distance utilities ----

/**
 * Format a focus distance (metres) to a human string.
 */
export function formatFocusDist(metres) {
  if (metres == null || !isFinite(metres) || metres > 500) return '∞';
  if (metres >= 10)   return `${metres.toFixed(0)} m`;
  if (metres >= 1)    return `${metres.toFixed(1)} m`;
  if (metres >= 0.1)  return `${(metres * 100).toFixed(0)} cm`;
  return `${(metres * 100).toFixed(1)} cm`;
}

/**
 * Semantic label for a focus distance, including Pixel 8 Pro macro range.
 */
export function focusZoneLabel(metres) {
  if (metres == null || !isFinite(metres) || metres > 20) return 'Landscape / ∞';
  if (metres > 5)    return 'Distance';
  if (metres > 2.5)  return 'Full body';
  if (metres > 1.2)  return 'Portrait';
  if (metres > 0.5)  return 'Close-up';
  if (metres > 0.08) return 'Macro';
  return 'Super Macro (2 cm)';
}

/**
 * Convert a normalised focusDistance to metres.
 * Chrome/Android reports in metres (max > 5); some browsers normalise to 0–1.
 */
export function normToMetres(value, focusCap) {
  if (!focusCap) return null;
  const { min = 0, max = 1 } = focusCap;
  if (max > 5) return value; // already metres
  return min + value * (max - min);
}

// ---- Private helpers ----

function _pinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function _clampZoom(z, cap) {
  return Math.max(cap?.min ?? 1, Math.min(cap?.max ?? 20, z));
}

function _deviceMeta(device, mult, index, forceName) {
  const profile = nearestProfile(mult);
  return {
    deviceId: device.deviceId,
    label:    device.label,
    mult,
    name:     forceName || profile.name,
    profile,
  };
}
