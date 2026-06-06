/**
 * GalleryManager — IndexedDB photo gallery with thumbnails, download, and Web Share.
 */

const DB_NAME    = 'aperture_gallery';
const DB_VERSION = 1;
const STORE      = 'photos';
const THUMB_SIZE = 200;

export class GalleryManager {
  constructor() {
    this._db = null;
  }

  async init() {
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('timestamp', 'timestamp');
          store.createIndex('mode', 'mode');
        }
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async save(blob, mode, metadata = {}) {
    const thumbnail = await this._makeThumbnail(blob);
    const timestamp = Date.now();
    const record    = { blob, thumbnail, mode, timestamp, metadata };

    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction([STORE], 'readwrite');
      const req = tx.objectStore(STORE).add(record);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async getAll() {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction([STORE], 'readonly');
      const req = tx.objectStore(STORE).index('timestamp').getAll();
      req.onsuccess = e => resolve(e.target.result.reverse());
      req.onerror   = e => reject(e.target.error);
    });
  }

  async getById(id) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction([STORE], 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async deleteById(id) {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction([STORE], 'readwrite');
      const req = tx.objectStore(STORE).delete(id);
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async clearAll() {
    return new Promise((resolve, reject) => {
      const tx  = this._db.transaction([STORE], 'readwrite');
      const req = tx.objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror   = e => reject(e.target.error);
    });
  }

  async render(container) {
    container.innerHTML = '';
    const items = await this.getAll();

    const countEl = document.getElementById('galleryCount');
    if (countEl) countEl.textContent = `${items.length} item${items.length !== 1 ? 's' : ''}`;

    if (!items.length) {
      container.innerHTML = '<p class="text-secondary text-center mt-5">No photos yet.</p>';
      return;
    }

    for (const item of items) {
      const thumbUrl = URL.createObjectURL(item.thumbnail);
      const el = document.createElement('div');
      el.className = 'ap-gallery-item';
      el.dataset.id = item.id;

      const ext = _mimeToExt(item.blob.type);
      const date = new Date(item.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

      el.innerHTML = `
        <img src="${thumbUrl}" alt="${item.mode} ${date}" loading="lazy">
        <div class="ap-gallery-badge">${item.mode}</div>
        <div class="ap-gallery-actions">
          <button class="ap-icon-btn btn-sm" data-action="download" aria-label="Download">
            <i class="bi bi-download"></i>
          </button>
          ${navigator.share ? `<button class="ap-icon-btn btn-sm" data-action="share" aria-label="Share">
            <i class="bi bi-share"></i>
          </button>` : ''}
          <button class="ap-icon-btn btn-sm text-danger" data-action="delete" aria-label="Delete">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      `;

      // Revoke thumbnail URL after render
      const img = el.querySelector('img');
      img.onload = () => URL.revokeObjectURL(thumbUrl);

      el.addEventListener('click', async e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (!action) return;
        e.stopPropagation();
        const record = await this.getById(item.id);
        if (!record) return;
        if (action === 'download') this.download(record);
        if (action === 'share')   this.share(record);
        if (action === 'delete') {
          await this.deleteById(item.id);
          el.remove();
          const remaining = container.querySelectorAll('.ap-gallery-item').length;
          if (countEl) countEl.textContent = `${remaining} item${remaining !== 1 ? 's' : ''}`;
        }
      });

      container.appendChild(el);
    }
  }

  download(record) {
    const ext  = _mimeToExt(record.blob.type);
    const date = new Date(record.timestamp).toISOString().slice(0, 19).replace(/:/g, '-');
    const name = `aperture_${record.mode}_${date}.${ext}`;
    const url  = URL.createObjectURL(record.blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async share(record) {
    if (!navigator.share) return;
    const ext  = _mimeToExt(record.blob.type);
    const name = `aperture_${record.mode}.${ext}`;
    const file = new File([record.blob], name, { type: record.blob.type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Photo from Aperture' });
      } else {
        await navigator.share({ title: 'Photo from Aperture', text: `Captured with Aperture in ${record.mode} mode` });
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Share failed:', e);
    }
  }

  async _makeThumbnail(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const ratio = img.naturalWidth / img.naturalHeight;
        const [tw, th] = ratio > 1
          ? [THUMB_SIZE, Math.round(THUMB_SIZE / ratio)]
          : [Math.round(THUMB_SIZE * ratio), THUMB_SIZE];
        const c = document.createElement('canvas');
        c.width  = tw;
        c.height = th;
        c.getContext('2d').drawImage(img, 0, 0, tw, th);
        c.toBlob(b => resolve(b), 'image/jpeg', 0.75);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }
}

function _mimeToExt(mime) {
  if (!mime) return 'jpg';
  if (mime.includes('png'))  return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}
