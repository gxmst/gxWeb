import { readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function collectFiles(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path, extensions)));
    else if (entry.isFile() && extensions.includes(extname(entry.name))) files.push(path);
  }

  return files;
}

const publicJsFiles = (await collectFiles(join(root, 'public', 'js'), ['.js'])).sort();
const files = [
  ...publicJsFiles,
  ...(await collectFiles(join(root, '.github', 'scripts'), ['.mjs'])).sort(),
  ...(await collectFiles(join(root, 'tests'), ['.mjs'])).sort(),
  join(root, 'public', 'vendor', 'purify.min.js'),
  join(root, 'tailwind.config.cjs'),
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const html = await readFile(join(root, 'public', 'index.html'), 'utf8');
const entryMatch = html.match(/<script\s+type="module"\s+src="\.\/js\/main\.js\?v=([^"]+)"/i);
if (!entryMatch) {
  console.error('Missing versioned <script type="module" src="./js/main.js?v=..."> in public/index.html');
  process.exit(1);
}
const version = entryMatch[1];

const cssMatches = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="(\.\/(?:css\/[^"]+|vendor\/app\.css[^"]*))"/gi)];
for (const [, href] of cssMatches) {
  if (!href.endsWith(`?v=${version}`)) {
    console.error(`Stylesheet href missing matching ?v=${version}: ${href}`);
    process.exit(1);
  }
}

const preloadMap = new Map();
for (const [, href] of html.matchAll(/<link\s+rel="modulepreload"\s+href="([^"]+)"/gi)) {
  const [pathPart, queryPart = ''] = href.split('?');
  if (queryPart !== `v=${version}`) {
    console.error(`modulepreload href missing matching ?v=${version}: ${href}`);
    process.exit(1);
  }
  preloadMap.set(pathPart, href);
}

const expectedPreloads = new Set(
  publicJsFiles.map(file => `./${relative(join(root, 'public'), file).replaceAll('\\', '/')}`)
);
for (const expected of expectedPreloads) {
  if (!preloadMap.has(expected)) {
    console.error(`Missing <link rel="modulepreload"> for ${expected} in public/index.html`);
    process.exit(1);
  }
}
for (const actual of preloadMap.keys()) {
  if (!expectedPreloads.has(actual)) {
    console.error(`Dangling <link rel="modulepreload"> in public/index.html: ${actual}`);
    process.exit(1);
  }
}

for (const file of publicJsFiles) {
  const source = await readFile(file, 'utf8');
  for (const [, spec] of source.matchAll(/\b(?:import|export)\b[^'"]*?\bfrom\s+['"](\.[^'"]+)['"]/g)) {
    if (!spec.endsWith(`.js?v=${version}`)) {
      const rel = relative(root, file).replaceAll('\\', '/');
      console.error(`Relative import missing ?v=${version} in ${rel}: ${spec}`);
      process.exit(1);
    }
  }
}

console.log(`JavaScript syntax & cache-busting check passed (${files.length} files, version=${version})`);
