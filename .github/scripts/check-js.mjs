import { readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectJavaScript(path)));
    else if (entry.isFile() && extname(entry.name) === '.js') files.push(path);
  }

  return files;
}

const files = [
  ...(await collectJavaScript(join(root, 'public', 'js'))),
  join(root, 'public', 'vendor', 'purify.min.js'),
  join(root, 'tailwind.config.js'),
].sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`JavaScript syntax check passed (${files.length} files)`);
