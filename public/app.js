import { renderPreview as renderMedia } from './preview.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const use = (id, cls = '') => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') showLogin();
  if (!r.ok) throw new Error(data.error || `请求失败 (${r.status})`);
  return data;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function fmtSize(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}  ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function join(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

// ==========================================================================
// 文件类型和图标
// ==========================================================================

// 浏览器不支持的格式（HEIC、AVI、AC3……）由服务器转换/转码后播放
const KINDS = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff'],
  video: [
    'mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'm3u8', 'avi', 'wmv', 'flv', 'f4v', 'm2ts', 'mts',
    '3gp', 'mpg', 'mpeg', 'vob', 'rm', 'rmvb', 'asf', 'divx', 'xvid',
  ],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'ape', 'wma', 'ac3', 'dts', 'aiff', 'aif', 'amr', 'mka', 'wv', 'tta'],
  pdf: ['pdf'],
};

/** 可预览的文件类型：image / video / audio / pdf，不可预览返回 null */
function kindOf(name) {
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

function fileIcon(it) {
  if (it.isDir) {
    const color = it.mount ? '#6FA4FF' : '#FFC94D';
    const tab = it.mount ? '#4C8DF7' : '#F5B731';
    return `<span class="ficon dir"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 11a3 3 0 0 1 3-3h8.5l3.2 3.2H33a3 3 0 0 1 3 3V30a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="${tab}"/><path d="M4 15.5a3 3 0 0 1 3-3h26a3 3 0 0 1 3 3V30a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="${color}"/></svg></span>`;
  }
  const ext = it.name.includes('.') ? it.name.split('.').pop().toLowerCase() : '';
  const kind = kindOf(it.name) || Object.keys(EXT_GROUP).find((g) => EXT_GROUP[g].includes(ext)) || 'file';
  return `<span class="ficon" style="background:${FILE_COLORS[kind]}"><svg viewBox="0 0 24 24" aria-hidden="true">${GLYPH[kind]}</svg></span>`;
}

const fileUrl = (p, inline = false) => `/api/fs/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;

// ==========================================================================
// 通用：带动画的对话框、确认/输入框、提示条、显示密码
// ==========================================================================

/** 关闭对话框前先播放退场动画（面板滑出、弹窗缩小） */
function closeDialog(dlg) {
  if (!dlg.open || dlg.classList.contains('closing')) return;
  if (reduceMotion()) return dlg.close();
  dlg.classList.add('closing');
  const done = () => {
    dlg.classList.remove('closing');
    dlg.close();
  };
  dlg.addEventListener('animationend', done, { once: true });
  setTimeout(() => dlg.classList.contains('closing') && done(), 500); // 兜底
}

for (const dlg of $$('dialog:not(.preview)')) {
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault(); // Esc 也走退场动画
    closeDialog(dlg);
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) closeDialog(dlg); // 点遮罩或“取消”关闭
  });
}

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${use(type === 'ok' ? 'i-check' : 'i-close')}<span></span>`;
  el.querySelector('span').textContent = text;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 500);
  }, 2600);
}

/**
 * 替代浏览器原生 prompt/confirm：
 *   ask({ title, message, value })            -> 输入的文本，取消返回 null
 *   ask({ title, message, confirm: true })    -> true / null
 * validate(text) 返回错误提示时不关闭，可用于异步提交（返回 Promise）。
 */
function ask({ title, message = '', value, placeholder = '', okText = '确定', danger = false, validate }) {
  const dlg = $('#ask');
  const input = $('#ask-input');
  const ok = $('#ask-ok');
  const isInput = value !== undefined;
  $('#ask-title').textContent = title;
  $('#ask-message').textContent = message;
  $('#ask-message').hidden = !message;
  $('#ask-error').textContent = '';
  input.hidden = !isInput;
  input.value = value ?? '';
  input.placeholder = placeholder;
  ok.textContent = okText;
  ok.className = `btn ${danger ? 'danger fill' : 'primary'}`;
  if (danger) ok.style.cssText = 'background:var(--danger);color:#fff;border-color:var(--danger)';
  else ok.style.cssText = '';
  dlg.showModal();
  if (isInput) {
    input.focus();
    // 重命名时只选中文件名主体，不选扩展名（和 Finder 一样）
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  } else ok.focus();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      $('#ask-form').removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      resolve(v);
    };
    const onSubmit = async (e) => {
      e.preventDefault();
      const v = isInput ? input.value.trim() : true;
      if (isInput && !v) return;
      if (validate) {
        ok.disabled = true;
        const err = await validate(v).catch((e2) => e2.message);
        ok.disabled = false;
        if (err) return ($('#ask-error').textContent = err);
      }
      finish(v);
      closeDialog(dlg);
    };
    const onClose = () => finish(null);
    $('#ask-form').addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
  });
}

