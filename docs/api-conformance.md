# SiYuan API 一致性对照（api-conformance）

本文件记录 SiYuanMaster 实际调用的思源 API 面，与官方文档逐项对照的结果，以及思源版本升级时的回归清单。核对基准：

- 官方文档：[siyuan-note/siyuan `docs/API.md`（master 分支）](https://github.com/siyuan-note/siyuan/blob/master/docs/API.md)，2026-09 核对
- 插件目标版本：思源 **3.8.1**（`MIN_APP_VERSION`；上述端点自 2.x 起稳定，README 记录的实机取证均为 3.8.1）
- 插件内部 API 类型：官方类型包 `siyuan@1.2.4`（`kernel.d.ts` 声明 `IAgent` / `IRpc` / `IStorage` / `IClient`）

## 1. HTTP 端点对照（全部一致）

| 端点 | 代码位置 | 传参 | 官方文档 | 结论 |
|---|---|---|---|---|
| `/api/notebook/lsNotebooks` | `kernel-api.ts listNotebooks` | `{}` | 无参数，返回 `data.notebooks[]` | 一致 |
| `/api/query/sql` | `kernel-api.ts sql` | `{stmt}` | `stmt`；响应含 `data[] + limit + truncated` | 一致（见 §3.2） |
| `/api/file/getFile` | `kernel-api.ts` / `siyuan-api.ts` | `{path}` | `path`（工作区相对路径） | 一致 |
| `/api/filetree/createDocWithMd` | `createDocument` | `notebook, path, markdown` | 同 | 一致（见 §3.1） |
| `/api/filetree/removeDocByID` | `removeDocument` | `{id}` | `id` | 一致 |
| `/api/filetree/renameDocByID` | `renameDocument` | `{id, title}` | `id, title` | 一致 |
| `/api/filetree/moveDocsByID` | `moveDocument` | `{fromIDs, toID}` | `fromIDs, toID`（目标为父文档 ID 或笔记本 ID） | 一致 |
| `/api/block/appendBlock` | `appendMarkdown` | `dataType:"markdown", data, parentID` | 同 | 一致 |
| `/api/block/updateBlock` | `updateBlockMarkdown` | `dataType, data, id` | `dataType, data, id, lockType(可选默认 false)` | 一致（未传 `lockType` 即默认值） |
| `/api/block/getBlockKramdown` | `getBlockKramdown` | `{id}`，读 `data.kramdown` | `id`；返回 `data.id + data.kramdown`；**IAL 属性顺序在内容与属性不变时稳定**（官方原文） | 一致（见 §3.3） |
| `/api/attr/getBlockAttrs` | `tagState` | `{id}` | `id`；返回属性 map | 一致 |
| `/api/attr/setBlockAttrs` | `applyTags` | `{id, attrs}` | `id, attrs`；**自定义属性必须 `custom-` 前缀** | 一致：`tags` 为内建块属性；一次性标记 `custom-siyuanmaster-tagged` 前缀正确 |
| `/api/export/exportMdContent` | `exportMarkdown` | `{id, yfm:false, addTitle:false}` | 文档仅列出 `id`；返回 `data.hPath + data.content` | **基本一致，多传未文档化参数**：`yfm`/`addTitle` 为内核会忽略的多余字段（无害，但属超纲；若官方后续赋予语义需复核） |

## 2. 不在官方 API.md 内、靠其他证据支撑的依赖面

| 依赖面 | 内容 | 证据来源 | 风险 |
|---|---|---|---|
| SQL 表结构（内核内部 schema） | `blocks` 表列（`id, root_id, box, path, hpath, name, alias, memo, tag, content, markdown, type, subtype, sort, created, updated`）；`refs` 表（`def_block_id, block_id`） | API.md 不记载表结构；依据为 README 记录的 3.8.0-alpha.2 / 3.8.1 实机冒烟 | 思源大版本升级可能调整内部库结构，是最先需要回归的部分 |
| `/mcp` 端点 + Agent capability 注册 | `siyuan.agent.registerCapability` / `unregisterCapability`、运行时模型名 `plugin__<id>__<name>__<稳定哈希>` | API.md 未提及；依据为 `scripts/mcp-smoke.mjs` 对内核 `api_agent.go` 哈希算法的源码复现 + 实机取证 + 官方类型包声明 | 3.8.x 新面；跟随内核演进 |
| 插件运行时 JS API | `api.storage.get/put`、`api.rpc.bind/call`、`api.client.fetch`、`api.plugin.lifecycle`、`api.logger` | 官方类型包 `siyuan@1.2.4` 的 `kernel.d.ts` | 低（类型约束） |

## 3. 被产品语义依赖的官方文档要点

1. **`createDocWithMd` 同路径不覆盖**（官方原文 "Repeated calls with the same path won't overwrite existing docs"）：盲目重试 `create_note` 必然产生重复文档。这是写入结果语义三分（`state_changed` / `outcome_unknown` / `verification_failed`）与"标签失败返回部分成功、引导 `apply_tags` 单独补"设计的官方依据。
2. **`/api/query/sql` 的 `limit`/`truncated` 响应字段**：`truncated` 仅在**未显式指定 LIMIT** 时为 true（默认受 `search.limit` 裁剪）；显式 LIMIT 下服务端不感知截断。因此本插件的 LIMIT+1 探测（块 5001、引用 201）是显式 LIMIT 场景下唯一正确的截断检测方式。
3. **`getBlockKramdown` 的 IAL 顺序稳定性**（官方原文 "remains stable while the block content and attributes are unchanged"）：`edit_block` 回读的字节级前缀 + root-IAL 规范化校验依赖此保证。
4. **`setBlockAttrs` 的 `custom-` 前缀规则**：内建属性（`name/alias/memo/tags/bookmark` 等）可直接写；其余必须前缀。当前仅写 `tags` 与 `custom-siyuanmaster-tagged`。

## 4. 查询上限清单（全部有显式截断标志或分块，不存在静默截断）

| 查询 | 上限 | 截断表达 |
|---|---|---|
| `read_note_segments` 单文档块抓取 | 5000（`MAX_DOCUMENT_BLOCK_FETCH`，SQL LIMIT 5001 探测） | 响应 `dbTruncated: true`；`totalBlocks` 为已抓取数 |
| `edit_block` 引用来源抓取 | 200（`MAX_REFERENCING_FETCH`，SQL LIMIT 201 探测） | 响应 `referencingTruncated: true`；`referencingCount` 为下界；deny 提示为 "more than N" |
| `listExactDocumentsByIds` ID 分块 | 每批 200 | 分块循环，无截断 |

## 5. 思源版本升级回归清单

升级 `MIN_APP_VERSION` 或跟进新内核时，按序执行：

1. 重读官方 `docs/API.md`，对照 §1 表逐端点复核参数与响应字段（重点：`exportMdContent` 的多余参数是否被赋予语义；`updateBlock` 的 `lockType` 默认值是否变化）。
2. 在真实实例上重跑 `pnpm smoke:mcp`（28 项目录校验 + 两个只读工具）与 `pnpm smoke:mcp:write`（可弃笔记本）。
3. 验证 §2 未文档化面：`blocks`/`refs` 表结构（`SELECT` 探测列名）、Agent capability 模型名哈希（`tools/list` 实测与 `buildAgentCapabilityToolName` 比对）、`/mcp` 协议协商。
4. 验证 §3.3 的 IAL 顺序稳定性仍成立（`edit_block` 回读校验的前提）。
5. 更新本文件 §1 的核对日期与结论；发现不一致时先修代码再更新文档，不得只改文档。

## 修订记录

- 2026-09-29：首次建立。13 个 HTTP 端点全部核对一致；`exportMdContent` 存在两个未文档化多余参数（无害）；识别两个未文档化依赖面（SQL 内部表结构、`/mcp`+Agent API）。同日按 §4 补齐引用查询（200 上限）的截断标志。
