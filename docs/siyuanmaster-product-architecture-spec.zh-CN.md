# 思源大师（SiYuanMaster / siyuanmaster）产品架构规格

> 唯一规格文档 · 中文 · 自包含
>
> - 规格版本：1.4
> - 产品基线：`siyuan-agent-access` v0.3.0（git 基线 94af5b2）
> - 目标版本：0.5.2
> - 编写日期：2026-08-12
> - 一致性声明：本文档描述**本仓库当前实际实现**。所有“已实现”条目均可在仓库中找到对应代码与测试；已在思源实机验证的路径单独标注证据；其余“未接入”或“未在思源实机验证”的行为均如实标注，不冒充已实现。**不宣称**与外部参考项目（Bridge / Sisyphus）功能全量对等。
> - 专项路线：知识复利产品线、SiYuan + LLM 与成熟 Obsidian/VS Code + LLM 实现的差距及分阶段验收标准，见 [《SiYuanMaster 知识复利产品路线与能力差距基线》](knowledge-compounding-product-roadmap.zh-CN.md)。专项路线只描述计划，不改变本文的“当前已实现”口径。

---

## 1. 产品定位

**思源大师（SiYuanMaster，品牌 slug `siyuanmaster`）** 是思源笔记（SiYuan）的可信本机 Agent 接入产品，由原 `siyuan-agent-access` 插件演进而来。它解决的核心问题是：

> 让本机 AI Agent 可以安全、可审计、可回读地读写用户的思源笔记，同时把“管理员级思源 API Token”与外部 Agent 尽可能隔离开。

### 1.1 内部组件（自有名称）

| 内部名称 | 职责 |
|---|---|
| **Access Boundary（访问边界）** | 笔记本允许/禁止名单、操作级允许/需确认/禁止、文档树权限继承（当前=笔记本决策下沉）、标签策略、审计（无正文）、插件 MCP 工具注册 |
| **Safe Write Transaction（安全写事务，`SafeWriteTxn`）** | 写前快照 → 确认 → 执行前状态复核 → 只执行一次 → 回读验证 → 无正文审计；快照失败停止；`unknown` 不自动重试 |
| **Capability Catalog（能力目录）** | `catalog/capabilities.json` 单一事实源；Rust 内嵌解析；TS 生成 + 新鲜度门禁 |
| **Local Gateway（本机网关 `siyuanmasterd`）** | 健康检查、能力目录、范围令牌校验、审计查询、事务预览/确认骨架；默认拒绝 |
| **CLI（`siyuanmaster`）** | capabilities / token / txn / migrate check |

### 1.2 外部参考项目（不是内部支柱）

下列二者是**外部参考**，用于吸收能力与约束设计；**不是**本产品内部组件名称，也不得在架构图中当作内部模块。
**当前 P0/P1 不是全量功能对等**，不得宣传为“已吸收全部能力”。

#### SiYuan Bridge（外部参考）

- 源仓库：<https://github.com/alone-tree/siyuan-bridge>
- 定位（事实描述）：面向文档/知识库的思源 Agent 接入方案，而非本仓库子系统。
- 主要能力面：搜索与文档树浏览；大纲优先、段落安全的长文读取；精确块编辑与多块编辑；表格行列编辑；资源上传/本地文件夹链接；笔记本/文档的创建、重命名、移动、复制、导出、删除；块引用检查与破坏性引用防护；写入前确认 + 思源工作区快照；笔记本/文档的读写/只读/隐藏隐私及树继承；多工作区与个性化指令/索引。
- 其文档声明的排除项：数据库编辑、闪卡、标签/块样式、移动端。
- **本仓库不内嵌、不依赖、不宣称实现了名为 “SiYuan Bridge” 的子系统。** 对应内部实现是 **Access Boundary** + 思源原生插件 MCP 工具 + 可选 **Local Gateway**。

#### SiYuan Sisyphus（外部参考）

