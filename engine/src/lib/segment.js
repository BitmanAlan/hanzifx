// 分词三层（PLAN.md 第 5 条）：
//   第一层：作者自己用 | 标的切分，比如「这也太|好笑了吧」，最优先；
//   第二层：jieba（jieba-wasm）加本项目的补充词表，在准备阶段算好，作为风格的输入数据传进去；
//   第三层：浏览器自带的 Intl.Segmenter 加补充词表，只当兜底。
// 这个文件只做「把切好的结果整理成统一格式」，不加载 jieba，所以风格代码保持零依赖。

import { segmentWords } from './text.js';

// ---------- 规则层（切分标准里能写成规则的几条，跟在 jieba 和兜底分词后面） ----------
// 做法：先按块拿到切分点；第一步按词性合并「动词＋结果补语」；第二步在原文上用模式标出「必须整体」的区间，
// 去掉区间内部的切分点、补上区间两头的切分点。补切分点时不许切开成语、长词（4 个字以上）和补充词表里的词，
// 切不开就整条模式不用，不会只用一半。
// 覆盖的标准：④ 数字连同后面紧挨的单位、量词、序数；⑦⑮ 英文单词、型号、带空格的英文产品名整体；
// ⑨ 代词直接跟量词整体；⑩ 汉字数字加量词；⑫ 动词带结果补语；促销日（双11、双十一）；时刻（5:30）。

import { BUILTIN_WORDS } from './lexicon.js';

const LEX = new Set(BUILTIN_WORDS);
// 单位和量词（按长度从长到短匹配）
const UNITS = [
  // 时间
  '个小时', '个星期', '个礼拜', '个月', '小时', '分钟', '秒钟', '刻钟', '钟头', '星期', '礼拜', '季度', '周年', '年代', '世纪', '天', '日', '周', '月', '年', '秒', '分', '刻', '时', '点', '号', '晚', '夜',
  // 钱和数量级
  '块钱', '毛钱', '分钱', '元', '块', '毛', '角', '万', '亿', '千', '百', '十', 'w', 'W', 'k', 'K',
  // 度量
  '公斤', '千克', '公里', '厘米', '毫米', '毫升', '平米', '平方', '斤', '两', '克', '吨', '米', '寸', '尺', '升', '度', '倍', '成', '折', '级', '层', '楼', '%', '％', 'p', 'P', 'G', 'T', 'M', 'B',
  // 量词
  '个', '只', '条', '张', '本', '件', '位', '名', '杯', '瓶', '碗', '盒', '包', '袋', '支', '根', '片', '颗', '粒', '首', '份', '幅', '双', '对', '副', '箱', '罐', '桶', '勺', '口', '头', '匹', '辆', '台', '部', '架', '家', '间', '座', '栋', '户', '套', '款', '种', '样', '期', '集', '季', '章', '节', '课', '篇', '页', '行', '句', '字', '遍', '次', '回', '趟', '场', '局', '轮', '步', '招', '波', '下', '岁', '代', '届', '人', '帧', '格',
].sort((a, b) => b.length - a.length);
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&');
const UNIT_RE = `(?:${UNITS.map(esc).join('|')})`;
const QUANT = '个款种次位只条张件家套部回招样份批群段句波期碗杯集首篇本场天年阵组点';
const CN_NUM = '[零一二三四五六七八九十百千万两几半]';
// 结果补语和趋向补语（「过」「着」「了」不在里面：标准第 5、11 条要求它们单独切）
const VERB_TAIL = new Set(['完', '到', '懂', '光', '透', '好', '会', '住', '掉', '成', '满', '够', '坏', '错', '对', '清', '齐', '饱', '醒', '死', '惯', '腻', '开', '倒', '翻', '破',
  '清楚', '明白', '干净', '起来', '出来', '下来', '上来', '进来', '进去', '出去', '回来', '过来', '下去', '上去', '回去', '过去']);
