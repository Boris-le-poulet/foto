/**
 * exif.js — EXIF tag writing via the global `piexif` object (piexifjs CDN).
 *
 * piexifjs must be loaded as a classic <script> before this ES module.
 */

export function buildExifStr({ settings, gps, timestamp }) {
  if (typeof piexif === 'undefined') return null;

  const piexifObj = window.piexif;
  const zeroth = {};
  const exif   = {};
  const gpsIfd = {};

  zeroth[piexifObj.ImageIFD.Make]  = 'Web Browser';
  zeroth[piexifObj.ImageIFD.Model] = (navigator.userAgent || '').slice(0, 128);
  zeroth[piexifObj.ImageIFD.Software]  = 'Aperture PWA';
  zeroth[piexifObj.ImageIFD.DateTime]  = _formatDatetime(timestamp || new Date());
  zeroth[piexifObj.ImageIFD.Orientation] = 1;

  if (settings?.exposureTime)
    exif[piexifObj.ExifIFD.ExposureTime] = _toRational(settings.exposureTime);
  if (settings?.fNumber)
    exif[piexifObj.ExifIFD.FNumber] = _toRational(settings.fNumber);
  if (settings?.iso)
    exif[piexifObj.ExifIFD.ISOSpeedRatings] = Math.round(settings.iso);
  if (settings?.focalLength)
    exif[piexifObj.ExifIFD.FocalLength] = _toRational(settings.focalLength);

  exif[piexifObj.ExifIFD.ColorSpace] = 1; // sRGB
  exif[piexifObj.ExifIFD.FlashPixVersion] = '0100';

  if (settings?.width)
    exif[piexifObj.ExifIFD.PixelXDimension] = Math.round(settings.width);
  if (settings?.height)
    exif[piexifObj.ExifIFD.PixelYDimension] = Math.round(settings.height);

  exif[piexifObj.ExifIFD.DateTimeOriginal]  = _formatDatetime(timestamp || new Date());
  exif[piexifObj.ExifIFD.DateTimeDigitized] = _formatDatetime(timestamp || new Date());

  const out = { '0th': zeroth, 'Exif': exif };

  if (gps?.lat != null && gps?.lng != null) {
    gpsIfd[piexifObj.GPSIFD.GPSLatitudeRef]  = gps.lat >= 0 ? 'N' : 'S';
    gpsIfd[piexifObj.GPSIFD.GPSLatitude]     = _toDMS(Math.abs(gps.lat));
    gpsIfd[piexifObj.GPSIFD.GPSLongitudeRef] = gps.lng >= 0 ? 'E' : 'W';
    gpsIfd[piexifObj.GPSIFD.GPSLongitude]    = _toDMS(Math.abs(gps.lng));
    if (gps.altitude != null)
      gpsIfd[piexifObj.GPSIFD.GPSAltitude] = _toRational(Math.abs(gps.altitude));
    out['GPS'] = gpsIfd;
  }

  try {
    return piexifObj.dump(out);
  } catch (e) {
    console.warn('piexif.dump failed:', e);
    return null;
  }
}

export async function injectExif(jpegBlob, exifStr) {
  if (!exifStr) return jpegBlob;
  try {
    const arrayBuffer = await jpegBlob.arrayBuffer();
    const dataStr  = _arrayBufferToString(arrayBuffer);
    const newData  = window.piexif.insert(exifStr, dataStr);
    const buf      = _stringToArrayBuffer(newData);
    return new Blob([buf], { type: 'image/jpeg' });
  } catch (e) {
    console.warn('EXIF injection failed:', e);
    return jpegBlob;
  }
}

// ---- Helpers ----

function _formatDatetime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}:${pad(d.getMonth()+1)}:${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function _toRational(value) {
  const denom = 10000;
  return [Math.round(value * denom), denom];
}

function _toDMS(decimal) {
  const deg  = Math.floor(decimal);
  const minF = (decimal - deg) * 60;
  const min  = Math.floor(minF);
  const sec  = (minF - min) * 60;
  return [[deg, 1], [min, 1], [Math.round(sec * 100), 100]];
}

function _arrayBufferToString(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    str += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return str;
}

function _stringToArrayBuffer(str) {
  const buf  = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) view[i] = str.charCodeAt(i) & 0xff;
  return buf;
}
