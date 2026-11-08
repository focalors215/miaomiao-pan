// OpenList 驱动：把一个 OpenList 实例（或其中的某个子路径）挂载进来。
// OpenList 自带 70+ 种网盘驱动（阿里云盘、百度网盘、OneDrive、Google Drive……），
// 在 OpenList 里配置好存储后，这里通过它的 HTTP API 读写，界面仍然是本站的。
import fs from 'node:fs';
import path from 'node:path';
import { proxyFetch } from './util.js';

export class OpenListDriver {
  constructor(o, state) {
    this.url = String(o.url).replace(/\/+$/, '');
    this.publicUrl = String(o.publicUrl || '').replace(/\/+$/, '');
    this.username = o.username;
    this.password = o.password || '';
    this.rootPath = '/' + String(o.root || '/').replace(/^\/+|\/+$/g, '');
    this.proxy = o.downloadMode !== 'redirect';
    this.state = state;
    this.urls = new Map(); // 内部路径 -> { at, raw }
  }

  p(inner) {
    return path.posix.join(this.rootPath, inner || '/');
  }

  // ---------- 鉴权 ----------

  async token(force = false) {
    const s = this.state.getState();
    // OpenList 的 token 有效期 48 小时，这里 24 小时后主动刷新
    if (!force && s.token && Date.now() - (s.at || 0) < 24 * 3600_000) return s.token;
    const r = await fetch(`${this.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 200) throw new Error(`OpenList 登录失败: ${j.message || r.status}`);
    this.state.setState({ token: j.data.token, at: Date.now() });
    return j.data.token;
  }

  async call(method, api, body, retried = false) {
    const r = await fetch(`${this.url}${api}`, {
      method,
      headers: { Authorization: await this.token(retried), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (j.code === 401 && !retried) return this.call(method, api, body, true);
    if (j.code !== 200) {
      const msg = String(j.message || `HTTP ${r.status}`);
      const notFound = j.code === 404 || /not found|不存在/i.test(msg);
      throw Object.assign(new Error(`OpenList: ${msg}`), { status: notFound ? 404 : undefined });
    }
    return j.data;
  }

  // ---------- 文件操作 ----------

  async list(dir) {
    const data = await this.call('POST', '/api/fs/list', {
      path: this.p(dir), password: '', page: 1, per_page: 0, refresh: false,
    });
    return (data.content || []).map((i) => ({
      name: i.name,
      isDir: !!i.is_dir,
      size: i.is_dir ? 0 : i.size,
      modified: i.modified && !i.modified.startsWith('0001') ? new Date(i.modified).toISOString() : null,
    }));
  }

  async mkdir(dir, name) {
    await this.call('POST', '/api/fs/mkdir', { path: this.p(path.posix.join(dir, name)) });
  }

  async move(p, toDir) {
    await this.call('POST', '/api/fs/move', {
      src_dir: this.p(path.posix.dirname(p)),
      dst_dir: this.p(toDir),
      names: [path.posix.basename(p)],
    });
    this.urls.clear();
  }

  async rename(p, newName) {
    await this.call('POST', '/api/fs/rename', { path: this.p(p), name: newName });
    this.urls.clear();
  }

  async remove(p) {
    await this.call('POST', '/api/fs/remove', {
      dir: this.p(path.posix.dirname(p)),
      names: [path.posix.basename(p)],
    });
    this.urls.clear();
  }

  async upload(dir, name, stream, size, { file } = {}) {
    const dest = this.p(path.posix.join(dir, name));
    const body = file ? fs.createReadStream(file) : stream;
    const headers = {
      Authorization: await this.token(),
      'File-Path': encodeURIComponent(dest),
      'Content-Type': 'application/octet-stream',
      'As-Task': 'false',
    };
    if (size) headers['Content-Length'] = String(size);
    const r = await fetch(`${this.url}/api/fs/put`, { method: 'PUT', headers, body, duplex: 'half' });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 200) throw new Error(`OpenList 上传失败: ${j.message || r.status}`);
  }

  // ---------- 下载 ----------

  /** 取文件的直链（带签名）；缓存 5 分钟 */
  async rawUrl(p) {
    const hit = this.urls.get(p);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.raw;
    const data = await this.call('POST', '/api/fs/get', { path: this.p(p), password: '' });
    if (data.is_dir) throw Object.assign(new Error('不能下载文件夹'), { status: 400 });
    let raw = data.raw_url;
    // 本站容器内部地址换成对外地址（只有 OpenList 自己的 /d 链接才需要换）
    if (this.publicUrl && raw.startsWith(this.url + '/')) raw = this.publicUrl + raw.slice(this.url.length);
    this.urls.set(p, { at: Date.now(), raw });
    return raw;
  }

  async source(p) {
    const raw = await this.rawUrl(p);
    return { input: raw.startsWith('/') ? this.url + raw : raw };
  }

  async download(p, req, res, { name, inline, proxy }) {
    const raw = await this.rawUrl(p);
    const abs = raw.startsWith('/') ? this.url + raw : raw;
    // 重定向模式下，没有设置对外地址时无法保证浏览器能访问内部地址，所以只在直链指向外部时才跳转
    const external = !abs.startsWith(this.url + '/');
    if (!proxy && !this.proxy && (external || this.publicUrl)) return res.redirect(302, abs);
    await proxyFetch(abs, req, res, name, inline);
  }
}
