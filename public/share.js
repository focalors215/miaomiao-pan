// 公开分享页 /s/<id>：不需要登录。根据分享内容显示提取码输入框、单个文件卡片或文件夹列表，可以在线预览和下载
import { renderPreview as renderMedia } from './preview.js';
import { $, use, esc, fmtSize, fmtTime, join, kindOf, fileIcon, reduceMotion, applyWallpaper } from './common.js';

const id = location.pathname.split('/')[2] || '';
const base = `/api/public/share/${encodeURIComponent(id)}`;
let info = null;

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `请求失败 (${r.status})`), { status: r.status });
  return data;
}

function toast(text, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${use(type === 'ok' ? 'i-check' : 'i-close')}<span></span>`;
  el.querySelector('span').textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 2800);
}

const urlFor = (rel, inline = false) => `${base}/download?path=${encodeURIComponent(rel)}${inline ? '&inline=1' : ''}`;

function show(section) {
  for (const s of ['loading', 'error', 'lock', 'file', 'folder']) $(`#s-${s}`).hidden = s !== section;
}

function expiryText() {
  if (!info.expiresAt) return '永久有效';
  const days = Math.ceil((info.expiresAt - Date.now()) / 86400_000);
  return days <= 1 ? '1 天内过期' : `${days} 天后过期`;
}

// ---------- 启动 ----------

async function init() {
  fetch('/api/site').then((r) => r.json()).then((site) => applyWallpaper(site, site.login), () => {});
  try {
    info = await api('GET', base);
  } catch (e) {
    $('#s-error-title').textContent = e.status === 410 ? '这个分享已经过期了' : '分享不存在或已被取消';
    $('#s-error-sub').textContent = e.status === 410 ? '请联系分享者重新分享。' : '链接可能输错了，或者分享者已经取消了分享。';
    document.title = '分享已失效 · 喵喵零和小鱼的仓库';
    return show('error');
  }
  document.title = `${info.name} · ${info.owner} 的分享`;
  if (info.needCode && !info.unlocked) {
    $('#s-lock-sub').textContent = `${info.owner} 分享了“${info.name}”，输入提取码后查看`;
    show('lock');
    return setTimeout(() => $('#s-lock').code.focus(), 50);
  }
  open();
}

$('#s-lock').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = e.target.code.value.trim();
  if (!code) return ($('#s-lock-error').textContent = '请输入提取码');
  try {
    await api('POST', `${base}/unlock`, { code });
    open();
  } catch (err) {
    $('#s-lock-error').textContent = err.message;
    e.target.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], {
      duration: reduceMotion() ? 1 : 320,
    });
  }
});

function open() {
  if (info.isDir) {
    $('#s-folder-name').textContent = info.name;
    $('#s-folder-meta').textContent = `${info.owner} 分享的文件夹 · ${expiryText()}`;
    show('folder');
    loadFolder();
  } else {
    $('#s-file-icon').innerHTML = fileIcon({ name: info.name, isDir: false });
    $('#s-file-name').textContent = info.name;
    $('#s-file-meta').textContent = `${fmtSize(info.size)} · ${info.owner} 分享 · ${expiryText()}`;
    $('#s-file-download').href = urlFor('/');
    $('#s-file-preview').hidden = !kindOf(info.name);
    show('file');
  }
}

$('#s-file-preview').addEventListener('click', () => openPreview([{ name: info.name, isDir: false }], 0, '/', true));

// ---------- 文件夹 ----------

const relPath = () => decodeURIComponent(location.hash.slice(1)) || '/';
let items = [];

