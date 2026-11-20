// 小参数解析：--key value、--key=value、--flag；--set k=v 可以写多次。
export function parseArgs(argv) {
  const out = { _: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (v === undefined) {
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('--')) { v = nxt; i++; } else v = true;
    }
    if (k === 'set') out.set.push(v); else out[k] = v;
  }
  return out;
}

/**
 * 拍点和字级时间（export、check、demo、determinism 共用，校验一样）：
 *   --beats 0.5,1.0,…  或  --beats-file 拍点.json（数组，或 { beats: [...] }）
 *   --words-file 时间.json（[{ text, start, end }, …]，秒）  --words-offset 毫秒
 * 文件读不到、不是 JSON、格式不对、偏移不是数，都直接报错（不悄悄忽略）。逐条的严格校验在底座 normalizeWords 里做。
 * base：相对路径从哪里算（demo 条目里的 wordsFile 从风格目录算）；默认当前目录。
 */
export async function timingArgs(args, { base = null } = {}) {
  const { readFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const abs = (f) => (base ? resolve(base, String(f)) : resolve(String(f)));
  const readJson = async (f, what) => {
    let raw;
    try { raw = await readFile(abs(f), 'utf8'); } catch { throw new Error(`${what}读不到：${f}`); }
    try { return JSON.parse(raw); } catch { throw new Error(`${what}不是合法的 JSON：${f}`); }
  };
  let beats = [];
  if (args.beats !== undefined && args.beats !== true) beats = String(args.beats).split(',').map((v) => Number(v.trim()));
  if (args['beats-file'] !== undefined && args['beats-file'] !== true) {
    const raw = await readJson(args['beats-file'], '拍点文件');
    beats = Array.isArray(raw) ? raw : raw && Array.isArray(raw.beats) ? raw.beats : null;
    if (!beats) throw new Error(`拍点文件要是一串秒数，或者 { "beats": [...] }：${args['beats-file']}`);
  }
  if (beats.some((b) => !Number.isFinite(Number(b)))) throw new Error(`拍点里有不是数的：${beats.join(',')}`);
  let words = [];
  if (args['words-file'] === true) throw new Error('--words-file 后面要跟时间文件的路径');
  if (args['words-file'] !== undefined) {
    words = await readJson(args['words-file'], '字级时间文件');
    if (!Array.isArray(words)) throw new Error(`字级时间文件要是一个数组：[{"text":"普通人","start":0.12,"end":0.55}, …]：${args['words-file']}`);
  }
  const wordsOffsetMs = args['words-offset'] === undefined || args['words-offset'] === true ? 0 : Number(args['words-offset']);
  if (!Number.isFinite(wordsOffsetMs)) throw new Error(`--words-offset 要是毫秒数，收到 ${args['words-offset']}`);
  return { beats: beats.map(Number), words, wordsOffsetMs };
}

/** --text/--palette/... 和 --set k=v 合成风格参数 */
export function styleParams(args, keys) {
  const p = {};
  for (const k of keys) if (args[k] !== undefined && args[k] !== true) p[k] = args[k];
  for (const kv of args.set) {
    const m = /^([^=]+)=(.*)$/s.exec(kv);
    if (!m) throw new Error(`--set 要写成 key=value，收到 ${kv}`);
    p[m[1]] = m[2];
  }
  if (typeof p.text === 'string') p.text = p.text.replace(/\\n/g, '\n');
  return p;
}
