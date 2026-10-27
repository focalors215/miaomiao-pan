import { renderPreview as renderMedia } from './preview.js';

const $ = (s) => document.querySelector(s);

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
  if (!n) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtTime(s) {
  return s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function join(dir, name) {
  return (dir === '/' ? '' : dir) + '/' + name;
}

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

function icon(item) {
  if (item.isDir) return item.mount ? '🗄️' : '📁';
  const kind = kindOf(item.name);
  if (kind) return { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕' }[kind];
  const ext = item.name.split('.').pop().toLowerCase();
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return '📦';
  return '📄';
}

const fileUrl = (p, inline = false) => `/api/fs/download?path=${encodeURIComponent(p)}${inline ? '&inline=1' : ''}`;

// ---------- 登录 ----------

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') });
    $('#login-error').textContent = '';
    start();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  showLogin();
});

// ---------- 视图切换 ----------

function setView(view) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-files').hidden = view !== 'files';
  $('#view-storages').hidden = view !== 'storages';
  if (view === 'storages') loadStorages();
  else loadFiles();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---------- 文件浏览 ----------

const currentPath = () => decodeURIComponent(location.hash.slice(1)) || '/';

function renderCrumbs(p) {
  const segs = p.split('/').filter(Boolean);
  let acc = '';
  const parts = [`<a href="#/">全部文件</a>`];
  for (const s of segs) {
    acc += '/' + s;
    parts.push(`<span>/</span><a href="#${encodeURIComponent(acc)}">${esc(s)}</a>`);
  }
  $('#crumbs').innerHTML = parts.join('');
}

let currentItems = [];

async function loadFiles() {
  const p = currentPath();
  renderCrumbs(p);
  const rows = $('#file-rows');
  try {
    const { items } = await api('GET', `/api/fs/list?path=${encodeURIComponent(p)}`);
    currentItems = items;
    $('#empty').hidden = items.length > 0;
    rows.innerHTML = items
      .map((it) => {
        const full = join(p, it.name);
        const href = it.isDir ? `#${encodeURIComponent(full)}` : fileUrl(full);
        const preview = !it.isDir && kindOf(it.name) ? 'data-preview' : '';
        const actions = it.mount
          ? ''
          : `<button data-act="rename">重命名</button><button data-act="delete" class="danger">删除</button>`;
        return `<tr data-path="${esc(full)}" data-name="${esc(it.name)}">
          <td><a class="name" href="${href}" ${preview} ${it.isDir ? '' : 'target="_blank" rel="noopener"'}><span class="icon">${icon(it)}</span><span>${esc(it.name)}</span></a></td>
          <td class="num">${it.isDir ? '-' : fmtSize(it.size)}</td>
          <td class="muted hide-sm">${fmtTime(it.modified)}</td>
          <td class="row-actions">${actions}</td>
        </tr>`;
      })
      .join('');
  } catch (err) {
    rows.innerHTML = `<tr><td colspan="4" class="error">${esc(err.message)}</td></tr>`;
    $('#empty').hidden = true;
  }
}