- 源仓库：<https://github.com/yangtaihong59/siyuan-plugins-mcp-sisyphus>
- 定位（事实描述）：广义 **MCP + CLI 产品**（v0.5.x 一线），**不是**本产品内部的安全写入方法论名称。
- 主要能力面：约 14 个低上下文聚合工具覆盖 100+ 思源能力；HTTP / stdio / 本机 / 远程 / Docker；笔记本权限 none / r / rw / rwd；通过扩展发现并转发官方插件 MCP；人类可读 fs 路径；database / export / tag / flashcard / timeline / system / markup 等场景技能；类 Git 的文档时间线 / diff / 回滚；MCP 与 CLI 共享核心。
- 重要边界：经转发的官方原生工具**可能绕过** Sisyphus 自身权限。
- **本仓库不内嵌名为 “Sisyphus” 的模块。** 对应内部实现是 **Safe Write Transaction**（Rust `core::txn` + TS `src/write-transaction.ts`，目录名 `SafeWriteTxn`）。不得把 “Sisyphus” 当作本产品写事务品牌名。

### 1.3 外部能力吸收矩阵（诚实边界）

下表说明外部参考能力在 SiYuanMaster P0/P1 的**当前落地状态**。
**结论：P0/P1 ≠ 功能全量对等；不得营销为“已吸收全部功能”。**

| 来源能力 | P0/P1 现状 | 阶段 |
|---|---|---|
| 搜索 / 文档树浏览 | 已实现：`search_notes`、`list_document_tree`、笔记本名单 | P0 |
| 大纲优先长文分段读 | 已实现：`read_note_segments`（含 `includeStateHash`）；专用笔记本写烟测路径已实机通过；**超长文档性能/排序未验证** | P1 |
| 路径只读解析 | 已实现：`resolve_document`；专用笔记本写烟测路径已实机通过 | P1 |
| 精确块编辑 | 已实现：`edit_block` + SafeWriteTxn + `validateOnly`；专用笔记本写烟测路径已实机通过（空引用场景） | P1 |
| 多块编辑 / 表格行列编辑 | 未实现 | P2 / backlog |
| 资源上传 / 本地文件夹链接 | 未实现 | P2 / backlog |
| 笔记本/文档创建·重命名·移动·导出·删除 | 部分：创建/重命名/移动/删除等既有工具；复制/导出等未全量 | 部分 P0；其余 backlog |
| 块引用检查 / 破坏性引用防护 | 已实现代码路径：`referenceProtection` warn/deny；**非空引用场景未思源实机验证** | P1 |
| 写前确认 + 工作区/内容快照 | **已强制**：`snapshotBeforeWrite=true`；插件侧为内容哈希快照；**非**完整工作区级 UI 快照产品 | P0/P1 不变量 |
| 笔记本级访问控制 | 已实现：允许/禁止名单 + 操作级 allow/confirm/deny | P0 |
| 文档级读写/只读/隐藏 + 最近祖先继承 | **未接入 TS 插件**（Rust `core::perm` 有原语与单测） | 缺口 / P2 |
| 多工作区 / 个性化指令与索引 | 未实现 | P2 / backlog |
| 低上下文聚合工具（14 工具 / 100+ 能力） | 未采用；本产品为显式 19 工具契约 | 不目标对等 |
| HTTP/stdio 远程 / Docker | 网关仅本机最小可用；远程/Docker 未实现 | P2 登记 |
| 官方插件 MCP 发现与转发 | 未实现；且转发可能绕过权限——非当前方向 | backlog |
| 人类可读 fs 路径写操作 | 仅只读 `resolve_document`；写入仍要求精确 ID | P1 只读侧 |
| database / flashcard / tag 场景技能包 | 标签策略有限支持；database/flashcard 未实现 | 标签 P0；其余 P2 |
| Git 式时间线 / diff / 回滚 | 未实现完整时间线；写事务无用户可见全量 diff | P2 / backlog |
| 跨调用持久 preview token | **未实现**；确认重试为新事务/新快照 | 未来工作 |
| 用户可见全量 diff | **未实现** | 未来工作 |

### 1.4 产品形态

