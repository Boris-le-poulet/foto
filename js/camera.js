/**
 * CameraManager — manages the getUserMedia stream, capabilities, and constraint application.
 */
export class CameraManager {
  constructor() {
    this.stream = null;
    this.track = null;
    this.imageCapture = null;
    this.facingMode = 'environment';
    this.capabilities = {};
    this.settings = {};
    this._videoEl = null;
    this._torchOn = false;
  }

  async start(videoEl) {
    this._videoEl = videoEl;
    await this._startStream();
  }

  async _startStream() {
    if (this.stream) this.stop();

    const constraints = {
      video: {
        facingMode: { ideal: this.facingMode },
        width:  { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this._videoEl.srcObject = this.stream;
    await this._videoEl.play().catch(() => {});

    this.capabilities = this.track.getCapabilities ? this.track.getCapabilities() : {};
    this.settings    = this.track.getSettings    ? this.track.getSettings()    : {};

    this.imageCapture = ('ImageCapture' in window) ? new ImageCapture(this.track) : null;
  }

  async switchCamera() {
    this.facingMode = this.facingMode === 'environment' ? 'user' : 'environment';
    this._torchOn = false;
    await this._startStream();
  }

  /**
   * Apply a single named constraint.
   * Uses the `advanced` array form required for non-standard constraints.
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

  /**
   * Temporarily apply max video resolution, then restore preview resolution.
   * Returns a promise that resolves when the preview is restored.
   */
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
