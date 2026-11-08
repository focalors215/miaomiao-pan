// OpenList 管理页：存储（70+ 网盘驱动）、离线下载、任务、搜索索引、站点设置。
// 所有请求经 /api/openlist/call 转发给已挂载的 OpenList，界面沿用本站风格。
import { $, $$, use, esc, fmtSize, reduceMotion } from './common.js';

const TASK_TYPES = {
  offline_download: '离线下载',
  offline_download_transfer: '下载转存',
  upload: '上传',
  copy: '复制',
  move: '移动',
  decompress: '解压',
  decompress_upload: '解压上传',
};
const TASK_STATE = ['等待中', '运行中', '成功', '取消中', '已取消', '出错', '失败', '等待重试', '重试中', '等待重试', '被阻塞'];
const SETTING_GROUPS = { 1: '站点', 3: '预览', 4: '全局', 5: '离线下载', 6: '索引', 11: '传输' };
const DELETE_POLICIES = {
  delete_on_upload_succeed: '转存成功后删除下载的临时文件',
  delete_on_upload_failed: '转存失败后删除临时文件',
  delete_never: '不删除',
  delete_always: '总是删除',
};

export function createOpenlist({ api, toast, ask, closeDialog, selectSegment }) {
  const call = (method, target, body) => api('POST', '/api/openlist/call', { method, api: target, body }).then((r) => r.data);
  let tab = 'storages';
  let timer = null;
  let drivers = null;
  let editing = null;

  const root = $('#view-openlist');
  const panel = (name) => $(`#ol-${name}`);

  // ---------- 标签页 ----------

  function showTab(name) {
    tab = name;
    selectSegment($('#ol-tabs'), (b) => b.dataset.tab === name);
    for (const p of ['storages', 'offline', 'tasks', 'index', 'settings']) panel(p).hidden = p !== name;
    clearInterval(timer);
    timer = null;
    ({ storages: loadStorages, offline: loadOffline, tasks: loadTasks, index: loadIndex, settings: loadSettings })[name]();
    if (name === 'tasks' || name === 'index') timer = setInterval(() => root.hidden ? stop() : (name === 'tasks' ? loadTasks(true) : loadIndex(true)), 3000);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  $('#ol-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[role="tab"]');
    if (b) showTab(b.dataset.tab);
  });

  async function load() {
    // 先确认已挂载 OpenList
    try {
      await call('GET', '/api/public/settings');
      $('#ol-missing').hidden = true;
      $('#ol-body').hidden = false;
    } catch (err) {
      $('#ol-body').hidden = true;
      $('#ol-missing').hidden = false;
      $('#ol-missing-msg').textContent = err.message;
      stop();
      return;
    }
    showTab(tab);
  }

  const fail = (err) => toast(err.message, 'error');

  // ---------- 存储（驱动） ----------

  async function loadStorages() {
    const tbody = $('#ol-storage-rows');
    try {
      const data = await call('GET', '/api/admin/storage/list?page=1&per_page=500');
      const list = data.content || [];
      $('#ol-storage-empty').hidden = list.length > 0;
      tbody.innerHTML = list
        .map((s, i) => {
          const work = s.status === 'work';
          const status = s.disabled ? '<span class="status off">已停用</span>' : work ? '<span class="status ok">正常</span>' : `<span class="status bad" title="${esc(s.status)}">${esc(s.status.length > 14 ? '出错' : s.status)}</span>`;
          return `<tr data-id="${s.id}" class="row-in"${reduceMotion() ? '' : ` style="animation-delay:${Math.min(i, 20) * 20}ms"`}>
            <td><div class="sname"><span class="sicon openlist">OL</span><span class="stext"><b>${esc(s.mount_path)}</b><small>${esc(s.remark || '')}</small></span></div></td>
            <td><span class="pill openlist">${esc(s.driver)}</span></td>
            <td>${status}</td>
            <td><label class="switch"><input type="checkbox" data-toggle ${s.disabled ? '' : 'checked'} aria-label="启用 ${esc(s.mount_path)}"><span></span></label></td>
            <td><span class="row-actions"><button class="act outline" data-act="edit">${use('i-pencil')}<span>编辑</span></button><button class="act danger fill" data-act="delete">${use('i-trash')}<span>删除</span></button></span></td>
          </tr>`;
        })
        .join('');
      tbody._list = list;
    } catch (err) {
      fail(err);
    }
  }

  $('#ol-storage-rows').addEventListener('change', async (e) => {
    const sw = e.target.closest('[data-toggle]');
    if (!sw) return;
    const id = sw.closest('tr').dataset.id;
    try {
      await call('POST', `/api/admin/storage/${sw.checked ? 'enable' : 'disable'}?id=${id}`);
      toast(sw.checked ? '已启用' : '已停用');
    } catch (err) {
      fail(err);
    }
    loadStorages();
  });

  $('#ol-storage-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const s = $('#ol-storage-rows')._list.find((x) => String(x.id) === btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'edit') return openDrawer(s);
    const ok = await ask({ title: `删除存储“${s.mount_path}”？`, message: '只删除 OpenList 里的存储配置，不会删除网盘里的文件。', confirm: true, okText: '删除', danger: true });
    if (!ok) return;
    await call('POST', `/api/admin/storage/delete?id=${s.id}`).then(() => toast('已删除'), fail);
    loadStorages();
  });

  /** 渲染一个 OpenList 驱动配置项（type: string/number/bool/select/text） */
  function fieldHtml(it, value, prefix) {
    const name = `${prefix}.${it.name}`;
    const label = esc(it.name.replace(/_/g, ' '));
    const help = it.help ? `<small class="help">${esc(it.help)}</small>` : '';
    const v = value ?? it.default ?? '';
    if (it.type === 'bool') {
      const on = v === true || v === 'true';
      return `<div class="check-row"><span>${label}${help}</span><label class="switch"><input type="checkbox" name="${name}" data-type="bool" ${on ? 'checked' : ''}><span></span><b class="sr-only">${label}</b></label></div>`;
    }
    if (it.type === 'select') {
      const opts = String(it.options || '').split(',').filter(Boolean).map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('');
      return `<label class="stack">${label}<span class="select-wrap"><select name="${name}">${opts}</select>${use('i-down')}</span>${help}</label>`;
    }
    const secret = /password|secret|token|key/i.test(it.name) && it.type !== 'number';
    const req = it.required ? ' required' : '';
    const star = it.required ? ' <span style="color:var(--danger)">*</span>' : '';
    if (it.type === 'text') return `<label class="stack">${label}${star}<textarea name="${name}" rows="3"${req}>${esc(v)}</textarea>${help}</label>`;
    const input = `<input name="${name}" data-type="${it.type === 'number' ? 'number' : 'string'}" value="${esc(v)}" ${secret ? 'type="password" autocomplete="new-password"' : it.type === 'number' ? 'type="number"' : ''}${req}>`;
    const field = secret ? `<span class="pw">${input}<button type="button" class="eye" aria-label="显示密码">${use('i-eye-off')}</button></span>` : input;
    return `<label class="stack">${label}${star}${field}${help}</label>`;
  }

  function renderDriverFields(driver, s) {
    const d = drivers[driver];
    const addition = s?.addition ? JSON.parse(s.addition) : {};
    const common = (d.common || []).filter((it) => it.name !== 'mount_path');
    $('#ol-fields').innerHTML =
      `<label class="stack">挂载路径 <span style="color:var(--danger)">*</span><input name="c.mount_path" value="${esc(s?.mount_path || '')}" placeholder="/阿里云盘" required></label>` +
      (d.additional || []).map((it) => fieldHtml(it, addition[it.name], 'a')).join('') +
      common.map((it) => fieldHtml(it, s ? s[it.name] : undefined, 'c')).join('');
  }

  async function openDrawer(s = null) {
    try {
      drivers ||= await call('GET', '/api/admin/driver/list');
    } catch (err) {
      return fail(err);
    }
    editing = s;
    const form = $('#ol-form');
    form.reset();
    $('#ol-error').textContent = '';
    $('#ol-title').textContent = s ? '编辑 OpenList 存储' : '添加 OpenList 存储';
    const sel = $('#ol-driver');
    sel.innerHTML = Object.keys(drivers).sort().map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
    sel.value = s?.driver || (drivers['Local'] ? 'Local' : sel.options[0].value);
    sel.disabled = !!s;
    renderDriverFields(sel.value, s);
    $('#ol-dialog').showModal();
    $('#ol-dialog .sheet-scroll').scrollTop = 0;
  }

  $('#ol-add').addEventListener('click', () => openDrawer());
  $('#ol-driver').addEventListener('change', (e) => renderDriverFields(e.target.value, null));

  $('#ol-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const driver = $('#ol-driver').value;
    const missing = [...form.querySelectorAll('[required]')].find((i) => !i.value.trim());
    if (missing) {
      $('#ol-error').textContent = `请填写“${missing.closest('label').firstChild.textContent.trim()}”`;
      return missing.focus();
    }
    const read = (el) => (el.dataset.type === 'bool' ? el.checked : el.dataset.type === 'number' ? Number(el.value || 0) : el.value);
    const body = { driver, addition: '' };
    const add = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.name.startsWith('c.')) body[el.name.slice(2)] = el.tagName === 'SELECT' ? el.value : read(el);
      else if (el.name.startsWith('a.')) add[el.name.slice(2)] = el.tagName === 'SELECT' ? el.value : read(el);
    }
    body.addition = JSON.stringify(add);
    if (editing) body.id = editing.id;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await call('POST', editing ? '/api/admin/storage/update' : '/api/admin/storage/create', body);
      closeDialog($('#ol-dialog'));
      toast(editing ? '已保存' : '已添加');
      loadStorages();
    } catch (err) {
      $('#ol-error').textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- 离线下载 ----------

  async function loadOffline() {
    const form = $('#ol-offline-form');
    if (form._ready) return;
    try {
      const tools = await call('GET', '/api/public/offline_download_tools');
      form.tool.innerHTML = (tools || []).map((t) => `<option>${esc(t)}</option>`).join('') || '<option value="">没有可用的下载工具</option>';
      form.policy.innerHTML = Object.entries(DELETE_POLICIES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
      form._ready = true;
    } catch (err) {
      fail(err);
    }
  }

  $('#ol-offline-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const urls = f.urls.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return ($('#ol-offline-error').textContent = '请填写下载链接，一行一个');
    if (!f.dest.value.trim()) return ($('#ol-offline-error').textContent = '请填写保存到的 OpenList 路径');
    $('#ol-offline-error').textContent = '';
    try {
      await call('POST', '/api/fs/add_offline_download', { urls, path: f.dest.value.trim(), tool: f.tool.value, delete_policy: f.policy.value });
      f.urls.value = '';
      toast(`已添加 ${urls.length} 个离线下载任务`);
      showTab('tasks');
    } catch (err) {
      $('#ol-offline-error').textContent = err.message;
    }
  });

  // ---------- 任务 ----------

  async function loadTasks(quiet = false) {
    try {
      const rows = [];
      await Promise.all(
        Object.keys(TASK_TYPES).flatMap((t) =>
          ['undone', 'done'].map(async (st) => {
            const list = (await call('GET', `/api/admin/task/${t}/${st}`)) || [];
            for (const x of list) rows.push({ ...x, type: t, done: st === 'done' });
          }),
        ),
      );
      rows.sort((a, b) => Number(a.done) - Number(b.done) || String(b.start_time || '').localeCompare(String(a.start_time || '')));
      $('#ol-task-empty').hidden = rows.length > 0;
      $('#ol-task-rows').innerHTML = rows
        .map((t) => {
          const failed = t.state === 5 || t.state === 6;
          const cls = t.state === 2 ? 'ok' : failed ? 'bad' : t.done ? 'off' : 'ok';
          const pct = Math.round(t.progress || 0);
          const acts = [];
          if (!t.done) acts.push(`<button class="act outline" data-act="cancel">${use('i-close')}<span>取消</span></button>`);
          if (failed) acts.push(`<button class="act outline" data-act="retry">${use('i-refresh')}<span>重试</span></button>`);
          if (t.done) acts.push(`<button class="act danger fill" data-act="delete">${use('i-trash')}<span>移除</span></button>`);
          return `<tr data-type="${t.type}" data-id="${esc(t.id)}">
            <td title="${esc(t.name)}">${esc(t.name)}${t.error ? `<br><small class="help" title="${esc(t.error)}">${esc(t.error)}</small>` : ''}</td>
            <td><span class="pill">${esc(TASK_TYPES[t.type])}</span></td>
            <td><span class="status ${cls}">${esc(TASK_STATE[t.state] || t.status || '')}</span></td>
            <td>${t.done && t.state === 2 ? '100%' : pct + '%'}${t.total_bytes > 0 ? ` · ${fmtSize(t.total_bytes)}` : ''}</td>
            <td><span class="row-actions">${acts.join('')}</span></td></tr>`;
        })
        .join('');
    } catch (err) {
      if (!quiet) fail(err);
    }
  }

  $('#ol-task-rows').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr');
    await call('POST', `/api/admin/task/${tr.dataset.type}/${btn.dataset.act}?tid=${encodeURIComponent(tr.dataset.id)}`).catch(fail);
    loadTasks();
  });
  $('#ol-task-clear').addEventListener('click', async () => {
    await Promise.all(Object.keys(TASK_TYPES).map((t) => call('POST', `/api/admin/task/${t}/clear_done`).catch(() => {})));
    toast('已清除已完成的任务');
    loadTasks();
  });

  // ---------- 搜索索引 ----------

  async function loadIndex(quiet = false) {
    try {
      const p = await call('GET', '/api/admin/index/progress');
      const state = p.error ? `出错：${p.error}` : p.is_done ? '已完成' : '构建中…';
      $('#ol-index-state').textContent = `${state} · 已索引 ${p.obj_count ?? 0} 个文件${p.last_done_time ? ' · ' + new Date(p.last_done_time).toLocaleString() : ''}`;
    } catch (err) {
      if (/not available|not enable/i.test(err.message)) {
        $('#ol-index-state').textContent = '搜索索引未启用：到“站点设置 → 索引”里把搜索器改成 database，保存后再回来构建索引';
      } else if (!quiet) fail(err);
    }
  }

  $('#ol-index-actions').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-index]');
    if (!b) return;
    const act = b.dataset.index;
    if (act === 'clear' && !(await ask({ title: '清空搜索索引？', message: '清空后需要重新构建才能搜索。', confirm: true, okText: '清空', danger: true }))) return;
    const body = act === 'build' || act === 'update' ? { paths: ['/'], max_depth: -1, ignore_paths: [] } : undefined;
    await call('POST', `/api/admin/index/${act}`, body).then(() => toast('已提交'), fail);
    loadIndex();
  });

  $('#ol-search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const kw = e.target.keywords.value.trim();
    if (!kw) return;
    const box = $('#ol-search-rows');
    try {
      const data = await call('POST', '/api/fs/search', { parent: '/', keywords: kw, page: 1, per_page: 100, scope: 0, password: '' });
      const list = data.content || [];
      box.innerHTML = list.length
        ? list.map((r) => `<tr><td title="${esc(r.parent)}/${esc(r.name)}">${r.is_dir ? use('i-folder') : ''} ${esc(r.name)}<br><small class="help">${esc(r.parent)}</small></td><td>${r.is_dir ? '—' : fmtSize(r.size)}</td></tr>`).join('')
        : '<tr><td colspan="2" class="help">没有找到，确认搜索索引已构建</td></tr>';
    } catch (err) {
      fail(err);
    }
  });

  // ---------- 站点设置 ----------

  async function loadSettings() {
    const sel = $('#ol-setting-group');
    if (!sel.options.length) sel.innerHTML = Object.entries(SETTING_GROUPS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    try {
      const list = (await call('GET', `/api/admin/setting/list?group=${sel.value}`)) || [];
      $('#ol-setting-fields').innerHTML = list
        .map((s) => {
          const it = { name: s.key, type: s.type === 'bool' ? 'bool' : s.type === 'select' ? 'select' : s.type === 'number' ? 'number' : s.type === 'text' ? 'text' : 'string', options: s.options, help: s.help };
          return fieldHtml(it, s.value, 's');
        })
        .join('');
      $('#ol-setting-fields')._list = list;
    } catch (err) {
      fail(err);
    }
  }
  $('#ol-setting-group').addEventListener('change', loadSettings);
  $('#ol-setting-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const list = $('#ol-setting-fields')._list || [];
    const out = [];
    for (const s of list) {
      if (s.flag === 2 || s.flag === 3) continue; // 只读 / 已弃用
      const el = e.target.elements[`s.${s.key}`];
      if (!el) continue;
      const value = el.type === 'checkbox' ? String(el.checked) : el.value;
      if (value !== String(s.value)) out.push({ ...s, value });
    }
    if (!out.length) return toast('没有修改');
    await call('POST', '/api/admin/setting/save', out).then(() => toast('已保存'), fail);
    loadSettings();
  });

  return { load, stop };
}
