// 字级时间（ctx.words）：外部给的「哪个字/词/句在几秒出现」。底座只读、校验、整体平移，怎么分配时间由风格自己定。
// 格式：[{ text: "普通人", start: 0.12, end: 0.55 }, …]，单位秒，按 start 升序；text 的粒度不限。

import { plainText } from './segment.js';
import { graphemes } from './text.js';

const strip = (s) => graphemes(plainText(String(s))).filter((g) => !/^[\s\p{P}]+$/u.test(g)).join('');

/**
 * 校验并整理。offsetMs：整体偏移（毫秒，转写工具常常整体偏 50–150 毫秒），加完以后小于 0 的夹到 0。
 * 拼起来的字（去掉空白和标点）必须等于风格文字（同样去掉空白和标点），对不上就报错，指出从第几个字开始不一样。
 */
export function normalizeWords(words, text, { offsetMs = 0 } = {}) {
  if (!words || (Array.isArray(words) && !words.length)) return [];
  if (!Array.isArray(words)) throw new Error('字级时间要是数组：[{ "text": "…", "start": 秒, "end": 秒 }, …]');
  const off = Number(offsetMs || 0) / 1000;
  const out = words.map((w, i) => {
    if (!w || typeof w.text !== 'string' || !Number.isFinite(Number(w.start)) || !Number.isFinite(Number(w.end))) {
      throw new Error(`字级时间第 ${i + 1} 项格式不对，要有 text、start、end：${JSON.stringify(w)}`);
    }
    const start = Math.max(0, Number(w.start) + off);
    const end = Math.max(start, Number(w.end) + off);
    return { text: w.text, start: Math.round(start * 1e6) / 1e6, end: Math.round(end * 1e6) / 1e6 };
  });
  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) throw new Error(`字级时间要按 start 升序：第 ${i + 1} 项「${out[i].text}」(${out[i].start} 秒) 比前一项早`);
  }
  const a = strip(out.map((w) => w.text).join(''));
  const b = strip(text);
  if (a !== b) {
    const ga = graphemes(a); const gb = graphemes(b);
    let k = 0;
    while (k < ga.length && k < gb.length && ga[k] === gb[k]) k++;
    throw new Error(`字级时间跟文字对不上：从第 ${k + 1} 个字开始不一样（去掉标点后比较）——文字是「${gb.slice(Math.max(0, k - 3), k + 4).join('')}」，时间文件是「${ga.slice(Math.max(0, k - 3), k + 4).join('')}」`);
  }
  return out;
}
