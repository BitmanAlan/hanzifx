// to-words 的测试：node --test styles/004-word-pop-captions/tools/to-words.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseTranscript, alignToScript, spokenChars } from './to-words.mjs';
import { normalizeWords } from '../../../engine/src/lib/words.js';

const TOOL = fileURLToPath(new URL('./to-words.mjs', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'to-words-'));
const run = (args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
// 一个字一段的识别结果：每字 0.2 秒
const perChar = (s, t0 = 0) => spokenChars(s).map((c, i) => ({ text: c, start: t0 + i * 0.2, end: t0 + (i + 1) * 0.2 }));
const SCRIPT = '家人们，今天教大家三分钟剪出一条爆款视频！先打开剪映，导入素材。';
const passesEngine = (words, script) => { normalizeWords(words, script); return true; }; // 底座的严格校验，不过就会抛错

test('一字不差：全部用识别时间，没有插值，能过底座严格校验', () => {
  const r = alignToScript(perChar(SCRIPT), SCRIPT);
  assert.equal(r.ratio, 1); assert.equal(r.interpolated.length, 0);
  assert.equal(r.words.map((w) => w.text).join(''), spokenChars(SCRIPT).join(''));
  assert.ok(passesEngine(r.words, SCRIPT));
});

test('识别错一个字：那个字插值，报出识别成了什么', () => {
  const heard = SCRIPT.replace('剪出', '减出');
  const r = alignToScript(perChar(heard), SCRIPT);
  assert.equal(r.interpolated.length, 1);
  assert.deepEqual(r.interpolated[0], { index: 12, char: '剪', heard: '减' });
  const w = r.words; const k = 11;
  assert.ok(w[k].start >= w[k - 1].end - 1e-9 && w[k].end <= w[k + 1].start + 1e-9, '插值落在前后两个字之间');
  assert.ok(passesEngine(w, SCRIPT));
});

test('漏认一个字：插值，heard 是 null', () => {
  const heard = SCRIPT.replace('三分钟', '三钟');
  const r = alignToScript(perChar(heard), SCRIPT);
  assert.equal(r.interpolated.length, 1);
  assert.equal(r.interpolated[0].char, '分'); assert.equal(r.interpolated[0].heard, null);
  assert.ok(passesEngine(r.words, SCRIPT));
});

test('识别结果比口播稿多出一句：多出来的字丢掉，口播稿的字全对上', () => {
  const heard = SCRIPT + '记得点赞关注哦。';
  const r = alignToScript(perChar(heard), SCRIPT);
  assert.equal(r.ratio, 1);
  assert.equal(r.words.length, spokenChars(SCRIPT).length);
  assert.ok(passesEngine(r.words, SCRIPT));
  // 多出的一句在中间也一样
  const mid = '家人们，嗯那个我先说一下，今天教大家三分钟剪出一条爆款视频！先打开剪映，导入素材。';
  assert.equal(alignToScript(perChar(mid), SCRIPT).ratio, 1);
});

test('识别结果比口播稿少一句：少的那句按语速往后估，时间单调不倒退', () => {
  const script = SCRIPT + '加上字幕。';
  const r = alignToScript(perChar(SCRIPT), script);
  assert.equal(r.interpolated.length, 4);
  assert.ok(r.ratio >= 0.85, `对上 ${r.ratio}`);
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].start >= r.words[i - 1].start - 1e-9);
  assert.ok(r.words.at(-1).start > r.words.at(-5).end - 1e-9, '少的那句接在后面');
  assert.ok(passesEngine(r.words, script));
});

test('对上不到 85%：命令行报错、不输出文件', () => {
  const tf = join(tmp, 'asr.json'); writeFileSync(tf, JSON.stringify(perChar('今天天气不错我们出去走走吧')));
  const out = join(tmp, 'out-bad.json');
  const p = run([tf, '--text', SCRIPT, '--out', out]);
  assert.equal(p.status, 1);
  assert.match(p.stderr, /只对上 .*%（低于 85%）/);
  assert.ok(!existsSync(out), '不输出');
  assert.doesNotMatch(p.stderr, /at .*\.mjs:\d+/, '没有调用栈');
});

test('命令行：对齐以后输出逐字文件，并列出插值的字', () => {
  const heard = SCRIPT.replace('剪映', '简影');
  const tf = join(tmp, 'asr2.json'); writeFileSync(tf, JSON.stringify(perChar(heard)));
  const out = join(tmp, 'out.json');
  const p = run([tf, '--text', SCRIPT, '--out', out]);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stderr, /第 23 个字『剪』：识别成『简』，插值/);
  assert.match(p.stderr, /第 24 个字『映』：识别成『影』，插值/);
  assert.match(p.stderr, /对上 9\d\.\d%/);
  const words = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(passesEngine(words, SCRIPT));
});

test('whisper.cpp -ojf：跳过特殊标记；拆坏了字的段用整段时间', () => {
  const ojf = {
    transcription: [
      { offsets: { from: 0, to: 1200 }, text: '家人们今天', tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        { text: '家', offsets: { from: 0, to: 240 } }, { text: '人们', offsets: { from: 240, to: 700 } },
        { text: '今天', offsets: { from: 700, to: 1200 } }, { text: '[_TT_60]', offsets: { from: 1200, to: 1200 } }] },
      { offsets: { from: 1200, to: 2000 } , text: '教大家', tokens: [
        { text: '�', offsets: { from: 1200, to: 1300 } }, { text: '�大家', offsets: { from: 1300, to: 2000 } }] },
    ],
  };
  const r = parseTranscript(JSON.stringify(ojf));
  assert.match(r.kind, /whisper\.cpp/); assert.match(r.kind, /1 段/);
  assert.deepEqual(r.words.map((w) => w.text), ['家', '人们', '今天', '教大家']);
  assert.equal(r.words[1].start, 0.24); assert.equal(r.words[3].start, 1.2);
});

test('认不出的格式：一句话报错退出，没有调用栈', () => {
  const f = join(tmp, 'weird.json'); writeFileSync(f, JSON.stringify({ foo: 1 }));
  const p = run([f]);
  assert.equal(p.status, 2);
  assert.equal(p.stderr.trim().split('\n').length, 1);
  assert.match(p.stderr, /认不出这个文件的格式/);
  const g = join(tmp, 'broken.json'); writeFileSync(g, '{这不是 JSON');
  const q = run([g]);
  assert.equal(q.status, 2); assert.equal(q.stderr.trim().split('\n').length, 1);
});
