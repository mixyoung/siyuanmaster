# 思源大师（SiYuanMaster）

思源大师：让人工智能助手安全、可控地读写和管理思源笔记。

| | |
|---|---|
| **品牌** | 思源大师 / SiYuanMaster |
| **包名** | `siyuanmaster` |
| **版本** | `0.6.1` |
| **技术插件 ID** | `siyuanmaster` |
| **MCP 命名空间** | `plugin__siyuanmaster__*` |
| **仓库** | https://github.com/mixyoung/siyuanmaster |

**Breaking change（0.5.0）：** 技术插件 ID 已切换为 `siyuanmaster`。安装目录为 `data/plugins/siyuanmaster`；MCP 工具全名为 `plugin__siyuanmaster__*`。旧的 `plugin__siyuan_agent_access__*` 名称失效，外部 Agent/Skill 配置必须更新。首次加载时，若新路径无策略/审计，会**自动复制**旧 petal（`data/storage/petal/siyuan-agent-access/`）到 `data/storage/petal/siyuanmaster/`（新值始终优先、失败关闭）；**旧目录保留不删**。外部 Agent/Skill 的 MCP 命名空间仍须**手工**改为 `plugin__siyuanmaster__*`。

**兼容性变更（0.6.1）：** 思源 3.8.1 已移除内核插件的 `siyuan.mcp.registerTool` 接口。思源大师现通过 `siyuan.agent.registerCapability` 注册全部 27 项受控操作，并保守声明本地读写副作用。运行时模型名保留 `plugin__siyuanmaster__` 前缀，并追加思源生成的稳定 12 位十六进制哈希；应调用 `tools/list` 返回的精确名称，不再拼接旧的无后缀名称。

## 概述

思源大师作为思源桌面端原生插件运行，向内置 `/mcp` 注册受策略约束的工具，提供侧边栏展示连接状态与安全策略，不额外启动 Node/Python 常驻服务。

- 笔记本允许/禁止访问，以及按操作的 allow / confirm / deny
- `update_note`、`edit_block` 走 Safe Write Transaction
- 重命名/移动采用两阶段、一次性预演令牌
- 可选标签策略；AI 标签建议默认为提案
- 仅元数据审计（不含笔记正文）
- 界面字号跟随思源编辑器字体设置

## 已实现能力

- 侧边栏：连接状态、安全策略与 P1 能力状态
- GUI 配置笔记本访问、操作权限、标签策略与写入安全策略
- 在 `/mcp` 上暴露 **27** 项 Agent capability（原 16 + 3 个 P1 + 8 个知识复利 M1）；模型名格式为 `plugin__siyuanmaster__<name>__<稳定哈希>`
- 有界文档树浏览（`list_document_tree`；仅元数据，不返回正文）
- 路径查找（`resolve_document`，只读）、长文窗口（`read_note_segments`）、块编辑（`edit_block`）
- 内核强制笔记本边界；笔记本决策下沉到全部子孙
- 能力目录：`catalog/capabilities.json`（生成物过期则构建失败）

## 快速开始

1. 构建或获取插件包（`pnpm build` 产出 `package.zip` / `dist/`）。
2. 安装到思源工作空间：

```text
<工作空间>/data/plugins/siyuanmaster
```

3. 在思源中启用插件，打开右侧边栏 **思源大师**。
4. 选择允许访问的笔记本。默认是允许名单模式且选择为空——未选择前不可访问任何笔记本。

最低思源版本：`3.8.1`（见 `plugin.json`）。

## 连接 AI 助手（MCP）

将本机 MCP 客户端指向思源内置端点。使用你自己的 API Token；切勿写入真实凭据。

```json
{
  "mcpServers": {
    "siyuan": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:6806/mcp",
      "headers": {
        "Authorization": "Token ${SIYUAN_API_TOKEN}"
      }
    }
  }
}
```

建议优先调用：

1. `tools/list` 中对应 `get_policy` 的 capability（`plugin__siyuanmaster__get_policy__<稳定哈希>`）
2. `tools/list` 中对应 `list_accessible_notebooks` 的 capability（`plugin__siyuanmaster__list_accessible_notebooks__<稳定哈希>`）
3. 再用 `list_document_tree` 浏览层级，用 `resolve_document` 做路径查找，用 `read_note_segments` 读长文，用 `edit_block` 做块编辑。

当策略要求确认时，须先获得用户同意，再带 `confirmed=true` 重试。未获真实确认时不得设置 `confirmed=true`。

## 工具（27 = 原 16 + 3 个 P1 + 8 个知识复利 M1）

