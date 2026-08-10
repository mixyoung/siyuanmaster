# 思源大师（SiYuanMaster）

思源大师：让人工智能助手安全、可控地读写和管理思源笔记。

| | |
|---|---|
| **品牌** | 思源大师 / SiYuanMaster |
| **包名** | `siyuanmaster` |
| **版本** | `0.5.0` |
| **技术插件 ID** | `siyuanmaster` |
| **MCP 命名空间** | `plugin__siyuanmaster__*` |
| **仓库** | https://github.com/mixyoung/siyuanmaster |

**Breaking change（0.5.0）：** 技术插件 ID 已切换为 `siyuanmaster`。安装目录为 `data/plugins/siyuanmaster`；MCP 工具全名为 `plugin__siyuanmaster__*`。旧的 `plugin__siyuan_agent_access__*` 名称失效，外部 Agent/Skill 配置必须更新。首次加载时，若新路径无策略/审计，会**自动复制**旧 petal（`data/storage/petal/siyuan-agent-access/`）到 `data/storage/petal/siyuanmaster/`（新值始终优先、失败关闭）；**旧目录保留不删**。外部 Agent/Skill 的 MCP 命名空间仍须**手工**改为 `plugin__siyuanmaster__*`。

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
- 在 `/mcp` 上注册 **19** 个工具（原 16 + 3 个 P1）；全名为 `plugin__siyuanmaster__*`
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

最低思源版本：`3.7.0`（见 `plugin.json`）。

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

1. `plugin__siyuanmaster__get_policy`
2. `plugin__siyuanmaster__list_accessible_notebooks`
3. 再用 `list_document_tree` 浏览层级，用 `resolve_document` 做路径查找，用 `read_note_segments` 读长文，用 `edit_block` 做块编辑。

当策略要求确认时，须先获得用户同意，再带 `confirmed=true` 重试。未获真实确认时不得设置 `confirmed=true`。

## 工具（19 = 原 16 + 3 个 P1）

全部注册为 `plugin__siyuanmaster__<name>`。

**原 16 个**（名称不变）：

`get_policy`、`list_accessible_notebooks`、`list_document_tree`、`search_notes`、`read_note`、`create_note`、`append_note`、`update_note`、`rename_note`、`move_note`、`delete_note`、`suggest_tags`、`apply_tags`、`prepare_summary`、`save_memory`、`get_audit_log`

**P1 新增：**

| 工具 | 作用 |
|---|---|
| `resolve_document` | 按笔记本 + 人类路径（`hPath`）只读查找；写入仍要求精确 ID |
| `read_note_segments` | 大纲 + 硬上限全块窗口，适合长文 |
| `edit_block` | 精确块 ID、期望内容/哈希、引用影响、Safe Write Transaction |

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

## 当前限制

- **权限模型：** 实际行为是笔记本决策继承到全部子孙。文档级读/写/隐藏覆盖**尚未**接入插件。
- **写入确认重试：** `update_note` / `edit_block` 在确认后重试会创建**新的**事务与快照。无跨调用持久 preview token，也无用户可见的全量 diff。
- **网关 / 端到端：** 网关向思源内核的出站代理，以及完整思源实机端到端行为，在本版本**未**做生产级验证。
- **范围：** 不宣称覆盖思源全部能力（无属性视图数据库工具、闪卡、完整时间线、Docker/远程部署、多块/表格编辑、资源上传等 backlog 项）。

## 开发与构建

```bash
pnpm build          # 生成目录、新鲜度检查、类型检查、vitest、打包
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

- Node `>= 24`（见 `package.json` engines）
- 能力目录源：`catalog/capabilities.json` → `src/generated/capabilities.ts`
- 插件包输出：`dist/` 与 `package.zip`

```text
安装目录：
<工作空间>/data/plugins/siyuanmaster
```
