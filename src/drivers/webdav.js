import { createClient } from 'webdav';
import path from 'node:path';
import { proxyFetch } from './util.js';

export class WebDAVDriver {
  constructor(o) {
    this.root = '/' + String(o.root || '/').replace(/^\/+|\/+$/g, '');
    this.client = createClient(o.url, o.username ? { username: o.username, password: o.password || '' } : {});
    this.url = String(o.url).replace(/\/+$/, '');
    this.auth = o.username
      ? { Authorization: 'Basic ' + Buffer.from(`${o.username}:${o.password || ''}`).toString('base64') }
      : {};
  }

  p(inner) {
    return path.posix.join(this.root, inner);
  }

  async list(dir) {
    const items = await this.client.getDirectoryContents(this.p(dir));
    return items.map((i) => ({
      name: i.basename,
      isDir: i.type === 'directory',
      size: i.type === 'directory' ? 0 : i.size,
      modified: i.lastmod ? new Date(i.lastmod).toISOString() : null,
    }));
  }

  async mkdir(dir, name) {
    await this.client.createDirectory(this.p(path.posix.join(dir, name)));
  }

  async rename(p, newName) {
    const from = this.p(p);
    await this.client.moveFile(from, path.posix.join(path.posix.dirname(from), newName), { overwrite: false });
  }

  async remove(p) {
    await this.client.deleteFile(this.p(p));
  }

  async upload(dir, name, stream, size) {
    const ok = await this.client.putFileContents(this.p(path.posix.join(dir, name)), stream, {
      overwrite: true,
      contentLength: size || false,
    });
    if (ok === false) throw new Error('WebDAV 上传失败');
  }

  // WebDAV 只支持服务器代理：重定向会把账号密码暴露给浏览器
  fileUrl(p) {
    return this.url + this.p(p).split('/').map(encodeURIComponent).join('/');
  }

  async source(p) {
    return { input: this.fileUrl(p), headers: this.auth };
  }

  async download(p, req, res, { name, inline }) {
    await proxyFetch(this.fileUrl(p), req, res, name, inline, this.auth);
  }
}
