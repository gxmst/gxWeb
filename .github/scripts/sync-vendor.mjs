import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checkOnly = process.argv.includes('--check');
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--check');

if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArgs.join(', ')}`);
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const declaredVersion = packageJson.devDependencies?.dompurify;

if (!/^\d+\.\d+\.\d+$/.test(declaredVersion || '')) {
  throw new Error('devDependencies.dompurify must be an exact semver version');
}

const installedPackage = JSON.parse(
  await readFile(join(root, 'node_modules', 'dompurify', 'package.json'), 'utf8'),
);

if (installedPackage.version !== declaredVersion) {
  throw new Error(
    `DOMPurify version mismatch: package.json=${declaredVersion}, installed=${installedPackage.version}`,
  );
}

const files = ['purify.min.js', 'purify.min.js.map'];
const sourceDir = join(root, 'node_modules', 'dompurify', 'dist');
const targetDir = join(root, 'public', 'vendor');

if (!checkOnly) await mkdir(targetDir, { recursive: true });

for (const filename of files) {
  const source = join(sourceDir, filename);
  const target = join(targetDir, filename);

  if (checkOnly) {
    const [expected, actual] = await Promise.all([
      readFile(source),
      readFile(target).catch(() => null),
    ]);

    if (actual === null || !expected.equals(actual)) {
      throw new Error(`${target} is stale; run \`npm run vendor:sync\``);
    }
  } else {
    await copyFile(source, target);
  }
}

console.log(
  checkOnly
    ? `DOMPurify ${declaredVersion} vendor files are in sync`
    : `Synced DOMPurify ${declaredVersion} vendor files`,
);