async function loadFolder() {
  const p = relPath();
  const segs = p.split('/').filter(Boolean);
  let acc = '';
  $('#s-crumbs').innerHTML = [`<a href="#/">${esc(info.name)}</a>`]
    .concat(segs.map((s) => ((acc += '/' + s), `${use('i-chevron', 'sep')}<a href="#${encodeURIComponent(acc)}">${esc(s)}</a>`)))
    .join('');
  try {
    ({ items } = await api('GET', `${base}/list?path=${encodeURIComponent(p)}`));
  } catch (err) {
    if (err.status === 401) return init(); // 提取码 Cookie 过期了
    items = [];
    toast(err.message, 'error');
  }
  $('#s-empty').hidden = items.length > 0;
  $('#s-rows').innerHTML = items
    .map((it, i) => {
      const full = join(p, it.name);
      const href = it.isDir ? `#${encodeURIComponent(full)}` : urlFor(full);
      const preview = !it.isDir && kindOf(it.name) ? 'data-preview' : '';
      const style = reduceMotion() ? '' : ` style="animation-delay:${Math.min(i, 20) * 18}ms"`;
      return `<tr class="row-in" data-name="${esc(it.name)}"${style}>
        <td><a class="name" href="${href}" ${preview}>${fileIcon(it)}<span>${esc(it.name)}</span></a></td>
        <td class="num">${it.isDir ? '—' : fmtSize(it.size)}</td>
        <td class="muted">${fmtTime(it.modified)}</td>
        <td>${it.isDir ? '' : `<a class="act" href="${urlFor(full)}">${use('i-download')}<span>下载</span></a>`}</td>
      </tr>`;
    })
    .join('');
}

addEventListener('hashchange', () => info?.isDir && loadFolder());
$('#s-rows').addEventListener('click', (e) => {
  const link = e.target.closest('a[data-preview]');
  if (!link || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  const list = items.filter((it) => !it.isDir && kindOf(it.name));
  openPreview(list, list.findIndex((it) => it.name === link.closest('tr').dataset.name), relPath());
});

// ---------- 预览（和主界面同一套降级逻辑，只是地址换成公开分享接口） ----------

const pv = { dialog: $('#preview'), list: [], index: 0, dir: '/', single: false };
let cleanup = null;
let seq = 0;

function openPreview(list, index, dir, single = false) {
  Object.assign(pv, { list, index: Math.max(0, index), dir, single });
  render();
  if (!pv.dialog.open) pv.dialog.showModal();
}

function clear() {
  seq++;
  try {
    cleanup?.();
  } catch {}
  cleanup = null;
  $('#pv-body').replaceChildren();
}

async function render() {
  const it = pv.list[pv.index];
  const rel = pv.single ? '/' : join(pv.dir, it.name);
  const kind = kindOf(it.name);
  $('#pv-name').textContent = it.name;
  $('#pv-count').textContent = pv.list.length > 1 ? `${pv.index + 1} / ${pv.list.length}` : '';
  $('#pv-download').href = urlFor(rel);
  $('#pv-prev').hidden = $('#pv-next').hidden = pv.list.length < 2;
  $('#pv-status').textContent = '';
  clear();
  const mine = seq;
  const body = $('#pv-body');
  body.dataset.kind = kind;
  const q = encodeURIComponent(rel);
  const urls = {
    inline: urlFor(rel, true),
    raw: urlFor(rel),
    proxy: urlFor(rel, true) + '&proxy=1',
    path: `${base}/d` + (rel === '/' ? `/${encodeURIComponent(it.name)}` : rel.split('/').map(encodeURIComponent).join('/')),
    probe: `${base}/probe?path=${q}`,
    image: `${base}/image?path=${q}`,
    transcode: `${base}/transcode`,
  };
  const isStale = () => mine !== seq;
  const onError = (msg) => {
    if (isStale()) return;
    clear();
    body.innerHTML = `<p class="pv-error">${esc(`预览失败${msg ? '：' + msg : ''}。可以下载后查看。`)}</p>`;
  };
  const onStatus = (text) => !isStale() && ($('#pv-status').textContent = text);
  const slot = document.createElement('div');
  slot.className = 'pv-slot';
  body.append(slot);
  try {
    const fn = await renderMedia(slot, { kind, name: it.name, path: rel, urls, onError, onStatus, isStale });
    if (isStale()) fn();
    else cleanup = fn;
  } catch (e) {
    console.error(e);
    onError();
  }
}

const step = (d) => {
  if (pv.list.length < 2) return;
  pv.index = (pv.index + d + pv.list.length) % pv.list.length;
  render();
};
$('#pv-prev').addEventListener('click', () => step(-1));
$('#pv-next').addEventListener('click', () => step(1));
$('#pv-close').addEventListener('click', () => (pv.dialog.close(), clear()));
pv.dialog.addEventListener('close', clear);
pv.dialog.addEventListener('click', (e) => (e.target === pv.dialog || e.target === $('#pv-body')) && (pv.dialog.close(), clear()));
document.addEventListener('keydown', (e) => {
  if (!pv.dialog.open) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

init();
