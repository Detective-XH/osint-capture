const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const watch = process.argv.includes('--watch');

// During the JS→TS migration an entry may be either .ts or .js. Resolve whichever
// exists so incremental renames don't require touching this file each time.
// esbuild strips the types and emits the same .js regardless of source extension.
function resolveEntry(base) {
  return fs.existsSync(`${base}.ts`) ? `${base}.ts` : `${base}.js`;
}

const shared = {
  bundle: true,
  sourcemap: false,
  target: ['chrome120', 'edge120'],
};

function copyStatic() {
  fs.mkdirSync('dist/popup', { recursive: true });
  fs.mkdirSync('dist/icons', { recursive: true });

  fs.copyFileSync('src/manifest.json', 'dist/manifest.json');
  fs.copyFileSync('src/popup/popup.html',     'dist/popup/popup.html');
  fs.copyFileSync('src/popup/popup.css',      'dist/popup/popup.css');
  fs.cpSync('src/icons', 'dist/icons', { recursive: true });
  fs.mkdirSync('dist/lib', { recursive: true });
  fs.cpSync('src/lib', 'dist/lib', { recursive: true });
}

async function build() {
  await esbuild.build({
    ...shared,
    entryPoints: [resolveEntry('src/content')],
    outfile: 'dist/content.js',
  });
  await esbuild.build({
    ...shared,
    entryPoints: [resolveEntry('src/popup/popup')],
    outfile: 'dist/popup/popup.js',
  });
  await esbuild.build({
    ...shared,
    entryPoints: [resolveEntry('src/background')],
    outfile: 'dist/background.js',
  });
  copyStatic();
  console.log('Build complete.');

  // Package zip
  const manifest = JSON.parse(fs.readFileSync('src/manifest.json', 'utf8'));
  const ver = manifest.version;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const zipName = `osint-capture-${ver}-${today}.zip`;
  fs.mkdirSync(path.join('..', 'releases'), { recursive: true });
  const { execSync } = require('child_process');
  execSync(`cd dist && zip -r ../../releases/${zipName} .`, { stdio: 'inherit' });
  console.log(`Packaged: releases/${zipName}`);
}

build().catch(() => process.exit(1));
