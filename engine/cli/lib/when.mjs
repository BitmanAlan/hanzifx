// 「截哪一刻」的写法，海报帧（meta.posterTime、样片条目的 posterTime）和 export --still / --poster 共用：
//   2.3            秒数
//   after-intro    入场段结束那一刻（默认，跟以前一样）
//   hold           时间段开头；hold.end 结尾；hold.mid 中间
//   hold+0.3       时间段开头往后 0.3 秒（也能写 hold.end-0.2）
// 时间段名来自风格的 timeline.segments（intro / hold / outro……）。
export function resolveTime(spec, timeline) {
  const dur = timeline.duration;
  const clampT = (t) => Math.max(0, Math.min(t, Math.max(0, dur - 1e-6)));
  if (spec == null || spec === '') spec = 'after-intro';
  if (typeof spec === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(String(spec))) return clampT(Number(spec));
  const s = String(spec).trim();
  if (s === 'after-intro') {
    const intro = timeline.segments.find((x) => x.name === 'intro');
    if (!intro) throw new Error('这个风格的时间轴里没有 intro 段，after-intro 用不了，写秒数或别的段名');
    return clampT(intro.end);
  }
  const m = s.match(/^([A-Za-z][\w-]*)(?:\.(start|end|mid))?(?:([+-])(\d+(?:\.\d+)?))?$/);
  if (!m) throw new Error(`看不懂的时刻「${s}」：写秒数（2.3）、after-intro、段名（hold）、段名.end / .mid，或者段名+秒数（hold+0.3）`);
  const seg = timeline.segments.find((x) => x.name === m[1]);
  if (!seg) throw new Error(`时间轴里没有「${m[1]}」这一段，有的是：${timeline.segments.map((x) => x.name).join('、')}`);
  const base = m[2] === 'end' ? seg.end : m[2] === 'mid' ? (seg.start + seg.end) / 2 : seg.start;
  const off = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
  return clampT(base + off);
}
