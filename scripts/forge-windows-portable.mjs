#!/usr/bin/env node
/**
 * forge-windows-portable.mjs —— 把 electron-forge 前端的 `npm run package` 产物
 * 打成 N.E.K.O 的 Windows Portable 发布资产。
 *
 * 用法（CI 与本地 scripts/build-desktop-release.ps1 共用同一份实现）：
 *
 *   node scripts/forge-windows-portable.mjs \
 *     --dir electron-app --version 1.2.3 --out electron-app/dist \
 *     [--previous previous-portable/previous-win-manifest.json] [--dry-run]
 *
 * 前置条件：`--dir` 指向的前端 checkout 已经跑完 `npm run package`，且同目录下的
 * `bin/projectneko_server.exe` 已就位（CI 用 actions/download-artifact 落到那里）。
 *
 * 它只做打包与清单生成，不碰 GitHub Release、不上传、不签名；`.sig` 由 workflow 的
 * nightly job 用 Ed25519 私钥统一生成（与这一侧的职责边界和旧链路一致）。
 *
 * 文件名刻意不带 `build` 前缀：.gitignore 第 160 行的 `build*` 会把
 * scripts/build-*.mjs 一并吞掉（既有的 scripts/build-desktop-release.ps1 靠一条单独
 * 的否定规则才留下）。未跟踪的脚本不进 CI，那种失败只会在 workflow 运行时才暴露。
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  BACKEND_RELATIVE_PATH,
  PortablePackageError,
  discoverForgeAppDir,
  fullAssetName,
  manifestFileName,
  packageForgePortable,
  WIN_ARCH,
  WIN_PLATFORM,
} from './lib/forge-portable-package.mjs';

function usage() {
  return [
    'Usage: node scripts/forge-windows-portable.mjs --dir <electron checkout> --out <output dir> [options]',
    '',
    'Options:',
    '  --dir <path>        electron-forge checkout that already ran `npm run package` (required)',
    '  --out <path>        where the ZIP/manifest/delta are written (required)',
    '  --version <semver>  release version; defaults to the frontend package.json version',
    '  --previous <path>   previous release Portable manifest, for the differential package',
    '  --backend <path>    backend binary; defaults to <dir>/bin/projectneko_server.exe',
    '  --app-dir <path>    forge output directory; defaults to <dir>/out/<productName>-win32-x64',
    '  --dry-run           resolve inputs and print what would be produced, write nothing',
    '  --help              print this message',
  ].join('\n');
}

export function parseArgs(argv) {
  const options = { dir: '', out: '', version: '', previous: '', backend: '', appDir: '', dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const readValue = (name) => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new PortablePackageError(`${name} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (token) {
      case '--dir':
        options.dir = readValue('--dir');
        break;
      case '--out':
        options.out = readValue('--out');
        break;
      case '--version':
        options.version = readValue('--version');
        break;
      case '--previous':
        options.previous = readValue('--previous');
        break;
      case '--backend':
        options.backend = readValue('--backend');
        break;
      case '--app-dir':
        options.appDir = readValue('--app-dir');
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new PortablePackageError(`unknown argument: ${token}`);
    }
  }
  return options;
}

function requirePackagingScript(electronDir) {
  const packagePath = path.join(electronDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    throw new PortablePackageError(`electron package.json not found: ${packagePath}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const packageScript = String(packageJson?.scripts?.package || '').trim();
  if (!packageScript) {
    throw new PortablePackageError(
      `${packagePath} has no "package" script. This workflow drives electron-forge ` +
        '(`npm run package`); a frontend that cannot be packaged that way has to land its ' +
        'packaging layer before CI can build it.',
    );
  }
  return { packageJson, packageScript };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.dir) throw new PortablePackageError('--dir is required');
  if (!options.out) throw new PortablePackageError('--out is required');

  const electronDir = path.resolve(options.dir);
  const { packageJson } = requirePackagingScript(electronDir);

  const version = String(options.version || packageJson.version || '').trim();
  if (!version) {
    throw new PortablePackageError(
      'no version available: pass --version or set a version in the frontend package.json',
    );
  }

  const { appDir } = options.appDir
    ? { appDir: path.resolve(options.appDir) }
    : discoverForgeAppDir({ electronDir, platform: WIN_PLATFORM, arch: WIN_ARCH });
  if (!fs.existsSync(appDir)) {
    throw new PortablePackageError(`--app-dir does not exist: ${appDir}`);
  }

  const backendBinaryPath = options.backend
    ? path.resolve(options.backend)
    : path.join(electronDir, 'bin', path.basename(BACKEND_RELATIVE_PATH));
  const previousManifestPath = options.previous ? path.resolve(options.previous) : null;
  if (previousManifestPath && !fs.existsSync(previousManifestPath)) {
    throw new PortablePackageError(`--previous manifest not found: ${previousManifestPath}`);
  }

  const outDir = path.resolve(options.out);
  process.stdout.write(
    [
      `electron checkout : ${electronDir}`,
      `forge app dir     : ${appDir}`,
      `version           : ${version}`,
      `backend binary    : ${backendBinaryPath}`,
      `output dir        : ${outDir}`,
      `previous manifest : ${previousManifestPath || '(none: full package only)'}`,
      '',
    ].join('\n'),
  );

  if (options.dryRun) {
    process.stdout.write(
      [
        'dry run: nothing written. Would produce:',
        `  ${path.join(outDir, fullAssetName(version))}`,
        `  ${path.join(outDir, manifestFileName(version))}`,
        previousManifestPath ? '  plus the differential ZIP derived from the previous manifest' : '',
        '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return 0;
  }

  const result = packageForgePortable({
    appDir,
    version,
    outDir,
    previousManifestPath,
    backendBinaryPath,
    platform: WIN_PLATFORM,
    arch: WIN_ARCH,
  });

  process.stdout.write(`Wrote ${result.artifacts.length} artifact(s):\n`);
  for (const artifact of result.artifacts) {
    process.stdout.write(`  ${artifact} (${fs.statSync(artifact).size} bytes)\n`);
  }
  process.stdout.write(
    `Package tree entries: ${result.manifest.files.length}` +
      (result.manifest.deltas?.length
        ? `; delta from ${result.manifest.deltas[0].fromVersion}: ` +
          `${result.manifest.deltas[0].files.length} file(s), ${result.manifest.deltas[0].delete.length} removal(s)\n`
        : '\n'),
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof PortablePackageError) {
      process.stderr.write(`::error title=Portable packaging failed::${error.message}\n`);
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
