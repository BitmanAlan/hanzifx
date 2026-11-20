// 调系统里的 ffmpeg / ffprobe（作为外部程序调用，不链接、不打包）。
import { spawn } from 'node:child_process';

export function run(cmd, args, { input } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = []; const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', (e) => fail(new Error(`${cmd} 启动失败：${e.message}（没装？）`)));
    p.on('close', (code) => {
      const stdout = Buffer.concat(out); const stderr = Buffer.concat(err).toString();
      if (code !== 0) fail(new Error(`${cmd} 退出码 ${code}：${stderr.slice(-2000)}`));
      else ok({ stdout, stderr });
    });
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}

export async function versionOf(cmd) {
  try {
    const { stdout } = await run(cmd, ['-version']);
    return stdout.toString().split('\n')[0].trim();
  } catch { return null; }
}

export async function encoders() {
  const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders']);
  const s = stdout.toString();
  return { libx264: /\blibx264\b/.test(s), prores_ks: /\bprores_ks\b/.test(s), libvpx_vp9: /\blibvpx-vp9\b/.test(s) };
}

const COLOR = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
const EXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1'];

/** 帧序列 → 成片。framesPattern 形如 dir/%06d.png */
export async function encode(format, framesPattern, fps, out) {
  const input = ['-y', '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', framesPattern];
  let args;
  if (format === 'mp4') {
    args = [...input,
      '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-tune', 'animation', '-profile:v', 'high',
      ...COLOR, '-color_range', 'tv', '-movflags', '+faststart', ...EXACT, out];
  } else if (format === 'mov') {
    args = [...input,
      '-vf', 'scale=out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuva444p10le',
      '-c:v', 'prores_ks', '-profile:v', '4444', '-alpha_bits', '16', '-vendor', 'apl0',
      ...COLOR, ...EXACT, out];
  } else if (format === 'webm') {
    args = [...input,
      '-vf', 'scale=out_color_matrix=bt709:flags=accurate_rnd+full_chroma_int,format=yuva420p',
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '18', '-deadline', 'good', '-cpu-used', '1',
      '-row-mt', '0', '-threads', '1', '-auto-alt-ref', '0', ...COLOR, ...EXACT, out];
  } else throw new Error(`未知格式 ${format}`);
  await run('ffmpeg', args);
}

export async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_frames,color_space,color_transfer,color_primaries:stream_tags:format=duration,size,format_name',
    '-of', 'json', file]);
  const j = JSON.parse(stdout.toString());
  return { ...j.streams[0], format: j.format };
}

const decoderFor = (file) => (file.endsWith('.webm') ? ['-c:v', 'libvpx-vp9'] : []);

/** 逐帧解码后的 md5（ffmpeg framemd5），用来证明两次导出的画面逐帧一致 */
export async function framemd5(file) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...decoderFor(file), '-i', file, '-map', '0:v', '-f', 'framemd5', '-']);
  return stdout.toString().split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

/** 把成片的第 k 帧解成 RGBA PNG（webm 强制用 libvpx 解码器，原生解码器会丢 alpha） */
export async function extractRgba(file, k) {
  const { stdout } = await run('ffmpeg', ['-v', 'error', ...decoderFor(file), '-i', file,
    '-vf', `select=eq(n\\,${k})`, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'image2pipe', '-c:v', 'png', '-']);
  return stdout;
}