window.addEventListener('hashchange', () => {
  if (!$('#view-files').hidden) loadFiles();
});
$('#btn-refresh').addEventListener('click', loadFiles);

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
  try {
    if (btn.dataset.act === 'rename') {
      const next = prompt('新名称', name);
      if (!next || next === name) return;
      await api('POST', '/api/fs/rename', { path, name: next });
    } else {
      if (!confirm(`确定删除「${name}」？`)) return;
      await api('POST', '/api/fs/delete', { paths: [path] });
    }
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

$('#btn-mkdir').addEventListener('click', async () => {
  const name = prompt('文件夹名称');
  if (!name) return;
  try {
    await api('POST', '/api/fs/mkdir', { path: currentPath(), name });
    loadFiles();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- 预览 ----------

const pv = { dialog: $('#preview'), list: [], index: 0 };

function openPreview(name) {
  pv.dir = currentPath();
  pv.list = currentItems.filter((it) => !it.isDir && kindOf(it.name));
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

// ---------- 上传 ----------

function uploadOne(file, dir) {
  const el = document.createElement('div');
  el.className = 'upload';
  el.innerHTML = `<div>${esc(file.name)} <span class="pct">0%</span></div><div class="bar"><i></i></div>`;
  $('#uploads').append(el);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/fs/upload?path=${encodeURIComponent(dir)}&size=${file.size}`);
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      // 浏览器传完后服务端可能还在转存到远端（如 123云盘），所以封顶 99%
      const pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
      el.querySelector('.pct').textContent = pct === 99 ? '处理中…' : `${pct}%`;
      el.querySelector('i').style.width = pct + '%';
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        el.remove();
      } else {
        let msg = `失败 (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText).error || msg;
        } catch {}
        el.classList.add('failed');
        el.querySelector('.pct').textContent = msg;
        setTimeout(() => el.remove(), 8000);
      }
      resolve();
    };
    xhr.onerror = () => {
      el.classList.add('failed');
      el.querySelector('.pct').textContent = '网络错误';
      resolve();
    };
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

async function uploadFiles(files) {
  const dir = currentPath();
  const queue = [...files];
  const worker = async () => {
    while (queue.length) await uploadOne(queue.shift(), dir);
  };
  await Promise.all([worker(), worker(), worker()]);
  loadFiles();
}

$('#upload-input').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';
});

const drop = $('#drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('dragover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('dragover');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

// ---------- 存储管理 ----------

let types = {};
let storages = [];
let editing = null;

function downloadModeText(s) {
  const field = types[s.type]?.fields.find((f) => f.key === 'downloadMode');
  if (!field) return '下载：服务器代理';
  return (s.options.downloadMode || field.default) === 'proxy' ? '下载：服务器代理' : '下载：302 重定向';
}

async function loadStorages() {
  types = await api('GET', '/api/storages/types');
  storages = await api('GET', '/api/storages');
  $('#storage-empty').hidden = storages.length > 0;
  $('#storage-rows').innerHTML = storages
    .map(
      (s) => `<tr data-id="${s.id}">
        <td><a class="name" href="#${encodeURIComponent(s.mountPath)}" data-open><span class="icon">🗄️</span><span>${esc(s.mountPath)}</span></a></td>
        <td>${esc(types[s.type]?.label || s.type)}<br><small class="help">${downloadModeText(s)}</small></td>
        <td>${!s.enabled ? '<span class="badge">已停用</span>' : s.mounted ? '<span class="badge ok">已挂载</span>' : '<span class="badge danger">挂载失败</span>'}</td>
        <td class="row-actions"><button data-act="edit">编辑</button><button data-act="delete" class="danger">删除</button></td>
      </tr>`,
    )
    .join('');
}

$('#storage-rows').addEventListener('click', async (e) => {
  if (e.target.closest('[data-open]')) return setTimeout(() => setView('files'));
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const s = storages.find((x) => x.id === btn.closest('tr').dataset.id);
  if (btn.dataset.act === 'edit') return openStorageDialog(s);
  if (!confirm(`确定移除挂载「${s.mountPath}」？（不会删除存储里的文件）`)) return;
  await api('DELETE', `/api/storages/${s.id}`);
  loadStorages();
});

function renderFields(type, values = {}) {
  $('#storage-fields').innerHTML = types[type].fields
    .map((f) => {
      const v = values[f.key] ?? f.default ?? '';
      const help = f.help ? `<small class="help">${esc(f.help)}</small>` : '';
      if (f.type === 'boolean') {
        return `<label class="check"><input type="checkbox" name="opt.${f.key}" ${v === true || v === 'true' ? 'checked' : ''}> ${esc(f.label)}</label>`;
      }
      if (f.type === 'select') {
        const opts = f.options
          .map((o) => `<option value="${esc(o.value)}" ${o.value === v ? 'selected' : ''}>${esc(o.label)}</option>`)
          .join('');
        return `<label>${esc(f.label)}<select name="opt.${f.key}">${opts}</select>${help}</label>`;
      }
      return `<label>${esc(f.label)}${f.required ? ' *' : ''}<input name="opt.${f.key}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}"
        ${f.secret ? 'type="password" autocomplete="new-password"' : ''} ${f.required ? 'required' : ''}></label>`;
    })
    .join('');
}

function openStorageDialog(s = null) {
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
}

$('#btn-add-storage').addEventListener('click', () => openStorageDialog());
$('#storage-type').addEventListener('change', (e) => renderFields(e.target.value));
$('#storage-cancel').addEventListener('click', () => $('#storage-dialog').close());

$('#storage-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const type = $('#storage-type').value;
  const options = {};
  for (const f of types[type].fields) {
    const input = form.elements[`opt.${f.key}`];
    options[f.key] = f.type === 'boolean' ? input.checked : input.value.trim();
  }
  const body = { type, mountPath: form.mountPath.value.trim(), enabled: form.enabled.checked, options };
  try {
    if (editing) await api('PUT', `/api/storages/${editing.id}`, body);
    else await api('POST', '/api/storages', body);
    $('#storage-dialog').close();
    loadStorages();
  } catch (err) {
    $('#storage-error').textContent = err.message;
  }
});

// ---------- 启动 ----------

async function start() {
  const { user } = await api('GET', '/api/me');
  if (!user) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  setView('files');
}

start();
