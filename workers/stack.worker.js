/**
 * stack.worker.js — Focus stacking via per-pixel Laplacian sharpness selection.
 *
 * Classic worker (no import/export) for maximum browser compatibility.
 *
 * Input message:  { frames: ArrayBuffer[], width: number, height: number }
 * Output message: { result: ArrayBuffer, width, height }
 */

self.onmessage = function(e) {
  try {
    const { frames: buffers, width, height } = e.data;
    if (!buffers || buffers.length < 2) {
      self.postMessage({ error: 'Need at least 2 frames' });
      return;
    }

    const frames = buffers.map(b => new Uint8ClampedArray(b));
    const result = focusStack(frames, width, height);

    self.postMessage({ result: result.buffer, width, height }, [result.buffer]);
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};

function focusStack(frames, width, height) {
  const N      = frames.length;
  const pixels = width * height;

  // Build luma planes per frame
  const lumaPlanes = frames.map(f => {
    const l = new Float32Array(pixels);
    for (let i = 0; i < pixels; i++) {
      l[i] = (0.2126 * f[i*4] + 0.7152 * f[i*4+1] + 0.0722 * f[i*4+2]) / 255;
    }
    return l;
  });

  // Apply Gaussian blur to each luma plane (to reduce noise before Laplacian)
  const blurred = lumaPlanes.map(l => gaussianBlur(l, width, height, 1.0));

  // Compute Laplacian variance (3×3 window) per frame
  const sharpness = blurred.map(l => laplacian(l, width, height));

  // Smooth sharpness maps with a box blur to reduce seams
  const smoothed = sharpness.map(s => boxBlur(s, width, height, 3));

  // Per-pixel: select frame with highest smoothed sharpness
  const out = new Uint8ClampedArray(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    let bestFrame = 0;
    let bestVal   = -1;
    for (let f = 0; f < N; f++) {
      if (smoothed[f][p] > bestVal) {
        bestVal   = smoothed[f][p];
        bestFrame = f;
      }
    }
    const i = p * 4;
    out[i]   = frames[bestFrame][i];
    out[i+1] = frames[bestFrame][i+1];
    out[i+2] = frames[bestFrame][i+2];
    out[i+3] = 255;
  }
  return out;
}

function laplacian(luma, width, height) {
  const pixels = width * height;
  const result = new Float32Array(pixels);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p  = y * width + x;
      const c  = luma[p];
      const lap = Math.abs(
        4 * c
        - luma[p - 1]
        - luma[p + 1]
        - luma[p - width]
        - luma[p + width]
      );
      result[p] = lap;
    }
  }
  return result;
}

function gaussianBlur(src, width, height, sigma) {
  // Separable 5-tap Gaussian approximation
  const kernel = makeGaussianKernel(sigma);
  const tmp = new Float32Array(src.length);
  const dst = new Float32Array(src.length);

  // Horizontal pass
  const r = Math.floor(kernel.length / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, wsum = 0;
      for (let k = -r; k <= r; k++) {
        const xi = Math.max(0, Math.min(width - 1, x + k));
        const w  = kernel[k + r];
        sum += src[y * width + xi] * w;
        wsum += w;
      }
      tmp[y * width + x] = sum / wsum;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, wsum = 0;
      for (let k = -r; k <= r; k++) {
        const yi = Math.max(0, Math.min(height - 1, y + k));
        const w  = kernel[k + r];
        sum += tmp[yi * width + x] * w;
        wsum += w;
      }
      dst[y * width + x] = sum / wsum;
    }
  }
  return dst;
}

function makeGaussianKernel(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2));
  const kernel = [];
  for (let i = -r; i <= r; i++) {
    kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  }
  return kernel;
}

function boxBlur(src, width, height, radius) {
  const dst = new Float32Array(src.length);
  const r   = radius;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xi = x + dx, yi = y + dy;
          if (xi >= 0 && xi < width && yi >= 0 && yi < height) {
            sum += src[yi * width + xi];
            count++;
          }
        }
      }
      dst[y * width + x] = sum / count;
    }
  }
  return dst;
}
