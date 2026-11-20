// 几个导出同时写同一份缓存字体（同一个内容哈希）时，读的一方不能读到写了一半的文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileAtomic } from '../cli/lib/atomic.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');

test('writeFileAtomic：并发写同一个文件，边写边读，读到的 sha 始终不变', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hanzifx-atomic-'));
  try {
    const buf = randomBytes(400_000);
    const want = sha(buf);
    const p = join(dir, 'notosc-black.woff2');
    await writeFile(p, buf);
    let stop = false; let reads = 0; let bad = 0;
    const reader = (async () => {
      while (!stop) { const b = await readFile(p); reads++; if (sha(b) !== want) bad++; }
    })();
    // 写失败（比如磁盘满）时也要让读的循环停下，不然测试会一直挂着（11-21 遇到过一次卡 3 分钟以上）
    try {
      for (let r = 0; r < 100; r++) await Promise.all([writeFileAtomic(p, buf), writeFileAtomic(p, buf), writeFileAtomic(p, buf)]);
    } finally { stop = true; await reader; }
    assert.ok(reads > 20, `读的次数太少（${reads}），测不出竞争`);
    assert.equal(bad, 0, `${reads} 次读里有 ${bad} 次读到不完整的文件`);
    assert.deepEqual(await readdir(dir), ['notosc-black.woff2'], '不该留下临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic：目标目录不存在时报错，也不留临时文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hanzifx-atomic-'));
  try {
    await assert.rejects(writeFileAtomic(join(dir, 'nope', 'a.woff2'), Buffer.from('x')));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
