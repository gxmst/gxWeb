import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rawVersion = (process.argv[2] || '').trim();

if (!rawVersion || !/^[a-zA-Z0-9._-]+$/.test(rawVersion)) {
  console.error('Usage: node .github/scripts/bump-version.mjs <version-tag>');
  process.exit(1);
}

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

const publicJsDir = join(root, 'public', 'js');
const jsFiles = (await collectFiles(publicJsDir, ['.js'])).sort();

let updatedJsCount = 0;
for (const file of jsFiles) {
  const original = await readFile(file, 'utf8');
  const next = original.replace(
    /(\b(?:import|export)\b[^'"]*?\bfrom\s+['"]\.[^'"]+?\.js)(?:\?v=[^'"]*)?(['"])/g,
    `$1?v=${rawVersion}$2`,
  );
  if (next !== original) {
    await writeFile(file, next, 'utf8');
    updatedJsCount++;
  }
}

const indexPath = join(root, 'public', 'index.html');
let html = await readFile(indexPath, 'utf8');

html = html.replace(
  /(<link\s+rel="stylesheet"\s+href="\.\/(?:css\/[^"?]+|vendor\/app\.css))(?:\?v=[^"]*)?(")/gi,
  `$1?v=${rawVersion}$2`,
);

html = html.replace(
  /(<script\s+type="module"\s+src="\.\/js\/main\.js)(?:\?v=[^"]*)?(")/i,
  `$1?v=${rawVersion}$2`,
);

const preloadTags = jsFiles.map(file => {
  const rel = relative(join(root, 'public'), file).replaceAll('\\', '/');
  return `    <link rel="modulepreload" href="./${rel}?v=${rawVersion}">`;
}).join('\n');

const preloadBlockRegex = /([ \t]*<link\s+rel="modulepreload"\s+href="[^"]+"[^>]*>\r?\n?)+/i;
if (preloadBlockRegex.test(html)) {
  html = html.replace(preloadBlockRegex, `${preloadTags}\n`);
} else {
  html = html.replace(/<\/head>/i, `${preloadTags}\n</head>`);
}

await writeFile(indexPath, html, 'utf8');
console.log(`Updated asset version to ${rawVersion} across index.html and ${updatedJsCount} JS files (${jsFiles.length} preloads synced)`);
