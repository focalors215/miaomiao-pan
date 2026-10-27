// 回收站：删除时把文件移到该存储根目录下的 .pan-trash/<条目 id>/，记录放在 data/trash.json
// - 每个用户只看得到自己删除的文件；30 天后自动彻底删除
// - 还原时原位置已有同名文件，就在名字后加“ (恢复)”
import path from 'node:path';
import crypto from 'node:crypto';
import * as vfs from './vfs.js';
import { HttpError, TRASH_DIR } from './vfs.js';
import { collection } from './db.js';

const KEEP_DAYS = 30;
const db = collection('trash');

const trashDir = (id) => `/${TRASH_DIR}/${id}`;

function view(e) {
  const left = Math.max(0, Math.ceil((e.deletedAt + KEEP_DAYS * 86400_000 - Date.now()) / 86400_000));
  return { id: e.id, name: e.name, isDir: e.isDir, size: e.size, from: e.fromVirtual, deletedAt: e.deletedAt, daysLeft: left };
}

/** 把一个文件/文件夹移进回收站。r 是 scope.resolve() 的结果（已经检查过写权限） */
export async function moveToTrash(user, r) {
  const parent = path.posix.dirname(r.inner);
  const name = path.posix.basename(r.inner);
  const item = (await r.driver.list(parent)).find((i) => i.name === name);
  if (!item) throw new HttpError(404, '文件或文件夹不存在');
  const id = crypto.randomBytes(8).toString('hex');
  await vfs.ensureDir(r.driver, trashDir(id));
  await r.driver.move(r.inner, trashDir(id));
  db.add({
    id,
    owner: user.id,
    storageId: r.storage.id,
    name,
    isDir: item.isDir,
    size: item.size || 0,
    fromInner: parent, // 存储内部的原位置，用于还原
    fromVirtual: path.posix.dirname(r.virtual), // 用户看到的原位置，用于显示
    deletedAt: Date.now(),
  });
}

function own(user, id) {
  const e = db.get(id);
  if (!e || e.owner !== user.id) throw new HttpError(404, '回收站里没有这个文件');
  return e;
}

export function list(user) {
  return db
    .filter((e) => e.owner === user.id)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .map(view);
}

export async function restore(user, id) {
  const e = own(user, id);
  const driver = vfs.getDriver(e.storageId);
  await vfs.ensureDir(driver, e.fromInner);
  const existing = new Set((await driver.list(e.fromInner)).map((i) => i.name));
  let name = e.name;
  if (existing.has(name)) {
    const ext = e.isDir ? '' : path.posix.extname(name);
    const base = ext ? name.slice(0, -ext.length) : name;
    for (let n = 1; existing.has(name); n++) name = `${base} (恢复${n > 1 ? n : ''})${ext}`;
    await driver.rename(`${trashDir(id)}/${e.name}`, name);
  }
  await driver.move(`${trashDir(id)}/${name}`, e.fromInner);
  await driver.remove(trashDir(id)).catch(() => {});
  db.remove(id);
  return { name, to: e.fromVirtual };
}

async function purgeEntry(e) {
  try {
    await vfs.getDriver(e.storageId).remove(trashDir(e.id));
  } catch (err) {
    // 存储已被移除时只能删记录；其他错误（网络等）保留记录，下次再试
    if (vfs.getStorage(e.storageId)) throw err;
  }
  db.remove(e.id);
}

export async function purge(user, id) {
  await purgeEntry(own(user, id));
}

export async function empty(user) {
  const mine = db.filter((e) => e.owner === user.id);
  for (const e of mine) await purgeEntry(e);
  return mine.length;
}

/** 删除用户时：他回收站里的东西一并彻底删除 */
export async function purgeOwner(userId) {
  for (const e of db.filter((x) => x.owner === userId)) await purgeEntry(e).catch(() => {});
}

// 每小时清理一次超过 30 天的条目
async function sweep() {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const e of db.filter((x) => x.deletedAt < cutoff)) {
    await purgeEntry(e).catch((err) => console.error('[trash] 自动清理失败', e.name, err.message));
  }
}
setInterval(sweep, 3600_000).unref();
setTimeout(sweep, 30_000).unref();
