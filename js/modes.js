/**
 * ModeController — manages all capture modes.
 *
 * Constructor receives a CameraManager and an onCapture callback:
 *   onCapture(blob, mode, metadata) called for each captured image.
 */
import { captureFrame, previewCapture, bitmapToBlob, applyLooks, cropToAspect } from './capture.js';

export class ModeController {
  constructor(cam, onCapture) {
    this._cam = cam;
    this._onCapture = onCapture;
    this._active = false;
    this._hdrWorker = null;
    this._stackWorker = null;
    this._stackLayers = [];
    this._recordTimer = null;
    this._videoRecorder = null;
    this._initWorkers();
  }

  _initWorkers() {
    try {
      this._hdrWorker   = new Worker('workers/hdr.worker.js');
      this._stackWorker = new Worker('workers/stack.worker.js');
    } catch (e) {
      console.warn('Worker init failed:', e.message);
    }
  }

  stop() {
    this._active = false;
    clearInterval(this._timelapse);
    this._timelapse = null;
  }

  // ---- Single photo ----

  async capturePhoto(opts = {}) {
    this._active = true;
    const result = await captureFrame(this._cam, opts.resolutionMode);
    const blob   = await this._postProcess(result.blob, opts);
    await this._onCapture(blob, 'photo', { source: result.source, megapixels: result.megapixels });
    this._active = false;
    return result;
  }

  // ---- Self-timer ----

  async captureSelfTimer(delay, opts = {}) {
    const overlay = document.getElementById('countdownOverlay');
    const num     = document.getElementById('countdownNum');
    overlay?.classList.remove('d-none');
    let remaining = delay;
    await new Promise(resolve => {
      const tick = setInterval(() => {
        if (num) num.textContent = remaining;
        remaining--;
        if (remaining < 0) {
          clearInterval(tick);
          overlay?.classList.add('d-none');
          resolve();
        }
      }, 1000);
    });
    return this.capturePhoto(opts);
  }

  // ---- Burst ----

  async captureBurst(count = 5, opts = {}) {
    this._active = true;
    const results = [];
    for (let i = 0; i < count && this._active; i++) {
      _progress(`Burst ${i + 1}/${count}`);
      const result = await captureFrame(this._cam, opts.resolutionMode);
      const blob   = await this._postProcess(result.blob, opts);
      await this._onCapture(blob, 'burst', { frame: i + 1, total: count, source: result.source, megapixels: result.megapixels });
      results.push(result);
    }
    _progress('');
    this._active = false;
    return results;
  }

  // ---- HDR bracket ----

  async captureHDR(brackets = 3, evSpacing = 1, opts = {}) {
    this._active = true;
    const cam   = this._cam;
    const caps  = cam.getCapabilities();
    const hasEV = !!(caps.exposureCompensation);
    const evValues = _bracketEVs(brackets, evSpacing);

    const frames = [];
    for (let i = 0; i < brackets && this._active; i++) {
      _progress(`HDR ${i + 1}/${brackets}`);
      if (hasEV) {
        await cam.applyConstraint('exposureCompensation', evValues[i]);
        await _delay(200);
      }
      const result = await captureFrame(cam, opts.resolutionMode);
      const imageData = await blobToImageData(result.blob);
      frames.push(imageData);
    }

    // Restore EV to 0
    if (hasEV) await cam.applyConstraint('exposureCompensation', 0).catch(() => {});

    _progress('HDR fusing…');
    let finalBlob;
    if (this._hdrWorker && frames.length > 0) {
      finalBlob = await this._runHDR(frames);
    } else if (frames.length > 0) {
      finalBlob = await imageDataToBlob(frames[Math.floor(frames.length / 2)]);
    }

    if (finalBlob) {
      const processed = await this._postProcess(finalBlob, opts);
      await this._onCapture(processed, 'hdr', { brackets, evSpacing, source: 'hdr-fusion' });
    }
    _progress('');
    this._active = false;
  }

