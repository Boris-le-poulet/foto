/**
 * captureFrame — 3-tier full-resolution capture with fallback.
 *
 * Tier 1: ImageCapture.takePhoto() at max photo size.
 * Tier 2: applyConstraints to max video res → grabFrame → restore preview.
 * Tier 3: drawImage from preview video element.
 *
 * Returns { blob, source, megapixels }
 */
export async function captureFrame(cam, resolutionMode = 'fullsensor') {
  const hiddenCanvas = document.getElementById('captureCanvas');

  // ---- Tier 1: ImageCapture.takePhoto ----
  if (cam.imageCapture && resolutionMode !== 'preview') {
    try {
      const photoOpts = {};
      const caps = cam.getCapabilities();
      if (caps.photoWidth?.max)  photoOpts.imageWidth  = caps.photoWidth.max;
      if (caps.photoHeight?.max) photoOpts.imageHeight = caps.photoHeight.max;

      const blob = await cam.imageCapture.takePhoto(
        Object.keys(photoOpts).length ? photoOpts : undefined
      );
      const mp = await blobMegapixels(blob);
      return { blob, source: 'ImageCapture', megapixels: mp };
    } catch (e) {
      console.warn('takePhoto failed, trying grabFrame:', e.message);
    }

    // ---- Tier 2: grabFrame at max video res ----
    if (resolutionMode !== 'preview') {
      try {
        let bitmap;
        if (resolutionMode === 'fullsensor' || resolutionMode === 'maxvideo') {
          bitmap = await cam.withMaxResolution(() => cam.imageCapture.grabFrame());
        } else {
          bitmap = await cam.imageCapture.grabFrame();
        }
        const blob = await bitmapToBlob(bitmap, hiddenCanvas);
        const mp   = (bitmap.width * bitmap.height) / 1e6;
        bitmap.close();
        return { blob, source: 'grabFrame', megapixels: parseFloat(mp.toFixed(2)) };
      } catch (e) {
        console.warn('grabFrame failed, using preview frame:', e.message);
      }
    }
  }

  // ---- Tier 3: preview canvas ----
  return previewCapture(hiddenCanvas);
}

/**
 * Capture a single frame from the live preview (lowest fidelity, always works).
 */
export function previewCapture(canvas) {
  const video = document.getElementById('preview');
  const w = video.videoWidth  || 1280;
  const h = video.videoHeight || 720;
  canvas.width  = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return new Promise(resolve => {
    canvas.toBlob(blob => {
      resolve({
        blob,
        source: 'preview',
        megapixels: parseFloat(((w * h) / 1e6).toFixed(2)),
      });
    }, 'image/jpeg', 0.95);
  });
}

/** Draw a blob to the hidden canvas and return the resulting blob. */
export function bitmapToBlob(bitmap, canvas, quality = 0.95) {
  canvas.width  = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0);
  return new Promise(resolve =>
    canvas.toBlob(b => resolve(b), 'image/jpeg', quality)
  );
}

/** Decode a blob's natural dimensions and return its megapixel count. */
export function blobMegapixels(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(parseFloat(((img.naturalWidth * img.naturalHeight) / 1e6).toFixed(2)));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    img.src = url;
  });
}

/** Apply vignette + grain + film simulation + watermark onto a canvas context. */
export function applyLooks(canvas, { filmSim, vignetteAmount, grainAmount, watermarkText }) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  if (filmSim && filmSim !== 'none') {
    applyFilmSim(ctx, w, h, filmSim);
  }

  if (vignetteAmount > 0) {
    const rad = Math.max(w, h) * 0.75;
    const grad = ctx.createRadialGradient(w/2, h/2, rad * (1 - vignetteAmount/100), w/2, h/2, rad);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, `rgba(0,0,0,${vignetteAmount / 100 * 0.7})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  if (grainAmount > 0) {
    const id = ctx.getImageData(0, 0, w, h);
    const d  = id.data;
    const strength = grainAmount * 1.2;
    for (let i = 0; i < d.length; i += 4) {
      const noise = (Math.random() - 0.5) * strength;
      d[i]   = Math.max(0, Math.min(255, d[i]   + noise));
      d[i+1] = Math.max(0, Math.min(255, d[i+1] + noise));
      d[i+2] = Math.max(0, Math.min(255, d[i+2] + noise));
    }
    ctx.putImageData(id, 0, 0);
  }

  if (watermarkText) {
    ctx.save();
    ctx.font = `bold ${Math.max(16, Math.round(h * 0.025))}px sans-serif`;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur  = 6;
    ctx.fillText(watermarkText, 16, h - 16);
    ctx.restore();
  }
}

function applyFilmSim(ctx, w, h, sim) {
  const id = ctx.getImageData(0, 0, w, h);
  const d  = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let r = d[i], g = d[i+1], b = d[i+2];
    switch (sim) {
      case 'velvia': {
        // Saturate
        const avg = (r + g + b) / 3;
        r = avg + (r - avg) * 1.4;
        g = avg + (g - avg) * 1.4;
        b = avg + (b - avg) * 1.2;
        break;
      }
      case 'astia': {
        // Soften / desaturate slightly
        const avg2 = (r + g + b) / 3;
        r = avg2 + (r - avg2) * 0.8;
        g = avg2 + (g - avg2) * 0.8;
        b = avg2 + (b - avg2) * 0.8;
        break;
      }
      case 'acros': {
        // B&W with luminance weights
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = g = b = l;
        break;
      }
      case 'sepia': {
        const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = Math.min(255, l2 * 1.1);
        g = Math.min(255, l2 * 0.9);
        b = Math.min(255, l2 * 0.7);
        break;
      }
      case 'fade': {
        // Lift blacks (matte look)
        r = r * 0.85 + 30;
        g = g * 0.85 + 28;
        b = b * 0.85 + 35;
        break;
      }
      // 'provia' / default — no change
    }
    d[i]   = Math.max(0, Math.min(255, r));
    d[i+1] = Math.max(0, Math.min(255, g));
    d[i+2] = Math.max(0, Math.min(255, b));
  }
  ctx.putImageData(id, 0, 0);
}

/**
 * Crop a canvas to the given aspect ratio (centered crop).
 * aspect: '4:3' | '16:9' | '1:1' | 'native'
 * Returns a new off-DOM canvas with the cropped image.
 */
export function cropToAspect(sourceCanvas, aspect) {
  if (!aspect || aspect === 'native') return sourceCanvas;
  const [aw, ah] = aspect.split(':').map(Number);
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  const targetRatio = aw / ah;
  const srcRatio = srcW / srcH;

  let cropW, cropH;
  if (srcRatio > targetRatio) {
    cropH = srcH;
    cropW = Math.round(srcH * targetRatio);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetRatio);
  }

  const ox = Math.round((srcW - cropW) / 2);
  const oy = Math.round((srcH - cropH) / 2);

  const out = document.createElement('canvas');
  out.width  = cropW;
  out.height = cropH;
  out.getContext('2d').drawImage(sourceCanvas, ox, oy, cropW, cropH, 0, 0, cropW, cropH);
  return out;
}
