# Copyright 2025-2026 Project N.E.K.O. Team
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""``scripts/forge-windows-portable.mjs`` 产出的 Portable 资产必须能被客户端接受。

背景：桌面 workflow 原来驱动 electron-builder 前端，打包与 Portable 清单都由前端仓库
的两个脚本产出。前端改成 electron-forge（``npm run package``）后这两者都不存在，于是
打包实现搬到本仓库。清单是**跨仓库契约**：消费方是前端
``src/main/portable-update.js`` 的 ``validatePortableManifest`` / ``validateFileRecord``
以及 Windows 更新助手的 ``Assert-ArchiveEntries``，任何一处不符都表现为「用户端更新
失败」，而不是构建失败 —— 这正是必须在 CI 里钉死的东西。

本文件用标准库独立复算契约，不复用生成器的任何判定：

* 清单字段与资产命名（客户端里是字符串模板硬编码）。
* ``files[]`` 每条记录的 path/type/size/sha256 与磁盘实际值一致。
* 完整包 ZIP 的条目集合**恰好等于** ``files[].path``（多一个文件，客户端
  ``Assert-ArchiveEntries`` 会抛 ``unexpected_update_file``）。
* 差分包 ZIP 的条目集合恰好等于 delta 的 ``files``；``delete`` 与最新 ``files``
  不相交。

集成用例（需要前端 checkout 在本地时才跑）：把产出交给前端真正的
``validatePortableManifest`` 验证一次。CI 上取不到那个 checkout 就跳过 —— 契约的
权威定义在那里，本地能跑就不该只信本文件的复算。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PACKAGER = ROOT / "scripts" / "forge-windows-portable.mjs"
FRONTEND_CHECKOUT_ENV = "NEKO_PC_CHECKOUT"
FRONTEND_CHECKOUT_DEFAULT = Path(r"F:\Home\Desktop\proj\N.E.K.O.-PC")
PORTABLE_UPDATE_RELATIVE = Path("src") / "main" / "portable-update.js"

APP_DIR_NAME = "N.E.K.O-win32-x64"
BACKEND_NAME = "projectneko_server.exe"
MARKER_NAME = "neko-distribution.json"
INVENTORY_NAME = "neko-portable-managed-files.json"

# 一棵与 electron-forge 打包产物同形的最小应用树。内容固定，便于独立复算 sha256。
BASE_TREE = {
    "N.E.K.O.exe": b"MZ-fake-electron-executable",
    "ffmpeg.dll": b"fake-ffmpeg-dll",
    "version": b"41.2.0",
    "locales/en-US.pak": b"locale-en",
    "locales/zh-CN.pak": b"locale-zh",
    "resources/app.asar": b"fake-asar-archive",
    "resources/core_config.txt": b"coreApi=free",
}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _require_node() -> str:
    node = shutil.which("node")
    if not node:
        pytest.skip("node not found")
    return node


