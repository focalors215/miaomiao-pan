// 简单的 JSON 集合：回收站、分享记录各存一个文件（DATA_DIR/<name>.json），和存凭据的 config.json 分开
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';

export function collection(name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  let items = [];
  if (fs.existsSync(file)) {
    try {
      items = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error(`[db] ${name}.json 读取失败，已忽略`, e.message);
    }
  }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  return {
    all: () => items,
    get: (id) => items.find((x) => x.id === id),
    filter: (fn) => items.filter(fn),
    add(item) {
      items.push(item);
      save();
      return item;
    },
    update(id, patch) {
      const it = items.find((x) => x.id === id);
      if (it) Object.assign(it, patch), save();
      return it;
    },
    remove(id) {
      const n = items.length;
      items = items.filter((x) => x.id !== id);
      if (items.length !== n) save();
    },
    save,
  };
}
