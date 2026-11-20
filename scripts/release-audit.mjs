#!/usr/bin/env node
// 发布前自检（清单 H8）：只扫 scripts/release-manifest.json 里要公开的文件，查
//   ✗ 本机路径（/Users/<名字>、/home/<名字>、C:\Users\<名字>）
//   ✗ 密钥和私钥（常见格式）
//   ✗ 邮箱（GitHub 的 noreply 邮箱除外）
//   ✗ 私人名单里的词（名单不进仓库，放在 research/refs/release-denylist.txt，一行一个；行首写 warn: 的只出警告）
//   ✗ 别人的视频链接（抖音、小红书、B 站的单条视频）和 research/refs 里的素材路径
//   ✗ 混进来的成片和大文件（mp4、mov、webm 和超过 5 MB 的文件）、字体文件（字体按 npm run fonts 下载，不进仓库）
//   ⚠ 内部会话名、TODO 和【待定】这类还没做完的标记（不卡发布，发布前过一遍）
// 用法：node scripts/release-audit.mjs [--list]   （--list 只列出要公开的文件）
// 零依赖；文件清单来自 git ls-files，所以只查进了 git 的文件。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/release-manifest.json'), 'utf8'));
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + (g.endsWith('/') ? '' : '$'));
const inc = manifest.include.map(globToRe); const exc = manifest.exclude.map(globToRe);
// core.quotePath=false：不然中文文件名会被 git 转义加引号，匹配不上清单，悄悄漏扫
const lsFiles = (...extra) => execFileSync('git', ['-c', 'core.quotePath=false', 'ls-files', '-z', ...extra], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
// --all：把还没进 git 的文件（不含 .gitignore 忽略的）也算进来，新风格提交前自查用
const tracked = process.argv.includes('--all') ? [...new Set([...lsFiles(), ...lsFiles('--others', '--exclude-standard')])] : lsFiles();
const files = tracked.filter((f) => inc.some((r) => r.test(f)) && !exc.some((r) => r.test(f)));
// 清单里写了、仓库里却没有的文件（比如 LICENSE 指向的 NOTICE.md 还没生成），单独报出来
const missingIncludes = manifest.include.filter((g) => !g.includes('*') && !tracked.some((f) => (g.endsWith('/') ? f.startsWith(g) : f === g)));
if (process.argv.includes('--list')) { console.log(files.join('\n')); process.exit(0); }
const publicContacts = new Set(manifest.publicContacts || []); // 有意公开的联系邮箱
const skip = new Set(manifest.auditSkip || []); // 自检脚本自己的源码会误报，跳过

const deny = []; const warnWords = [];
// 英文的词按整词匹配：前后紧挨着字母、数字、下划线、连字符就不算（textBaseline、dominant-baseline 这种属性名不算）；中文的词照旧按字面找
const wordRe = new Map();
const hit = (text, w) => {
  if (!/^[\x20-\x7e]+$/.test(w)) return text.includes(w);
  if (!wordRe.has(w)) wordRe.set(w, new RegExp(`(?<![A-Za-z0-9_-])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-])`));
  return wordRe.get(w).test(text);
};
const allowIn = []; // [文件, 词]：名单里的词只在这些文件里放行（比如版权方的名字只能出现在许可证文件里）
const allowed = (f, w) => allowIn.some(([af, aw]) => af === f && aw === w);
const denyFile = join(ROOT, 'research/refs/release-denylist.txt');
if (existsSync(denyFile)) {
  for (const raw of readFileSync(denyFile, 'utf8').split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    if (l.startsWith('warn:')) warnWords.push(l.slice(5).trim());
    else if (l.startsWith('allow:')) { const [file, w] = l.slice(6).split('='); if (file && w) allowIn.push([file.trim(), w.trim()]); } // allow:LICENSE=某词 —— 版权声明这类文件里允许出现
    else deny.push(l);
  }
} else console.log('⚠ 没有私人名单 research/refs/release-denylist.txt，这一项没查（名单不进仓库，要自己建）');

const RULES = [
  { level: 'error', name: '本机路径', re: /(?:\/Users\/(?!Shared\b)[A-Za-z0-9._-]+|\/home\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+|~\/(?:dev|Desktop|Downloads|Documents)\/)/g },
  { level: 'error', name: '密钥', re: /(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g },
  { level: 'error', name: '邮箱', re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)(?!anthropic\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { level: 'error', name: '别人的视频链接', re: /(?:douyin\.com\/(?:video|user)\/\S+|iesdouyin\.com\/\S+|xiaohongshu\.com\/(?:explore|discovery)\/\S+|xhslink\.com\/\S+|bilibili\.com\/video\/\S+|b23\.tv\/\S+)/g },
  { level: 'error', name: '内部素材路径', re: /research\/refs\/\S*/g },
  { level: 'warn', name: '指向内部资料的路径（research/ 不公开，读者点不开）', re: /(?<![\w/])research\/(?!refs\/)[^\s`）)」]*/g },
  { level: 'warn', name: '还没做完的标记', re: /(?:TODO|FIXME|【待定】|【待填】|（待定）|\[TBD[^\]]*\])/g },
  { level: 'warn', name: '还没填的占位符', re: /(?<!\$)\{\{[^}]{1,40}\}\}/g }, // ${{ … }} 是 GitHub Actions 的表达式，不算
];
const TEXT = /(?:\.(md|mjs|js|json|ts|txt|html|css|sh|yml|yaml|toml|svg)|(?:^|\/)(?:LICENSE|NOTICE|AUTHORS|CODEOWNERS|COPYING)[^/.]*)$/i; // 没有扩展名的 LICENSE、NOTICE 也要扫
const problems = [];
const add = (level, file, line, what, hit) => problems.push({ level, file, line, what, hit: String(hit).slice(0, 80) });

for (const f of files) {
  if (skip.has(f)) continue;
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  const st = statSync(p);
  if (/\.(mp4|mov|webm|mkv|avi)$/i.test(f)) add('error', f, 0, '成片文件进了仓库', `${(st.size / 1e6).toFixed(1)} MB`);
  if (/\.(ttf|otf|woff2?|ttc)$/i.test(f)) add('error', f, 0, '字体文件进了仓库（应由 npm run fonts 下载）', `${(st.size / 1e6).toFixed(1)} MB`);
  if (st.size > 5e6) add('error', f, 0, '大文件（超过 5 MB）', `${(st.size / 1e6).toFixed(1)} MB`);
  if (!TEXT.test(f) || st.size > 2e6) continue;
  const lines = readFileSync(p, 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const r of RULES) for (const m of text.matchAll(r.re)) if (!(r.name === '邮箱' && publicContacts.has(m[0])) && !(r.name === '还没填的占位符' && /\.template\.md$/.test(f))) add(r.level, f, i + 1, r.name, m[0]);
    for (const w of deny) if (hit(text, w) && !allowed(f, w)) add('error', f, i + 1, '私人名单里的词', w);
    for (const w of warnWords) if (hit(text, w) && !allowed(f, w)) add('warn', f, i + 1, '名单里要留意的词', w);
  });
}

for (const g of missingIncludes) add('warn', g, 0, '清单里写了要公开、仓库里还没有的文件', g);
const errors = problems.filter((x) => x.level === 'error'); const warns = problems.filter((x) => x.level === 'warn');
console.log(`要公开的文件 ${files.length} 个；✗ ${errors.length} 处，⚠ ${warns.length} 处`);
const show = (arr, mark) => {
  const byWhat = new Map();
  for (const x of arr) { if (!byWhat.has(x.what)) byWhat.set(x.what, []); byWhat.get(x.what).push(x); }
  for (const [what, xs] of byWhat) {
    console.log(`\n${mark} ${what}：${xs.length} 处`);
    for (const x of xs.slice(0, 12)) console.log(`   ${x.file}${x.line ? ':' + x.line : ''}  ${x.hit}`);
    if (xs.length > 12) console.log(`   ……还有 ${xs.length - 12} 处`);
  }
};
show(errors, '✗'); show(warns, '⚠');
process.exit(errors.length ? 1 : 0);
