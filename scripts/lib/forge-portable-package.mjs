/**
 * forge-portable-package.mjs —— 把 electron-forge 的 `npm run package` 产物
 * 变成 N.E.K.O 的 Portable 发布资产（ZIP + manifest，可选增量）。
 *
 * 为什么需要它：桌面 workflow 原来驱动的是 electron-builder 前端，靠它的
 * `scripts/build-electron-distribution.js` 出 `dist/win-unpacked`，再靠
 * `scripts/create-portable-update.js` 出 Portable 清单。现在的前端
 * （PeanutMelonSeedBigAlmond/N.E.K.O.-PC）改用 electron-forge，产物布局是
 * `out/<productName>-<platform>-<arch>`，两个脚本都不存在，所以打包与清单生成
 * 必须由本仓库自己承担。
 *
 * 本文件**只用 node 内置模块**，不引入任何 npm 依赖：仓库既有的约束是不携带第三方
 * 压缩/二进制依赖（见 .gitignore 对 *.exe/*.dll 的处理与 scripts/ 下的纯 Python/Node
 * 工具），而 `Compress-Archive` 在 Unix 上不保留权限位、symlink 会被跟随，正是客户端
 * 校验需要的两件事。
 *
 * 清单格式的事实来源是前端 `src/main/portable-update.js` 的
 * `validatePortableManifest` / `validateFileRecord` / `isSafeRelativePath`。这里的
 * 每条规则都对应客户端的一处硬校验，改动前先读那一侧：
 *   · 清单名 `N.E.K.O_<version>_<targetKey>_manifest.json`，完整包名
 *     `N.E.K.O_<version>_<targetKey>.zip`，增量包名
 *     `N.E.K.O_<from>_to_<to>_<targetKey>_delta.zip`（validatePortableManifest 里
 *     是字符串模板硬编码，不是可配置项）。
 *   · `files[]` 的 path 必须是安全相对路径（无 `\`、`:`、控制字符、`.`/`..` 段），
 *     Windows 记录不带 mode。
 *   · 完整包 ZIP 的条目集合必须与 `full.files` 的 path 集合**完全一致**，增量包
 *     ZIP 同理对应 delta 的 files —— 客户端 updater 的 Assert-ArchiveEntries 会
 *     逐条比对，多一个文件就报 unexpected_update_file。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const MANIFEST_SCHEMA_VERSION = 1;
export const PRODUCT = 'N.E.K.O';
/** 客户端 getDistributionMarker() 只认 archive-portable（zip-portable 是旧别名）。 */
export const DISTRIBUTION = 'archive-portable';
export const DISTRIBUTION_MARKER_NAME = 'neko-distribution.json';
export const MANAGED_FILES_NAME = 'neko-portable-managed-files.json';
export const WINDOWS_ENTRYPOINT = 'N.E.K.O.exe';
export const WIN_TARGET_KEY = 'win';
export const WIN_PLATFORM = 'win32';
export const WIN_ARCH = 'x64';
/** 后端二进制的落点：前端 backend-runtime.js 在打包态读 resources/bin/。 */
export const BACKEND_RELATIVE_PATH = 'resources/bin/projectneko_server.exe';
/** 完整包与增量包共用的 ZIP 形态。 */
export const ZIP_MODE = 0o644;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FAT_EPOCH_MS = Date.UTC(1980, 0, 1, 0, 0, 0);

export class PortablePackageError extends Error {}

function fail(message) {
  throw new PortablePackageError(message);
}

/**
 * 与客户端 isSafeRelativePath 同规则。生成器在写清单前就拒绝，避免把只有客户端才
 * 会发现的坏路径发到 release 上。
 */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || value.includes(':')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..');
}

export function assertSafeRelativePath(value, context) {
  if (!isSafeRelativePath(value)) {
    fail(`unsafe relative path in ${context}: ${JSON.stringify(value)}`);
  }
}

export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  // 流式读取：Windows 产物里的 N.E.K.O.exe 是 200MB 级，readFileSync 会在 CI 上白占
  // 一份等大的内存。
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * electron-forge 的产物目录：out/<productName>-<platform>-<arch>。
 * productName 缺失时 forge 回退到 package.json 的 name（packagerConfig.name 未设时）。
 */
export function resolveForgeProductName(packageJson) {
  const productName = String(packageJson?.productName || packageJson?.name || '').trim();
  if (!productName) {
    fail('electron package.json has neither productName nor name; cannot locate the forge output directory');
  }
  return productName;
}

