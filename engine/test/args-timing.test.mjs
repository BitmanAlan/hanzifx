// 拍点、字级时间的命令行解析（export、check、demo、determinism 共用）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { timingArgs } from '../cli/lib/args.mjs';

test('timingArgs：不给就是空；给了文件就读，相对路径按 base 算；坏文件、坏偏移直接报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hanzifx-timing-'));
  try {
    assert.deepEqual(await timingArgs({}), { beats: [], words: [], wordsOffsetMs: 0 });
    assert.deepEqual((await timingArgs({ beats: '0.5, 1,1.5' })).beats, [0.5, 1, 1.5]);
    await writeFile(join(dir, 'w.json'), JSON.stringify([{ text: '普通人', start: 0.12, end: 0.55 }]));
    await writeFile(join(dir, 'b.json'), JSON.stringify({ beats: [0.5, 1] }));
    await writeFile(join(dir, 'bad.json'), '{不是json');
    await writeFile(join(dir, 'obj.json'), '{"text":"x"}');
    const r = await timingArgs({ 'words-file': 'w.json', 'words-offset': '-80', 'beats-file': 'b.json' }, { base: dir });
    assert.equal(r.words.length, 1); assert.equal(r.wordsOffsetMs, -80); assert.deepEqual(r.beats, [0.5, 1]);
    await assert.rejects(timingArgs({ 'words-file': 'nope.json' }, { base: dir }), /读不到/);
    await assert.rejects(timingArgs({ 'words-file': 'bad.json' }, { base: dir }), /不是合法的 JSON/);
    await assert.rejects(timingArgs({ 'words-file': 'obj.json' }, { base: dir }), /要是一个数组/);
    await assert.rejects(timingArgs({ 'words-file': true }), /后面要跟/);
    await assert.rejects(timingArgs({ 'words-offset': 'abc' }), /毫秒数/);
    await assert.rejects(timingArgs({ beats: '0.5,x' }), /不是数/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
