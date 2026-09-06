// 前端公共工具：API 封装、格式化、图标、弹窗、toast

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 同源守卫：所有请求仅允许同源相对路径，基于固定 origin 构造 URL（防 SSRF）
export function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new Error('API 路径必须是以 / 开头的同源相对路径');
  }
  return new URL(path, location.origin).href;
}

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(apiUrl(path), init);
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('jd:unauthorized'));
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function fmtSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameYear ? `${md} ${time}` : `${d.getFullYear()}年${md}`;
}

// ---------- 文件类型 ----------

const EXT_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'flv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'],
  pdf: ['pdf'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  code: ['js', 'ts', 'jsx', 'tsx', 'html', 'css', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sh', 'sql', 'php', 'rb', 'swift', 'kt'],
  text: ['txt', 'md', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'ini', 'conf', 'toml'],
};

export function fileKind(item) {
  if (item.type === 'folder') return 'folder';
  const mime = (item.mime || '').toLowerCase();
  const ext = (item.name.split('.').pop() || '').toLowerCase();
  if (item.name.toLowerCase().endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  for (const [kind, exts] of Object.entries(EXT_MAP)) {
    if (exts.includes(ext)) return kind;
  }
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return 'file';
}

const ICON_COLORS = {
  folder: '#f6b73c',
  image: '#22c55e',
  video: '#ef4444',
  audio: '#a855f7',
  pdf: '#f97316',
  archive: '#b45309',
  code: '#0ea5e9',
  text: '#64748b',
  file: '#94a3b8',
};

const ICON_PATHS = {
  folder: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>',
  image:
    '<path d="M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill-opacity=".35"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="M5 17l4.5-5 3 3.4L15 12l4 5z"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2" fill-opacity=".35"/><path d="M10 9l6 3-6 3z"/>',
  audio: '<path d="M9.5 17.5V5.5l9-2v11.5"/><circle cx="7" cy="17.5" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
  pdf: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill-opacity=".35"/><text x="12" y="16.5" font-size="6.5" font-weight="700" text-anchor="middle">PDF</text>',
  archive: '<path d="M4 4h16v5H4z"/><path d="M5 9h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" fill-opacity=".35"/><rect x="10.5" y="4" width="3" height="1.6" rx=".5" fill="#fff" opacity=".85"/>',
  code: '<path d="M9 6L3 12l6 6M15 6l6 6-6 6" fill="none"/>',
  text: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill-opacity=".35"/><path d="M8 11h8M8 14.5h8M8 18h5" fill="none"/>',
  file: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill-opacity=".35"/><path d="M14 2v6h6" fill-opacity=".6"/>',
};

const STROKE_KINDS = ['audio', 'code', 'text'];

export function iconFor(item, size = 22) {
  const kind = fileKind(item);
  const color = ICON_COLORS[kind];
  const attrs = STROKE_KINDS.includes(kind)
    ? `fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`
    : `fill="${color}"`;
  const body = ICON_PATHS[kind]
    .replaceAll('<path', `<path ${attrs}`)
    .replaceAll('<circle', `<circle fill="${color}"`)
    .replaceAll('<rect', `<rect fill="${color}"`)
    .replaceAll('<text', `<text fill="${color}"`);
  return `<svg class="f-icon" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

// ---------- toast ----------

let toastTimer = null;
export function toast(msg, type = 'info') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------- 弹窗 ----------

export function openModal(html, { onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal" role="dialog">${html}</div>`;
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose && onClose();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  backdrop.close = close;
  backdrop.querySelector('.modal').addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  document.body.appendChild(backdrop);
  return backdrop;
}

export function confirmDialog(title, message, { danger = true, okText = '删除' } = {}) {
  return new Promise((resolve) => {
    const m = openModal(`
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        <p class="muted">${escapeHtml(message)}</p>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>取消</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${escapeHtml(okText)}</button>
      </div>`);
    m.querySelector('[data-ok]').addEventListener('click', () => {
      m.close();
      resolve(true);
    });
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) resolve(false);
    });
  });
}

export function promptDialog(title, { placeholder = '', value = '', okText = '确定', label = '' } = {}) {
  return new Promise((resolve) => {
    const m = openModal(`
      <div class="modal-body">
        <h3>${escapeHtml(title)}</h3>
        ${label ? `<p class="muted">${escapeHtml(label)}</p>` : ''}
        <input class="input" id="pd-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}" />
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" data-ok>${escapeHtml(okText)}</button>
      </div>`);
    const input = m.querySelector('#pd-input');
    input.focus();
    input.select();
    const ok = () => {
      const v = input.value.trim();
      m.close();
      resolve(v);
    };
    m.querySelector('[data-ok]').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok();
    });
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) resolve(null);
    });
  });
}

export function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}