  _runHDR(frames) {
    return new Promise((resolve, reject) => {
      const { width, height } = frames[0];
      const buffers = frames.map(f => f.data.buffer.slice(0));
      this._hdrWorker.onmessage = ({ data }) => {
        if (data.error) { reject(new Error(data.error)); return; }
        const id = new ImageData(new Uint8ClampedArray(data.result), data.width, data.height);
        imageDataToBlob(id).then(resolve).catch(reject);
      };
      this._hdrWorker.onerror = reject;
      this._hdrWorker.postMessage({ frames: buffers, width, height }, buffers);
    });
  }

  // ---- Long exposure ----

  async captureLongExposure(count = 10, mode = 'average', opts = {}) {
    this._active = true;
    const frames = [];
    for (let i = 0; i < count && this._active; i++) {
      _progress(`Long exp ${i + 1}/${count}`);
      const result = await captureFrame(this._cam, 'preview');
      const imageData = await blobToImageData(result.blob);
      frames.push(imageData);
      await _delay(50);
    }

    _progress('Merging…');
    const merged = mergeFrames(frames, mode);
    const blob   = await imageDataToBlob(merged);
    const processed = await this._postProcess(blob, opts);
    await this._onCapture(processed, `longexp-${mode}`, { count, mode, source: 'longexp' });
    _progress('');
    this._active = false;
  }

  // ---- Timelapse ----

  startTimelapse(intervalSec = 5, count = 30, opts = {}) {
    this._active = true;
    let captured = 0;
    _progress(`Timelapse 0/${count}`);
    this._timelapse = setInterval(async () => {
      if (!this._active || captured >= count) {
        clearInterval(this._timelapse);
        _progress('');
        return;
      }
      captured++;
      _progress(`Timelapse ${captured}/${count}`);
      const result = await captureFrame(this._cam, opts.resolutionMode || 'preview');
      const blob   = await this._postProcess(result.blob, opts);
      await this._onCapture(blob, 'timelapse', { frame: captured, total: count });
    }, intervalSec * 1000);
  }

  // ---- Focus stacking ----

  clearFocusStack() {
    this._stackLayers = [];
    _updateStackUI(this._stackLayers.length);
  }

  async addFocusLayer() {
    const result = await captureFrame(this._cam, 'preview');
    const imageData = await blobToImageData(result.blob);
    this._stackLayers.push(imageData);
    _updateStackUI(this._stackLayers.length);
    return this._stackLayers.length;
  }

  async mergeFocusStack(opts = {}) {
    if (this._stackLayers.length < 2) throw new Error('Need at least 2 layers');
    _progress('Focus stacking…');

    let finalBlob;
    if (this._stackWorker) {
      finalBlob = await this._runStack(this._stackLayers);
    } else {
      const mid = Math.floor(this._stackLayers.length / 2);
      finalBlob = await imageDataToBlob(this._stackLayers[mid]);
    }

    const processed = await this._postProcess(finalBlob, opts);
    await this._onCapture(processed, 'focusstack', { layers: this._stackLayers.length, source: 'stack-merge' });
    this._stackLayers = [];
    _updateStackUI(0);
    _progress('');
  }

  _runStack(frames) {
    return new Promise((resolve, reject) => {
      const { width, height } = frames[0];
      const buffers = frames.map(f => f.data.buffer.slice(0));
      this._stackWorker.onmessage = ({ data }) => {
        if (data.error) { reject(new Error(data.error)); return; }
        const id = new ImageData(new Uint8ClampedArray(data.result), data.width, data.height);
        imageDataToBlob(id).then(resolve).catch(reject);
      };
      this._stackWorker.onerror = reject;
      this._stackWorker.postMessage({ frames: buffers, width, height }, buffers);
    });
  }

  // ---- Video recording ----

