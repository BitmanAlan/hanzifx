#!/usr/bin/env node
// npm run dev：本地起试玩页。
import { startServer } from './lib/server.mjs';
const port = Number(process.env.PORT || process.argv[2] || 5180);
const s = await startServer({ port });
console.log(`试玩页：${s.url}/engine/player/`);
