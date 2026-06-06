/**
 * lens.js — multi-lens enumeration, optical zoom snap points, pinch-to-zoom,
 * focus-distance-to-metres conversion, and per-lens metadata.
 */

// ---- Known lens profiles keyed by approximate zoom multiplier ----
// Used to annotate detected snap points.
const LENS_PROFILES = [
  { mult: 0.5,  name: 'Ultrawide', fov: '120°', icon: 'bi-camera-reels'    },
  { mult: 0.6,  name: 'Ultrawide', fov: '114°', icon: 'bi-camera-reels'    },
  { mult: 0.7,  name: 'Ultrawide', fov: '108°', icon: 'bi-camera-reels'    },
  { mult: 1.0,  name: 'Wide',      fov: '78°',  icon: 'bi-camera'          },
  { mult: 1.5,  name: '1.5×',      fov: '57°',  icon: 'bi-camera'          },
  { mult: 2.0,  name: 'Tele',      fov: '42°',  icon: 'bi-binoculars'      },
  { mult: 3.0,  name: '3×',        fov: '28°',  icon: 'bi-binoculars'      },
  { mult: 5.0,  name: 'Periscope', fov: '17°',  icon: 'bi-binoculars-fill' },
  { mult: 10.0, name: '10× Tele',  fov: '8°',   icon: 'bi-binoculars-fill' },
  { mult: 20.0, name: '20× Tele',  fov: '4°',   icon: 'bi-binoculars-fill' },
  { mult: 30.0, name: '30× Tele',  fov: '3°',   icon: 'bi-binoculars-fill' },
];

function nearestProfile(zoom) {
  return LENS_PROFILES.reduce((best, p) =>
    Math.abs(p.mult - zoom) < Math.abs(best.mult - zoom) ? p : best
  );
}

// ---- LensManager ----