const DIRECTIONAL = new Set(['起来', '出来', '下来', '上来', '进来', '进去', '出去', '回来', '过来', '下去', '上去', '回去', '过去']);
// 可能补语「看不全、记不住、上不去」前面的单字动词
const POT_VERB = '看听说做写读吃喝玩学用剪拍刷买卖找想睡洗记拿放抓追跟等穿装数搬挤上下进出回起来去比打改走跑认';
const POT_TAIL = '全住去到清懂完动起下开见着了上来出回透掉';

// 模式：[正则, 能切开哪些块]
const HAN = '[\\u4e00-\\u9fff]';
const PATTERNS = [
  // 叠词：AABB（清清楚楚）、ABAB（研究研究）、数量词重叠（一次次）、AA（看看、试试；虚词不算）
  [new RegExp(`(${HAN})\\1(${HAN})\\2`, 'g'), 'strong'],
  [new RegExp(`((?![一二三四五六七八九十两几])${HAN}${HAN})\\1`, 'g'), 'cn'], // ABAB；「一个一个」这种数量词重复不算
  [new RegExp(`${CN_NUM}([个次天年波张遍回步件])\\1`, 'g'), 'strong'],
  [new RegExp(`([^\\s了吧啊呢吗呀哦嘛啦的地得着过一二三四五六七八九十0-9A-Za-z])\\1(?!\\1)`, 'g'), 'cn'],
  // 可能补语：单字动词＋不＋补语（看不全、记不住、上不去、做不了）
  [new RegExp(`[${POT_VERB}]不[${POT_TAIL}]`, 'g'), 'strong'],
  // 时刻：X点半、X点X分
  [new RegExp(`(?:[0-9]{1,2}|[一二三四五六七八九十两]{1,3})点(?:半|(?:[0-9]{1,2}|[一二三四五六七八九十]{1,3})分)`, 'g'), 'strong'],
  // 前几天、后两年、近三年、头几天（「这几天」按第 9 条拆开，不在这里）
  [new RegExp(`[前后近头](?:几|[一二三四五六七八九十两]{1,3}|[0-9]+)(?:个小时|个星期|个月|小时|星期|天|年|周)`, 'g'), 'strong'],
  // 带空格的英文产品名：Apple Watch、Claude Code、iPhone 17 Pro Max（后面的词要大写开头或者是数字）
  [/[A-Za-z][A-Za-z0-9.+\-]*(?: (?:[A-Z][A-Za-z0-9.+\-]*|[0-9]+[A-Za-z]*))+/g, 'strong'],
  // 英文连数字、连字符的型号：iPhone17、GPT-5、Wi-Fi、Qwen2.5
  [/[A-Za-z]+(?:[0-9]+(?:\.[0-9]+)?[A-Za-z]*|(?:-[A-Za-z0-9.]+)+)/g, 'strong'],
  // 时刻、比分
  [/[0-9]{1,2}[:：][0-9]{2}/g, 'strong'],
  // 促销日
  [/双(?:1[0-2]|十[一二]?)/g, 'strong'],
  // 第＋数字＋量词、数字＋单位（可以连两个单位：10万+、4个小时、2块钱）
  [new RegExp(`第?[0-9]+(?:[.,][0-9]+)*(?:(?:${UNIT_RE}){1,2}\\+?|\\+)`, 'g'), 'strong'],
  [new RegExp(`第[0-9]+`, 'g'), 'strong'],
  // 汉字数字＋单位：三分钟、半个小时、两块钱、一波、第三集
  [new RegExp(`第?${CN_NUM}+(?:${UNIT_RE}){1,2}`, 'g'), 'cn'],
  // 代词直接跟量词：这款、那种、每次、这家
  [new RegExp(`[这那哪每某各该][${QUANT}]`, 'g'), 'pron'],
];

function canSplit(tok, policy) {
  if (!tok) return true;
  const len = [...tok.w].length;
  if (len >= 4 || LEX.has(tok.w)) return false;
  if (policy === 'strong') return len <= 3;
  if (policy === 'cn') return len === 1 || /^(m|q|mq|x|eng)$/.test(tok.t || '') || !tok.t;
  if (policy === 'pron') return len === 1 || (len <= 2 && (/^(m|q|x|r)$/.test(tok.t || '') || !tok.t));
  return false;
}

