// 列出风格的共用规则（README 索引表、拼贴名单、宣传片拼贴共用）
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listStyles, groupByKind, KINDS } from '../cli/lib/style-list.mjs';
import { REPO_ROOT } from '../cli/lib/server.mjs';

test('listStyles：按编号排，跳过 draft- 和没有 meta.json 的目录，kind 没写当字效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hanzifx-styles-'));
  try {
    const add = async (name, meta) => { await mkdir(join(dir, name)); if (meta) await writeFile(join(dir, name, 'meta.json'), JSON.stringify(meta)); };
    await add('010-card', { code: '010', kind: 'interaction', name: '卡' });
    await add('002-poster', { code: '002', kind: 'style', name: '大字报' });
    await add('001-outline', { code: '001', name: '花字' }); // 没写 kind
    await add('draft-new-one', { code: '', kind: 'style', name: '草稿' });
    await add('003-empty', null); // 没有 meta.json
    const list = await listStyles(dir);
    assert.deepEqual(list.map((s) => s.dir), ['001-outline', '002-poster', '010-card']);
    assert.deepEqual(list.map((s) => s.kind), ['style', 'style', 'interaction']);
    const g = groupByKind(list);
    assert.deepEqual(Object.keys(g), KINDS);
    assert.deepEqual(g.style.map((s) => s.code), ['001', '002']);
    assert.deepEqual(g.interaction.map((s) => s.code), ['010']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listStyles：仓库里的风格编号不重复，kind 只有字效和互动元素两种', async () => {
  const list = await listStyles(join(REPO_ROOT, 'styles'));
  assert.ok(list.length > 0);
  assert.equal(new Set(list.map((s) => s.code)).size, list.length);
  for (const s of list) assert.ok(KINDS.includes(s.kind), `${s.dir} 的 kind 是 ${s.kind}`);
});