全部通过 Agent capability 注册，运行时暴露为 `plugin__siyuanmaster__<name>__<稳定12位十六进制哈希>`。下列目录保留稳定裸名；完整运行时名称以 `tools/list` 为准。

**原 16 个**（名称不变）：

`get_policy`、`list_accessible_notebooks`、`list_document_tree`、`search_notes`、`read_note`、`create_note`、`append_note`、`update_note`、`rename_note`、`move_note`、`delete_note`、`suggest_tags`、`apply_tags`、`prepare_summary`、`save_memory`、`get_audit_log`

**P1 新增：**

| 工具 | 作用 |
|---|---|
| `resolve_document` | 按笔记本 + 人类路径（`hPath`）只读查找；写入仍要求精确 ID |
| `read_note_segments` | 大纲 + 硬上限全块窗口，适合长文 |
| `edit_block` | 精确块 ID、期望内容/哈希、引用影响、Safe Write Transaction |

**知识复利 M1 新增：**

| 工具 | 作用 |
|---|---|
| `register_knowledge_source` | 将一篇允许访问的 Raw 文档登记进私有 Source Manifest；保存 ID、哈希/URL、状态和链接，不保存正文 |
| `register_wiki_authority` | 登记 Wiki 权威页、别名、页面类型、知识角色及来源双向链接；不生成或改写页面正文 |
| `knowledge_status` | 按当前访问边界计算来源状态、权威页类型和链接覆盖率，不让模型猜统计值 |
| `find_wiki_candidates` | 仅用登记标题、别名、类型和来源链接做确定性低上下文候选查找；无结果时回退 `search_notes` |
| `list_wiki_templates` | 返回六类 Wiki 页的版本、用途、创建门槛、元数据枚举与固定标题顺序 |
| `render_wiki_template` | 只生成确定性 Markdown 草稿预览；明确返回 `writeExecuted=false`，不创建或更新笔记 |
| `validate_wiki_template` | 只检查标题、必需章节顺序/重复和元数据；不写笔记，额外二级标题仅警告 |
| `plan_source_ingest` | 将一条精确 Raw、注册表/候选证据、创建门槛和模板选择编排成只读状态与有序操作计划；计划中的写入仍需后续逐项授权，工具本身不执行写入 |

结构类工具 `rename_note` / `move_note` 使用两阶段、一次性 `previewToken`。跨笔记本移动为独立权限，默认拒绝。

## 安全与标签行为

| 规则 | 行为 |
|---|---|
| 默认访问 | 空允许名单——未选中笔记本前全部拒绝 |
| 写入 | 遵循各操作策略（`allow` / `confirm` / `deny`）；多项写入默认需确认；删除默认禁止且始终需确认 |
| `snapshotBeforeWrite` | 强制为 `true`（即使存盘为 false 也会归一）；不是用户开关 |
| `permissionInheritance` | 强制为 `true`；笔记本决策适用于全部子孙 |
| 标签 | 先读取已有标签，再追加、修剪并去重——从不覆盖 |
| 自动打标 | 无显式选择或已保存策略时不自动打标；AI 建议默认为**提案**，除非启用自动应用 |
| 审计 | 仅元数据；开启正文脱敏 |
| 写入通道 | 仅通过思源内核 API——从不直接读写 `.sy` 文件 |

Safe Write Transaction（`update_note`、`edit_block`）：写前快照（失败即停）→ 按需确认 → 状态复核 → 只执行一次 → 回读验证。结果为 `unknown` 时不自动重试。审计记录不含正文。

**边界：** 插件策略仅保护本插件注册的工具。思源原生 `/mcp` 为管理员级认证入口；持有完整 API Token 的客户端仍可调用其他原生高权限工具。该边界已知，本插件不掩盖。

## 可选 Rust 组件

| Crate | 作用 |
|---|---|
| `siyuanmaster-core` | 共享目录、令牌、权限原语与事务辅助 |
| `siyuanmasterd` | 本机 HTTP 网关（范围令牌、健康检查、目录与事务端点） |
| `siyuanmaster` | CLI |

以上为可选本机辅助组件，不替代日常使用的 TypeScript 插件路径。

## 思源 3.8.1 实机验证

当前 0.6.1 已在真实本机思源 3.8.1 上验证：

- 安全安装流程备份 0.6.0，安装与 `dist/` 逐项一致的 13 个文件并完成重载；
- MCP `initialize` 协商协议为 **`2025-03-26`**；
- `tools/list` 总计 **58** 项：思源大师 Agent capability **27**、旧命名空间 **0**、思源其他工具 31；
- 带稳定哈希的 `get_policy`、`list_accessible_notebooks` 只读冒烟成功；kernel RPC 返回 `ready=true`、`toolCount=27`；
- 已安装 `kernel.js` 存在 Agent 注册/注销调用，不存在旧 `.mcp.registerTool(...)` 调用。

