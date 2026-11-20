// 极简静态服务器：把仓库根目录（engine/ 和 styles/ 的上一级）当网站根。只读、只服务根目录里的文件。
import http from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ENGINE_DIR, loadRegistry, ensureSource, subset } from './fonts.mjs';

export const REPO_ROOT = resolve(ENGINE_DIR, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wasm': 'application/wasm',
};

const subsetCache = new Map();

export function startServer({ port = 0, host = '127.0.0.1', root = REPO_ROOT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (p === '/') { res.writeHead(302, { location: '/engine/player/' }); return res.end(); }
      if (p === '/__hanzifx/subset') {
        // 只给本地试玩台用：按需给备用字体做子集（静态部署时没有这个接口，试玩台会提示缺字）
        const id = url.searchParams.get('font');
        const text = url.searchParams.get('text') || '';
        const reg = await loadRegistry();
        if (!reg[id] || text.length > 200) { res.writeHead(400); return res.end('bad request'); }
        const key = `${id}|${text}`;
        if (!subsetCache.has(key)) {
          const src = await readFile(await ensureSource(id, reg[id], { download: false }));
          subsetCache.set(key, (await subset(src, text, { variation: reg[id].variation })).woff2);
        }
        res.writeHead(200, { 'content-type': TYPES['.woff2'], 'cache-control': 'no-store' });
        return res.end(subsetCache.get(key));
      }
      if (p === '/__hanzifx/styles.json') {
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
        return res.end(JSON.stringify(await listStyles(root)));
      }
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(root, p));
      if (!file.startsWith(root + sep)) { res.writeHead(403); return res.end('forbidden'); }
      const st = await stat(file);
      if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((ok) => server.listen(port, host, () => {
    const a = server.address();
    ok({ server, url: `http://${host}:${a.port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}

/** 扫 styles/ 下所有 meta.json，给试玩页和画廊用（以后静态部署时同一个函数写成文件） */
export async function listStyles(root = REPO_ROOT) {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === 'meta.json')) {
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
        out.push({ dir: rel, id: meta.id, code: meta.code, name: meta.name, category: meta.category, status: meta.status, summary: meta.summary });
      } catch { /* 坏的 meta.json 跳过 */ }
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir, e.name), `${rel}/${e.name}`);
  }
  await walk(join(root, 'styles'), 'styles');
  return out.sort((a, b) => String(a.code).localeCompare(String(b.code)));
}