/**
 * tokens：jieba 的结果（字符串数组，或者带词性的 [{w, t}]）。返回合并、修正后的字符串数组，拼回去跟原句一样。
 */
export function applyRules(tokensIn) {
  let toks = tokensIn.map((x) => (typeof x === 'string' ? { w: x, t: null } : { w: x.w ?? x.word, t: x.t ?? x.tag ?? null }));
  // 第一步：动词（词性 v 开头）＋结果补语
  const merged = [];
  for (let i = 0; i < toks.length; i++) {
    const a = toks[i]; const b = toks[i + 1];
    // 动词（v 开头），以及「好起来」这种形容词带趋向补语（a 开头，只认两字补语）
    const isV = a.t && /^v/.test(a.t);
    const isA = a.t && /^a/.test(a.t) && b && [...b.w].length === 2;
    // 两个字的动词只带趋向补语（起来、出来……）和单字结果补语（不含「到」：「导航到公司」的「到」是介词）；
    // 两个字的动词带两字结果补语（划分清楚）标注是拆开的。单字动词带什么补语都合并
    const la = [...a.w].length; const lb = b ? [...b.w].length : 0;
    const okPair = la === 1 || (la === 2 && (DIRECTIONAL.has(b?.w) || (lb === 1 && b.w !== '到')));
    if (b && (isV || isA) && la <= 2 && VERB_TAIL.has(b.w) && okPair && !LEX.has(a.w) && (isV || DIRECTIONAL.has(b.w))) {
      merged.push({ w: a.w + b.w, t: 'v' });
      i++;
    } else merged.push(a);
  }
  toks = merged;
  // 第二步：模式区间
  const text = toks.map((t) => t.w).join('');
  const bounds = new Set();
  const owner = new Array(text.length); // 每个下标属于哪个块
  let p = 0;
  toks.forEach((t, k) => { for (let i = 0; i < t.w.length; i++) owner[p + i] = k; p += t.w.length; bounds.add(p); });
  bounds.delete(text.length);
  const taken = new Array(text.length).fill(false);
  const spans = [];
  for (const [re, policy] of PATTERNS) {
    re.lastIndex = 0;
    const whole = new RegExp(`^(?:${re.source})$`);
    let m;
    while ((m = re.exec(text))) {
      const a = m.index;
      // 两头要补的切分点会不会切开不许切的块
      const edgeOk = (e) => e <= 0 || e >= text.length || bounds.has(e) || canSplit(toks[owner[e]], policy);
      // 匹配太长时（比如单位表多吞了一个字）往回缩，缩到仍然符合模式、两头也切得开为止
      let b = -1;
      for (let e = a + m[0].length; e >= a + 2; e--) {
        if (!whole.test(text.slice(a, e))) continue;
        if (edgeOk(a) && edgeOk(e)) { b = e; break; }
      }
      if (b < 0) continue;
      let free = true;
      for (let i = a; i < b; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      // 区间整个落在一个块里面：这个块已经把它包住了，不用动（动了反而会把块切开，比如「一下子」）
      if (owner[a] === owner[b - 1]) continue;
      for (let i = a; i < b; i++) taken[i] = true;
      spans.push([a, b]);
    }
  }
  for (const [a, b] of spans) {
    for (let i = a + 1; i < b; i++) bounds.delete(i);
    if (a > 0) bounds.add(a);
    if (b < text.length) bounds.add(b);
  }
  const cuts = [0, ...[...bounds].sort((x, y) => x - y), text.length];
  const out = [];
  for (let k = 0; k < cuts.length - 1; k++) if (cuts[k + 1] > cuts[k]) out.push(text.slice(cuts[k], cuts[k + 1]));
  return out;
}

/** 显示用的文字：去掉作者切分符 | 和关键词标记 *…*（要显示竖线、星号请用全角「｜」「＊」） */
export function plainText(text) {
  return String(text).replace(/[|*]/g, '');
}

/**
 * 解析一段（一行）的标记：| 是作者指定的切分点，*…* 是关键词。
 * 返回 { text: 去掉标记并去掉首尾空白的文字, breaks: [切分点下标], emphasis: [[起, 止)] }，下标都是相对 text 的
 */
export function parseMarkup(raw) {
  let plain = ''; const breaks = []; const emphasis = []; let open = -1;
  for (const ch of String(raw)) {
    if (ch === '|') { breaks.push(plain.length); continue; }
    if (ch === '*') {
      if (open < 0) open = plain.length;
      else { if (plain.length > open) emphasis.push([open, plain.length]); open = -1; }
      continue;
    }
    plain += ch;
  }
  if (open >= 0 && plain.length > open) emphasis.push([open, plain.length]); // 没闭合就标到行尾
  const lead = plain.length - plain.trimStart().length;
  const text = plain.trim();
  const fix = (i) => Math.min(Math.max(i - lead, 0), text.length);
  return {
    text,
    breaks: breaks.map(fix).filter((i) => i > 0 && i < text.length),
    emphasis: emphasis.map(([a, b]) => [fix(a), fix(b)]).filter(([a, b]) => b > a),
  };
}

/** 每段的切分结果 [{text, index}]，cut 是第二层分词函数（paragraph → string[]），没有就走第三层 */
export function buildSegmentation(rawText, { cut = null, source = 'jieba+lexicon' } = {}) {
  const paras = String(rawText).replace(/\r/g, '').split('\n');
  const out = [];
  let usedAuthor = false; let usedCut = false; let usedIcu = false;
  paras.forEach((raw, paragraphIndex) => {
    const mk = parseMarkup(raw);
    const text = mk.text;
    if (!text) return;
    let words;
    if (raw.includes('|')) {
      usedAuthor = true;
      const cuts = [0, ...mk.breaks, text.length];
      words = [];
      for (let k = 0; k < cuts.length - 1; k++) {
        const piece = text.slice(cuts[k], cuts[k + 1]);
        if (piece.trim()) words.push({ text: piece, index: cuts[k] });
      }
    } else if (cut) {
      usedCut = true;
      words = [];
      let idx = 0;
      for (const piece of applyRules(cut(text))) { words.push({ text: piece, index: idx }); idx += piece.length; }
      if (idx !== text.length) throw new Error(`分词结果拼回去跟原文不一致：${text}`);
    } else {
      usedIcu = true;
      let idx = 0;
      words = applyRules(segmentWords(text).map((w) => w.text)).map((piece) => { const w = { text: piece, index: idx }; idx += piece.length; return w; });
    }
    out.push({ text, paragraphIndex, words, emphasis: mk.emphasis });
  });
  const sources = [usedAuthor && 'author', usedCut && source, usedIcu && 'icu+lexicon'].filter(Boolean);
  return { sources, paragraphs: out };
}

/** 关键词查询：第几段、段内第几个字（UTF-16 下标）是不是关键词 */
export function emphasisFrom(segmentation) {
  const map = new Map((segmentation?.paragraphs || []).map((p) => [p.paragraphIndex, p.emphasis || []]));
  return (paragraph, index) => (map.get(paragraph) || []).some(([a, b]) => index >= a && index < b);
}

function trimWord(w, text) {
  // 作者切分的块可能带首尾空格，按原文位置校正
  let { text: t, index } = w;
  while (t.startsWith(' ')) { t = t.slice(1); index++; }
  t = t.replace(/\s+$/, '');
  if (text.slice(index, index + t.length) !== t) {
    const at = text.indexOf(t, Math.max(0, index - 2));
    if (at >= 0) index = at;
  }
  return { text: t, index };
}

/** 给排版用的分词函数：按段落原文查预先算好的结果，查不到就走兜底 */
export function segmenterFrom(segmentation) {
  const map = new Map((segmentation?.paragraphs || []).map((p) => [p.text, p.words]));
  const fallback = (paragraph) => {
    let idx = 0;
    return applyRules(segmentWords(paragraph).map((w) => w.text)).map((piece) => { const w = { text: piece, index: idx }; idx += piece.length; return w; });
  };
  return (paragraph) => map.get(paragraph) || fallback(paragraph);
}