export class LensManager {
  constructor() {
    this.allDevices      = [];    // MediaDeviceInfo[] of videoinput
    this.activeDeviceId  = null;
    this.activeFacing    = 'environment';
    this.zoomSnaps       = [1];   // detected optical snap points
    this.opticalMax      = 1;     // estimated highest optical zoom
    this._zoomCap        = null;
    this._currentZoom    = 1;
    this._pinchStart     = null;  // { dist, baseZoom }
    this._wheelDebounce  = null;
    this.onZoomChange    = null;  // callback(zoom)
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
   * On many Android phones each physical lens is a separate device with
   * a label like "camera2 0, facing back".
   */
  facingDevices(facing = 'environment') {
    const isBack = facing === 'environment';
    return this.allDevices.filter(d => {
      if (!d.label) return true; // unknown — include
      const l = d.label.toLowerCase();
      return isBack
        ? (l.includes('back') || l.includes('rear') || l.includes('environment') || l.includes('facing back'))
        : (l.includes('front') || l.includes('user') || l.includes('selfie') || l.includes('facing front'));
    });
  }

  /**
   * Parse a device label to extract a display name and estimated focal multiplier.
   */
  parseDevice(device, indexAmongFacing) {
    const label = (device.label || '').toLowerCase();

    // Try to find an explicit multiplier in the label (e.g. "0.6x", "3x")
    const multMatch = label.match(/(\d+\.?\d*)\s*[×x]/i);
    if (multMatch) {
      const mult = parseFloat(multMatch[1]);
      const profile = nearestProfile(mult);
      return { deviceId: device.deviceId, label: device.label, mult, name: profile.name, profile };
    }

    // Keyword hints
    if (/ultra[-\s]?wide/i.test(label))  return _deviceMeta(device, 0.5, indexAmongFacing);
    if (/periscope/i.test(label))         return _deviceMeta(device, 5,   indexAmongFacing);
    if (/tele/i.test(label))              return _deviceMeta(device, 2,   indexAmongFacing);
    if (/macro/i.test(label))             return _deviceMeta(device, 1,   indexAmongFacing, 'Macro');
    if (/wide/i.test(label))              return _deviceMeta(device, 1,   indexAmongFacing);

    // camera2 N, facing back — assign by index
    const idxMatch = label.match(/camera\d*\s+(\d+)/i);
    if (idxMatch) {
      const hw = parseInt(idxMatch[1]);
      const guessedMult = [1, 0.5, 2, 5][hw] ?? 1;
      return _deviceMeta(device, guessedMult, indexAmongFacing);
    }

    // Fallback
    return _deviceMeta(device, indexAmongFacing === 0 ? 1 : 2, indexAmongFacing);
  }

  /**
   * Build parsed lens descriptors for the current facing side,
   * sorted by ascending focal multiplier (wide → tele).
   */
  buildLensList(facing = 'environment') {
    const facing_devices = this.facingDevices(facing);
    return facing_devices
      .map((d, i) => this.parseDevice(d, i))
      .sort((a, b) => a.mult - b.mult);
  }

  /**
   * Compute optical zoom snap points from the zoom capability.
   * Returns sorted array of zoom values where physical lens switches are likely.
   */
  buildZoomSnaps(zoomCap, numDevices = 1) {
    this._zoomCap = zoomCap;
    if (!zoomCap || !zoomCap.max) {
      this.zoomSnaps = [1];
      this.opticalMax = 1;
      return this.zoomSnaps;
    }

    const max = zoomCap.max;
    // All common optical multipliers that fit within the zoom range
    const candidates = [0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 20.0, 30.0];
    const snaps = candidates.filter(z => z <= max * 1.02);

    // Heuristic: estimate where optical ends and digital starts
    // A device that advertises only 1× optical + digital would have opticalMax=1
    // Multi-lens devices usually hit real transitions at the snap points
    if (numDevices >= 3) {
      this.opticalMax = snaps.includes(5) ? 5 : snaps.includes(3) ? 3 : snaps.includes(2) ? 2 : 1;
    } else if (numDevices === 2) {
      this.opticalMax = snaps.includes(3) ? 3 : snaps.includes(2) ? 2 : 1;
    } else {
      this.opticalMax = 1;
    }

    // Clamp opticalMax to actual zoom max
    this.opticalMax = Math.min(this.opticalMax, max);
    this.zoomSnaps  = snaps;
    return snaps;
  }

  /**
   * Classify whether a zoom level is optical, near-optical, or digital.
   * Returns 'optical' | 'nearoptical' | 'digital'
   */
  zoomQuality(zoom) {
    const nearSnap = this.zoomSnaps.some(s => Math.abs(zoom - s) < 0.2);
    if (nearSnap) return 'optical';
    if (zoom <= this.opticalMax + 0.1) return 'nearoptical';
    return 'digital';
  }

  setCurrentZoom(z) { this._currentZoom = z; }
  getCurrentZoom()  { return this._currentZoom; }

  /**
   * Attach pinch-to-zoom and mouse-wheel zoom to an element.
   * Calls onZoom(value) throttled; caller applies the constraint.
   */
  initPinchZoom(el, zoomCap, onZoom) {
    this._zoomCap = zoomCap;
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

  /** Snap zoom to the nearest optical snap point if within tolerance. */
  snapToNearest(zoom, tolerance = 0.12) {
    const close = this.zoomSnaps.find(s => Math.abs(s - zoom) <= tolerance * Math.max(1, s));
    return close ?? zoom;
  }

  /** Estimated field of view in degrees at given zoom (based on Wide = 78°). */
  estimateFoV(zoom, baseFoVDeg = 78) {
    return baseFoVDeg / zoom;
  }

  /** Estimated focal length in 35mm-equivalent given zoom and base focal. */
  estimateFocalLength(zoom, baseFocalMM = 24) {
    return Math.round(zoom * baseFocalMM);
  }
}

// ---- Focus distance utilities ----

/**
 * Format a focus distance (in metres) to a human string.
 * The MediaTrack API reports focusDistance in metres on Chrome/Android.
 */
export function formatFocusDist(metres) {
  if (metres == null || !isFinite(metres) || metres > 500) return '∞';
  if (metres >= 10)  return `${metres.toFixed(0)} m`;
  if (metres >= 1)   return `${metres.toFixed(1)} m`;
  if (metres >= 0.1) return `${(metres * 100).toFixed(0)} cm`;
  return `${(metres * 100).toFixed(1)} cm`;
}

/**
 * Semantic label for a focus distance.
 */
export function focusZoneLabel(metres) {
  if (metres == null || !isFinite(metres) || metres > 20) return 'Landscape / ∞';
  if (metres > 5)   return 'Distance';
  if (metres > 2.5) return 'Full body';
  if (metres > 1.2) return 'Portrait';
  if (metres > 0.5) return 'Close-up';
  if (metres > 0.1) return 'Macro';
  return 'Super Macro';
}

/**
 * Convert a normalised focusDistance (some browsers use 0–1 instead of metres)
 * to an estimated metres value using the capability range.
 * If max > 5, it's already in metres. Otherwise normalise.
 */
export function normToMetres(value, focusCap) {
  if (!focusCap) return null;
  const { min = 0, max = 1 } = focusCap;
  // Chrome/Android: values are in metres (max is often 10 or Infinity-clamped)
  if (max > 5) return value; // already metres
  // Normalised 0–1 → interpolate
  return min + value * (max - min);
}

// ---- Private helpers ----

function _pinchDist(e) {
  const dx = e.touches[0].clientX - e.touches[1].clientX;
  const dy = e.touches[0].clientY - e.touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function _clampZoom(z, cap) {
  const min = cap?.min ?? 1;
  const max = cap?.max ?? 20;
  return Math.max(min, Math.min(max, z));
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
