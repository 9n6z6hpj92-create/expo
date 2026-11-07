#!/usr/bin/env node
/**
 * Snapshot the package names in this app's production bundle.
 *
 *   node apps/minimal-tester/scripts/gen-prod-bundle-deps.js
 *   node apps/minimal-tester/scripts/gen-prod-bundle-deps.js --check
 */

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');

function parseArgs(argv) {
  let check = false;
  let platform = 'ios';
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--platform') {
      const value = argv[++i];
      if (value !== 'ios' && value !== 'android') {
        console.error(`Unsupported platform: ${value ?? '(missing)'}`);
        process.exit(2);
      }
      platform = value;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node apps/minimal-tester/scripts/gen-prod-bundle-deps.js [--check] [--platform ios|android]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return { check, platform };
}

function collectSources(map, sources) {
  if (map == null) return;
  if (Array.isArray(map.sources)) {
    for (const source of map.sources) {
      if (typeof source === 'string' && source.length > 0) sources.push(source);
    }
  }
  if (Array.isArray(map.sections)) {
    for (const section of map.sections) collectSources(section.map, sources);
  }
}

const packageNameByDir = new Map();

function packageNameAt(dir) {
  const cached = packageNameByDir.get(dir);
  if (cached !== undefined) return cached;
  let name = null;
  const file = path.join(dir, 'package.json');
  if (fs.existsSync(file)) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof json.name === 'string' && json.name.length > 0) name = json.name;
    } catch {
      name = null;
    }
  }
  packageNameByDir.set(dir, name);
  return name;
}

/**
 * Package name for one source-map path.
 *
 * Scoped and nested packages come from the nearest package.json, so
 * `node_modules/@scope/name` and `node_modules/foo/node_modules/bar` both
 * resolve to the package that owns the file. Workspace packages resolve the
 * same way once the path is realpath'd out of a pnpm symlink.
 *
 * Metro writes paths relative to the monorepo root with a leading slash
 * (`/packages/expo/build/Expo.js`, `/node_modules/.pnpm/...`). Those are not
 * filesystem-absolute. A path that exists on disk wins; otherwise the slash
 * is stripped and the path is resolved from the repo root, then the app root.
 *
 * The app's own source (the package at the export root) is omitted. Virtual
 * modules, whose ids contain a NUL, are omitted too. Polyfills that live in a
 * real package, such as `@react-native/js-polyfills` or `metro-runtime`, stay.
 */
