// 虚拟文件系统：把各存储挂载到统一的路径树上，如 /本地、/s3、/123
import path from 'node:path';
import crypto from 'node:crypto';
import { getConfig, save } from './store.js';
import { createDriver, DRIVER_TYPES } from './drivers/index.js';

const drivers = new Map(); // storage.id -> driver 实例

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** 规范化用户传入的路径，禁止 .. 跳出 */
export function normalize(p) {
  const segs = String(p || '/').split('/').filter(Boolean);
  if (segs.some((s) => s === '..' || s === '.')) throw new HttpError(400, '非法路径');
  return '/' + segs.join('/');
}

export function validName(name) {
  if (!name || /[\\/]/.test(name) || name === '.' || name === '..' || name.length > 255) {
    throw new HttpError(400, '非法文件名');
  }
  return name;
}

function makeDriver(storage) {
  return createDriver(storage.type, storage.options || {}, {
    getState: () => storage.state || {},
    setState: (state) => {
      storage.state = state;
      save();
    },
  });
}

// 旧版 S3 配置用布尔值 proxyDownload 表示下载方式，统一迁移成 downloadMode
function migrate() {
  let changed = false;
  for (const s of getConfig().storages) {
    if (s.options && 'proxyDownload' in s.options) {
      s.options.downloadMode ??= s.options.proxyDownload ? 'proxy' : 'redirect';
      delete s.options.proxyDownload;
      changed = true;
    }
  }
  if (changed) save();
}

export function initDrivers() {
  migrate();
  drivers.clear();
  for (const s of getConfig().storages) {
    if (!s.enabled) continue;
    try {
      drivers.set(s.id, makeDriver(s));
    } catch (e) {
      console.error(`[vfs] 挂载 ${s.mountPath} 失败:`, e.message);
    }
  }
}

/** 找到路径所属的挂载点（最长前缀匹配），返回驱动和存储内部路径 */
export function resolve(p) {
  const full = normalize(p);
  let best = null;
  for (const s of getConfig().storages) {
    if (!s.enabled || !drivers.has(s.id)) continue;
    const m = s.mountPath;
    if (full === m || full.startsWith(m + '/')) {
      if (!best || m.length > best.mountPath.length) best = s;
    }
  }
  if (!best) return null;
  return { storage: best, driver: drivers.get(best.id), inner: full.slice(best.mountPath.length) || '/' };
}

/** 列出 path 下的直接子挂载点（显示为虚拟文件夹） */
function virtualDirs(p) {
  const full = normalize(p);
  const prefix = full === '/' ? '/' : full + '/';
  const names = new Set();
  for (const s of getConfig().storages) {
    if (!s.enabled || !s.mountPath.startsWith(prefix)) continue;
    names.add(s.mountPath.slice(prefix.length).split('/')[0]);
  }
  return [...names].map((name) => ({ name, isDir: true, size: 0, modified: null, mount: true }));
}

export async function list(p) {
  const r = resolve(p);
  const virt = virtualDirs(p);
  if (!r) {
    if (!virt.length && normalize(p) !== '/') throw new HttpError(404, '路径不存在');
    return virt;
  }
  const items = await r.driver.list(r.inner);
  const names = new Set(items.map((i) => i.name));
  return [...items, ...virt.filter((v) => !names.has(v.name))];
}

export function mustResolve(p, { allowRoot = true } = {}) {
  const r = resolve(p);
  if (!r) throw new HttpError(404, '该路径没有挂载存储');
  if (!allowRoot && r.inner === '/') throw new HttpError(400, '不能对挂载点本身执行此操作');
  return r;
}

export function joinInner(dir, name) {
  return path.posix.join(dir, validName(name));
}

// ---------- 存储管理 ----------

function publicStorage(s) {
  const fields = DRIVER_TYPES[s.type]?.fields || [];
  const options = { ...s.options };
  for (const f of fields) if (f.secret && options[f.key]) options[f.key] = '******';
  return { id: s.id, type: s.type, mountPath: s.mountPath, enabled: s.enabled, options, mounted: drivers.has(s.id) };
}

export function listStorages() {
  return getConfig().storages.map(publicStorage);
}

function checkStorage(input, existing) {
  const type = existing?.type || input.type;
  const def = DRIVER_TYPES[type];
  if (!def) throw new HttpError(400, '未知存储类型');
  const mountPath = normalize(input.mountPath);
  if (mountPath === '/') throw new HttpError(400, '挂载路径不能是 /');
  if (getConfig().storages.some((s) => s.mountPath === mountPath && s.id !== existing?.id)) {
    throw new HttpError(400, '挂载路径已被占用');
  }
  const options = {};
  for (const f of def.fields) {
    let v = input.options?.[f.key];
    if (f.secret && v === '******' && existing) v = existing.options[f.key];
    if (f.type === 'boolean') v = v === true || v === 'true';
    if (v === undefined || v === '') v = f.default ?? '';
    if (f.type === 'select' && !f.options.some((o) => o.value === v)) throw new HttpError(400, `${f.label} 取值无效`);
    if (f.required && (v === '' || v === undefined)) throw new HttpError(400, `${f.label} 必填`);
    options[f.key] = v;
  }
  return { type, mountPath, options, enabled: input.enabled !== false };
}

export function addStorage(input) {
  const s = { id: crypto.randomUUID(), ...checkStorage(input), state: {} };
  makeDriver(s); // 先校验能否创建
  getConfig().storages.push(s);
  save();
  initDrivers();
  return publicStorage(s);
}

export function updateStorage(id, input) {
  const s = getConfig().storages.find((x) => x.id === id);
  if (!s) throw new HttpError(404, '存储不存在');
  const next = checkStorage(input, s);
  const credsChanged = JSON.stringify(next.options) !== JSON.stringify(s.options);
  makeDriver({ ...s, ...next });
  Object.assign(s, next);
  if (credsChanged) s.state = {};
  save();
  initDrivers();
  return publicStorage(s);
}

export function removeStorage(id) {
  const cfg = getConfig();
  const i = cfg.storages.findIndex((x) => x.id === id);
  if (i < 0) throw new HttpError(404, '存储不存在');
  cfg.storages.splice(i, 1);
  save();
  initDrivers();
}
