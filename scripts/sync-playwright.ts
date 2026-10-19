import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function syncPlaywright(skillsRoot: string | undefined, targetRoot = projectRoot): Promise<void> {
  skillsRoot = skillsRoot?.trim();
  if (!skillsRoot) throw new Error('必须配置 SKILLS_REPO_DIR，指向 skills 上游仓库；禁止使用本地脚本快照构建。');
  const files = ['chromium-connect.ps1', 'runtime-types.ps1'];
  const contents = await Promise.all(files.map(async name => {
    const source = path.join(path.resolve(targetRoot, skillsRoot), 'shared', name);
    return readFile(source, 'utf8').catch(error => {
      throw new Error(`无法读取 skills 上游脚本：${source}`, { cause: error });
    });
  }));
  const target = path.join(targetRoot, 'scripts/playwright');
  await mkdir(target, { recursive: true });
  await Promise.all(files.map((name, index) => writeFile(path.join(target, name), contents[index])));
}
if (import.meta.main) {
  const root = process.env.SKILLS_REPO_DIR?.trim();
  await syncPlaywright(root);
  console.log('已从 skills 上游生成浏览器授权脚本');
}