// 密码框右侧的“眼睛”：切换显示/隐藏
document.addEventListener('click', (e) => {
  const eye = e.target.closest('.eye');
  if (!eye) return;
  const input = eye.parentElement.querySelector('input');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  eye.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  eye.querySelector('use').setAttribute('href', show ? '#i-eye' : '#i-eye-off');
});

// ==========================================================================
// 登录
// ==========================================================================

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  closeMenu(true);
  document.title = '登录 · 喵喵零和小鱼的仓库';
  setTimeout(() => $('#login-form').username.focus(), 50);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type="submit"]');
  if (!f.username.value || !f.password.value) return ($('#login-error').textContent = '请输入用户名和密码');
  btn.disabled = true;
  try {
    await api('POST', '/api/login', { username: f.username.value, password: f.password.value, remember: f.remember.checked });
    $('#login-error').textContent = '';
    f.password.value = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
    f.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], {
      duration: reduceMotion() ? 1 : 320,
      easing: 'ease-in-out',
    });
  } finally {
    btn.disabled = false;
  }
});

$('#forgot').addEventListener('click', () =>
  ask({
    title: '忘记密码',
    message: '请服务器管理员在 .env 里设置新的 ADMIN_PASSWORD，并加上 ADMIN_RESET=true 后重启。登录后把 ADMIN_RESET 改回 false。',
    confirm: true,
    okText: '知道了',
  }),
);

// ==========================================================================
// 头像菜单
// ==========================================================================

const menu = $('#account-menu');
const menuBtn = $('#account-btn');

function openMenu() {
  menu.hidden = false;
  menu.classList.remove('closing');
  menuBtn.setAttribute('aria-expanded', 'true');
  menu.querySelector('button').focus();
}
function closeMenu(instant = false) {
  if (menu.hidden) return;
  menuBtn.setAttribute('aria-expanded', 'false');
  if (instant || reduceMotion()) return (menu.hidden = true);
  menu.classList.add('closing');
  menu.addEventListener('animationend', () => menu.classList.contains('closing') && (menu.hidden = true), { once: true });
}
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menu.hidden || menu.classList.contains('closing') ? openMenu() : closeMenu();
});
document.addEventListener('click', (e) => !e.target.closest('.account') && closeMenu());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !menu.hidden) {
    closeMenu();
    menuBtn.focus();
  }
});
$('#menu-logout').addEventListener('click', async () => {
  closeMenu(true);
  await api('POST', '/api/logout');
  showLogin();
});
$('#menu-settings').addEventListener('click', () => {
  closeMenu(true);
  openAccount();
});

// ==========================================================================
// 视图切换：侧边栏胶囊滑动 + 页面横向滑入
// ==========================================================================

const VIEWS = ['files', 'storages'];
let currentView = null;

function movePill() {
  const active = $('.nav-item.active');
  let pill = $('.nav-pill');
  if (!pill) {
    pill = document.createElement('span');
    pill.className = 'nav-pill';
    $('.sidebar').prepend(pill);
  }
  if (!active) return;
  const horizontal = matchMedia('(max-width: 900px)').matches;
  pill.style.width = horizontal ? `${active.offsetWidth}px` : '';
  pill.style.top = horizontal ? '' : '0';
  pill.style.transform = horizontal ? `translateX(${active.offsetLeft - 6}px)` : `translateY(${active.offsetTop}px)`;
}
addEventListener('resize', movePill);

function setView(view) {
  const prev = currentView;
  currentView = view;
  $$('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.toggleAttribute('aria-current', b.dataset.view === view);
  });
  movePill();
  for (const v of VIEWS) {
    const el = $(`#view-${v}`);
    el.hidden = v !== view;
    el.classList.remove('enter-right', 'enter-left');
  }
  if (prev && prev !== view) {
    const el = $(`#view-${view}`);
    void el.offsetWidth; // 重新触发动画
    el.classList.add(VIEWS.indexOf(view) > VIEWS.indexOf(prev) ? 'enter-right' : 'enter-left');
  }
  $('.search').style.visibility = view === 'files' ? '' : 'hidden';
  if (view === 'storages') document.title = '存储挂载 · 喵喵零和小鱼的仓库';
  if (view === 'storages') loadStorages();
  else loadFiles();
}
$$('.nav-item').forEach((b) =>
  b.addEventListener('click', () => {
    if (b.dataset.view === 'files' && currentView === 'files' && location.hash.length > 2) location.hash = '#/';
    else setView(b.dataset.view);
  }),
);