function resolveSourceFile(source, appRoot, repoRoot) {
  let file = source.split('?')[0] ?? source;
  if (file.startsWith('file://')) file = file.slice('file://'.length);
  try {
    file = decodeURIComponent(file);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  const stripped = file.startsWith('/') ? file.slice(1) : file;
  const candidates = [
    path.isAbsolute(file) && fs.existsSync(file) ? file : null,
    path.resolve(repoRoot, stripped),
    path.resolve(appRoot, stripped),
  ];
  for (const candidate of candidates) {
    if (candidate != null && fs.existsSync(candidate)) {
      try {
        return fs.realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
  }
  return null;
}

function packageNameForSource(source, appRoot, repoRoot) {
  if (source.includes('\0')) return null;
  const real = resolveSourceFile(source, appRoot, repoRoot);
  if (real == null) return null;
  const root = path.parse(real).root;
  let dir = path.dirname(real);
  while (dir.startsWith(root) && dir !== root) {
    const name = packageNameAt(dir);
    if (name != null) {
      if (path.resolve(dir) === path.resolve(appRoot)) return null;
      return name;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const SNAPSHOT_FILE = 'prod-bundle-deps.txt';
const UPDATE_COMMAND = 'node apps/minimal-tester/scripts/gen-prod-bundle-deps.js';

// signedsource (facebook/fbjs). The token sits in a comment and is replaced
// with `@generated SignedSource<<md5>>`. The hash covers the token, not the
// signature, so signing does not change the package list.
const SIGNED_SOURCE_GENERATED = '@' + 'generated';
const SIGNED_SOURCE_TOKEN = '<<SignedSource::*O*zOeWoEQle#+L!plEphiEmie@IsG>>';
const SIGNED_SOURCE_PATTERN = new RegExp(
  `${SIGNED_SOURCE_GENERATED} (?:SignedSource<<([a-f0-9]{32})>>)`
);

function signSignedSource(data) {
  if (!data.includes(SIGNED_SOURCE_TOKEN)) {
    throw new Error(`Cannot sign snapshot without signedsource token: ${SIGNED_SOURCE_TOKEN}`);
  }
  const digest = createHash('md5').update(data, 'utf8').digest('hex');
  return data.replace(SIGNED_SOURCE_TOKEN, `SignedSource<<${digest}>>`);
}

function snapshotPath() {
  return path.join(APP_ROOT, SNAPSHOT_FILE);
}

function packageCount(text) {
  return text.split('\n').filter((line) => line.length > 0 && !line.startsWith('#')).length;
}

function formatList(names) {
  const packages = [...names].sort().join('\n');
  const unsigned = `# Generated by \`${UPDATE_COMMAND}\`.\n# ${SIGNED_SOURCE_GENERATED} ${SIGNED_SOURCE_TOKEN}\n\n${packages}\n`;
  const signed = signSignedSource(unsigned);
  const match = SIGNED_SOURCE_PATTERN.exec(signed);
  const unsignedAgain = signed.replace(
    SIGNED_SOURCE_PATTERN,
    `${SIGNED_SOURCE_GENERATED} ${SIGNED_SOURCE_TOKEN}`
  );
  const digest = createHash('md5').update(unsignedAgain, 'utf8').digest('hex');
  if (match?.[1] !== digest) {
    throw new Error('signedsource signature does not match the snapshot');
  }
  return signed;
}

function bundleSourceMaps(outputDir, platform) {
  const metadataPath = path.join(outputDir, 'metadata.json');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  const bundle = metadata.fileMetadata?.[platform]?.bundle;
  if (bundle == null || bundle.length === 0) {
    throw new Error(`Export metadata has no ${platform} bundle`);
  }
  const bundleDir = path.dirname(path.join(outputDir, bundle));
  const maps = fs
    .readdirSync(bundleDir)
    .filter((file) => file.endsWith('.js.map') || file.endsWith('.hbc.map'))
    .sort()
    .map((file) => path.join(bundleDir, file));
  if (maps.length === 0) {
    throw new Error(`No source map next to ${bundle}`);
  }
  return maps;
}

function packagesFromExport(outputDir, platform) {
  const names = new Set();
  for (const mapPath of bundleSourceMaps(outputDir, platform)) {
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    const sources = [];
    collectSources(map, sources);
    for (const source of sources) {
      const name = packageNameForSource(source, APP_ROOT, REPO_ROOT);
      if (name != null) names.add(name);
    }
  }
  if (names.size === 0) {
    throw new Error('No packages found in the production bundle source map');
  }
  return [...names];
}

function exportProductionBundle(platform) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-bundle-deps-'));
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'expo',
      'export',
      '--platform',
      platform,
      '--source-maps',
      '--no-bytecode',
      '--clear',
      '--output-dir',
      outputDir,
    ],
    {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        CI: '1',
        EXPO_NO_TELEMETRY: '1',
        SKIP_SKIA_DOWNLOAD: '1',
      },
      stdio: 'inherit',
    }
  );
  if (result.status !== 0) {
    fs.rmSync(outputDir, { recursive: true, force: true });
    throw new Error(`expo export failed with status ${result.status ?? 'null'}`);
  }
  return outputDir;
}

function main() {
  const { check, platform } = parseArgs(process.argv);
  const outputDir = exportProductionBundle(platform);
  try {
    const text = formatList(packagesFromExport(outputDir, platform));
    const target = snapshotPath();
    const relativeTarget = path.relative(REPO_ROOT, target);
    if (!check) {
      fs.writeFileSync(target, text);
      console.log(`Wrote ${packageCount(text)} packages to ${relativeTarget}`);
      return;
    }
    const expected = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (expected === text) {
      console.log(`${relativeTarget} matches (${packageCount(text)} packages)`);
      return;
    }
    console.error(`Production bundle packages differ from ${relativeTarget}`);
    console.error(`Update it with \`${UPDATE_COMMAND}\`.`);
    const diff = spawnSync('diff', ['-u', '-L', relativeTarget, '-L', 'generated', target, '-'], {
      encoding: 'utf8',
      input: text,
    });
    if (diff.stdout) process.stderr.write(diff.stdout);
    process.exitCode = 1;
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
