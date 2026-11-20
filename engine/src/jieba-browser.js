// 第二层分词（浏览器端）：只在试玩台用户现场打字时才加载（wasm 约 4 MB，gzip 后约 2.8 MB）。
// 跟 Node 端用同一个包的同一份 wasm 和词典，补充词表也一样，所以两边切出来一致。
import { BUILTIN_WORDS } from './lib/lexicon.js';

const BASE = '/engine/node_modules/jieba-wasm/pkg/web/';
const LEXICON_FREQ = 200000; // 跟 cli/lib/jieba.mjs 保持一致
const IDIOM_FREQ = 50000;
let loading = null;

export function loadJiebaBrowser() {
  if (!loading) {
    loading = (async () => {
      const mod = await import(BASE + 'jieba_rs_wasm.js');
      await mod.default({ module_or_path: BASE + 'jieba_rs_wasm_bg.wasm' });
      // 成语表（THUOCL，MIT），跟 Node 端同一份文件、同样的加载顺序
      const idioms = (await (await fetch('/engine/data/idioms-thuocl.txt')).text()).split('\n').filter((l) => l && !l.startsWith('#'));
      for (const w of idioms) mod.add_word(w, IDIOM_FREQ);
      for (const w of BUILTIN_WORDS) mod.add_word(w, LEXICON_FREQ);
      const demote = (await (await fetch('/engine/data/lexicon-demote.txt')).text()).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split('\t')[0].trim());
      for (const w of demote) mod.add_word(w, 1);
      // 跟 Node 端一样用带词性的切分（规则层要用词性）
      return (paragraph) => mod.tag(paragraph, true).map((x) => ({ w: x.word, t: x.tag }));
    })();
  }
  return loading;
}