// ==========================================================================
// 文件浏览：排序、搜索、多选
// ==========================================================================

const currentPath = () => decodeURIComponent(location.hash.slice(1)) || '/';
let currentItems = [];
let sort = { key: 'name', dir: 1 };
const selected = new Set();

function renderCrumbs(p) {
  const segs = p.split('/').filter(Boolean);
  let acc = '';
  const parts = [`<a class="home" href="#/" aria-label="全部文件">${use('i-home')}</a>`, use('i-chevron', 'sep'), `<a href="#/">全部文件</a>`];
  for (const s of segs) {
    acc += '/' + s;
    parts.push(use('i-chevron', 'sep'), `<a href="#${encodeURIComponent(acc)}">${esc(s)}</a>`);
  }
  $('#crumbs').innerHTML = parts.join('');
  document.title = `${segs.at(-1) || '全部文件'} · 喵喵零和小鱼的仓库`;
}

function visibleItems() {
  const q = $('#search').value.trim().toLowerCase();
  const list = q ? currentItems.filter((it) => it.name.toLowerCase().includes(q)) : [...currentItems];
  const { key, dir } = sort;
  return list.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 文件夹永远在前
    if (key === 'name') return dir * a.name.localeCompare(b.name, 'zh', { numeric: true });
    const va = key === 'size' ? a.size || 0 : new Date(a.modified || 0).getTime();
    const vb = key === 'size' ? b.size || 0 : new Date(b.modified || 0).getTime();
    return dir * (va - vb) || a.name.localeCompare(b.name, 'zh');
  });
}

