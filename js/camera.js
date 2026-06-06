/**
 * CameraManager — manages the getUserMedia stream, capabilities, and constraint application.
 */
export class CameraManager {
  constructor() {
    this.stream      = null;
    this.track       = null;
    this.imageCapture= null;
    this.facingMode  = 'environment';
    this.capabilities= {};
    this.settings    = {};
    this._videoEl    = null;
    this._torchOn    = false;
    this._deviceId   = null;   // explicit deviceId constraint (overrides facingMode)
    this._pendingZoom= null;
    this._zoomTimer  = null;
    this._afLocked   = false;
    this._afLockDist = null;
    this._prevFocusMode = null;
  }

  async start(videoEl) {
    this._videoEl = videoEl;
    await this._startStream();
  }

  /** Start with a specific deviceId (e.g. a selected physical lens). */
  async startWithDevice(deviceId, videoEl) {
    this._deviceId = deviceId;
    if (videoEl) this._videoEl = videoEl;
    await this._startStream();
  }

  async _startStream() {
    if (this.stream) this.stop();

    const videoConstraints = {
      width:  { ideal: 1280 },
      height: { ideal: 720 },
    };

    if (this._deviceId) {
      videoConstraints.deviceId = { exact: this._deviceId };
    } else {
      videoConstraints.facingMode = { ideal: this.facingMode };
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false,
    });
    this.track = this.stream.getVideoTracks()[0];
    this._videoEl.srcObject = this.stream;
    await this._videoEl.play().catch(() => {});

    this.capabilities = this.track.getCapabilities ? this.track.getCapabilities() : {};
    this.settings     = this.track.getSettings    ? this.track.getSettings()     : {};

    this.imageCapture = ('ImageCapture' in window) ? new ImageCapture(this.track) : null;
    this._afLocked    = false;
    this._afLockDist  = null;
  }

  async switchCamera() {
    this._deviceId  = null; // let facingMode take over
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    this._torchOn   = false;
    await this._startStream();
  }

  // ---- Constraint helpers ----

  /**
   * Apply a single named constraint.
   * Uses the `advanced` array form required for non-standard constraints
   * (torch, zoom, focusDistance, pointsOfInterest, etc.).
   */
  async applyConstraint(name, value) {
    if (!this.track) return;
    try {
      await this.track.applyConstraints({ advanced: [{ [name]: value }] });
      this.settings = this.track.getSettings ? this.track.getSettings() : this.settings;
    } catch (e) {
      console.warn(`applyConstraint(${name}, ${value}) failed:`, e.message);
    }
  }

  async setTorch(on) {
    this._torchOn = on;
    await this.applyConstraint('torch', on);
  }

  // ---- Zoom ----

  /**
   * Throttled zoom — coalesces rapid changes (pinch gesture, wheel) into
   * one applyConstraints call per ~50 ms to avoid flooding the camera pipeline.
   */
  setZoom(value) {
    this._pendingZoom = value;
    if (this._zoomTimer) return;
    this._zoomTimer = setTimeout(async () => {
      this._zoomTimer = null;
      const z = this._pendingZoom;
      await this.applyConstraint('zoom', z);
      // Keep UI slider in sync
      const slider = document.getElementById('ctrlZoom');
      if (slider) slider.value = z;
      this._updateZoomUI(z);
    }, 50);
  }

  _updateZoomUI(z) {
    const valEl   = document.getElementById('valZoomLive');
    const typeEl  = document.getElementById('zoomTypeLabel');
    const fillEl  = document.getElementById('zoomQualityFill');
    if (valEl)  valEl.textContent  = `${z.toFixed(1)}×`;
    // Dispatch event for LensManager to update quality indicators
    window.dispatchEvent(new CustomEvent('ap:zoomChanged', { detail: { zoom: z } }));
  }

  // ---- Autofocus ----

  /**
   * Single-shot AF trigger: switch to single-shot AF, wait for settle,
   * optionally restore previous mode. Returns settled focusDistance.
   */
  async triggerAF() {
    const caps = this.capabilities;
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    this._prevFocusMode = this.settings.focusMode || 'auto';

    const target = modes.includes('single-shot') ? 'single-shot' : 'auto';
    await this.applyConstraint('focusMode', target);
    await _delay(350);
    this.settings = this.track?.getSettings?.() || this.settings;
    return this.settings.focusDistance ?? null;
  }

  /**
   * AF lock: read current focusDistance, switch to manual at that distance.
   * Returns { locked: bool, distance: metres|null }.
   */
  async lockAF() {
    if (this._afLocked) {
      // Unlock: restore continuous/auto
      this._afLocked   = false;
      this._afLockDist = null;
      const caps  = this.capabilities;
      const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
      const restore = modes.includes('continuous') ? 'continuous' : 'auto';
      await this.applyConstraint('focusMode', restore);
      return { locked: false, distance: null };
    }

    // Lock: capture current distance, set manual
    this.settings = this.track?.getSettings?.() || this.settings;
    const dist    = this.settings.focusDistance ?? null;
    await this.applyConstraint('focusMode', 'manual');
    if (dist != null) await this.applyConstraint('focusDistance', dist);
    this._afLocked   = true;
    this._afLockDist = dist;
    return { locked: true, distance: dist };
  }

  isAFLocked()    { return this._afLocked; }
  afLockDistance(){ return this._afLockDist; }

  // ---- Focus zone (pointsOfInterest) ----

  /**
   * Set the focus / metering point.
   * nx, ny are normalised [0,1] coordinates in the video frame.
   */
  async setFocusPoint(nx, ny) {
    await this.applyConstraint('pointsOfInterest', [{ x: nx, y: ny }]);
  }

  /**
   * Set a named focus zone (center | spot | wide | continuous-tracking).
   * 'tracking' enables continuous AF with a small dynamic ROI (best-effort).
   */
  async setFocusZone(zone) {
    const caps  = this.capabilities;
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    switch (zone) {
      case 'center':
        await this.setFocusPoint(0.5, 0.5);
        if (modes.includes('auto')) await this.applyConstraint('focusMode', 'auto');
        break;
      case 'spot':
        // Leave point as-is, switch to single-shot for precise locking
        if (modes.includes('single-shot')) await this.applyConstraint('focusMode', 'single-shot');
        break;
      case 'wide':
        // No specific ROI, back to full-frame AF
        if (modes.includes('auto')) await this.applyConstraint('focusMode', 'auto');
        break;
      case 'tracking':
        if (modes.includes('continuous')) await this.applyConstraint('focusMode', 'continuous');
        break;
    }
  }

  // ---- Max resolution helper ----

  async withMaxResolution(fn) {
    const maxW = this.capabilities.width?.max  || 1920;
    const maxH = this.capabilities.height?.max || 1080;
    try {
      await this.track.applyConstraints({ width: maxW, height: maxH });
      await _delay(300);
      return await fn();
    } finally {
      await this.track.applyConstraints({ width: { ideal: 1280 }, height: { ideal: 720 } })
        .catch(() => {});
    }
  }

  getCapabilities() { return this.capabilities; }
  getSettings()     { return this.settings; }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.track  = null;
      this.imageCapture = null;
    }
    if (this._videoEl) {
      this._videoEl.srcObject = null;
    }
  }
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