本次 3.8.1 兼容性验收未执行破坏性笔记写入。此前 3.8.0-alpha.2 可弃笔记本上的 create/read/resolve/segments/edit/update/delete 全流程属于历史证据，不能替代未来单独执行的 3.8.1 写入冒烟。

## 当前限制

- **权限模型：** 实际行为是笔记本决策继承到全部子孙。文档级读/写/隐藏覆盖**尚未**接入插件。
- **写入确认重试：** `update_note` / `edit_block` 在确认后重试会创建**新的**事务与快照。无跨调用持久 preview token，也无用户可见的全量 diff。
- **网关 / 端到端：** 网关向思源内核的出站代理，以及完整思源实机端到端行为，在本版本**未**做生产级验证。
- **范围：** 不宣称覆盖思源全部能力（无属性视图数据库工具、闪卡、完整时间线、Docker/远程部署、多块/表格编辑、资源上传等 backlog 项）。

## 开发与构建

```bash
pnpm build          # generate → check → typecheck → build:package → test
pnpm build:package  # 仅 esbuild + dist/ + package.zip
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

### MCP 发现冒烟（可选）

需要本机思源已运行且设置 `SIYUAN_API_TOKEN`。仅 loopback；Token 从不打印。脚本复现思源 3.8.1 的稳定 capability 名称哈希，按 `catalog/capabilities.json` 精确校验 27 个 `plugin__siyuanmaster__*` 名称，并断言旧命名空间 `plugin__siyuan_agent_access__*` 为 0。

- **默认 discovery：** 零笔记写入（仅 initialize → session → tools/list + 目录精确匹配）。
- **`--read-smoke`：** 依次调用两个只读工具 `get_policy` 与 `list_accessible_notebooks`；仅输出 `isError`、`structuredContent` 是否存在、顶层 key，以及顶层数组字段的名称与计数——绝不输出数组元素/值。这两次调用可能写入**仅元数据**审计记录。
- **Token：** 脚本始终发送 `Authorization: Token …`。在思源 `3.8.0-alpha.2` 实机观察到：无 `Authorization` 也可能成功，错误 Token 返回 `401`。本脚本**不宣称**原生认证为必需。

```bash
pnpm smoke:mcp
pnpm smoke:mcp -- --read-smoke   # 额外调用 get_policy + list_accessible_notebooks（只读；仅安全摘要）
```

### MCP 破坏性写入冒烟（可选，显式确认）

**与发现/只读冒烟分开。** 默认 `pnpm smoke:mcp` / `--read-smoke` **不会**创建、更新或删除笔记。本写入冒烟为**破坏性**操作：未同时提供可丢弃笔记本 id 与显式确认标志时**不会运行**。

前置条件：

- 一个**可丢弃且策略允许**的笔记本，通过 `--notebook-id` 传入其 id（仅操作该笔记本）。
- 插件策略：`create` / `update` / `read` / `delete` 均**不能**为 `deny`。`delete` 默认 `deny` — 须将 delete 设为 **`allow` 或 `confirm`**，以便预检允许清理；否则冒烟在 create 前**拒绝执行**。
- 已设置 `SIYUAN_API_TOKEN`（永不打印）。仅 loopback MCP URL。
- 显式确认：**`--confirm-destructive-smoke`**（必填）。

生命周期（仅插件工具；无原生 API / 旁路）：
`get_policy` → `list_accessible_notebooks`（预检）→ `create_note` → 就绪 `read_note`（有界轮询）→ `update_note` → `read_note` → `delete_note`。
create 之后，冒烟会在**有界时间窗**内（约 5 秒：20 × 250ms）仅通过插件 **`read_note`**（`confirmed=true`）等待思源索引可见。仅这些就绪读可重试；**create / update / delete 绝不重试**。`{ok:false}` 在窗口内视为尚未可见；畸形 MCP/`structuredContent` 为硬失败。
成功后**不留下**冒烟笔记。**已知 ID** 的 create 后失败（`documentId` 通过思源 id 校验）会尝试**恰好一次**插件 `delete_note` 清理；若清理失败，可能**留下一篇**笔记，错误信息**仅**打印该已校验的 `documentId`（不含标题/正文/Token/会话）。**未知 create 结果**（超时、envelope 缺失/畸形、`{ok:false}`、或 `documentId` 缺失/非法）无法安全清理——错误会报告 **`artifactPossiblyCreated=true`**，并提示需在所选可丢弃笔记本中人工检查（**不含** `documentId` / 标题 / 正文 / Token / 会话）。

```bash
pnpm smoke:mcp:write -- --notebook-id <可丢弃笔记本ID> --confirm-destructive-smoke
# 可选: --url http://127.0.0.1:6806/mcp
```

### Windows 一键本地循环（`dev:local`）

桌面端开发一键流程：**构建 → 安全安装 → 思源重载 → MCP 冒烟**（需 PowerShell 7+）。安装目标固定为：

```text
<工作空间>/data/plugins/siyuanmaster
```

```bash
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace"
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -ReadSmoke
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -WhatIf
pnpm dev:local -- -Workspace "D:\path\to\siyuan-workspace" -SkipBuild -SkipReload   # 仅安装；端口须关闭，除非显式覆盖
```

| 参数 | 行为 |
|---|---|
| `-Workspace` | **必填。** 思源工作空间根目录（建议绝对路径）。 |
| `-SkipBuild` | 使用已有 `dist/`（跳过 `pnpm build`）。 |
| `-SkipReload` | 仅安装；**不**调用 `setPetalEnabled`，**不**跑 MCP smoke。输出 `manual restart required`。默认若 `-ApiBaseUrl` TCP 端口可达则**拒绝安装**（运行中的思源会继续用旧插件文件）。仅在思源未运行或你将手动重启时使用。默认路径始终 reload + smoke。 |
| `-AllowRunningWithoutReload` | **仅配合 `-SkipReload`。** 允许在 API 端口可达时仍安装。**风险：** 运行中的思源实例可能继续提供旧插件，直到真正 reload/重启。优先保证端口关闭，而不是依赖此覆盖开关。 |
| `-ReadSmoke` | 重载后执行 `pnpm smoke:mcp --url <ApiBaseUrl-origin>/mcp --read-smoke`（可能写入**仅元数据**审计记录）。 |
| `-WhatIf` | 只校验 `dist/` 与路径并打印计划——不 build、不调 API、不做 TCP、不建目录、不移动、不改环境变量。不打印凭据。 |
| `-ApiBaseUrl` | 默认 `http://127.0.0.1:6806`。**必须是严格 origin**（无 userinfo/query/fragment；path 只能为空或 `/`）。仅 loopback（`localhost` / `127.0.0.0/8` / `::1`）。 |

