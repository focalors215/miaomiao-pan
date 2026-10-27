// 分块上传：浏览器按块（默认 20MB）逐个 PUT，单个请求远小于 Cloudflare 免费版 100MB 的请求体上限；
// 最后“完成上传”只启动后台任务，把拼好的文件写入存储，浏览器轮询进度，避免 Cloudflare 100 秒超时（524）。
// 同一个文件（目录 + 文件名 + 大小 + 修改时间）再次上传会复用已收到的块，实现断点续传。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR } from './store.js';
import * as vfs from './vfs.js';
import { HttpError } from './vfs.js';

const DIR = path.join(DATA_DIR, 'uploads');
const CHUNK = Math.min(95, Math.max(1, Number(process.env.UPLOAD_CHUNK_MB) || 20)) * 1024 * 1024;
const EXPIRE = 24 * 3600_000; // 24 小时没动静的未完成上传会被清理

fs.mkdirSync(DIR, { recursive: true });

const sessions = new Map(); // id -> meta

const partFile = (id) => path.join(DIR, `${id}.part`);
const metaFile = (id) => path.join(DIR, `${id}.json`);

function persist(m) {
  m.updatedAt = Date.now();
  fs.writeFileSync(metaFile(m.id), JSON.stringify(m));
}

async function drop(m) {
  sessions.delete(m.id);
  await fsp.rm(partFile(m.id), { force: true });
  await fsp.rm(metaFile(m.id), { force: true });
}

function publicView(m) {
  return {
    id: m.id,
    status: m.status, // uploading | processing | done | error
    chunkSize: m.chunkSize,
    chunks: m.chunks,
    received: m.received.flatMap((ok, i) => (ok ? [i] : [])),
    error: m.error || null,
  };
}

// 启动时恢复未完成的上传；重启前正在后台处理的标记为失败，浏览器重新点“完成”即可重试
for (const f of fs.readdirSync(DIR)) {
  if (!f.endsWith('.json')) continue;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    if (m.status === 'processing') {
      m.status = 'error';
      m.error = '服务器重启，处理中断，请重试';
    }
    if (m.status === 'done') continue;
    sessions.set(m.id, m);
  } catch {}
}

/** 创建（或续传）上传任务 */
/** 创建（或续传）上传任务。sc 是当前用户的 scope（决定能写哪里） */
export async function init(user, sc, { path: dir, name, size, lastModified }) {
  const r = await sc.resolve(dir, { write: true }); // 目标目录必须可写
  name = vfs.validName(String(name || ''));
  size = Number(size);
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '文件大小不正确');
  const target = vfs.normalize(dir);
  // 同一个文件得到同一个 id，用于断点续传
  const id = crypto
    .createHash('sha256')
    .update(JSON.stringify([user.id, r.storage.id, r.inner, name, size, Number(lastModified) || 0, CHUNK]))
    .digest('hex')
    .slice(0, 32);
  let m = sessions.get(id);
  if (m && m.status === 'processing') return publicView(m);
  if (!m || m.status === 'done' || !fs.existsSync(partFile(id))) {
    m = {
      id,
      owner: user.id,
      dir: target, // 用户看到的目录，仅用于日志
      storageId: r.storage.id,
      innerDir: r.inner, // 存储内部的目标目录，写入时用它
      name,
      size,
      chunkSize: CHUNK,
      chunks: Math.max(1, Math.ceil(size / CHUNK)),
      received: [],
      status: 'uploading',
      createdAt: Date.now(),
    };
    m.received = new Array(m.chunks).fill(false);
    await fsp.writeFile(partFile(id), '');
    await fsp.truncate(partFile(id), size); // 预分配，块可以乱序写入
    sessions.set(id, m);
  }
  if (m.status === 'error') m.status = 'uploading';
  persist(m);
  return publicView(m);
}

function get(id, user) {
  const m = sessions.get(id);
  if (!m) throw new HttpError(404, '上传任务不存在或已过期，请重新上传');
  // 只能操作自己的上传任务（旧版任务没有 owner，只有管理员能继续）
  if (m.owner ? m.owner !== user.id : user.role !== 'admin') throw new HttpError(404, '上传任务不存在或已过期，请重新上传');
  return m;
}

/** 接收一个块：请求体是原始二进制 */
export async function putChunk(user, id, index, req) {
  const m = get(id, user);
  if (m.status !== 'uploading') throw new HttpError(409, '这个上传任务已经在处理或已完成');
  index = Number(index);
  if (!Number.isInteger(index) || index < 0 || index >= m.chunks) throw new HttpError(400, '块序号不正确');
  const start = index * m.chunkSize;
  const expected = Math.min(m.chunkSize, m.size - start);
  const declared = Number(req.headers['content-length']);
  if (req.headers['content-length'] !== undefined && declared !== expected) {
    throw new HttpError(400, `块大小不正确：应为 ${expected} 字节，实际 ${declared} 字节`);
  }
  let got = 0;
  const counter = new Transform({
    transform(buf, _enc, cb) {
      got += buf.length;
      if (got > expected) return cb(new HttpError(400, '块大小超出'));
      cb(null, buf);
    },
  });
  await pipeline(req, counter, fs.createWriteStream(partFile(id), { flags: 'r+', start }));
  if (got !== expected) throw new HttpError(400, `块数据不完整：应为 ${expected} 字节，收到 ${got} 字节`);
  m.received[index] = true;
  persist(m);
  return { index, received: m.received.filter(Boolean).length, chunks: m.chunks };
}

/** 所有块到齐后，后台把文件写入存储；立即返回，进度用 status() 查 */
export function complete(user, id) {
  const m = get(id, user);
  if (m.status === 'processing' || m.status === 'done') return publicView(m);
  const missing = m.received.findIndex((ok) => !ok);
  if (missing >= 0) throw new HttpError(400, `还有块没有上传（第 ${missing + 1} 块）`);
  m.status = 'processing';
  m.error = null;
  persist(m);
  (async () => {
    try {
      const { driver, inner } = m.storageId ? { driver: vfs.getDriver(m.storageId), inner: m.innerDir } : vfs.mustResolve(m.dir);
      const file = partFile(id);
      // 第 5 个参数把临时文件路径告诉驱动，123云盘驱动可以直接用它算 MD5，免得再复制一遍
      await driver.upload(inner, m.name, fs.createReadStream(file), m.size, { file });
      m.status = 'done';
      await fsp.rm(file, { force: true });
      await fsp.rm(metaFile(id), { force: true });
      setTimeout(() => sessions.get(id) === m && sessions.delete(id), 10 * 60_000).unref(); // 留一会儿给浏览器查结果
    } catch (e) {
      console.error('[upload] 写入存储失败', m.dir, m.name, e);
      m.status = 'error';
      m.error = e.message || '写入存储失败';
      persist(m);
    }
  })();
  return publicView(m);
}

export function status(user, id) {
  return publicView(get(id, user));
}

export async function cancel(user, id) {
  if (!sessions.has(id)) return;
  const m = get(id, user);
  if (m.status === 'processing') throw new HttpError(409, '正在写入存储，不能取消');
  await drop(m);
}

export const chunkSize = CHUNK;

// 清理过期的未完成上传
setInterval(() => {
  const now = Date.now();
  for (const m of sessions.values()) {
    if (m.status !== 'processing' && now - (m.updatedAt || m.createdAt) > EXPIRE) drop(m);
  }
}, 3600_000).unref();
