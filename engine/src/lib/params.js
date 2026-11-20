// 参数解析：默认值 + 预设（配色 C*、节奏 R*）+ 用户覆盖。浏览器和 Node 共用。
// meta.json 是参数的唯一来源：画廊不用执行风格代码就能生成控件。

/**
 * @param {object} meta 风格的 meta.json
 * @param {object} overrides 用户给的参数（可以只给几个）
 * @returns {object} 完整参数，外加 _palette / _rhythm 两个展开后的预设对象
 */
export function resolveParams(meta, overrides = {}) {
  const p = {};
  for (const def of meta.params) p[def.key] = def.default;
  // 造型预设（V0、V1……）：一组参数值，盖过默认值，但用户自己给的参数优先
  // 造型可以用编号，也可以用别名（比如「综艺」「showcase」）；解析后 params.look 一律是编号
  const lookId = overrides.look ?? p.look;
  const look = (meta.looks || []).find((l) => l.id === lookId || (l.aliases || []).includes(lookId));
  if (look) { p.look = look.id; if (overrides.look !== undefined) overrides = { ...overrides, look: look.id }; }
  if (lookId && meta.looks && !look) throw new Error(`没有造型预设 ${lookId}（可用：${meta.looks.map((l) => l.id).join('、')}）`);
  if (look) {
    for (const [k, v] of Object.entries(look.params)) {
      const def = meta.params.find((d) => d.key === k);
      if (!def) throw new Error(`造型预设 ${look.id} 里有未知参数 ${k}`);
      p[k] = coerce(def, v);
    }
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null) continue;
    const def = meta.params.find((d) => d.key === k);
    // 空字符串默认当「没填」用默认值；参数声明了 allowEmpty（比如 003 的印章字「留空就不盖章」）才把空当成值
    if (v === '' && !(def && def.allowEmpty)) continue;
    if (!def) throw new Error(`未知参数：${k}（可用：${meta.params.map((d) => d.key).join('、')}）`);
    p[k] = coerce(def, v);
  }
  const palette = (meta.palettes || []).find((c) => c.id === p.palette) || (meta.palettes || [])[0];
  const rhythm = (meta.rhythms || []).find((r) => r.id === p.rhythm) || (meta.rhythms || [])[0];
  // 单独改的颜色盖过配色预设
  const colors = { ...(palette ? palette.colors : {}) };
  for (const def of meta.params) {
    if (def.overrides && p[def.key]) colors[def.overrides] = p[def.key];
  }
  return { ...p, _palette: { ...palette, colors }, _rhythm: rhythm ? { ...rhythm } : {}, _look: look ? { id: look.id, name: look.name } : null };
}

function coerce(def, v) {
  switch (def.type) {
    case 'number':
    case 'range': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`参数 ${def.key} 要数字，收到 ${v}`);
      const lo = def.min ?? -Infinity;
      const hi = def.max ?? Infinity;
      return Math.min(hi, Math.max(lo, n));
    }
    case 'int':
      return Math.round(Number(v)) | 0;
    case 'bool':
      return v === true || v === 'true' || v === 1 || v === '1';
    case 'select': {
      const ok = def.options.map((o) => (typeof o === 'object' ? o.value : o));
      if (!ok.includes(v)) throw new Error(`参数 ${def.key} 只能是 ${ok.join('/')}，收到 ${v}`);
      return v;
    }
    case 'color':
      if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`参数 ${def.key} 要 #RRGGBB，收到 ${v}`);
      return v.toUpperCase();
    default:
      return String(v);
  }
}

/** 调用编号：风格 · 配色 · 节奏，比如 P0-01·C2·R1 */
export function comboCode(meta, params) {
  return [meta.code || meta.id, params.look, params.palette, params.rhythm].filter(Boolean).join('·');
}

/** 所有 text 类型参数的值拼在一起（做字体子集、缺字检查用：署名、印章这类单独的文字参数也要算进去） */
export function allTextParams(meta, params) {
  return meta.params.filter((d) => d.type === 'text').map((d) => params[d.key] ?? '').join('\n');
}

/**
 * 这次要加载哪些字体、每款给哪些字。
 * 默认所有文字参数都用主字体（params.font）那条链；meta.paramFonts 可以指定某个文字参数改用另一款字体，
 * 比如 003 的印章字用思源宋体 Black：{ "seal": "notoserif-black" }。值也可以写成 "@参数名"，表示用那个参数选的字体。
 * 返回 [{ fontId, chain, chars }]：chain 是这款字体加上 meta.fontFallback 里它的备用字体；chars 是这一组要的字（含 extraGlyphs 只给主字体组）。
 * 导出（pipeline）和试玩台都用它，所以两边加载的字体一致。
 */
export function fontPlan(meta, params, plain = (s) => s) {
  const primary = params.font || meta.fonts[0];
  const pf = meta.paramFonts || {};
  const pick = (v) => (typeof v === 'string' && v.startsWith('@') ? params[v.slice(1)] : v);
  const groups = new Map();
  const add = (fontId, text) => {
    if (!groups.has(fontId)) groups.set(fontId, { fontId, chain: [fontId, ...((meta.fontFallback || {})[fontId] || [])], text: '' });
    groups.get(fontId).text += text;
  };
  add(primary, meta.extraGlyphs || '');
  for (const d of meta.params) {
    if (d.type !== 'text') continue;
    const v = params[d.key] ?? '';
    add(pf[d.key] ? pick(pf[d.key]) || primary : primary, plain(String(v)) + '\n');
  }
  // 参数字体那一组要是一个看得见的字都没有（几项都留空），就不出这一组：不做子集、不加载。
  // 只有空白的子集 glyf 表长度是 0，浏览器会拒收（OTS），导出就挂载失败。主字体组一直留着（风格要用它的字体名）
  return [...groups.values()]
    .filter((g) => g.fontId === primary || /\S/.test(g.text))
    .map((g) => ({ fontId: g.fontId, chain: g.chain, chars: g.text }));
}
