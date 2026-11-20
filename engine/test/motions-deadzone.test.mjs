// 共用动作的尾巴死区：衰减到静止的最后一点点直接落到正好的静止值（ADR-001「逐帧一致的几类坑」）
import test from 'node:test';
import assert from 'node:assert/strict';
import { shake, bounceIn, DEAD_PX, DEAD_DEG } from '../src/motions/index.js';

const FPS = 30;

test('shake：每一帧要么正好是 0，要么至少挪 0.05 像素、转 0.02 度；时长过了正好是 0', () => {
  for (const start of [0, 0.0137, 1.06, 1.875, 0.5 + 1 / 90]) {
    for (let f = 0; f < 60; f++) {
      const t = start + f / FPS - 0.004 * (f % 3);
      const m = shake(t, { start, amplitude: 1.7, duration: 0.18, freq: 26, seed: 113, rotate: 1.5 });
      for (const v of [m.dx, m.dy]) assert.ok(v === 0 || Math.abs(v) >= DEAD_PX, `t=${t} 位移 ${v}`);
      assert.ok(m.rot === 0 || Math.abs(m.rot) >= DEAD_DEG, `t=${t} 转角 ${m.rot}`);
    }
    const after = shake(start + 0.2, { start, amplitude: 1.7, duration: 0.18 });
    assert.equal(after.dx, 0); assert.equal(after.dy, 0); assert.equal(after.rot, 0);
  }
});

test('bounceIn：落地以后的尾巴最后落到正好的静止值（位移 0、转角 0、缩放 1），入场开头不受影响', () => {
  for (const mode of ['pop', 'drop']) {
    const fs = 120;
    let settledAt = null;
    for (let f = 0; f < 150; f++) {
      const m = bounceIn(f / FPS, { mode, fs, sign: 1 });
      const near = (Math.abs(m.dy) > 0 && Math.abs(m.dy) < DEAD_PX) || (Math.abs(m.rot) > 0 && Math.abs(m.rot) < DEAD_DEG)
        || [m.sx, m.sy].some((s) => s !== 1 && Math.abs(s - 1) * fs < DEAD_PX);
      assert.ok(!near, `${mode} 第 ${f} 帧还有零点零几像素的尾巴：dy ${m.dy} rot ${m.rot} sx ${m.sx} sy ${m.sy}`);
      if (settledAt === null && m.dy === 0 && m.rot === 0 && m.sx === 1 && m.sy === 1) settledAt = f;
    }
    assert.ok(settledAt !== null && settledAt < 150, `${mode} 最后停在正好的静止值`);
    const first = bounceIn(1 / FPS, { mode, fs });
    assert.ok(first.sx < 0.9, `${mode} 入场第一帧还小（${first.sx}），死区没吃掉入场`);
  }
});