1. **思源原生插件**（TypeScript）：`plugin.json` **技术 name** = `siyuanmaster`；展示名 = SiYuanMaster / 思源大师；内核注册受控 MCP 工具并执行 Access Boundary + Safe Write Transaction。
2. **Rust 工作区**：`core` / `siyuanmasterd` / `siyuanmaster`。
3. **单一能力目录**：`catalog/capabilities.json`。

**默认安全姿势**：笔记本访问默认拒绝（空允许名单）；写入默认需确认；删除默认禁止且始终需确认；标签默认不添加；AI 标签默认仅提案；网关默认拒绝；审计永不含正文；`snapshotBeforeWrite` 与 `permissionInheritance` 为强制不变量（恒为 true）。

---

## 2. 命名与技术身份（0.5.0）

### 2.1 矩阵

| 维度 | 值 | 说明 |
|---|---|---|
| 品牌 slug / package 名 | `siyuanmaster` | `package.json` name |
| 展示名 default | `SiYuanMaster` | 用户可见 |
| 展示名 zh-CN | `思源大师` | 用户可见 |
| **技术插件 ID**（`plugin.json` name） | **`siyuanmaster`** | **0.5.0 已切换**；旧安装路径与旧 MCP 全名失效 |
| MCP 命名空间 | **仅** `plugin__siyuanmaster__*` | 由思源内核从技术 name 推导；单插件不能注册双原生命名空间 |
| 插件存储目录 | `data/storage/petal/siyuanmaster/` | 首次加载自动复制旧 petal（新值优先、失败关闭；旧目录保留不删） |
| Dock 类型键 | `siyuanmaster-dock` | 随技术 ID 切换（breaking） |
| “仅首次”标记属性 | `custom-agent-access-tagged` | 保持不变 |
| 版本 | `0.5.2` | package / plugin / catalog / Rust workspace 统一 |

### 2.2 0.5.0 技术 ID 切换（breaking）

思源内核将 MCP 工具命名为 `plugin__<sanitize(plugin.json name)>__<tool>`（已在 v3.8.0-alpha.2 的 `plugin/api_mcp.go` 行为中核对）。0.5.0 已将 `plugin.json` 的 `name` 改为 `siyuanmaster`：

1. 安装目录变为 `data/plugins/siyuanmaster`，petal 变为 `data/storage/petal/siyuanmaster/`；
2. 工具全名变为 `plugin__siyuanmaster__*`；旧 `plugin__siyuan_agent_access__*` **全部失效**，外部 Agent/Skill 配置必须更新；
3. **同一插件无法同时注册两个原生命名空间**，故不做双命名空间兼容。

**旧数据迁移（已实现）：** `src/migration.ts` 在前端与 kernel 启动时运行幂等迁移：新 policy 始终优先；仅当新侧缺失时只读读取旧 petal 并复制到新 scoped storage；损坏/缺失则失败关闭到空 allowlist；新 audit 为空时才做有界 metadata-only 审计复制；写入 migration marker；**永不删除/改写旧目录**。外部 Agent 命名空间仍须手工更新。

### 2.3 工具集合

19 个裸工具名 = 原 16 + `resolve_document` + `read_note_segments` + `edit_block`。全部只生成当前 `plugin__siyuanmaster__` 命名空间下的全名。

---

## 3. 功能版图总表

