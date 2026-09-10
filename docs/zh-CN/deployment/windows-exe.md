# Windows 桌面构建

普通用户应从 [Steam 商店](https://store.steampowered.com/app/4099310/__NEKO/?utm_source=project-neko.online&utm_medium=referral&utm_campaign=docs_deployment&utm_content=install_zh_cn) 安装并通过 Steam 启动，再在桌面/Web UI 配置 Provider。

独立 Python 后端产物不包含 Electron 窗口、托盘、Steam 集成、路由或更新器，不能与桌面产物混为一谈。

`.github/workflows/build-desktop.yml` 会构建 Windows x64 Electron 产物和单独的 Python 后端产物。定时任务仅在必要阶段成功时更新仓库 `nightly` 预发行版。

Nightly 是未签名测试构建，会被下一次运行替换，不是稳定或自动更新渠道。只从项目 GitHub Releases 下载，核对构建 commit，并先备份 N.E.K.O. 数据根。

桌面 workflow 组合指定 N.E.K.O.-PC revision 的 Electron 前端、本仓库 Nuitka standalone 后端，以及打包检查要求的 config/templates/static/plugins/embedding/tiktoken/browser 资源。端口占用时会回退，自动化不应写死 48911。

## Electron 前端与打包链

Windows 前端来自 `PeanutMelonSeedBigAlmond/N.E.K.O.-PC`（可用 `electron_repo` / `electron_ref` 覆盖），它是 **electron-forge** 应用，唯一构建命令是 `npm run package`，产物落在 `out/<productName>-<platform>-<arch>`。

Portable 资产（完整包、差分包、清单）由本仓库的 `scripts/forge-windows-portable.mjs` 生成，验收规则对齐前端 `src/main/portable-update.js` 的 `validatePortableManifest`：清单名 `N.E.K.O_<版本>_win_manifest.json`、包名 `N.E.K.O_<版本>_win.zip`、差分包名 `N.E.K.O_<旧版本>_to_<新版本>_win_delta.zip`，且归档条目集合必须与清单 `files` 完全一致。

后端二进制在打包时由 `actions/download-artifact` 落在 `electron-app/bin/projectneko_server.exe`，再被该脚本搬进 `resources/bin/`——前端在打包态只从那里加载后端。

尚未迁移：macOS / Linux 腿（缺 `.dmg` / `.AppImage` / `.deb` 的 maker）与 Authenticode 签名接线；`build-desktop-windows.yml` 恒为 Windows-only，不受前者影响，后者使 `skip_signing=false` 目前与 `true` 产出相同。