export function discoverForgeAppDir({ electronDir, platform = 'win32', arch = 'x64' }) {
  const packagePath = path.join(electronDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    fail(`electron package.json not found: ${packagePath}`);
  }
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const productName = resolveForgeProductName(packageJson);
  const appDir = path.join(electronDir, 'out', `${productName}-${platform}-${arch}`);
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    const outDir = path.join(electronDir, 'out');
    let available = [];
    try {
      available = fs.readdirSync(outDir).filter((name) => fs.statSync(path.join(outDir, name)).isDirectory());
    } catch (_) {
      available = [];
    }
    fail(
      `forge output directory not found: ${appDir}. ` +
        `Run \`npm run package\` in ${electronDir} first. ` +
        `Directories currently under out/: ${available.length ? available.join(', ') : '(none)'}`,
    );
  }
  return { appDir, productName, packageJson };
}

/**
 * 收集一棵应用树的清单记录。
 *
 * 目录不产生记录：客户端的 validateFileRecord 只认 file/symlink，directories 由
 * 解包端按路径创建。
 */
export function collectTreeEntries(appDir, { exclude = [] } = {}) {
  const excluded = new Set(exclude);
  const entries = [];
  const visit = (directory, prefix) => {
    const children = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (excluded.has(relative)) continue;
      assertSafeRelativePath(relative, `forged tree under ${appDir}`);
      const absolute = path.join(directory, child.name);
      if (child.isDirectory()) {
        visit(absolute, relative);
        continue;
      }
      const stat = fs.lstatSync(absolute);
      if (child.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(absolute);
        entries.push({
          path: relative,
          type: 'symlink',
          size: 0,
          sha256: sha256Buffer(Buffer.from(linkTarget, 'utf8')),
          linkTarget,
          absolute,
        });
        continue;
      }
      if (!child.isFile()) {
        fail(`unsupported entry type in package tree: ${relative}`);
      }
      entries.push({
        path: relative,
        type: 'file',
        size: stat.size,
        sha256: sha256File(absolute),
        mode: stat.mode & 0o777,
        absolute,
      });
    }
  };
  visit(appDir, '');
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 客户端只在 Windows 上使用这张表，且只会看 resources/ 前缀下的路径。 */
export function managedFilesInventory(entries) {
  return entries
    .filter((entry) => entry.path.startsWith('resources/'))
    .filter((entry) => entry.path !== `resources/${MANAGED_FILES_NAME}`)
    .map((entry) => entry.path)
    .sort();
}

export function writeDistributionMarker(resourcesPath, { platform = WIN_PLATFORM, arch = WIN_ARCH } = {}) {
  fs.mkdirSync(resourcesPath, { recursive: true });
  const marker = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: PRODUCT,
    platform,
    arch,
    distribution: DISTRIBUTION,
  };
  fs.writeFileSync(
    path.join(resourcesPath, DISTRIBUTION_MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
    'utf8',
  );
  return marker;
}

export function writeManagedFilesInventory(resourcesPath, entries) {
  const inventory = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: PRODUCT,
    files: managedFilesInventory(entries),
  };
  fs.writeFileSync(
    path.join(resourcesPath, MANAGED_FILES_NAME),
    `${JSON.stringify(inventory, null, 2)}\n`,
    'utf8',
  );
  return inventory;
}

/**
 * 后端二进制就位。
 *
 * 旧链路里 electron-builder 把 bin/ 当 extraResource 放到应用根旁边，而现在的
 * forge.config.js 把它作为 extraResource 拷到 resources/ 下 —— 前端
 * backend-runtime.js 在打包态读的正是 resources/bin/projectneko_server.exe。
 */
export function placeBackendBinary(appDir, sourcePath) {
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    fail(`backend binary not found: ${sourcePath}`);
  }
  const destination = path.join(appDir, BACKEND_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  // 幂等：重复打包时先清掉上一次的落点，避免留下旧二进制又被当成 manifest 记录。
  fs.rmSync(destination, { force: true });
  fs.copyFileSync(sourcePath, destination);
  return destination;
}

function dosDateTime(date) {
  const clamped = date.getTime() < FAT_EPOCH_MS ? new Date(FAT_EPOCH_MS) : date;
  const year = Math.min(Math.max(clamped.getFullYear(), 1980), 2107);
  const time = ((clamped.getHours() & 0x1f) << 11) | ((clamped.getMinutes() & 0x3f) << 5) | ((clamped.getSeconds() / 2) & 0x1f);
  const day = (((year - 1980) & 0x7f) << 9) | (((clamped.getMonth() + 1) & 0x0f) << 5) | (clamped.getDate() & 0x1f);
  return { time, date: day };
}

