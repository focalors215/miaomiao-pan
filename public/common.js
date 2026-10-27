// 主界面（app.js）和分享页（share.js）共用的工具函数和文件类型图标
export const $ = (s) => document.querySelector(s);
export const $$ = (s) => [...document.querySelectorAll(s)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const use = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="/icons.svg#${id}"/></svg>`;

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtSize(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function join(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

// ==========================================================================
// 文件类型和图标
// ==========================================================================

// 浏览器不支持的格式（HEIC、AVI、AC3……）由服务器转换/转码后播放
export const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff'],
  video: [
    'mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'm3u8', 'avi', 'wmv', 'flv', 'f4v', 'm2ts', 'mts',
    '3gp', 'mpg', 'mpeg', 'vob', 'rm', 'rmvb', 'asf', 'divx', 'xvid',
  ],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'ape', 'wma', 'ac3', 'dts', 'aiff', 'aif', 'amr', 'mka', 'wv', 'tta'],
  pdf: ['pdf'],
};

/** 可预览的文件类型：image / video / audio / pdf，不可预览返回 null */
export function kindOf(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return Object.keys(KINDS).find((k) => KINDS[k].includes(ext)) || null;
}

const GLYPH = {
  image: '<path d="M4 17l4.5-5 3.5 4 2.5-3 5.5 6H4z" fill="#fff"/><circle cx="15.5" cy="8.5" r="2" fill="#fff"/>',
  video: '<path d="M9 7.5v9l7.5-4.5z" fill="#fff"/>',
  audio: '<path d="M10 16.5V6.5l8-2v10" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="8" cy="16.5" r="2.5" fill="#fff"/><circle cx="16" cy="14.5" r="2.5" fill="#fff"/>',
  pdf: '<text x="12" y="16" text-anchor="middle" font-size="8.5" font-weight="800" fill="#fff" font-family="-apple-system,sans-serif">PDF</text>',
  zip: '<path d="M11 3h2v2h-2zm0 4h2v2h-2zm0 4h2v2h-2z" fill="#fff"/><rect x="9.5" y="14" width="5" height="5" rx="1.2" fill="none" stroke="#fff" stroke-width="1.8"/>',
  text: '<path d="M7 8h10M7 12h10M7 16h6" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  code: '<path d="M9.5 8 6 12l3.5 4m5-8 3.5 4-3.5 4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
  file: '<path d="M8 4.5h5.5L17 8v11.5H8z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>',
};
const FILE_COLORS = { image: '#38A9F5', video: '#8B5CF6', audio: '#EC4899', pdf: '#EF4444', zip: '#22A35A', text: '#3B82F6', code: '#64748B', file: '#94A3B8' };
const EXT_GROUP = {
  zip: ['zip', 'rar', '7z', 'gz', 'tar', 'bz2', 'xz', 'tgz'],
  text: ['txt', 'md', 'doc', 'docx', 'rtf', 'pages', 'csv', 'xls', 'xlsx', 'numbers', 'ppt', 'pptx', 'key'],
  code: ['js', 'ts', 'json', 'html', 'css', 'py', 'go', 'java', 'c', 'cpp', 'sh', 'yml', 'yaml', 'xml'],
};

export function fileIcon(it) {
  if (it.isDir) {
    const color = it.mount ? '#6FA4FF' : '#FFC94D';
    const tab = it.mount ? '#4C8DF7' : '#F5B731';
    return `<span class="ficon dir"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 11a3 3 0 0 1 3-3h8.5l3.2 3.2H33a3 3 0 0 1 3 3V30a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="${tab}"/><path d="M4 15.5a3 3 0 0 1 3-3h26a3 3 0 0 1 3 3V30a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="${color}"/></svg></span>`;
  }
  const ext = it.name.includes('.') ? it.name.split('.').pop().toLowerCase() : '';
  const kind = kindOf(it.name) || Object.keys(EXT_GROUP).find((g) => EXT_GROUP[g].includes(ext)) || 'file';
  return `<span class="ficon" style="background:${FILE_COLORS[kind]}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[kind]}</svg></span>`;
}

