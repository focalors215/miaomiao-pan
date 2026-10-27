// 配置持久化：所有设置保存在 DATA_DIR/config.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const FILE = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let config = { secret: '', storages: [] };
if (fs.existsSync(FILE)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
}
if (!config.secret) {
  config.secret = crypto.randomBytes(32).toString('hex');
  save();
}

export function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function getConfig() {
  return config;
}