| 功能 | 归属 | 阶段 | 实现位置 | 状态 |
|---|---|---|---|---|
| 笔记本允许/禁止名单 | Access Boundary | P0 保留 | `src/config.ts` / `src/kernel.ts` | 已实现 |
| 操作级权限 | Access Boundary | P0 保留 | `src/policy-engine.ts` | 已实现 |
| 标签策略 / AI 提案 | Access Boundary | P0 保留 | `src/policy-engine.ts` | 已实现 |
| 写标签先读后追加去重 | Access Boundary | P0 保留 | `mergeTags` | 已实现 |
| 文档树有界浏览 | Access Boundary | P0 保留 | `list_document_tree` | 已实现 |
| 两阶段重命名/移动 | Access Boundary | P0 保留 | `rename_note` / `move_note` | 已实现（结构预演；**未**走 SafeWriteTxn 状态机） |
| 审计（无正文） | Access Boundary | P0 保留 | `src/audit.ts` + `core::audit` | 已实现 |
| 品牌展示与 package 名 | — | P0 | plugin/package/README/i18n | 已实现 |
| 技术 ID 过渡策略 | — | P0 | plugin.json + catalog.compatibility | 已实现 |
| 未来 ID 切换纯决策 | — | P0 | `src/migration.ts` | 已实现（纯函数；**未**接 onload） |
| 启动自动迁移旧 petal | — | — | — | **未实现（本轮明确不做）** |
| 双命名空间/旧别名双注册 | — | — | — | **未实现（单插件不可能）** |
| Rust 工作区 | — | P0 | `crates/*` | 已实现（单元测试绿） |
| 能力目录 + 生成/新鲜度 | — | P0 | catalog + scripts + tests | 已实现 |
| 网关健康/令牌/默认拒绝 | Local Gateway | P0 | `siyuanmasterd` | 已实现（本地 HTTP 单测） |
| 管理员 Token 可信边界设计 | Local Gateway | P0 | `core::secret` + 网关 | 已实现（设计+单测；**无思源出站代理实机**） |
| SafeWriteTxn 状态机 | Safe Write Transaction | P0 | `core::txn` + `write-transaction.ts` | 已实现 |
| `snapshotBeforeWrite` 强制 true | Safe Write Transaction | P0/P1 不变量 | `normalizePolicy` + UI 状态展示 | **强制**：存盘 false 亦归一为 true；UI **状态**非开关 |
| `permissionInheritance` 强制 true | Access Boundary | P0/P1 不变量 | `normalizePolicy` + UI 状态展示 | **强制**：存盘 false 亦归一为 true；UI **状态**非开关 |
| 笔记本判定下沉全部子孙 | Access Boundary | P0/P1 | `assertDocumentAllowed` + `isNotebookAllowed` | **当前真实边界**：无文档级覆盖表 |
| 文档级 rw/ro/hidden 与最近祖先继承 | Access Boundary | — | Rust `core::perm` 原语/单测 | **缺口**：TS 插件未接线 |
| `update_note` 接入写事务 | Safe Write Transaction | P1 | `kernel.ts` | 进程内 SafeWriteTxn；需确认时返回 `confirmation_required`；重试=**新事务/新快照**；专用笔记本写烟测路径已实机通过 |
| `edit_block` | Safe Write Transaction | P1 | `kernel.ts` + `edit-block.ts` + `document-access.ts` | SafeWriteTxn + 严格 root-IAL 回读；`validateOnly` 原子预检不写；专用笔记本写烟测路径已实机通过（空引用） |
| 跨调用持久 preview token | Safe Write Transaction | — | — | **未实现（未来工作）** |
| 用户可见全量 diff | Safe Write Transaction | — | — | **未实现（未来工作）** |
| 引用影响检查 | Safe Write Transaction | P1 | `document-access` + refs SQL | 已实现代码路径；**非空引用场景未思源实机验证** |
| 长文分段读取 | Access Boundary | P1 | `read_note_segments` | 已实现；`includeStateHash` 已实机用于写烟测 expectedHash；**超长文档性能/排序未验证** |
| 路径只读查找 | Access Boundary | P1 | `resolve_document` | 已实现；专用笔记本写烟测路径已实机通过 |
| GUI 展示安全策略与 P1 状态 | Access Boundary | P1 | `src/index.ts` Dock/设置 | 已实现代码路径（**GUI 视觉行为未思源实机验证**）；快照/继承为状态文案 |
| 属性视图数据库 | — | P2 | — | 未实现（仅登记） |
| 闪卡 | — | P2 | — | 未实现（仅登记） |
| 完整时间线 | — | P2 | — | 未实现（仅登记） |
| Docker 部署 | — | P2 | — | 未实现（仅登记） |
| 远程/公网接入 | — | P2 | — | 未实现（仅登记） |
| 移动端 | — | P2 | — | 未实现（仅登记） |

---

## 4. Access Boundary 与 Safe Write Transaction

### 4.1 Access Boundary