def _write_tree(app_dir: Path, tree: dict[str, bytes]) -> None:
    for relative, payload in tree.items():
        target = app_dir / Path(relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


def _make_checkout(tmp_path: Path, *, tree: dict[str, bytes] | None = None, package_script: str | None = "electron-forge package") -> Path:
    """搭一个「前端 checkout + 已跑完 npm run package」的目录结构。"""
    checkout = tmp_path / "electron-app"
    checkout.mkdir(parents=True, exist_ok=True)
    package_json: dict[str, object] = {
        "name": "neko-frontend",
        "productName": "N.E.K.O",
        "version": "0.9.0",
        "main": "src/electron-entry.js",
    }
    scripts: dict[str, str] = {"start": "electron-forge start"}
    if package_script is not None:
        scripts["package"] = package_script
    package_json["scripts"] = scripts
    (checkout / "package.json").write_text(
        json.dumps(package_json, indent=2) + "\n", encoding="utf-8"
    )
    # 后端二进制由 workflow 的 actions/download-artifact 落在 <checkout>/bin/。
    backend = checkout / "bin" / BACKEND_NAME
    backend.parent.mkdir(parents=True, exist_ok=True)
    backend.write_bytes(b"fake-nuitka-backend")
    _write_tree(checkout / "out" / APP_DIR_NAME, tree if tree is not None else BASE_TREE)
    return checkout


def _run_packager(node: str, checkout: Path, out_dir: Path, *extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            node,
            str(PACKAGER),
            "--dir",
            str(checkout),
            "--out",
            str(out_dir),
            *extra,
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _read_manifest(out_dir: Path, version: str) -> dict:
    return json.loads((out_dir / f"N.E.K.O_{version}_win_manifest.json").read_text(encoding="utf-8"))


def _zip_names(archive: Path) -> list[str]:
    with zipfile.ZipFile(archive) as handle:
        return sorted(handle.namelist())


def test_full_package_manifest_matches_the_client_contract(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"

    result = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert result.returncode == 0, result.stderr or result.stdout

    manifest_path = out_dir / "N.E.K.O_1.2.3_win_manifest.json"
    archive_path = out_dir / "N.E.K.O_1.2.3_win.zip"
    assert manifest_path.is_file()
    assert archive_path.is_file()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # 字段与命名：客户端 validatePortableManifest 逐条硬校验，且资产名是字符串模板。
    assert manifest["schemaVersion"] == 1
    assert manifest["product"] == "N.E.K.O"
    assert manifest["platform"] == "win32"
    assert manifest["arch"] == "x64"
    assert manifest["distribution"] == "archive-portable"
    assert manifest["version"] == "1.2.3"
    assert manifest["entrypoint"] == "N.E.K.O.exe"
    assert manifest["full"]["assetName"] == "N.E.K.O_1.2.3_win.zip"
    assert manifest["full"]["size"] == archive_path.stat().st_size
    assert manifest["full"]["sha256"] == _sha256(archive_path.read_bytes())
    assert "deltas" not in manifest or manifest["deltas"] == []

    # files 必须在顶层：放进 full 会让客户端抛 portable_manifest_files_invalid。
    assert isinstance(manifest["files"], list) and manifest["files"]
    paths = [record["path"] for record in manifest["files"]]
    assert paths == sorted(paths), "manifest records must be path-sorted for stable deltas"
    assert len(paths) == len(set(paths))

    # 每条记录都要与磁盘实际内容一致（sha256 是客户端校验的最终依据）。
    app_dir = checkout / "out" / APP_DIR_NAME
    expected = dict(BASE_TREE)
    expected[f"resources/bin/{BACKEND_NAME}"] = b"fake-nuitka-backend"
    marker_bytes = (app_dir / "resources" / MARKER_NAME).read_bytes()
    expected[f"resources/{MARKER_NAME}"] = marker_bytes
    assert marker_bytes == (
        json.dumps(
            {
                "schemaVersion": 1,
                "product": "N.E.K.O",
                "platform": "win32",
                "arch": "x64",
                "distribution": "archive-portable",
            },
            indent=2,
        )
        + "\n"
    ).encode("utf-8")

    assert sorted(paths) == sorted(expected)
    for record in manifest["files"]:
        assert record["type"] == "file"
        assert record["size"] == len(expected[record["path"]])
        assert record["sha256"] == _sha256(expected[record["path"]])
        # Windows 记录不带 mode（客户端不要求，带上只会给增量引入噪声）。
        assert "mode" not in record

    # 生成物自身不参与清单，否则每次打包都会自我引用、增量永远抖动。
    assert f"resources/{INVENTORY_NAME}" not in paths
    inventory = json.loads((app_dir / "resources" / INVENTORY_NAME).read_text(encoding="utf-8"))
    assert inventory["files"] == sorted(
        path for path in expected if path.startswith("resources/")
    )

    # 归档条目集合必须恰好等于 files —— 客户端 Assert-ArchiveEntries 的语义。
    assert _zip_names(archive_path) == sorted(paths)
    with zipfile.ZipFile(archive_path) as handle:
        assert handle.testzip() is None
        assert handle.read("N.E.K.O.exe") == BASE_TREE["N.E.K.O.exe"]

    # 后端二进制必须落到 resources/bin/：前端 backend-runtime.js 打包态只读那里。
    assert (app_dir / "resources" / "bin" / BACKEND_NAME).read_bytes() == b"fake-nuitka-backend"


def test_archive_entry_names_stay_relative_and_posix(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"
    result = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert result.returncode == 0, result.stderr or result.stdout

    for name in _zip_names(out_dir / "N.E.K.O_1.2.3_win.zip"):
        assert "\\" not in name
        assert ":" not in name
        assert not name.startswith("/")
        assert ".." not in Path(name).parts
        assert name == name.strip()


def test_differential_package_covers_changes_and_removals(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"

    first = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert first.returncode == 0, first.stderr or first.stdout
    baseline = out_dir / "N.E.K.O_1.2.3_win_manifest.json"

    app_dir = checkout / "out" / APP_DIR_NAME
    (app_dir / "ffmpeg.dll").write_bytes(b"fake-ffmpeg-dll-v2")  # 变更
    (app_dir / "locales" / "ja-JP.pak").write_bytes(b"locale-ja")  # 新增
    (app_dir / "locales" / "zh-CN.pak").unlink()  # 删除

    second = _run_packager(
        node, checkout, out_dir, "--version", "1.2.4", "--previous", str(baseline)
    )
    assert second.returncode == 0, second.stderr or second.stdout

    manifest = _read_manifest(out_dir, "1.2.4")
    assert len(manifest["deltas"]) == 1
    delta = manifest["deltas"][0]
    assert delta["fromVersion"] == "1.2.3"
    assert delta["assetName"] == "N.E.K.O_1.2.3_to_1.2.4_win_delta.zip"
    assert sorted(delta["files"]) == ["ffmpeg.dll", "locales/ja-JP.pak"]
    assert delta["delete"] == ["locales/zh-CN.pak"]

    # 客户端 validatePortableManifest 的显式约束。
    latest_paths = {record["path"] for record in manifest["files"]}
    assert set(delta["files"]) <= latest_paths
    assert not set(delta["delete"]) & latest_paths
    assert delta["fromVersion"] != manifest["version"]

    delta_archive = out_dir / delta["assetName"]
    assert delta["size"] == delta_archive.stat().st_size
    assert delta["sha256"] == _sha256(delta_archive.read_bytes())
    # 增量包条目必须恰好是 delta.files：多一个文件，客户端会拒绝整包。
    assert _zip_names(delta_archive) == sorted(delta["files"])
    with zipfile.ZipFile(delta_archive) as handle:
        assert handle.testzip() is None
        assert handle.read("ffmpeg.dll") == b"fake-ffmpeg-dll-v2"


def test_previous_manifest_at_the_same_version_is_rejected(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"
    first = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert first.returncode == 0, first.stderr or first.stdout

    same_version = _run_packager(
        node,
        checkout,
        out_dir,
        "--version",
        "1.2.3",
        "--previous",
        str(out_dir / "N.E.K.O_1.2.3_win_manifest.json"),
    )
    assert same_version.returncode != 0
    assert "must predate" in (same_version.stderr + same_version.stdout)


def test_missing_package_script_fails_with_an_actionable_message(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path, package_script=None)
    result = _run_packager(node, checkout, tmp_path / "dist", "--version", "1.2.3")
    assert result.returncode != 0
    combined = result.stderr + result.stdout
    assert "no \"package\" script" in combined
    assert "npm run package" in combined


def test_missing_forge_output_lists_what_is_there(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    shutil.rmtree(checkout / "out")
    (checkout / "out" / "some-other-app").mkdir(parents=True)
    result = _run_packager(node, checkout, tmp_path / "dist", "--version", "1.2.3")
    assert result.returncode != 0
    combined = result.stderr + result.stdout
    assert "forge output directory not found" in combined
    assert "some-other-app" in combined


def test_missing_backend_binary_is_reported_before_packaging(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    (checkout / "bin" / BACKEND_NAME).unlink()
    result = _run_packager(node, checkout, tmp_path / "dist", "--version", "1.2.3")
    assert result.returncode != 0
    combined = result.stderr + result.stdout
    assert "backend binary" in combined
    assert BACKEND_NAME in combined


def test_dry_run_writes_nothing(tmp_path: Path) -> None:
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"
    result = _run_packager(node, checkout, out_dir, "--version", "1.2.3", "--dry-run")
    assert result.returncode == 0, result.stderr or result.stdout
    assert "dry run" in result.stdout
    assert not out_dir.exists()


def test_repackaging_the_same_tree_is_idempotent(tmp_path: Path) -> None:
    """同一棵树重复打包必须产出同字节归档（CI 重跑与缓存比对都依赖这一点）。"""
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"

    first = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert first.returncode == 0, first.stderr or first.stdout
    first_bytes = (out_dir / "N.E.K.O_1.2.3_win.zip").read_bytes()

    second = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert second.returncode == 0, second.stderr or second.stdout
    assert (out_dir / "N.E.K.O_1.2.3_win.zip").read_bytes() == first_bytes


def _frontend_checkout() -> Path | None:
    configured = os.environ.get(FRONTEND_CHECKOUT_ENV)
    candidate = Path(configured) if configured else FRONTEND_CHECKOUT_DEFAULT
    if (candidate / PORTABLE_UPDATE_RELATIVE).is_file():
        return candidate
    return None


def test_generated_manifest_passes_the_frontend_validator(tmp_path: Path) -> None:
    """把产出交给前端真正的 validatePortableManifest 验收一次。

    契约的权威定义在客户端的 ``src/main/portable-update.js``；本文件其余用例只是它的
    复算。CI 上拿不到那个 checkout 就跳过（构建契约本身由上面那些用例钉住），在开发者
    机器上设 ``NEKO_PC_CHECKOUT`` 指向前端 checkout 即可让它真正跑起来。
    """
    frontend = _frontend_checkout()
    if frontend is None:
        pytest.skip(
            f"frontend checkout not available; set {FRONTEND_CHECKOUT_ENV} to run the "
            "authoritative validator"
        )
    node = _require_node()
    checkout = _make_checkout(tmp_path)
    out_dir = tmp_path / "dist"
    result = _run_packager(node, checkout, out_dir, "--version", "1.2.3")
    assert result.returncode == 0, result.stderr or result.stdout

    manifest_path = out_dir / "N.E.K.O_1.2.3_win_manifest.json"
    validator = frontend / PORTABLE_UPDATE_RELATIVE
    script = f"""
const fs = require('node:fs');
const moduleRef = require({json.dumps(str(validator))});
const raw = JSON.parse(fs.readFileSync({json.dumps(str(manifest_path))}, 'utf8'));
moduleRef.validatePortableManifest(raw, raw.version, {{
  platform: 'win32', arch: 'x64', distribution: 'archive-portable',
}});
for (const record of raw.files) {{
  if (!moduleRef.isSafeRelativePath(record.path)) {{
    throw new Error('unsafe path: ' + record.path);
  }}
}}
process.stdout.write('validator accepted ' + raw.files.length + ' file records\\n');
"""
    verification = subprocess.run(
        [node, "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    assert verification.returncode == 0, verification.stderr or verification.stdout
    assert "validator accepted" in verification.stdout