**安全与失败恢复**

- 要求完整 `dist/`（`index.js`、`index.css`、`kernel.js`、`plugin.json`、README、图标、`i18n/`、`agent-skill/`）；对 `dist/` 与 staging 递归拒绝 reparse point。
- 先落到 `data/plugins/.siyuanmaster-staging-<guid>/`，再用 **Move-Item** 交换进正式目标（禁止覆盖式 Copy-Item 到已存在目标；禁止递归删除插件/备份目录）。
- 旧安装移到 `data/plugins/.siyuanmaster-dev-backups/<timestamp-guid>/siyuanmaster`，且仅当其 `plugin.json` 的 `name` 恰好为 `siyuanmaster`（拒绝把普通同名目录当备份）。无旧安装时不创建空 backup 根目录。
- Token 仅从 `<工作空间>/conf/conf.json` 的 `api.token` 读入当前进程环境变量（不打印、不写文件）；`finally` 中恢复调用方原值。
- 默认 reload 路径在 disable/swap **之前**，用同一 origin+token 调用 `POST /api/system/getWorkspaceInfo {}`，要求 `data.workspaceDir` 与 `-Workspace` 一致（Windows 规范化后大小写不敏感）。不一致则固定失败且不做目录移动。
- 重载调用 `POST /api/petal/setPetalEnabled`，`app=siyuanmaster-dev-local-<guid>`。此处 `app` **只**是该次调用的 **excludeApp** 值，**不是**登录/调用方身份；因与真实前端 app id 不匹配，官方 `PushReloadPlugin` 仍会广播到真实前端。
- MCP smoke 始终显式传入 `--url <ApiBaseUrl-origin>/mcp`（本循环不继承 `SIYUAN_MCP_URL` 或环境默认 6806）。
- 交换后失败：尽力禁用新插件，将失败目标移到 `data/plugins/.siyuanmaster-failed-<guid>`，若原先有安装则恢复 backup，且**仅在身份确定时**重新启用旧插件（`backupRestored`，或从未移动/替换）。若新 target 隔离失败且 backup 未恢复，则禁止 enable 并标记 recover incomplete。若原先不存在则**不伪造**恢复。
- 不修改认证配置。

- Node `>= 24`（见 `package.json` engines）
- 能力目录源：`catalog/capabilities.json` → `src/generated/capabilities.ts`
- 插件包输出：`dist/` 与 `package.zip`

```text
安装目录：
<工作空间>/data/plugins/siyuanmaster
```