function renderFiles(animate = false) {
  const p = currentPath();
  const items = visibleItems();
  const q = $('#search').value.trim();
  $('#empty').hidden = items.length > 0;
  $('#empty .empty-title').textContent = q ? `没有找到“${q}”` : '这里还空空的';
  $('#empty .empty-sub').textContent = q ? '换个关键词试试，搜索只在当前文件夹里进行' : '把文件拖到这里，或者点“上传文件”';
  $('#file-rows').innerHTML = items
    .map((it, i) => {
      const full = join(p, it.name);
      const href = it.isDir ? `#${encodeURIComponent(full)}` : fileUrl(full);
      const preview = !it.isDir && kindOf(it.name) ? 'data-preview' : '';
      const sel = selected.has(it.name);
      const check = it.mount
        ? ''
        : `<label class="checkbox"><input type="checkbox" data-check ${sel ? 'checked' : ''} aria-label="选择 ${esc(it.name)}"><span></span></label>`;
      const actions = it.mount
        ? ''
        : `<span class="row-actions"><button class="act" data-act="rename" aria-label="重命名 ${esc(it.name)}">${use('i-pencil')}<span>重命名</span></button><button class="act danger" data-act="delete" aria-label="删除 ${esc(it.name)}">${use('i-trash')}<span>删除</span></button></span>`;
      const style = animate && i < 24 && !reduceMotion() ? ` style="animation-delay:${i * 18}ms"` : '';
      return `<tr data-path="${esc(full)}" data-name="${esc(it.name)}" class="${animate ? 'row-in' : ''} ${sel ? 'selected' : ''}"${style}>
        <td>${check}</td>
        <td><a class="name" href="${href}" ${preview} ${it.isDir ? '' : 'target="_blank" rel="noopener"'}>${fileIcon(it)}<span>${esc(it.name)}</span></a></td>
        <td class="num">${it.isDir ? '—' : fmtSize(it.size)}</td>
        <td class="muted">${fmtTime(it.modified)}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join('');
  $$('.sort').forEach((b) => {
    b.classList.toggle('asc', b.dataset.sort === sort.key && sort.dir === 1);
    b.classList.toggle('desc', b.dataset.sort === sort.key && sort.dir === -1);
    b.closest('th').setAttribute('aria-sort', b.dataset.sort === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
  });
  updateSelection();
}

async function loadFiles() {
  const p = currentPath();
  renderCrumbs(p);
  selected.clear();
  try {
    const { items } = await api('GET', `/api/fs/list?path=${encodeURIComponent(p)}`);
    if (p !== currentPath()) return; // 加载期间又切换了目录
    currentItems = items;
    renderFiles(true);
  } catch (err) {
    currentItems = [];
    $('#file-rows').innerHTML = `<tr><td colspan="5" class="error" style="text-align:center">${esc(err.message)}</td></tr>`;
    $('#empty').hidden = true;
    updateSelection();
  }
}

window.addEventListener('hashchange', () => {
  $('#search').value = '';
  if (currentView !== 'files') setView('files');
  else loadFiles();
});
$('#btn-refresh').addEventListener('click', (e) => {
  const icon = e.currentTarget.querySelector('svg');
  icon.animate?.([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: reduceMotion() ? 1 : 600, easing: 'cubic-bezier(.32,.72,0,1)' });
  loadFiles();
});
$('#search').addEventListener('input', () => renderFiles());
$('#search').addEventListener('keydown', (e) => e.key === 'Escape' && (($('#search').value = ''), renderFiles()));

$$('.sort').forEach((b) =>
  b.addEventListener('click', () => {
    sort = sort.key === b.dataset.sort ? { key: sort.key, dir: -sort.dir } : { key: b.dataset.sort, dir: b.dataset.sort === 'name' ? 1 : -1 };
    renderFiles();
  }),
);

// 多选
function selectableNames() {
  return visibleItems()
    .filter((it) => !it.mount)
    .map((it) => it.name);
}
function updateSelection() {
  const names = selectableNames();
  const n = names.filter((x) => selected.has(x)).length;
  const all = $('#check-all');
  all.checked = n > 0 && n === names.length;
  all.indeterminate = n > 0 && n < names.length;
  all.disabled = names.length === 0;
  const bar = $('#selection-bar');
  $('#selection-count').textContent = `已选择 ${n} 项`;
  bar.hidden = n === 0;
}
$('#check-all').addEventListener('change', (e) => {
  for (const name of selectableNames()) e.target.checked ? selected.add(name) : selected.delete(name);
  renderFiles();
});
$('#sel-clear').addEventListener('click', () => {
  selected.clear();
  renderFiles();
});
$('#sel-delete').addEventListener('click', async () => {
  const names = [...selected];
  const ok = await ask({
    title: `删除 ${names.length} 项？`,
    message: names.length <= 3 ? names.join('、') : `${names.slice(0, 3).join('、')} 等 ${names.length} 项`,
    confirm: true,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/fs/delete', { paths: names.map((n) => join(currentPath(), n)) });
    toast(`已删除 ${names.length} 项`);
  } catch (err) {
    toast(err.message, 'error');
  }
  loadFiles();
});

$('#file-rows').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-check]');
  if (!cb) return;
  const tr = cb.closest('tr');
  cb.checked ? selected.add(tr.dataset.name) : selected.delete(tr.dataset.name);
  tr.classList.toggle('selected', cb.checked);
  updateSelection();
});

$('#file-rows').addEventListener('click', async (e) => {
  const link = e.target.closest('a[data-preview]');
  if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault();
    return openPreview(link.closest('tr').dataset.name);
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const { path, name } = tr.dataset;
  if (btn.dataset.act === 'rename') {
    const next = await ask({
      title: '重命名',
      value: name,
      okText: '重命名',
      validate: async (v) => (v === name ? null : (await api('POST', '/api/fs/rename', { path, name: v }), null)),
    });
    if (next && next !== name) {
      toast('已重命名');
      loadFiles();
    }
  } else {
    const ok = await ask({ title: `删除“${name}”？`, message: '删除后无法在网页上恢复。', confirm: true, okText: '删除', danger: true });
    if (!ok) return;
    try {
      await api('POST', '/api/fs/delete', { paths: [path] });
      tr.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateX(24px)' }], { duration: reduceMotion() ? 1 : 260, easing: 'ease-in' }).finished.then(loadFiles, loadFiles);
      toast('已删除');
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

$('#btn-mkdir').addEventListener('click', async () => {
  const name = await ask({
    title: '新建文件夹',
    value: '',
    placeholder: '文件夹名称',
    okText: '新建',
    validate: async (v) => (await api('POST', '/api/fs/mkdir', { path: currentPath(), name: v }), null),
  });
  if (name) {
    toast('已新建文件夹');
    loadFiles();
  }
});

// ==========================================================================
// 预览
// ==========================================================================

const pv = { dialog: $('#preview'), list: [], index: 0 };

function openPreview(name) {
  pv.dir = currentPath();
  pv.list = visibleItems().filter((it) => !it.isDir && kindOf(it.name));
  pv.index = Math.max(0, pv.list.findIndex((it) => it.name === name));
  renderPreview();
  if (!pv.dialog.open) pv.dialog.showModal();
}

let cleanup = null;
let renderSeq = 0;

function clearPreview() {
  renderSeq++;
  try {
    cleanup?.();
  } catch {}
  cleanup = null;
  $('#pv-body').replaceChildren(); // 移除旧元素会顺带停止正在播放的音视频
}

async function renderPreview() {
  const it = pv.list[pv.index];
  const full = join(pv.dir, it.name);
  const kind = kindOf(it.name);
  $('#pv-name').textContent = it.name;
  $('#pv-count').textContent = pv.list.length > 1 ? `${pv.index + 1} / ${pv.list.length}` : '';
  $('#pv-open').href = fileUrl(full, true);
  $('#pv-download').href = fileUrl(full);
  $('#pv-prev').hidden = $('#pv-next').hidden = pv.list.length < 2;

  clearPreview();
  const seq = renderSeq;
  const body = $('#pv-body');
  body.dataset.kind = kind;
  const q = encodeURIComponent(full);
  const urls = {
    inline: fileUrl(full, true),
    raw: fileUrl(full),
    proxy: fileUrl(full, true) + '&proxy=1', // 强制经服务器中转（302 目标浏览器访问不到时）
    path: '/api/fs/d' + full.split('/').map(encodeURIComponent).join('/'),
    probe: `/api/fs/probe?path=${q}`,
    image: `/api/fs/image?path=${q}`,
  };
  $('#pv-status').textContent = '';
  const isStale = () => seq !== renderSeq;
  const onError = (msg) => !isStale() && previewError(kind, it.name, msg);
  const onStatus = (text) => !isStale() && ($('#pv-status').textContent = text);
  // 每次渲染用独立容器：加载期间切换了文件，旧渲染只会写进已被移除的旧容器
  const slot = document.createElement('div');
  slot.className = 'pv-slot';
  body.append(slot);
  try {
    const fn = await renderMedia(slot, { kind, name: it.name, path: full, urls, onError, onStatus, isStale });
    if (seq === renderSeq) cleanup = fn;
    else fn(); // 加载期间已经切到别的文件
  } catch (e) {
    console.error(e);
    onError();
  }
}

// 只有直接播放、服务器代理、服务器转码全部失败才会走到这里（文件损坏、服务器没装 ffmpeg 等）
function previewError(kind, name, msg) {
  const hint = `预览失败${msg ? '：' + msg : ''}。文件可能已损坏，可以下载后查看。`;
  clearPreview();
  $('#pv-body').innerHTML = `<p class="pv-error">${esc(hint)}</p>`;
}

function stepPreview(d) {
  if (pv.list.length < 2) return;
  pv.index = (pv.index + d + pv.list.length) % pv.list.length;
  renderPreview();
}

$('#pv-prev').addEventListener('click', () => stepPreview(-1));
$('#pv-next').addEventListener('click', () => stepPreview(1));
function closePreview() {
  pv.dialog.close();
  clearPreview(); // 不只依赖 close 事件，确保音视频立即停止
}

$('#pv-close').addEventListener('click', closePreview);
pv.dialog.addEventListener('close', clearPreview); // Esc 关闭时走这里
pv.dialog.addEventListener('click', (e) => {
  if (e.target === pv.dialog || e.target === $('#pv-body')) closePreview(); // 点空白处关闭
});
document.addEventListener('keydown', (e) => {
  if (!pv.dialog.open) return;
  if (e.key === 'ArrowLeft') stepPreview(-1);
  if (e.key === 'ArrowRight') stepPreview(1);
});
// 手机上左右滑动切换文件
{
  let x0 = null;
  pv.dialog.addEventListener('touchstart', (e) => e.touches.length === 1 && (x0 = e.touches[0].clientX), { passive: true });
  pv.dialog.addEventListener('touchend', (e) => {
    if (x0 === null || $('#pv-body').dataset.kind === 'pdf' || $('#pv-body').dataset.kind === 'image') return (x0 = null);
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60) stepPreview(dx < 0 ? 1 : -1);
  });
}

// ==========================================================================
// 上传
// ==========================================================================

// 分块上传：每块一个请求（默认 20MB，远小于 Cloudflare 免费版 100MB 的上限），失败自动重试；
// 同一个文件再次上传会跳过服务器已收到的块（断点续传）。所有块传完后服务器在后台写入存储，这里轮询进度。
function putChunk(url, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status === 200) return resolve();
      let msg = `失败 (${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {}
      reject(Object.assign(new Error(msg), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('网络错误'), { status: 0 }));
    xhr.onabort = () => reject(Object.assign(new Error('已取消'), { aborted: true }));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

const uploadStats = { active: 0, done: 0 };
function updateUploadPanel() {
  const panel = $('#uploads');
  const n = $('#upload-list').children.length;
  panel.hidden = n === 0;
  $('#uploads-summary').textContent = uploadStats.active ? `${uploadStats.active} 个进行中` : `已完成 ${uploadStats.done} 个`;
}

async function uploadOne(file, dir) {
  const el = document.createElement('div');
  el.className = 'upload';
  el.innerHTML = `<div class="upload-head"><span class="upload-name"></span><span class="pct">准备中…</span><button class="upload-cancel" title="取消" aria-label="取消上传">${use('i-close')}</button></div><div class="bar"><i></i></div>`;
  el.querySelector('.upload-name').textContent = file.name;
  $('#upload-list').append(el);
  uploadStats.active++;
  updateUploadPanel();
  const pctEl = el.querySelector('.pct');
  const barEl = el.querySelector('i');
  const ac = new AbortController();
  let uploadId = null;
  el.querySelector('.upload-cancel').addEventListener('click', () => {
    ac.abort();
    if (uploadId) api('DELETE', `/api/uploads/${uploadId}`).catch(() => {});
  });
  const show = (text, ratio) => {
    pctEl.textContent = text;
    if (ratio !== undefined) barEl.style.width = `${Math.round(ratio * 100)}%`;
  };
  const finish = (ms) => {
    uploadStats.active--;
    updateUploadPanel();
    setTimeout(() => {
      el.animate?.([{ opacity: 1 }, { opacity: 0, transform: 'translateX(24px)' }], { duration: reduceMotion() ? 1 : 260, easing: 'ease-in' });
      setTimeout(() => {
        el.remove();
        if (!$('#upload-list').children.length) uploadStats.done = 0;
        updateUploadPanel();
      }, 250);
    }, ms);
  };

  try {
    const s = await api('POST', '/api/uploads', { path: dir, name: file.name, size: file.size, lastModified: file.lastModified });
    uploadId = s.id;
    if (s.status !== 'processing') {
      const done = new Set(s.received);
      const sizeOf = (i) => Math.min(s.chunkSize, file.size - i * s.chunkSize);
      let doneBytes = [...done].reduce((a, i) => a + sizeOf(i), 0);
      const inflight = new Map(); // 正在传的块 -> 已发送字节
      const report = () => {
        const sent = doneBytes + [...inflight.values()].reduce((a, b) => a + b, 0);
        const ratio = file.size ? sent / file.size : 1;
        show(`${Math.min(99, Math.floor(ratio * 100))}%`, ratio);
      };
      if (done.size) report(); // 续传：直接显示已完成的进度
      const queue = [];
      for (let i = 0; i < s.chunks; i++) if (!done.has(i)) queue.push(i);
      const worker = async () => {
        while (queue.length) {
          const i = queue.shift();
          const blob = file.slice(i * s.chunkSize, i * s.chunkSize + sizeOf(i));
          for (let attempt = 1; ; attempt++) {
            try {
              inflight.set(i, 0);
              await putChunk(`/api/uploads/${s.id}/${i}`, blob, (n) => (inflight.set(i, n), report()), ac.signal);
              inflight.delete(i);
              doneBytes += blob.size;
              report();
              break;
            } catch (e) {
              inflight.delete(i);
              const retryable = !e.aborted && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500);
              if (!retryable || attempt >= 5) throw e;
              show(`第 ${i + 1} 块失败，${attempt * 2} 秒后重试…`);
              await sleep(attempt * 2000);
            }
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      await api('POST', `/api/uploads/${s.id}/complete`);
    }
    // 服务器把文件写入存储（S3、123云盘等可能需要较长时间），轮询结果
    show('服务器处理中…', 1);
    for (;;) {
      if (ac.signal.aborted) throw Object.assign(new Error('已取消'), { aborted: true });
      const st = await api('GET', `/api/uploads/${s.id}`);
      if (st.status === 'done') break;
      if (st.status === 'error') throw new Error(st.error || '写入存储失败');
      await sleep(1000);
    }
    el.classList.add('done');
    el.querySelector('.upload-cancel').remove();
    show('已完成', 1);
    uploadStats.done++;
    finish(1500);
  } catch (e) {
    el.classList.add('failed');
    el.querySelector('.upload-cancel')?.remove();
    show(e.aborted ? '已取消' : `${e.message}（再次上传同一文件可从断点继续）`);
    finish(e.aborted ? 1200 : 10000);
  }
}

async function uploadFiles(files) {
  const dir = currentPath();
  const queue = [...files];
  const worker = async () => {
    while (queue.length) await uploadOne(queue.shift(), dir);
  };
  await Promise.all([worker(), worker(), worker()]);
  if (currentPath() === dir && currentView === 'files') loadFiles();
}

$('#upload-input').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});

const drop = $('#drop');
let dragDepth = 0;
drop.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  drop.classList.add('dragover');
});
drop.addEventListener('dragover', (e) => e.preventDefault());
drop.addEventListener('dragleave', () => --dragDepth <= 0 && ((dragDepth = 0), drop.classList.remove('dragover')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

// ==========================================================================
// 存储管理
// ==========================================================================

let types = {};
let storages = [];
let editing = null;

const STORAGE_ICON = {
  local: use('i-storage'),
  s3: 'S3',
  webdav: 'DAV',
  pan123: '123',
};
const STORAGE_SHORT = { local: '本地', s3: 'S3', webdav: 'WebDAV', pan123: '123云盘' };

function storageDetail(s) {
  const o = s.options || {};
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return u || '';
    }
  };
  const mode = (o.downloadMode || 'redirect') === 'proxy' ? '服务器代理' : '302 重定向';
  if (s.type === 'local') return `本机目录 ${o.root || ''}`;
  if (s.type === 's3') return `${o.bucket || ''}${o.prefix ? '/' + o.prefix : ''} · ${o.endpoint ? host(o.endpoint) : 'AWS'} · ${mode}`;
  if (s.type === 'webdav') return `${host(o.url)}${o.root && o.root !== '/' ? o.root : ''}`;
  if (s.type === 'pan123') return `${String(o.rootFolderId || '0') === '0' ? '整个网盘' : '文件夹 ' + o.rootFolderId} · ${mode}`;
  return '';
}

async function loadStorages() {
  try {
    types = await api('GET', '/api/storages/types');
    storages = await api('GET', '/api/storages');
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  $('#storage-empty').hidden = storages.length > 0;
  $('#storage-rows').innerHTML = storages
    .map((s, i) => {
      const status = !s.enabled ? '<span class="status off">已停用</span>' : s.mounted ? '<span class="status ok">正常</span>' : '<span class="status bad">挂载失败</span>';
      const style = reduceMotion() ? '' : ` style="animation-delay:${i * 30}ms"`;
      return `<tr data-id="${s.id}" class="row-in"${style}>
        <td><div class="sname"><span class="sicon ${s.type}">${STORAGE_ICON[s.type] || ''}</span><span class="stext"><b>${esc(types[s.type]?.label || s.type)}</b><small>${esc(storageDetail(s))}</small></span></div></td>
        <td><span class="pill ${s.type}">${esc(STORAGE_SHORT[s.type] || s.type)}</span></td>
        <td><span class="mpath"><a href="#${encodeURIComponent(s.mountPath)}" title="打开">${esc(s.mountPath)}</a><button class="copy" data-copy="${esc(s.mountPath)}" aria-label="复制挂载路径">${use('i-copy')}</button></span></td>
        <td>${status}</td>
        <td><label class="switch"><input type="checkbox" data-toggle ${s.enabled ? 'checked' : ''} aria-label="启用 ${esc(s.mountPath)}"><span></span></label></td>
        <td><span class="row-actions"><button class="act outline" data-act="edit">${use('i-pencil')}<span>编辑</span></button><button class="act danger fill" data-act="delete">${use('i-trash')}<span>删除</span></button></span></td>
      </tr>`;
    })
    .join('');
}

$('#storage-rows').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    await navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
    return toast('已复制挂载路径');
  }
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const s = storages.find((x) => x.id === btn.closest('tr').dataset.id);
  if (btn.dataset.act === 'edit') return openStorageDrawer(s);
  const ok = await ask({ title: `移除挂载“${s.mountPath}”？`, message: '只移除挂载配置，不会删除存储里的文件。', confirm: true, okText: '移除', danger: true });
  if (!ok) return;
  await api('DELETE', `/api/storages/${s.id}`).then(() => toast('已移除挂载'), (err) => toast(err.message, 'error'));
  loadStorages();
});

// 开关：直接启用/停用，不用打开编辑面板
$('#storage-rows').addEventListener('change', async (e) => {
  const sw = e.target.closest('[data-toggle]');
  if (!sw) return;
  const s = storages.find((x) => x.id === sw.closest('tr').dataset.id);
  sw.disabled = true;
  try {
    // 密钥类字段是打码值“******”，服务端会保留原值
    await api('PUT', `/api/storages/${s.id}`, { mountPath: s.mountPath, enabled: sw.checked, options: s.options });
    toast(sw.checked ? `已启用 ${s.mountPath}` : `已停用 ${s.mountPath}`);
  } catch (err) {
    sw.checked = !sw.checked;
    toast(err.message, 'error');
  }
  await loadStorages();
});

function renderFields(type, values = {}) {
  $('#storage-fields').innerHTML = types[type].fields
    .map((f) => {
      const v = values[f.key] ?? f.default ?? '';
      const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
      if (f.type === 'boolean') {
        return `<div class="check-row"><span>${esc(f.label)}</span><label class="switch"><input type="checkbox" name="opt.${f.key}" ${v === true || v === 'true' ? 'checked' : ''}><span></span><b class="sr-only">${esc(f.label)}</b></label></div>`;
      }
      if (f.type === 'select') {
        const opts = f.options.map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
        return `<label class="stack">${esc(f.label)}<span class="select-wrap"><select name="opt.${f.key}">${opts}</select>${use('i-down')}</span>${help}</label>`;
      }
      const input = `<input name="opt.${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" ${f.secret ? 'type="password" autocomplete="new-password"' : ''} ${f.required ? 'required' : ''}>`;
      const field = f.secret ? `<span class="pw">${input}<button type="button" class="eye" aria-label="显示密码">${use('i-eye-off')}</button></span>` : input;
      return `<label class="stack">${esc(f.label)}${f.required ? ' <span style="color:var(--danger)">*</span>' : ''}${field}</label>`;
    })
    .join('');
}

function openStorageDrawer(s = null) {
  editing = s;
  const form = $('#storage-form');
  form.reset();
  $('#storage-error').textContent = '';
  $('#storage-title').textContent = s ? '编辑存储' : '添加存储';
  const sel = $('#storage-type');
  sel.innerHTML = Object.entries(types)
    .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`)
    .join('');
  sel.value = s?.type || 'local';
  sel.disabled = !!s;
  form.mountPath.value = s?.mountPath || '';
  form.enabled.checked = s ? s.enabled : true;
  renderFields(sel.value, s?.options);
  $('#storage-dialog').showModal();
  (s ? form.mountPath : sel).focus();
  $('.sheet-scroll').scrollTop = 0;
}

$('#btn-add-storage').addEventListener('click', () => openStorageDrawer());
$('#storage-type').addEventListener('change', (e) => renderFields(e.target.value));

$('#storage-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const type = $('#storage-type').value;
  const missing = [...form.querySelectorAll('[required]')].find((i) => !i.value.trim());
  if (missing) {
    $('#storage-error').textContent = `请填写“${missing.closest('label').firstChild.textContent.trim()}”`;
    return missing.focus();
  }
  const options = {};
  for (const f of types[type].fields) {
    const input = form.elements[`opt.${f.key}`];
    options[f.key] = f.type === 'boolean' ? input.checked : input.value.trim();
  }
  const body = { type, mountPath: form.mountPath.value.trim(), enabled: form.enabled.checked, options };
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (editing) await api('PUT', `/api/storages/${editing.id}`, body);
    else await api('POST', '/api/storages', body);
    closeDialog($('#storage-dialog'));
    toast(editing ? '已保存' : `已挂载到 ${body.mountPath}`);
    loadStorages();
  } catch (err) {
    $('#storage-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ==========================================================================
// 账号设置
// ==========================================================================

let currentUser = '';

function setUser(user) {
  currentUser = user;
  $('#account-name').textContent = user;
  menuBtn.setAttribute('aria-label', `账号：${user}`);
}

function openAccount() {
  const form = $('#account-form');
  form.reset();
  form.querySelectorAll('.pw input').forEach((i) => (i.type = 'password'));
  form.username.value = currentUser;
  $('#account-error').textContent = '';
  $('#account-dialog').showModal();
}

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const err = $('#account-error');
  const username = f.username.value.trim();
  const newPassword = f.newPassword.value;
  if (!f.currentPassword.value) return (err.textContent = '请输入当前密码');
  if (newPassword && newPassword.length < 8) return (err.textContent = '新密码至少 8 位');
  if (newPassword !== f.confirmPassword.value) return (err.textContent = '两次输入的新密码不一致');
  if (username === currentUser && !newPassword) return (err.textContent = '没有需要修改的内容');
  try {
    const { user } = await api('PUT', '/api/account', { currentPassword: f.currentPassword.value, username, newPassword });
    setUser(user);
    closeDialog($('#account-dialog'));
    toast(newPassword ? '已保存，其他设备需要用新密码重新登录' : '已保存');
  } catch (e2) {
    err.textContent = e2.message;
  }
});

// ==========================================================================
// 启动
// ==========================================================================

async function start() {
  const { user } = await api('GET', '/api/me');
  if (!user) return showLogin();
  setUser(user);
  $('#login').hidden = true;
  $('#app').hidden = false;
  setView('files');
}

start();
