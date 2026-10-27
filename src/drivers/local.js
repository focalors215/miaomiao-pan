import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { contentDisposition, safeInlineType } from './util.js';

export class LocalDriver {
  constructor(options) {
    this.root = path.resolve(options.root);
    fs.mkdirSync(this.root, { recursive: true });
  }

  abs(p) {
    const full = path.resolve(this.root, '.' + p);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error('非法路径');
    return full;
  }

  async list(dir) {
    const entries = await fsp.readdir(this.abs(dir), { withFileTypes: true });
    const out = [];
    for (const e of entries) {
      if (e.name.startsWith('.pan-upload-')) continue;
      try {
        const st = await fsp.stat(path.join(this.abs(dir), e.name));
        out.push({ name: e.name, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtime.toISOString() });
      } catch {
        // 损坏的软链接等，跳过
      }
    }
    return out;
  }

  async mkdir(dir, name) {
    await fsp.mkdir(path.join(this.abs(dir), name));
  }

  async rename(p, newName) {
    const from = this.abs(p);
    const to = path.join(path.dirname(from), newName);
    if (fs.existsSync(to)) throw new Error('目标名称已存在');
    await fsp.rename(from, to);
  }

  async remove(p) {
    await fsp.rm(this.abs(p), { recursive: true, force: true });
  }

  async upload(dir, name, stream) {
    const target = path.join(this.abs(dir), name);
    const tmp = path.join(this.abs(dir), `.pan-upload-${Date.now()}-${name}`);
    try {
      await pipeline(stream, fs.createWriteStream(tmp));
      await fsp.rename(tmp, target);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
  }

  async source(p) {
    return { input: this.abs(p) };
  }

  async download(p, req, res, { name, inline }) {
    const type = inline && safeInlineType(name);
    const headers = { 'Content-Disposition': contentDisposition(name, !!type), 'X-Content-Type-Options': 'nosniff' };
    if (type) headers['Content-Type'] = type;
    await new Promise((resolve, reject) => {
      res.sendFile(this.abs(p), { dotfiles: 'allow', headers }, (err) =>
        err && !res.headersSent ? reject(err) : resolve(),
      );
    });
  }
}
