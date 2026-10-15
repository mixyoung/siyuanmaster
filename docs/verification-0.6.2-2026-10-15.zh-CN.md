# 0.6.2 实机验收记录（2026-10-15）

- 验收对象：PR #6（`fix/policy-storage-single-writer`），提交 `c0b0f6232a5683a3222f9f628e77045c1935f4b9` + 发版提交（版本字段 0.6.1 → 0.6.2，无代码改动）
- 构建产物：全部用例先在 `c0b0f62` 构建（plugin.json 版本字段 0.6.1）上执行，产物 SHA-256 `d142dd0e2b84a3700170619996b5a5cff2dd9c09dd7b6fd3a5f64546930e1b45`；发版提交将版本字段统一提升 0.6.2 后重建，最终发版产物 SHA-256 `31d2b40798d645c79daab48ae6f6691503b478d7062284f6788bd5e8be17225d`，并已换装实机复验（见下表末行），两者除版本字段外内容一致
- 环境：Windows 10，SiYuan 3.8.6（127.0.0.1:6806，回环），工作区 `E:\01_personal_vault\personal_database\SiYuanDB\Digital_Brian`
- 升级场景：已装 0.6.1 正式版（不含本 PR 修复）→ `dev-local.ps1` 部署（构建 → 暂存 → 工作区匹配校验 → 备份换装 → 重载），旧安装备份于 `data/plugins/.siyuanmaster-dev-backups/`
- 写入范围：仅一次性笔记本「SiYuanMaster验收0.6.2」（`20261015143143-n7xf5b6`）；读取仅取证元数据，正文未留存；令牌仅存于仓库外本地文件，未出现在任何输出

## 验收项与证据

| 项 | 结果 | 证据 |
|---|---|---|
| 部署 + 读冒烟 | 通过 | MCP initialize/tools/list 正常；28 项能力与目录精确匹配，旧命名空间 0 |
| 升级保留有效策略（C 核心） | 通过 | `policy.json` 升级前后字节级不变（SHA-256 `ae9e0e11…d714c`）；`audit.json` 302,058 字节、2000 条完整；`knowledge-registry.json` 8,566 字节原样；迁移 marker 由「未封存」自动补封存（`policyInitialized: null → true`，真实命中修复路径） |
| 审计追加与上限 | 通过 | 新调用产生 `list_accessible_notebooks allowed` 条目、2000 上限裁最旧；观察项：部署瞬间冒烟两次调用未入审计，属 reload 时序窗口，其后全部正常 |
| 受控写冒烟 | 通过 | 12 步全 PASS：create_note → read_note → resolve_document → read_note_segments → edit_block(validateOnly) → edit_block（执行）→ update_note（Safe Write Transaction）→ delete_note |
| 非空引用保护（D） | 通过 | 被引用文档两阶段改名：无 previewToken 调用仅返回预演（`mode=preview`、`previewToken`、未执行）；凭 token 二次调用 `mode=executed`；审计记录 `rename_preview` ×2 + `rename` 各一条 |
| 长文档（E） | 通过 | 11,642 块文档：`dbTruncated=true`、`totalBlocks=5000`（抓取上限）如实上报；23,360,396 字符文档：`truncated=true`（50k 上限）如实上报，均不误报完整 |
| GUI 策略保存（A） | 通过 | 用户在设置面板将 move 改为「需确认」并保存；存储侧验证 `operations.move=confirm` 落盘（经内核单写者写-回读-确认路径，文件哈希按预期变化），marker 保持封存，内核 `get_policy` 实时返回新值 |
| 跨窗口同步（B） | 平台限制 + 等价通过 | 思源浮动窗口（文档新窗口打开）不加载插件 Dock，插件前端仅运行于主窗口，本机不存在第二个可见插件前端。等价路径实测：保存后经 `setPetalEnabled` 禁用/启用触发前端重载（bootstrap 追赶路径，即 `c0b0f62` 修复目标），重载后实机 `get_policy` 返回 `operations.move=confirm`，`policy.json`/审计/marker 全部完好。真实多窗口广播语义由单元级双窗口仿真覆盖（`tests/policy-recovery.test.ts` 双窗口通知与追赶各用例） |
| 发版产物换装复验 | 通过 | 版本字段提升 0.6.2 后重建（`31d2b407…`）换装实机：能力目录 28 精确匹配、读冒烟 PASS；`get_policy` 返回 `product.version=0.6.2`、`operations.move=confirm`；`policy.json` 哈希 `7e7b0d27…` 换装前后不变（部署不触碰策略）；审计 2000 条、迁移 marker 保持封存、`knowledge-registry.json` 8,566 字节 |

## 结论

0.6.2 范围内全部验收项通过或按平台限制以等价路径通过；无数据损失，无策略重置，旧版安装完整备份可回退。

遗留观察（不阻塞发版）：

1. 部署瞬间的 reload 时序窗口内审计可能漏记紧跟的首次调用（后续正常，计数器与文件一致）；
2. 浮动窗口无插件 Dock 属思源平台行为，跨窗口同步对最终用户当前实际等价于「重载/重启后策略保持最新」。

## 0.7.0 待验收（另行记录）

目录分页与成员指纹、正文 offset+哈希分页、`open_scope_read`/`scope_read_status` 覆盖账本、检索按文档聚合去重与游标绑定（PR #7）。
