// 123云盘开放平台驱动，接口参照 123云盘开放平台/ 文档目录
// 开放平台按文件 ID 操作，这里通过逐级列目录把路径解析成 ID，并做短时缓存
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { proxyFetch } from './util.js';

const API = 'https://open-api.123pan.com';
const CACHE_TTL = 60_000;

export class Pan123Driver {
  constructor(o, state) {
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.rootId = Number(o.rootFolderId || 0);
    this.proxy = o.downloadMode === 'proxy';
    this.state = state; // { getState, setState }，用于持久化 access_token
    this.cache = new Map(); // dirId -> { at, items }
    this.urls = new Map(); // fileId -> { at, url }，下载直链缓存
  }

  // ---------- 鉴权 ----------

  async token(force = false) {
    const s = this.state.getState();
    if (!force && s.accessToken && new Date(s.expiredAt).getTime() - Date.now() > 5 * 60_000) return s.accessToken;
    // 同一 client_id 最多 3 个有效 token，所以要持久化复用，避免重启时反复申请
    const r = await fetch(`${API}/api/v1/access_token`, {
      method: 'POST',
      headers: { Platform: 'open_platform', 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientID: this.clientId, clientSecret: this.clientSecret }),
    });
    const j = await r.json();
    if (j.code !== 0) throw new Error(`123云盘鉴权失败: ${j.message}`);
    this.state.setState({ accessToken: j.data.accessToken, expiredAt: j.data.expiredAt });
    return j.data.accessToken;
  }

  async api(method, url, { query, body, base = API } = {}, retried = false) {
    const u = new URL(url, base);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, v);
    const r = await fetch(u, {
      method,
      headers: {
        Authorization: `Bearer ${await this.token(retried)}`,
        Platform: 'open_platform',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json();
    if (j.code === 401 && !retried) return this.api(method, url, { query, body, base }, true);
    if (j.code === 429 && !retried) {
      await new Promise((ok) => setTimeout(ok, 1000));
      return this.api(method, url, { query, body, base }, true);
    }
    if (j.code !== 0) throw Object.assign(new Error(`123云盘: ${j.message} (code ${j.code})`), { panCode: j.code });
    return j.data;
  }

  // ---------- 路径 -> ID ----------

  async children(dirId) {
    const c = this.cache.get(dirId);
    if (c && Date.now() - c.at < CACHE_TTL) return c.items;
    const items = [];
    let lastFileId;
    do {
      const d = await this.api('GET', '/api/v2/file/list', { query: { parentFileId: dirId, limit: 100, lastFileId } });
      items.push(...d.fileList.filter((f) => f.trashed === 0));
      lastFileId = d.lastFileId;
    } while (lastFileId !== -1);
    this.cache.set(dirId, { at: Date.now(), items });
    return items;
  }

  async lookup(p) {
    let node = { fileId: this.rootId, type: 1, filename: '' };
    for (const seg of p.split('/').filter(Boolean)) {
      if (node.type !== 1) throw new Error('路径不存在');
      const next = (await this.children(node.fileId)).find((f) => f.filename === seg);
      if (!next) throw Object.assign(new Error('路径不存在'), { status: 404 });
      node = next;
    }
    return node;
  }

  invalidate(dirId) {
    this.cache.delete(dirId);
  }

  // ---------- 驱动接口 ----------

  async list(dir) {
    const node = await this.lookup(dir);
    return (await this.children(node.fileId)).map((f) => ({
      name: f.filename,
      isDir: f.type === 1,
      size: f.size,
      modified: f.updateAt ? new Date(f.updateAt.replace(' ', 'T') + '+08:00').toISOString() : null,
    }));
  }

  async mkdir(dir, name) {
    const parent = await this.lookup(dir);
    await this.api('POST', '/upload/v1/file/mkdir', { body: { name, parentID: parent.fileId } });
    this.invalidate(parent.fileId);
  }

  async rename(p, newName) {
    const node = await this.lookup(p);
    await this.api('PUT', '/api/v1/file/name', { body: { fileId: node.fileId, fileName: newName } });
    this.urls.delete(node.fileId);
    this.invalidate(node.parentFileId);
  }

  async remove(p) {
    const node = await this.lookup(p);
    await this.api('POST', '/api/v1/file/trash', { body: { fileIDs: [node.fileId] } });
    this.invalidate(node.parentFileId);
  }

  // 直链缓存 10 分钟：预览/转码时会反复请求同一文件，避免触发 download_info 限流
  async downloadUrl(p) {
    const node = await this.lookup(p);
    if (node.type === 1) throw Object.assign(new Error('不能下载文件夹'), { status: 400 });
    const c = this.urls.get(node.fileId);
    if (c && Date.now() - c.at < 10 * 60_000) return c.url;
    const d = await this.api('GET', '/api/v1/file/download_info', { query: { fileId: node.fileId } });
    this.urls.set(node.fileId, { at: Date.now(), url: d.downloadUrl });
    return d.downloadUrl;
  }

  async source(p) {
    return { input: await this.downloadUrl(p) };
  }

  async download(p, req, res, { name, inline, proxy }) {
    const url = await this.downloadUrl(p);
    // PDF 内嵌也走代理：123 的 CDN 返回附件下载头，浏览器自带阅读器无法内嵌显示
    if (this.proxy || proxy || (inline && name.toLowerCase().endsWith('.pdf'))) return proxyFetch(url, req, res, name, inline);
    res.redirect(302, url);
  }

  // V2 分片上传：创建文件(可能秒传) -> 按 sliceSize 上传分片 -> 轮询上传完毕
  async upload(dir, name, stream) {
    const parent = await this.lookup(dir);
    // 创建文件需要整文件 MD5，所以先落盘到临时文件
    const tmp = path.join(os.tmpdir(), `pan123-${crypto.randomUUID()}`);
    const md5 = crypto.createHash('md5');
    let size = 0;
    stream.on('data', (b) => {
      md5.update(b);
      size += b.length;
    });
    try {
      await pipeline(stream, fs.createWriteStream(tmp));
      const etag = md5.digest('hex');
      const created = await this.api('POST', '/upload/v2/file/create', {
        body: { parentFileID: parent.fileId, filename: name, etag, size, duplicate: 2 },
      });
      if (!created.reuse) {
        const server = created.servers[0];
        const sliceSize = created.sliceSize;
        const fh = await fsp.open(tmp);
        try {
          const count = Math.max(1, Math.ceil(size / sliceSize));
          for (let no = 1; no <= count; no++) {
            const off = (no - 1) * sliceSize;
            const buf = Buffer.alloc(Math.min(sliceSize, size - off));
            await fh.read(buf, 0, buf.length, off);
            await this.uploadSlice(server, created.preuploadID, no, buf);
          }
        } finally {
          await fh.close();
        }
        // 分片传完后 123 需要校验文件：返回 completed=false 或 code 20103（校验中）时每秒轮询一次
        for (let i = 0; ; i++) {
          if (i === 600) throw new Error('123云盘上传校验超时');
          const r = await this.api('POST', '/upload/v2/file/upload_complete', { body: { preuploadID: created.preuploadID } }).catch(
            (e) => {
              if (e.panCode === 20103) return null;
              throw e;
            },
          );
          if (r?.completed && r.fileID) break;
          await new Promise((ok) => setTimeout(ok, 1000));
        }
      }
      this.invalidate(parent.fileId);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async uploadSlice(server, preuploadID, sliceNo, buf, attempt = 1) {
    const form = new FormData();
    form.set('preuploadID', preuploadID);
    form.set('sliceNo', String(sliceNo));
    form.set('sliceMD5', crypto.createHash('md5').update(buf).digest('hex'));
    form.set('slice', new Blob([buf]), `part${sliceNo}`);
    const r = await fetch(new URL('/upload/v2/file/slice', server), {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, Platform: 'open_platform' },
      body: form,
    });
    const j = await r.json().catch(() => ({ code: r.ok ? 0 : r.status }));
    if (j.code === 0) return;
    if (attempt < 3) return this.uploadSlice(server, preuploadID, sliceNo, buf, attempt + 1);
    throw new Error(`123云盘分片 ${sliceNo} 上传失败: ${j.message || j.code}`);
  }
}
