# Aperture — Professional Camera Web App

A fully client-side, serverless camera web app. No build step, no backend, no tracking. Every photo stays on your device.

**Live URL:** https://boris-le-poulet.github.io/foto/

---

## Features

| Category | Features |
|----------|----------|
| **Modes** | Photo, Pro (manual controls), Video (MediaRecorder) |
| **Capture** | Single, Self-timer (3s/10s), Burst, HDR bracket, Long Exposure, Timelapse, Focus Stack |
| **Overlays** | Live histogram (RGB + luminance + clipping), Focus peaking (Sobel), Zebra highlights, Rule-of-thirds grid, Horizon level, Tap-to-focus |
| **Pro controls** | ISO, Exposure compensation, Zoom, Focus distance, White balance (Kelvin), Brightness, Contrast, Saturation, Sharpness |
| **Looks** | Film simulations (Provia/Velvia/Astia/Acros/Sepia/Fade), Vignette, Grain, Text watermark |
| **EXIF & GPS** | Full EXIF tags (make, model, ISO, f-number, focal, date/time) + optional GPS geotag |
| **Gallery** | IndexedDB thumbnails, Download, Web Share, tagged by mode |
| **Calculator** | Hyperfocal, DoF, Angle of view, Frame width, Magnification, EV₁₀₀, Sunny-16, 500-rule, ND filter, Pinhole distance |
| **PWA** | Installable, works offline (app shell + CDN dependencies cached) |

---

## Running locally

No build step required. Serve the folder with any static server:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

Or with Node:

```bash
npx serve .
```

---

## Browser compatibility

| Feature | Chrome/Edge (Android/Desktop) | Firefox (Desktop) | Safari (iOS 15+) |
|---------|------|------|------|
| Camera preview | ✓ | ✓ | ✓ |
| Full-res capture | ✓ (ImageCapture) | ✓ | Preview frame only |
| Pro controls | ✓ (most) | Limited | Unavailable |
| Torch | ✓ (Android) | ✗ | ✗ |
| Video recording | ✓ | ✓ | ✗ |
| PWA / offline | ✓ | ✓ | ✓ |

---

## Honest limits

- **No RAW or >8-bit capture.** The browser delivers a processed 8-bit frame regardless of the hardware's RAW capability. `takePhoto()` returns a JPEG.
- **Manual ISO/shutter/torch/optical zoom** depend entirely on the browser and OS exposing `getCapabilities()`. Chrome on Android exposes the most; Safari/iOS exposes almost nothing.
- **HDR and focus stacking assume a steady camera.** There is no frame alignment (no feature matching or homography) in v1. Mount the phone or use a steady surface.
- **Timelapse** captures at preview resolution to avoid repeated `applyConstraints` churn.
- **iOS Safari** has no `ImageCapture` API and no `MediaRecorder` for video. Photo capture is at the live preview resolution (720p–1080p). All Pro controls are disabled.

---

## Architecture

```
index.html               single HTML file, Bootstrap 5.3 dark theme, CDN deps
css/app.css              camera UI styles (fullscreen viewfinder, overlays)
js/app.js                entry point (ES module), wires all modules
js/camera.js             CameraManager — getUserMedia, capabilities, applyConstraints
js/capture.js            3-tier capture: ImageCapture → grabFrame → canvas
js/capabilities.js       feature detection, UI binding, tier classification
js/modes.js              ModeController — all capture modes
js/overlays.js           OverlayManager — throttled rAF loop, pixel analysis
js/exif.js               EXIF + GPS writing (piexifjs)
js/calculator.js         pure optical & exposure formulas
js/gallery.js            IndexedDB gallery
workers/hdr.worker.js    Mertens exposure fusion (classic worker)
workers/stack.worker.js  Laplacian focus stacking (classic worker)
sw.js                    service worker — cache-first, CDN + shell
manifest.webmanifest     PWA manifest
```

All dependencies load from CDN. No `node_modules`, no build step, no compiler.

---

## CDN dependencies

- [Bootstrap 5.3.3](https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css)
- [Bootstrap Icons 1.11.3](https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css)
- [piexifjs 1.0.6](https://cdn.jsdelivr.net/npm/piexifjs@1.0.6/piexif.js)
