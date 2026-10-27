// 用户视角：管理员看到所有挂载；普通用户只看到两个虚拟文件夹
//   /我的空间  -> 私人空间存储里的 <目录>/<用户名>，只有自己能看到（第一次访问时自动创建）
//   /公共空间  -> 公共空间存储里的 <目录>，所有用户共用；管理员可以设为只读
// 设置保存在 config.settings.privateSpace / publicSpace，由管理员在“系统设置”里修改
import path from 'node:path';
import * as vfs from './vfs.js';
import { HttpError } from './vfs.js';
import { getConfig, save } from './store.js';

export const PRIVATE = '我的空间';
export const PUBLIC = '公共空间';

function settings() {
  const s = getConfig().settings;
  s.privateSpace ||= { storageId: '', dir: '/users' };
  s.publicSpace ||= { storageId: '', dir: '/', writable: true };
  return s;
}

function spaces(user) {
  const s = settings();
  const out = [];
  if (s.privateSpace.storageId) {
    out.push({ name: PRIVATE, kind: 'private', storageId: s.privateSpace.storageId, base: path.posix.join(s.privateSpace.dir, user.username), readOnly: false });
  }
  if (s.publicSpace.storageId) {
    out.push({ name: PUBLIC, kind: 'public', storageId: s.publicSpace.storageId, base: s.publicSpace.dir, readOnly: !s.publicSpace.writable });
  }
  return out;
}

const ensured = new Set();

// ---------- 管理员：全局视角 ----------

const adminScope = {
  isAdmin: true,
  async resolve(p, { allowRoot = true } = {}) {
    const r = vfs.mustResolve(p, { allowRoot });
    return { ...r, readOnly: false, virtual: vfs.normalize(p) };
  },
  list: (p) => vfs.list(p),
};

// ---------- 普通用户：只能看到自己的空间 ----------

function userScope(user) {
  return {
    isAdmin: false,
    async resolve(p, { allowRoot = true, write = false } = {}) {
      const full = vfs.normalize(p);
      const [first, ...rest] = full.split('/').filter(Boolean);
      if (!first) throw new HttpError(400, `请先进入“${PRIVATE}”或“${PUBLIC}”`);
      const sp = spaces(user).find((x) => x.name === first);
      if (!sp) throw new HttpError(404, '路径不存在');
      if (!allowRoot && !rest.length) throw new HttpError(400, '不能对空间本身执行这个操作');
      if (write && sp.readOnly) throw new HttpError(403, `${sp.name}是只读的，只能浏览和下载`);
      const driver = vfs.getDriver(sp.storageId);
      if (sp.kind === 'private' && !ensured.has(sp.storageId + sp.base)) {
        await vfs.ensureDir(driver, sp.base);
        ensured.add(sp.storageId + sp.base);
      }
      return { storage: vfs.getStorage(sp.storageId), driver, inner: path.posix.join(sp.base, ...rest), readOnly: sp.readOnly, virtual: full };
    },
    async list(p) {
      if (vfs.normalize(p) === '/') {
        return spaces(user).map((sp) => ({ name: sp.name, isDir: true, size: 0, modified: null, mount: true, space: sp.kind, readOnly: sp.readOnly }));
      }
      const r = await this.resolve(p);
      return vfs.hideReserved(await r.driver.list(r.inner));
    },
  };
}

export function scope(user) {
  return user.role === 'admin' ? adminScope : userScope(user);
}

// ---------- 设置 ----------

export function getSpaceSettings() {
  const s = settings();
  return { privateSpace: s.privateSpace, publicSpace: s.publicSpace, registration: s.registration };
}

export function updateSettings({ registration, privateSpace, publicSpace } = {}) {
  const s = settings();
  const checkStorage = (id) => {
    if (id && !vfs.getStorage(id)) throw new HttpError(400, '选择的存储不存在');
    return id || '';
  };
  if (registration) {
    const code = String(registration.inviteCode ?? s.registration.inviteCode ?? '').trim();
    if (code.length > 64) throw new HttpError(400, '邀请码不能超过 64 个字符');
    s.registration = { open: !!registration.open, inviteCode: code };
  }
  if (privateSpace) {
    s.privateSpace = { storageId: checkStorage(privateSpace.storageId), dir: vfs.normalize(privateSpace.dir || '/users') };
    ensured.clear();
  }
  if (publicSpace) {
    s.publicSpace = { storageId: checkStorage(publicSpace.storageId), dir: vfs.normalize(publicSpace.dir || '/'), writable: publicSpace.writable !== false };
  }
  save();
  return getSpaceSettings();
}

/** 新用户注册后立即建好私人空间文件夹（失败不影响注册，第一次访问时还会再建） */
export async function prepareHome(user) {
  const s = settings().privateSpace;
  if (!s.storageId) return;
  const base = path.posix.join(s.dir, user.username);
  try {
    await vfs.ensureDir(vfs.getDriver(s.storageId), base);
    ensured.add(s.storageId + base);
  } catch {}
}

/** 用户改名时，把私人空间文件夹跟着改名 */
export async function renameHome(from, to) {
  const s = settings().privateSpace;
  if (!s.storageId) return;
  const driver = vfs.getDriver(s.storageId);
  const items = await driver.list(s.dir).catch(() => []);
  if (!items.some((i) => i.name === from && i.isDir)) return;
  await driver.rename(path.posix.join(s.dir, from), to);
  ensured.clear();
}