  startRecording(stream) {
    const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=h264')
      ? 'video/mp4;codecs=h264'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';

    const chunks = [];
    this._videoRecorder = new MediaRecorder(stream, { mimeType });
    this._videoRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    this._videoRecorder.start(100);

    let elapsed = 0;
    const timerEl = document.getElementById('recordTimer');
    this._recordTimer = setInterval(() => {
      elapsed++;
      if (timerEl) timerEl.textContent = _formatTime(elapsed);
    }, 1000);

    return new Promise(resolve => {
      this._videoRecorder.onstop = () => {
        clearInterval(this._recordTimer);
        if (timerEl) timerEl.textContent = '';
        resolve(new Blob(chunks, { type: mimeType }));
      };
    });
  }

  stopRecording() {
    if (this._videoRecorder && this._videoRecorder.state !== 'inactive') {
      this._videoRecorder.stop();
    }
  }

  // ---- Post-processing (looks + crop) ----

  async _postProcess(blob, opts = {}) {
    const { filmSim, vignetteAmount = 0, grainAmount = 0, watermarkText, aspect, format } = opts;
    if (!filmSim && !vignetteAmount && !grainAmount && !watermarkText && !aspect) {
      return _convertFormat(blob, format);
    }

    const canvas = await blobToCanvas(blob);
    applyLooks(canvas, { filmSim, vignetteAmount, grainAmount, watermarkText });
    const cropped = cropToAspect(canvas, aspect);

    return new Promise(resolve => {
      const mime = format || 'image/jpeg';
      const quality = mime === 'image/png' ? undefined : 0.95;
      cropped.toBlob(b => resolve(b), mime, quality);
    });
  }
}

// ---- Helpers ----

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function _progress(msg) {
  const el = document.getElementById('statusProgress');
  if (el) el.textContent = msg;
}

function _updateStackUI(count) {
  const countEl = document.getElementById('stackLayerCount');
  const mergeBtn = document.getElementById('btnMergeStack');
  const clearBtn = document.getElementById('btnClearStack');
  if (countEl) countEl.textContent = count;
  if (mergeBtn) mergeBtn.classList.toggle('d-none', count < 2);
  if (clearBtn) clearBtn.classList.toggle('d-none', count === 0);
}

function _bracketEVs(brackets, spacing) {
  const evs = [];
  const half = Math.floor(brackets / 2);
  for (let i = -half; i <= half; i++) evs.push(i * spacing);
  return evs.slice(0, brackets);
}

function _formatTime(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

async function _convertFormat(blob, format) {
  if (!format || format === 'image/jpeg' || blob.type === format) return blob;
  const canvas = await blobToCanvas(blob);
  return new Promise(resolve => {
    const quality = format === 'image/png' ? undefined : 0.95;
    canvas.toBlob(b => resolve(b), format, quality);
  });
}

export function blobToCanvas(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const c = document.createElement('canvas');
      c.width  = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      resolve(c);
    };
    img.src = url;
  });
}

export function blobToImageData(blob) {
  return blobToCanvas(blob).then(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
  );
}

export function imageDataToBlob(imageData, quality = 0.92) {
  const c = document.createElement('canvas');
  c.width  = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/jpeg', quality));
}

function mergeFrames(frames, mode) {
  if (!frames.length) return null;
  const { width, height } = frames[0];
  const out = new Uint8ClampedArray(width * height * 4);
  const n   = frames.length;

  if (mode === 'max') {
    for (let i = 0; i < out.length; i += 4) {
      let maxR = 0, maxG = 0, maxB = 0;
      for (const f of frames) {
        if (f.data[i]   > maxR) maxR = f.data[i];
        if (f.data[i+1] > maxG) maxG = f.data[i+1];
        if (f.data[i+2] > maxB) maxB = f.data[i+2];
      }
      out[i] = maxR; out[i+1] = maxG; out[i+2] = maxB; out[i+3] = 255;
    }
  } else {
    // average
    for (let i = 0; i < out.length; i += 4) {
      let sumR = 0, sumG = 0, sumB = 0;
      for (const f of frames) {
        sumR += f.data[i]; sumG += f.data[i+1]; sumB += f.data[i+2];
      }
      out[i] = sumR / n; out[i+1] = sumG / n; out[i+2] = sumB / n; out[i+3] = 255;
    }
  }
  return new ImageData(out, width, height);
}
