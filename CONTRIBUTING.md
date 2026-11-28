# 参与开发与发版

面向维护者。普通使用看 [README](README.md)。

## 仓库结构

```
AGENTS.md                     规程核心（<=8k 字符，常驻注入版本）
docs/workflow/rules/          分册 01–09
docs/workflow/practices/      经验库
playbook/                     发布用副本（由 scripts/sync-playbook.mjs 从上面三处同步）
lib/index.js                  DSH 命令插件入口（/atp）
lib/install.js                原子安装器（scan / inspectConflict / installAtomic）
bin/cli.mjs                   CLI 入口（init 系列）
client.js                     浏览器半身（ModuleLoader bundle，无构建）
scripts/sync-playbook.mjs     AGENTS.md + docs → playbook/ 同步
scripts/smoke-install.mjs     安装自检（真实 dsh plugin add）
cordis.patch.yml              bundle patch（挂载本插件）
screenshots.json              市场详情页展示图声明
```

**改文档要同步 playbook**：`npm run sync`；CI/发版前用 `npm run check` 校验一致性。

## 安装自检

单测只覆盖源码，`pack` 只验证包内容；真正会坏的是安装链路。自检在**全新 `DSH_HOME`** 里走一遍真实安装：

```bash
npm run smoke:pack                    # 本地打包 → 真实安装（发版前跑）
npm run smoke -- --version 1.33.0     # 从 npm 装已发布版本，验证线上产物
```

7 项检查：安装成功 / 版本与清单（`dsh.bundle`、`dsh.client`、`exports["./client"]`、`engines.dsh`）/ bundle patch 激活 / `cordis.patch.yml` 注释与实际命令一致 / host 半身注册 `/atp` / client 半身装配三个插槽 / bin 可执行。

`npm publish` 前会自动执行（`prepublishOnly`），**不通过不发布**。

> 自检本身也要能测：`npm publish --dry-run` 会把 `--dry-run` 经 `npm_config_*` 传给嵌套 `npm pack`，脚本已清环境；`prepack` 的进度输出会污染 `npm pack --json`，所以脚本先显式同步再 `--ignore-scripts` 打包。

## 发版流程

```bash
# 1. 改内容
# 2. 同步副本 + 校验
npm run sync && npm run check
# 3. 升版本（package.json version 与 npm 一致）
# 4. 提交推送
# 5. 发布（prepublishOnly 自动跑自检）
npm publish --access public
# 6. 建 GitHub Release（tag = vX.Y.Z），正文写本次变更
```

npm 令牌不入库：放在仓库外的 `.secrets/`，用临时 `--userconfig` 文件传入并立刻销毁。

## DSH 兼容范围

`package.json` 的 `engines.dsh` 决定哪些 DSH 能装：

```json
"engines": { "node": ">=20", "dsh": ">=0.2.2-rc.1 <0.3.0-0" }
```

- DSH 在**安装/激活前**用 `dsh-app-boot` 的版本比对；不满足直接拒绝（不是装了不动）
- 没写 `engines.dsh` 也没有 dsh 相关的 `peerDependencies` 时，**任何版本都被视为兼容** —— 老运行时上会"装上了但面板/命令不生效"
- 只声明实测过的范围，不虚标更早版本；升级验证后再放宽

## 版本号有两套

| 版本 | 含义 | 在哪 |
|---|---|---|
| 插件包 `1.33.x` | npm 包版本 | `package.json` / [CHANGELOG](CHANGELOG.md) |
| 规程文档 `v1.22` | `AGENTS.md` 核心的版本 | `AGENTS.md` 标题 / `docs/workflow/rules/09-环境适配与变更记录.md` |

改规程内容 → 升文档版本并记入 09；改插件代码/打包 → 升包版本并记入 CHANGELOG。

## 浏览器半身

`client.js` 是**手写 `window.__ModuleLoader__.load`** bundle，无构建步骤，`require` 由 shell 提供（react / primitives / slots）。挂三个插槽：

- `settings.section` — 设置里的「协作规程」面板
- `conversation.hero.options` — 首页 chip 行入口
- `shell.overlay` — 冲突处理弹窗

写操作一律通过 `remote.commands.execute(sessionId, '/atp apply …')` 回到 host，**不新增 HTTP 写接口**；面板只读状态走 `GET /api/agent-team-playbook/status`（平台在 handler 前已做 Host/Origin 与会话凭据校验）。

样式全用**内联 style 对象**：早期用 `<style>` 注入曾整体不生效（菜单横排、弹窗不限高），内联没有这个问题。仅保留一条 `div:has(> .atp-wrap)` 调整 chip 左对齐。

## 发布前检查清单

- [ ] `npm run check`（playbook 与源文档一致）
- [ ] `npm run smoke:pack` 通过
- [ ] 版本号已升，CHANGELOG 已记
- [ ] `cordis.patch.yml` 注释与实际命令一致
- [ ] `engines.dsh` 与实测运行时相符
- [ ] README 面向用户的描述仍然准确（改过行为就要改 README）
