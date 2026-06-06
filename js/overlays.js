/**
 * OverlayManager — manages all visual overlays on the camera viewfinder.
 *
 * Uses a single throttled rAF loop, OffscreenCanvas for pixel analysis,
 * and draws results onto the visible overlay canvas.
 */
export class OverlayManager {
  constructor() {
    this._video   = null;
    this._display = null;
    this._displayCtx = null;
    this._analysis   = null;
    this._analysisCtx = null;
    this._active  = new Set();
    this._frame   = 0;
    this._rafId   = null;
    this._beta    = 0;
    this._gamma   = 0;
    this._orientationHandler = null;
    this._pinholeMode = false;
    this._pinholeP1 = null;
    this._pinholeP2 = null;
    this._focusRings = [];
  }

  init(videoEl, displayCanvas) {
    this._video   = videoEl;
    this._display = displayCanvas;
    this._displayCtx = displayCanvas.getContext('2d');

    // Size analysis canvas to a downsampled resolution for performance
    const aw = 320, ah = 180;
    if (typeof OffscreenCanvas !== 'undefined') {
      this._analysis = new OffscreenCanvas(aw, ah);
    } else {
      this._analysis = Object.assign(document.createElement('canvas'), { width: aw, height: ah });
    }
    this._analysisCtx = this._analysis.getContext('2d', { willReadFrequently: true });

    this._orientationHandler = e => {
      this._beta  = e.beta  ?? 0;
      this._gamma = e.gamma ?? 0;
    };
    window.addEventListener('deviceorientation', this._orientationHandler);

    // Resize overlay canvas when video dimensions change
    videoEl.addEventListener('loadedmetadata', () => this._resizeCanvas());
    videoEl.addEventListener('resize', () => this._resizeCanvas());
    new ResizeObserver(() => this._resizeCanvas()).observe(displayCanvas);
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const rect = this._display.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._display.width  = rect.width;
      this._display.height = rect.height;
    }
  }

  enable(name) {
    this._active.add(name);
    if (name === 'tapFocus') {
      this._display.classList.add('tap-focus-active');
    }
    this._startLoop();
  }

  disable(name) {
    this._active.delete(name);
    if (name === 'tapFocus') {
      this._display.classList.remove('tap-focus-active');
    }
    if (!this._active.size) this._stopLoop();
    else this._clearOverlay(name);
  }

  toggle(name) {
    if (this._active.has(name)) this.disable(name);
    else this.enable(name);
    return this._active.has(name);
  }

  isActive(name) { return this._active.has(name); }

  _startLoop() {
    if (this._rafId) return;
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      this._frame++;
      this._render();
    };
    tick();
  }

  _stopLoop() {
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    this._displayCtx.clearRect(0, 0, this._display.width, this._display.height);
  }

  _render() {
    const dc = this._displayCtx;
    const dw = this._display.width;
    const dh = this._display.height;
    dc.clearRect(0, 0, dw, dh);

    const needsPixels = this._active.has('histogram')
      || this._active.has('focusPeaking')
      || this._active.has('zebra');

    let imageData = null;
    if (needsPixels && this._frame % 6 === 0) {
      try {
        this._analysisCtx.drawImage(this._video, 0, 0, this._analysis.width, this._analysis.height);
        imageData = this._analysisCtx.getImageData(0, 0, this._analysis.width, this._analysis.height);
      } catch (_) {}
    }

    if (imageData) {
      if (this._active.has('histogram'))   this._drawHistogram(dc, dw, dh, imageData);
      if (this._active.has('focusPeaking')) this._drawFocusPeaking(dc, dw, dh, imageData);
      if (this._active.has('zebra'))       this._drawZebra(dc, dw, dh, imageData);
    }

    if (this._active.has('grid'))  this._drawGrid(dc, dw, dh);
    if (this._active.has('level')) this._drawLevel(dc, dw, dh);

    // Focus rings (short-lived animation)
    this._focusRings = this._focusRings.filter(r => {
      r.age++;
      if (r.age > 30) return false;
      const alpha = 1 - r.age / 30;
      const scale = 1 + (1 - r.age / 30) * 0.4;
      const sz = 60 * scale;
      dc.strokeStyle = `rgba(255, 232, 0, ${alpha})`;
      dc.lineWidth = 2;
      dc.strokeRect(r.x - sz / 2, r.y - sz / 2, sz, sz);
      return true;
    });
    if (!this._focusRings.length && !this._active.size) this._stopLoop();

    // Pinhole measuring line
    if (this._pinholeP1 && this._pinholeMode) {
      dc.strokeStyle = 'rgba(0, 200, 255, 0.8)';
      dc.lineWidth = 2;
      dc.setLineDash([6, 4]);
      dc.beginPath();
      dc.moveTo(this._pinholeP1.x, this._pinholeP1.y);
      if (this._pinholeP2) dc.lineTo(this._pinholeP2.x, this._pinholeP2.y);
      dc.stroke();
      dc.setLineDash([]);
    }
  }

  // ---- HISTOGRAM ----

  _drawHistogram(dc, dw, dh, imageData) {
    const data = imageData.data;
    const histW = 180, histH = 60;
    const x0 = 8, y0 = dh - histH - 8;

    const R = new Uint32Array(256), G = new Uint32Array(256), B = new Uint32Array(256);
    const L = new Uint32Array(256);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i+1], b = data[i+2];
      R[r]++; G[g]++; B[b]++;
      L[Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b)]++;
    }

    const maxVal = Math.max(
      Math.max(...Array.from(L)),
      Math.max(...Array.from(R)),
      Math.max(...Array.from(G)),
      Math.max(...Array.from(B)),
    ) || 1;

    // Background
    dc.fillStyle = 'rgba(0,0,0,0.55)';
    dc.beginPath();
    dc.roundRect(x0 - 4, y0 - 4, histW + 8, histH + 8, 6);
    dc.fill();

    const channels = [
      [L, 'rgba(255,255,255,0.5)'],
      [R, 'rgba(255,60,60,0.55)'],
      [G, 'rgba(60,220,60,0.55)'],
      [B, 'rgba(60,120,255,0.55)'],
    ];

    for (const [hist, color] of channels) {
      dc.beginPath();
      dc.fillStyle = color;
      for (let i = 0; i < 256; i++) {
        const barH = (hist[i] / maxVal) * histH;
        const bx = x0 + (i / 256) * histW;
        const bw = histW / 256 + 0.5;
        dc.rect(bx, y0 + histH - barH, bw, barH);
      }
      dc.fill();
    }

    // Clipping markers
    dc.fillStyle = 'rgba(255,80,80,0.85)';
    dc.fillRect(x0 + histW - 4, y0, 4, histH);
    dc.fillStyle = 'rgba(80,80,255,0.6)';
    dc.fillRect(x0, y0, 4, histH);
  }

  // ---- FOCUS PEAKING ----

  _drawFocusPeaking(dc, dw, dh, imageData) {
    const sw = this._analysis.width, sh = this._analysis.height;
    const d  = imageData.data;
    const THRESHOLD = 40;

    // Build luma plane
    const luma = new Uint8Array(sw * sh);
    for (let i = 0; i < sw * sh; i++) {
      luma[i] = 0.2126 * d[i*4] + 0.7152 * d[i*4+1] + 0.0722 * d[i*4+2];
    }

    // Sobel magnitude
    const scaleX = dw / sw, scaleY = dh / sh;
    dc.save();
    dc.globalCompositeOperation = 'screen';

    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const tl = luma[(y-1)*sw+(x-1)], tm = luma[(y-1)*sw+x], tr = luma[(y-1)*sw+(x+1)];
        const ml = luma[y*sw+(x-1)],                               mr = luma[y*sw+(x+1)];
        const bl = luma[(y+1)*sw+(x-1)], bm = luma[(y+1)*sw+x], br = luma[(y+1)*sw+(x+1)];
        const gx = -tl - 2*ml - bl + tr + 2*mr + br;
        const gy = -tl - 2*tm - tr + bl + 2*bm + br;
        const mag = Math.sqrt(gx*gx + gy*gy);
        if (mag > THRESHOLD) {
          const alpha = Math.min(1, (mag - THRESHOLD) / 200);
          dc.fillStyle = `rgba(255,60,0,${(alpha * 0.9).toFixed(2)})`;
          dc.fillRect(x * scaleX, y * scaleY, scaleX + 0.5, scaleY + 0.5);
        }
      }
    }
    dc.restore();
  }

  // ---- ZEBRA ----

  _drawZebra(dc, dw, dh, imageData) {
    const sw = this._analysis.width, sh = this._analysis.height;
    const d  = imageData.data;
    const THRESHOLD = 230;
    const STRIPE = 8;

    const scaleX = dw / sw, scaleY = dh / sh;
    dc.save();
    dc.globalCompositeOperation = 'overlay';

    for (let i = 0; i < sw * sh; i++) {
      const r = d[i*4], g = d[i*4+1], b = d[i*4+2];
      if (r > THRESHOLD || g > THRESHOLD || b > THRESHOLD) {
        const x = (i % sw), y = Math.floor(i / sw);
        if ((x + y) % STRIPE < STRIPE / 2) {
          dc.fillStyle = 'rgba(255,220,0,0.7)';
          dc.fillRect(x * scaleX, y * scaleY, scaleX + 0.5, scaleY + 0.5);
        }
      }
    }
    dc.restore();
  }

  // ---- GRID ----

  _drawGrid(dc, dw, dh) {
    dc.save();
    dc.strokeStyle = 'rgba(255,255,255,0.3)';
    dc.lineWidth   = 1;
    dc.setLineDash([4, 4]);
    // Thirds
    for (let i = 1; i <= 2; i++) {
      const x = dw * i / 3;
      const y = dh * i / 3;
      dc.beginPath(); dc.moveTo(x, 0); dc.lineTo(x, dh); dc.stroke();
      dc.beginPath(); dc.moveTo(0, y); dc.lineTo(dw, y); dc.stroke();
    }
    // Center cross
    dc.setLineDash([2, 8]);
    dc.strokeStyle = 'rgba(255,255,255,0.15)';
    dc.beginPath(); dc.moveTo(dw/2, dh*0.4); dc.lineTo(dw/2, dh*0.6); dc.stroke();
    dc.beginPath(); dc.moveTo(dw*0.4, dh/2); dc.lineTo(dw*0.6, dh/2); dc.stroke();
    dc.restore();
  }

  // ---- HORIZON LEVEL ----

  _drawLevel(dc, dw, dh) {
    const angle = (this._gamma || 0);
    const cx = dw / 2, cy = dh / 2;
    const len = dw * 0.3;
    const rad = angle * Math.PI / 180;
    const isLevel = Math.abs(angle) < 2;

    dc.save();
    dc.strokeStyle = isLevel ? '#00e676' : '#ff5252';
    dc.lineWidth   = 2;
    dc.globalAlpha = 0.85;
    dc.translate(cx, cy);
    dc.rotate(rad);
    dc.beginPath();
    dc.moveTo(-len, 0);
    dc.lineTo(len, 0);
    dc.stroke();
    // End ticks
    dc.beginPath();
    dc.moveTo(-len, -8); dc.lineTo(-len, 8);
    dc.moveTo( len, -8); dc.lineTo( len, 8);
    dc.stroke();
    // Center dot
    dc.fillStyle = isLevel ? '#00e676' : '#ff5252';
    dc.beginPath(); dc.arc(0, 0, 4, 0, Math.PI * 2); dc.fill();
    dc.restore();

    // Angle readout
    if (!isLevel) {
      dc.fillStyle = 'rgba(255,82,82,0.9)';
      dc.font = 'bold 12px monospace';
      dc.textAlign = 'center';
      dc.fillText(`${angle > 0 ? '+' : ''}${angle.toFixed(1)}°`, cx, cy + 24);
    }
  }

  // ---- TAP TO FOCUS ----

  addTapFocusListener(cam) {
    this._tapHandler = (e) => {
      if (!this._active.has('tapFocus')) return;
      const rect = this._display.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;
      const px = (e.clientX - rect.left) * (this._display.width  / rect.width);
      const py = (e.clientY - rect.top)  * (this._display.height / rect.height);

      this.showFocusRing(px, py);
      cam.applyConstraint('pointsOfInterest', [{ x: nx, y: ny }])
        .then(() => cam.applyConstraint('focusMode', 'manual'))
        .catch(() => {});
    };
    this._display.addEventListener('pointerdown', this._tapHandler);
  }

  showFocusRing(x, y) {
    this._focusRings.push({ x, y, age: 0 });
    if (!this._rafId) this._startLoop();
  }

  // ---- PINHOLE MEASUREMENT ----

  startPinholeMeasure() {
    this._pinholeMode = true;
    this._pinholeP1 = null;
    this._pinholeP2 = null;
    this._tapHandler2 = (e) => {
      const rect = this._display.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      if (!this._pinholeP1) {
        this._pinholeP1 = { x: px, y: py };
      } else {
        this._pinholeP2 = { x: px, y: py };
        this._pinholeMode = false;
        this._display.removeEventListener('pointerdown', this._tapHandler2);
        this._display.classList.remove('tap-focus-active');
        const dx = this._pinholeP2.x - this._pinholeP1.x;
        const dy = this._pinholeP2.y - this._pinholeP1.y;
        const pixels = Math.sqrt(dx*dx + dy*dy);
        window.dispatchEvent(new CustomEvent('ap:pinholePixels', { detail: { pixels } }));
      }
    };
    this._display.classList.add('tap-focus-active');
    this._display.addEventListener('pointerdown', this._tapHandler2);
    if (!this._rafId) this._startLoop();
  }

  _clearOverlay() {
    // intentionally no-op: render loop clears on each frame
  }

  destroy() {
    this._stopLoop();
    if (this._orientationHandler) {
      window.removeEventListener('deviceorientation', this._orientationHandler);
    }
    if (this._tapHandler)  this._display?.removeEventListener('pointerdown', this._tapHandler);
    if (this._tapHandler2) this._display?.removeEventListener('pointerdown', this._tapHandler2);
  }
}