1. 策略：笔记本名单、操作决策、标签、安全策略（`safety.*`）。
2. 入口：思源 `/mcp` 上注册的 `plugin__siyuanmaster__*` 工具；可选网关范围令牌入口。
3. 审计：元数据 only。
4. 默认拒绝。
5. **当前权限边界（诚实）**：有效边界 = **笔记本决策继承到该笔记本下全部子孙文档/块**。文档级读写/只读/隐藏覆盖、最近祖先覆盖表**尚未接入 TS 插件**；Rust `core::perm` 仅有原语与单测，不得宣称插件已具备文档级隐私矩阵。

### 4.2 Safe Write Transaction

统一状态（与目录一致）：`previewed` → `awaiting_confirmation` → `confirmed` → `executing` → `committed` | `failed` | `unknown`。

不变量：`snapshot_failure_stops`、`exactly_once`、`no_auto_retry_on_uncertain`、`state_or_hash_check_required`、`readback_required`、`audit_without_body`。
P0/P1 另强制：`snapshotBeforeWrite ≡ true`、`permissionInheritance ≡ true`（`normalizePolicy` 将存盘 false 归一为 true）。

插件侧已接入：`update_note`、`edit_block`。`create_note` / `append_note` / 结构变更仍走既有路径（结构变更用预演令牌，非 SafeWriteTxn 状态机）。

**当前确认语义（落地事实）**：

1. 每次调用在进程内跑一次 `runWriteTransaction` 尝试。
2. 需要确认且未带 `confirmed=true` 时，返回 `confirmation_required`（事务停在 awaiting 语义；**不**保留跨调用可复用的插件侧 preview token）。
3. Agent/用户确认后的重试会创建**新的事务 ID 与新的快照**；执行前仍做哈希复核。
4. **无**用户可见的全量 diff；diff/持久 preview token 属未来工作，规格不得声称已具备。

---

## 5. P0 / P1 / P2 边界

### 5.1 P0

品牌与技术 ID 过渡策略、Rust 工作区、能力目录、网关最小可用、SafeWriteTxn 骨架、原插件能力不回归、`snapshotBeforeWrite`/`permissionInheritance` 强制不变量。

### 5.2 P1

关键写入接入写前快照与确认重试语义、`edit_block`、引用保护、笔记本决策下沉式权限继承、长文分段、路径只读查找、GUI 以**状态**展示强制安全项与 P1 能力。

### 5.3 P2 / backlog（仅登记，非本轮交付）

属性视图数据库、闪卡、完整时间线、Docker、远程/公网、移动端；网关→思源内核出站代理实机接通；文档级 rw/ro/hidden 与最近祖先继承接线；跨调用 preview token；用户可见全量 diff；多块/表格编辑；资源上传；官方插件 MCP 转发等。
**不宣称与 Bridge / Sisyphus 功能全量对等。**

---

## 6. 架构组件与数据流

```text
外部 Agent
  ├─ ① 思源 /mcp + 管理员 Token（用户自配）
  └─ ② 可选 siyuanmasterd + 范围令牌
        │
        ▼
思源内核 3.7+
  └─ 插件 kernel.js（技术 ID: siyuanmaster）
       ├─ Access Boundary（策略/工具/审计）
       └─ Safe Write Transaction（update_note / edit_block）
插件前端 index.js（Dock / 设置）
Rust core / siyuanmasterd / siyuanmaster
catalog/capabilities.json
```

写入只通过思源 Kernel API（如 `/api/block/updateBlock`、`/api/export/exportMdContent`、`/api/block/getBlockKramdown`、SQL 查询），**禁止**直接读写 `.sy` 文件。

---

## 7. 为何 TS 插件 + Rust core/gateway/CLI

1. 思源插件运行时是 JS/TS，MCP 注册与内核 API 只能在此完成。
2. 令牌/事务/哈希/权限等安全关键逻辑用 Rust 纯实现便于独立测试与 clippy 门禁。
3. 网关需要轻量本机 HTTP 进程形态。
4. CLI 便于运维与自动化。
5. 单一能力目录防止双语言漂移。

---

## 8. 单一能力目录

