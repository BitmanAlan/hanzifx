// 原子写文件：先写同目录下的临时文件，再 rename 盖过去。
// 用在几个导出共用的缓存上（out/.fonts/<内容哈希>/）。普通 writeFile 会先把文件截成 0 再写，
// 另一个导出的浏览器正好来读，就会读到半个字体文件。rename 在同一个磁盘上是原子的：
// 读的一方要么看到旧文件、要么看到新文件，不会看到写了一半的。
import { writeFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

let seq = 0;

export async function writeFileAtomic(path, data) {
  const tmp = `${path}.${process.pid}.${++seq}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
