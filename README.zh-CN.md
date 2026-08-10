# 思源大师（SiYuanMaster）

面向可信本机 Agent 的思源原生插件。

- **品牌 slug**：`siyuanmaster`
- **技术插件 ID（过渡期）**：`siyuan-agent-access`
- **版本**：`0.4.0`

## 已实现

- 侧边栏展示连接状态、安全策略与 P1 能力；
- 正文/表单/按钮字号跟随思源编辑器字体大小；
- GUI 配置笔记本允许/禁止名单、操作权限、标签策略、安全写入策略；
- 向思源内置 `/mcp` 注册 **19** 个受控工具（原 16 + `resolve_document` / `read_note_segments` / `edit_block`）；
- 工具完全限定名保持 `plugin__siyuan_agent_access__*`，保证已有 Agent 配置与原 16 个工具名不断；
- `update_note` / `edit_block` 走 Safe Write Transaction（写前快照、状态复核、只执行一次、回读验证、无正文审计）；
- 内核强制笔记本边界与文档树权限继承；
- 不启动额外 Node/Python 常驻服务。

## 命名与兼容

| 维度 | 值 | 说明 |
|---|---|---|
| 展示名 | 思源大师 / SiYuanMaster | 用户可见品牌 |
| package 名 | `siyuanmaster` | 品牌包名 |
| `plugin.json` name | `siyuan-agent-access` | 保留安装目录、petal 存储与 MCP 命名空间 |
| Dock 键 | `siyuan-agent-access-dock` | 避免布局重置 |
| 仅首次打标属性 | `custom-agent-access-tagged` | 避免升级后重复打标 |

**单插件无法注册双原生命名空间**（思源内核由 `plugin.json` name 推导命名空间）。未来若切换技术 ID 到 `siyuanmaster`，需要双插件或迁移桥；本版本**不**在启动时自动迁移存储，也**不**删除旧存储。

安装目录仍为：

```text
<工作空间>/data/plugins/siyuan-agent-access
```

启用后打开右侧边栏「思源大师」。初始策略为「只允许选中」，且未选中任何笔记本，因此默认不可访问。

## Agent 接入

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

先调用：

1. `plugin__siyuan_agent_access__get_policy`
2. `plugin__siyuan_agent_access__list_accessible_notebooks`
3. 需要层级时用 `list_document_tree`；路径查找用 `resolve_document`（只读）；长文用 `read_note_segments`；块编辑用 `edit_block`。

需确认的操作必须先获用户同意，再带 `confirmed=true` 重试。

## 安全边界

原生 `/mcp` 仍是管理员级入口。本插件只约束自己注册的工具，无法阻止持有完整 API Token 的客户端调用原生高权限工具。

可选 Rust 组件：`siyuanmaster-core`、`siyuanmasterd`（本机网关）、`siyuanmaster`（CLI）。网关到思源内核的出站代理**尚未**在本轮做思源实机验证。

## 构建

```bash
pnpm build
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
```

`pnpm build` 会执行能力目录生成与新鲜度校验；生成物与 `catalog/capabilities.json` 不一致时构建失败。