- 事实源：`catalog/capabilities.json`
- Rust：`include_str!` + 校验
- TS：`pnpm run generate` → `src/generated/capabilities.ts`；`pnpm run check:catalog` 与 `tests/catalog.test.ts` 门禁
- `pnpm build` **必须**执行 catalog check
- 只声明当前技术命名空间；不声明 `legacyPlugin` 双命名空间

工具 19 个（见 §2.3）。事务名：`SafeWriteTxn`。

---

## 9. 威胁模型（摘要）

| 场景 | 缓解 |
|---|---|
| 持完整管理员 Token 调原生工具 | 已知边界：插件无法阻止；文档与 `get_policy` 声明 |
| 范围令牌越权 | 作用域裁剪 + 默认拒绝 |
| 预览后并发修改 | 执行前哈希复核 → `state_changed`（重试为新快照） |
| 破坏块引用 | `referenceProtection` warn/deny |
| 通过子文档绕过笔记本限制 | 笔记本判定应用于全部子孙（**非**文档级覆盖矩阵） |
| 将 Sisyphus 转发官方工具当成本产品 | 外部参考；本产品不转发官方 MCP，避免绕过自身边界 |

---

## 10. 工具契约要点

| 工具 | 要点 |
|---|---|
| `resolve_document` | 只读；`notebookId`+`hPath`；不写 |
| `read_note_segments` | 大纲 + 窗口；limit 被 `safety.longDocument` 硬夹紧。**`includeStateHash`**（默认 `false`）：为 `true` 时仅为**当前返回窗口**内每个块附加 `getBlockKramdown` 原文的 64 位小写 SHA-256 `stateHash`（不是 SQL markdown 文本哈希；从不对全文扫哈希）。该哈希是 `edit_block.expectedHash` 的权威来源。 |
| `edit_block` | 精确 block ID；`expectedContent` 或 `expectedHash`（与当前 `getBlockKramdown` 原文比对/哈希）；引用影响；默认确认；进程内 SafeWriteTxn（快照→确认→复核→**只执行一次**→回读；失败不重试）。**`validateOnly=true`**：跑完整 expected-state + 引用预检后返回 `mode=validated` / `writeExecuted=false`，**永不**调用写 API（即使 `confirmed=true`）。审计 `preview`：`validateOnly` → `true`，真实写入 → `false`（仅元数据，无正文/哈希）。回读使用目标 ID 感知的 root-IAL 规范化（提交 markdown 逐字节前缀；body→IAL 边界为 rest 上恰好一个 LF/CRLF 分隔，或 expected 本身以 LF/CRLF 结尾且 rest 紧接单一 root IAL——后者把提交尾部换行当作分隔、不再额外要求；严格游标分词 IAL + 可选一个结尾 LF/CRLF；拒绝重复键/缺空白/畸形转义/同行第二 IAL 等）。确认后重试=新事务/新快照。 |
| `update_note` | 同上：快照/确认/复核/回读；**无**跨调用 preview token；**无**用户可见全量 diff |

### 10.1 思源 3.8.0-alpha.2 实机证据（已确认）

在**真实本地思源 3.8.0-alpha.2** 实例上已确认：

1. MCP `initialize` 协商协议 **`2025-03-26`**
2. `tools/list`：**总计 51** 个工具，其中 **19** 个 `plugin__siyuanmaster__*`，**0** 个旧 `plugin__siyuan_agent_access__*` 遗留名
3. 只读探测：`get_policy`、`list_accessible_notebooks`
4. **专用可弃笔记本** 完整写烟测通过（插件工具 only；写路径从不重试）：
   `create_note` → 可见性 `read_note` → `resolve_document` → `read_note_segments(includeStateHash=true)` → `edit_block validateOnly=true`（无写） → **一次** `edit_block` 确认提交并回读验证 → 编辑后 `read_note` → **一次** `update_note` → 最终 `read_note` → `delete_note` 清理
5. 审计元数据可区分：`validateOnly` 预检 `preview=true` vs 真实 `edit_block` `preview=false`

**仍未宣称实机验证**（见 §13）：非空块引用场景、超长文档性能/排序、GUI 视觉行为、网关出站链路；**不**宣称 Bridge / Sisyphus 功能全量对等。

