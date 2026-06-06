/**
 * hdr.worker.js — Mertens single-scale exposure fusion.
 *
 * Classic worker (no import/export) for maximum browser compatibility.
 *
 * Input message:  { frames: ArrayBuffer[], width: number, height: number }
 *   frames: RGBA Uint8ClampedArray buffers, all same dimensions
 * Output message: { result: ArrayBuffer, width, height }
 *   result: fused RGBA image
 */

self.onmessage = function(e) {
  try {
    const { frames: buffers, width, height } = e.data;
    if (!buffers || !buffers.length) {
      self.postMessage({ error: 'No frames received' });
      return;
    }

    const frames = buffers.map(b => new Uint8ClampedArray(b));
    const result = fuseExposures(frames, width, height);

    self.postMessage({ result: result.buffer, width, height }, [result.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

function fuseExposures(frames, width, height) {
  const N = frames.length;
  const pixels = width * height;

  // Compute weight maps — one per frame, one value per pixel
  const weightMaps = frames.map(f => computeWeightMap(f, width, height));

  // Normalize weights per pixel
  const normWeights = new Array(N);
  for (let f = 0; f < N; f++) normWeights[f] = new Float32Array(pixels);

  for (let p = 0; p < pixels; p++) {
    let total = 0;
    for (let f = 0; f < N; f++) total += weightMaps[f][p];
    if (total < 1e-6) total = 1;
    for (let f = 0; f < N; f++) normWeights[f][p] = weightMaps[f][p] / total;
  }

  // Blend
  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    let r = 0, g = 0, b = 0;
    for (let f = 0; f < N; f++) {
      const w  = normWeights[f][p];
      const i  = p * 4;
      r += w * frames[f][i];
      g += w * frames[f][i+1];
      b += w * frames[f][i+2];
    }
    const i = p * 4;
    out[i]   = clamp(r);
    out[i+1] = clamp(g);
    out[i+2] = clamp(b);
    out[i+3] = 255;
  }
  return out;
}

function computeWeightMap(frame, width, height) {
  const pixels = width * height;
  const weights = new Float32Array(pixels);

  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    const r = frame[i] / 255;
    const g = frame[i+1] / 255;
    const b = frame[i+2] / 255;

    // Well-exposedness: Gaussian centered at 0.5
    const sigma2 = 0.04; // sigma = 0.2
    const we = gaussian(r, 0.5, sigma2) * gaussian(g, 0.5, sigma2) * gaussian(b, 0.5, sigma2);

    // Saturation: std-dev of RGB channels
    const mean = (r + g + b) / 3;
    const sat  = Math.sqrt(((r-mean)*(r-mean) + (g-mean)*(g-mean) + (b-mean)*(b-mean)) / 3);

    // Contrast: approximate as luminance magnitude (per-pixel Laplacian computed separately)
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // Simpler contrast: deviation from 0.5 (lighter weight near 0 or 1)
    const contrast = we; // use well-exposedness as contrast proxy for single-scale

    weights[p] = Math.max(1e-6, we * (1 + sat) * Math.max(0.01, contrast));
  }

  // Laplacian contrast refinement on luma
  const luma = new Float32Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    luma[p] = (0.2126 * frame[i] + 0.7152 * frame[i+1] + 0.0722 * frame[i+2]) / 255;
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p    = y * width + x;
      const lap  = Math.abs(
        4 * luma[p]
        - luma[p - 1]
        - luma[p + 1]
        - luma[p - width]
        - luma[p + width]
      );
      weights[p] *= (1 + lap * 3);
    }
  }

  return weights;
}

function gaussian(x, mu, sigma2) {
  const diff = x - mu;
  return Math.exp(-(diff * diff) / (2 * sigma2));
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