/**
 * 最小 ZIP 写入器（deflate）。
 *
 * 条目名一律正斜杠、按 path 排序、时间戳钳到 FAT 纪元之后 —— 同一棵应用树两次打包
 * 产出同字节的归档，便于比对与缓存。
 */
export function writeZip(entries, zipPath, { sourceRoot }) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));

  for (const entry of sorted) {
    assertSafeRelativePath(entry.path, `zip archive ${zipPath}`);
    const nameBytes = Buffer.from(entry.path, 'utf8');
    const absolute = path.join(sourceRoot, ...entry.path.split('/'));
    const stat = fs.lstatSync(absolute);
    const isSymlink = stat.isSymbolicLink();
    const payload = isSymlink
      ? Buffer.from(fs.readlinkSync(absolute), 'utf8')
      : fs.readFileSync(absolute);
    const deflated = zlib.deflateRawSync(payload, { level: 9 });
    const useDeflate = deflated.length < payload.length;
    const body = useDeflate ? deflated : payload;
    const method = useDeflate ? 8 : 0;
    const { time, date } = dosDateTime(stat.mtime);
    const crc = crc32(payload);
    const externalAttributes = isSymlink
      ? ((0o120777 << 16) >>> 0)
      : ((0o100000 | ZIP_MODE) << 16) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(payload.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBytes, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x031e, 4); // unix, 3.0
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(payload.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(externalAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + body.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, Buffer.concat([...localParts, centralDirectory, end]));
  return { entries: sorted.length, size: fs.statSync(zipPath).size };
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function recordFor(entry) {
  const record = {
    path: entry.path,
    type: entry.type,
    size: entry.size,
    sha256: entry.sha256,
  };
  if (entry.type === 'symlink') {
    record.linkTarget = entry.linkTarget;
  }
  return record;
}

function recordKey(record) {
  return String(record?.path || '').toLowerCase();
}

export function fullAssetName(version) {
  return `${PRODUCT}_${version}_${WIN_TARGET_KEY}.zip`;
}

export function deltaAssetName(fromVersion, version) {
  return `${PRODUCT}_${fromVersion}_to_${version}_${WIN_TARGET_KEY}_delta.zip`;
}

export function manifestFileName(version) {
  return `${PRODUCT}_${version}_${WIN_TARGET_KEY}_manifest.json`;
}

export function assertVersion(version, context) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    fail(`invalid version for ${context}: ${JSON.stringify(version)} (expected semver like 1.0.0 or 1.0.0-beta.1)`);
  }
  return version;
}

function readPreviousManifest(previousManifestPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(previousManifestPath, 'utf8'));
  } catch (error) {
    fail(`cannot read previous Portable manifest ${previousManifestPath}: ${error.message}`);
  }
  if (parsed?.schemaVersion !== MANIFEST_SCHEMA_VERSION || !Array.isArray(parsed?.files)) {
    fail(`previous Portable manifest is not a schema-1 manifest with a files array: ${previousManifestPath}`);
  }
  if (typeof parsed.version !== 'string' || !SEMVER_PATTERN.test(parsed.version)) {
    fail(`previous Portable manifest has an invalid version: ${JSON.stringify(parsed.version)}`);
  }
  return parsed;
}

/**
 * 生成清单；`previousManifest` 提供时同时给出增量描述。
 *
 * 增量语义对齐客户端 validatePortableManifest：`files` 必须是最新 files[].path 的
 * 子集，`delete` 必须与最新 files 不相交，`fromVersion` 不得等于当前 version。
 */