---

## 11. 配置 `safety` 默认值

```jsonc
{
  "snapshotBeforeWrite": true,      // 强制不变量；存盘 false → normalize 为 true；UI 仅展示状态
  "referenceProtection": "warn",
  "permissionInheritance": true,    // 强制不变量；存盘 false → normalize 为 true；UI 仅展示状态
  "longDocument": {
    "maxBlocksPerWindow": 50,
    "maxCharsPerBlock": 8000,
    "maxOutlineBlocks": 500
  },
  "blockEdit": {
    "requireExpectedState": true,
    "defaultConfirm": true,
    "maxBlocks": 200
  }
}
```

说明：当前 `permissionInheritance=true` 的**实现含义**是“笔记本决策继承到全部子孙”，**不是**“已启用文档级覆盖 + 最近祖先查找”。

---

## 12. 测试与质量门禁

- `pnpm build`：generate → check:catalog → typecheck → vitest → package.zip（目录仍为技术 ID 产物）
- `cargo fmt --check`
- `cargo clippy --workspace -- -D warnings`
- `cargo test --workspace`

Vitest 覆盖：安全策略默认与 normalize（含强制 true 归一）、`mergeTags` 不覆盖、未来迁移决策、事务快照失败/状态漂移/unknown 不重试/回读、长文窗口、路径只读、引用保护、能力目录新鲜度、19 工具含原 16。

---

## 13. 思源实机验证状态（强制如实）

### 13.1 已在真实思源 3.8.0-alpha.2 本地实例确认

见 §10.1。摘要：协议协商 `2025-03-26`；`tools/list` 51 = 19 插件 + 0 遗留；`get_policy` / `list_accessible_notebooks`；专用笔记本写烟测全路径（create → 可见性 read → resolve → segments+`includeStateHash` → `edit_block` validateOnly 不写 → 一次确认 edit 提交并验证 → post-edit read → 一次 `update_note` → final read → delete）；审计 `preview` 区分 validateOnly vs 实写。

### 13.2 仍有代码/单测但未（或仅部分）实机验证

1. **非空引用场景**：`referenceProtection` warn/deny 在真实库中存在引用块时的行为（写烟测为空引用）
2. 确认重试路径下“新事务/新快照”与**并发编辑**的实机表现
3. `refs` 表引用查询在真实库中的完整性（有引用数据时）
4. `read_note_segments` 对**超长文档**的性能与排序
5. Dock/设置 **GUI 视觉行为**在真实思源前端的展示（含强制安全项状态文案）
6. `siyuanmasterd` 作为 Agent 前置网关的实机链路
7. 网关持管理员 Token 代理调用思源内核（**未实现出站代理**）
8. 其余未出现在 §13.1 写烟测路径中的工具组合与边界条件

---

## 14. P2 / 未来工作登记

知识复利产品线采用独立、可验收的专项路线，见 [《SiYuanMaster 知识复利产品路线与能力差距基线》](knowledge-compounding-product-roadmap.zh-CN.md)。该路线把模板、Raw 清单、证据索引、健康检查、批量事务、后台任务和检索能力拆为四个阶段；在代码与实机门禁完成前，任何条目均不得从“计划”宣传为“已实现”。

- 属性视图数据库
- 闪卡
- 完整时间线 / 用户可见全量 diff
- 跨调用持久 preview token
- 文档级读写/只读/隐藏 + 最近祖先继承（接线 TS 插件）
- Docker 部署
- 远程/公网接入
- 移动端
- 多块/表格编辑、资源上传、官方插件 MCP 转发（若做，须单独评估绕过风险）

---

## 15. 版本与交付物

- 版本：0.5.2
- 规格版本：1.4
- 插件包：`package.zip`（技术目录名 `siyuanmaster`）
- 规格：本文档
- 不提交密钥；`.gitignore` 含 `target/`、`.umadev/`、`output/`；保留 `Cargo.lock` 与生产规格
- 交付边界声明：P0/P1 **不是** Bridge/Sisyphus 全量功能对等；营销与 README 不得声称“已吸收全部功能”
