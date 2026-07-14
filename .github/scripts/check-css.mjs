import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'gxweb-css-'));
const generatedCss = join(temporaryDirectory, 'app.css');

try {
  const tailwindCli = join(root, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
  const result = spawnSync(
    process.execPath,
    [
      tailwindCli,
      '-c',
      'tailwind.config.js',
      '-i',
      'build/tailwind-input.css',
      '-o',
      generatedCss,
      '--minify',
    ],
    { cwd: root, stdio: 'inherit' },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Tailwind build failed with exit code ${result.status ?? 'unknown'}`);
  }

  const [expected, actual] = await Promise.all([
    readFile(generatedCss),
    readFile(join(root, 'public', 'vendor', 'app.css')),
  ]);

  if (!expected.equals(actual)) {
    throw new Error('public/vendor/app.css is stale; run `npm run build:css`');
  }

  console.log('Tailwind CSS artifact is in sync');
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