export function buildPortableManifest({ entries, version, previousManifest = null }) {
  assertVersion(version, 'current manifest');
  const files = entries.map(recordFor);
  const filePaths = new Set(files.map((record) => record.path));
  if (filePaths.has(WINDOWS_ENTRYPOINT) === false) {
    fail(`package tree is missing the entrypoint ${WINDOWS_ENTRYPOINT}: ${[...filePaths].slice(0, 8).join(', ')}`);
  }
  for (const record of files) {
    assertSafeRelativePath(record.path, 'manifest record');
    if (record.type === 'file' && !SHA256_PATTERN.test(record.sha256)) {
      fail(`invalid sha256 for ${record.path}`);
    }
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    product: PRODUCT,
    platform: WIN_PLATFORM,
    arch: WIN_ARCH,
    distribution: DISTRIBUTION,
    version,
    entrypoint: WINDOWS_ENTRYPOINT,
    // files 在**顶层**：客户端的 validatePortableManifest 校验的是 manifest.files，
    // full 只描述归档本身（assetName/size/sha256）。放进 full 会直接
    // portable_manifest_files_invalid —— 已由前端校验器实测确认。
    files,
  };

  if (previousManifest) {
    const fromVersion = previousManifest.version;
    if (fromVersion === version) {
      fail(
        `previous manifest is already at version ${version}; a baseline must predate the build being packaged`,
      );
    }
    const currentByKey = new Map(files.map((record) => [recordKey(record), record]));
    const previousKeys = new Set(previousManifest.files.map(recordKey));
    const changed = [];
    for (const record of files) {
      if (!previousKeys.has(recordKey(record))) {
        changed.push(record.path);
      }
    }
    for (const previousRecord of previousManifest.files) {
      const current = currentByKey.get(recordKey(previousRecord));
      if (current && current.sha256 !== previousRecord.sha256) {
        changed.push(current.path);
      }
    }
    // 删除项必须安全相对路径：客户端碰上一处不合法路径会整份清单判死
    // （validateFileRecord 一失败就 throw），比漏报几个删除项严重得多。
    const deleted = previousManifest.files
      .filter((record) => !currentByKey.has(recordKey(record)))
      .map((record) => record.path)
      .filter((recordPath) => isSafeRelativePath(recordPath));
    const uniqueDeleted = [...new Set(deleted)].sort();
    const uniqueChanged = [...new Set(changed)].sort();
    manifest.deltas = [
      {
        fromVersion,
        files: uniqueChanged,
        delete: uniqueDeleted,
      },
    ];
  }

  return manifest;
}

/**
 * 打包一棵已就位的 forge 应用树，产出完整包（必选）与增量包（给了基线时）。
 *
 * 返回写出的文件路径，供 CLI 打印与测试断言。
 */
export function packageForgePortable({
  appDir,
  version,
  outDir,
  previousManifestPath = null,
  backendBinaryPath = null,
  platform = WIN_PLATFORM,
  arch = WIN_ARCH,
}) {
  assertVersion(version, 'package output');
  if (!fs.existsSync(appDir) || !fs.statSync(appDir).isDirectory()) {
    fail(`app directory not found: ${appDir}`);
  }
  const resourcesPath = path.join(appDir, 'resources');
  if (!fs.existsSync(resourcesPath) || !fs.statSync(resourcesPath).isDirectory()) {
    fail(`app directory has no resources/ directory: ${appDir} (not an electron-forge package output?)`);
  }
  if (backendBinaryPath) {
    placeBackendBinary(appDir, backendBinaryPath);
  }
  if (!fs.existsSync(path.join(appDir, BACKEND_RELATIVE_PATH))) {
    fail(
      `backend binary missing at ${BACKEND_RELATIVE_PATH} inside ${appDir}. ` +
        'Download the python-backend-win artifact into <electron-app>/bin/projectneko_server.exe first.',
    );
  }

  writeDistributionMarker(resourcesPath, { platform, arch });

  // 清单先建在 markers 落位之后，marker 本身才可能被收进 files；inventory 的路径
  // 又依赖同一棵树，所以先收集一次、写 inventory、再为清单收集一次。
  const preInventoryEntries = collectTreeEntries(appDir, {
    exclude: [`resources/${MANAGED_FILES_NAME}`],
  });
  writeManagedFilesInventory(resourcesPath, preInventoryEntries);

  const entries = collectTreeEntries(appDir, {
    exclude: [`resources/${MANAGED_FILES_NAME}`],
  });
  const previousManifest = previousManifestPath ? readPreviousManifest(previousManifestPath) : null;
  const manifest = buildPortableManifest({ entries, version, previousManifest });

  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  const fullZipPath = path.join(outDir, fullAssetName(version));
  writeZip(entries, fullZipPath, { sourceRoot: appDir });
  written.push(fullZipPath);
  manifest.full = {
    assetName: fullAssetName(version),
    size: fs.statSync(fullZipPath).size,
    sha256: sha256File(fullZipPath),
  };

  if (manifest.deltas?.length) {
    const delta = manifest.deltas[0];
    const deltaZipPath = path.join(outDir, deltaAssetName(delta.fromVersion, version));
    const deltaEntries = entries.filter((entry) => delta.files.includes(entry.path));
    writeZip(deltaEntries, deltaZipPath, { sourceRoot: appDir });
    written.push(deltaZipPath);
    delta.assetName = deltaAssetName(delta.fromVersion, version);
    delta.size = fs.statSync(deltaZipPath).size;
    delta.sha256 = sha256File(deltaZipPath);
  }

  const manifestPath = path.join(outDir, manifestFileName(version));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  written.push(manifestPath);

  return { manifest, manifestPath, artifacts: written, assets: written.map((file) => path.basename(file)) };
}
