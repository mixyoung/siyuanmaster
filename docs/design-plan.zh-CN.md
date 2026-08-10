# 思源大师（SiYuanMaster）设计规划

> 状态：持续增量设计  
> 版本：v0.4
> 更新日期：2026-07-31
> 当前验证环境：SiYuan 3.7.1  
> 建议最低版本：SiYuan 3.7.0  

## 1. 产品定位

本项目交付物是一个可安装到思源笔记中的原生插件，现技术名为 `siyuanmaster`（品牌 SiYuanMaster / 思源大师）。

它由两部分组成：

1. 前端插件：提供配置页面、侧边栏、状态和审计界面。
2. 内核插件：执行权限策略、调用思源内核 API，并向思源内置 MCP 服务注册受控工具。

它不是一个独立的 MCP Server，也不再自行启动 Node.js 服务。思源内核启动时已经提供 `/mcp` 服务端入口；本插件是在该入口中追加一组受控的语义工具。

当前独立的 `siyuan-mcp-dev` Node 服务作为历史实现和兼容参考保留，但不再是插件 MVP 的运行依赖，也不把独立安全网关列为当前产品方向。

## 2. 新增需求登记

### R-001 思源原生插件交付

插件必须按思源官方插件格式开发和打包：

```text
package.zip
├── plugin.json
├── index.js
├── index.css
├── kernel.js
├── i18n/
│   ├── zh_CN.json
│   └── en_US.json
├── icon.png
├── preview.png
├── README.md
└── README.zh-CN.md
```

要求：

- `plugin.json` 声明 `minAppVersion`、`kernels`、`backends` 和 `frontends`。
- 使用官方 `siyuan-note/plugin-sample` 的前端与内核双构建方式。
- 构建产物为可被思源插件系统识别的 `package.zip`。
- 支持开发期放入 `{workspace}/data/plugins/<plugin-name>/`。
- 支持后续通过思源集市安装；本地安装流程需要在目标版本上做一次真实验收。
- 不直接读写 `.sy` 文件，所有笔记操作均通过思源内核 API 完成。

### R-002 配置页面与侧边栏

插件需要同时提供：

1. 插件设置页：用于完整配置。
2. 思源侧边栏 Dock：用于查看运行状态和执行高频操作。

侧边栏 MVP 内容：

- 插件状态：运行中、异常、配置未完成。
- MCP 状态：端点地址、注册工具数量。
- 当前权限模式：允许名单或保护名单。
- 有效可访问笔记本数量。
- 当前标签策略摘要。
- 最近访问和拒绝记录。
- “打开完整设置”“复制 Agent 接入配置”“测试权限”按钮。

完整设置页分区：

- 常规
- 访问权限
- 写入与标签
- Agent 接入
- 审计记录
- 高级与诊断

### R-003 追加标签可配置

不再要求任何固定来源标签，`siyuanMCP` 也不是必需标签。用户能够决定是否添加、何时添加以及添加什么标签。

标签策略支持：

1. `off`：从不自动添加。
2. `ask`：每次相关操作后生成标签决策或候选项，等待用户确认。
3. `always`：每次匹配的操作完成后自动应用标签。
4. `once`：仅在文档首次被 AI 处理且尚无插件标签记录时应用。

`once` 模式不依赖固定标签判断。插件在私有存储中维护已处理文档 ID、时间和策略版本，避免为了追踪状态向笔记强行写入标记。

支持按操作类型分别启用：

- 创建文档；
- 追加内容；
- 修改内容；
- 总结文档；
- 记忆沉淀；
- 批量整理。

标签来源支持：

- 用户自定义的固定标签；
- 本次操作临时输入的标签；
- AI 根据文档最终内容总结的候选标签；
- 固定标签与 AI 候选标签组合。

需要写入标签时，插件统一执行标签合并：

1. 读取目标文档现有块属性和标签。
2. 保留全部原标签。
3. 解析全局策略、操作级策略和本次调用选择。
4. 必要时根据文档最终内容生成 AI 标签候选。
5. 根据确认策略决定跳过、提案或应用。
6. 追加本次确定的标签。
7. 去空、去重并保持稳定顺序。
8. 调用 `setBlockAttrs` 写回。
9. 标签失败时将整次操作标记为“部分成功”，写入审计记录。

策略优先级：

```text
本次操作的明确选择
  > 操作类型专属策略
  > 全局标签策略
  > 默认不添加
```

外部 Agent 调用写入工具时，可显式传入：

```json
{
  "tagging": {
    "decision": "use_default",
    "tags": []
  }
}
```

`decision` 可选值：

- `use_default`：遵循插件策略；
- `add`：本次添加；
- `skip`：本次不添加；
- `propose`：只生成候选，不写入。

配置模型：

```json
{
  "tagging": {
    "mode": "ask",
    "operations": {
      "create": true,
      "append": true,
      "update": true,
      "summarize": true,
      "memory": true,
      "batchOrganize": false
    },
    "sources": {
      "fixed": true,
      "manual": true,
      "aiSuggested": true
    },
    "fixedTags": [],
    "ai": {
      "enabled": true,
      "provider": "calling_agent",
      "applyMode": "propose",
      "maxTags": 5,
      "preferExistingTags": true,
      "deduplicateSynonyms": true
    }
  }
}
```

AI 标签总结规则：

- 基于操作完成后的最终文档内容，而不是只看本次新增片段。
- 优先复用工作空间中已有的相同或近义标签。
- 限制最大标签数量、单个标签长度和禁止词。
- 去除空标签、重复标签、过泛标签和无实际检索价值的标签。
- 默认只返回候选和理由，不直接写入。
- 用户可在设置中切换为自动应用。
- 候选标签可逐个勾选、编辑、删除或全部拒绝。
- AI 生成失败不能导致主体笔记操作回滚。

AI 标签可以通过两条路径产生：

1. 外部 Agent 路径：当前调用 MCP 的 Agent 根据文档最终内容生成候选，并把候选提交给插件校验、确认和写入。这是 MVP 主路径，不需要插件再配置一个模型。
2. 思源内置 AI 路径：从插件 GUI 点击“AI 总结标签”时，插件调用思源已经配置的 AI 模型生成候选；未配置模型时提示用户改用外部 Agent。

无论候选来自哪种路径，插件都必须执行长度限制、禁止词、去重、近义词处理和现有标签复用，不能直接信任模型输出。

在 `ask` 模式下：

- 插件 GUI 发起的操作使用确认弹窗。
- 外部 Agent 发起的操作返回待确认的候选标签，并通过单独的 `apply_tags` 工具应用。
- 未获得确认时保持文档原有标签不变。

### R-004 笔记本访问范围 GUI

设置页从 `/api/notebook/lsNotebooks` 获取笔记本列表，以笔记本 ID 作为配置主键、名称作为展示信息。

支持两种互斥模式：

#### 正选：允许名单

- 勾选的笔记本允许访问。
- 未勾选的笔记本全部拒绝。
- 新建笔记本默认拒绝。
- 这是默认和推荐模式。

#### 反选：保护名单

- 勾选的笔记本禁止访问。
- 未勾选的笔记本允许访问。
- 新建笔记本默认允许。
- 适合笔记本很多、只有少量敏感区域的用户。

GUI 要求：

- 模式切换器使用清楚的业务名称：
  - `只允许选中的笔记本`
  - `禁止选中的笔记本`
- 不只显示“正选/反选”，避免理解歧义。
- 支持搜索、全选、清空、仅看已选。
- 显示笔记本名称、ID、开启/关闭状态和加密状态。
- 固定显示“最终可访问范围预览”。
- 模式切换、全选和清空需要二次确认。
- 保存前显示配置变化摘要。
- 保存后立即热生效，不要求重启思源。

配置示例：

```json
{
  "access": {
    "mode": "allowlist",
    "selectedNotebookIds": [
      "20260101000000-abcdefg"
    ],
    "defaultDecision": "deny"
  }
}
```

权限配置保存在插件私有存储：

```text
data/storage/petal/siyuanmaster/policy.json
```

权限配置不保存在普通笔记中，避免被 AI 搜索、修改或删除。

## 3. 插件和 MCP 的关系

### 3.1 插件是否是 MCP 插件

准确说法是：

> 它是一个带有 MCP 工具提供能力的思源原生插件。

它不是 Claude、Codex 或其他 Agent 平台的插件，也不是一个独立 MCP Server。

需要区分思源中的两个方向：

- `设置 → AI → MCP 服务器`：思源作为 MCP 客户端，连接外部 MCP Server，供思源内置 Agent 使用。
- `http://127.0.0.1:6806/mcp`：思源作为 MCP Server，供 Codex、Claude、Cursor 等外部 Agent 连接。

本插件使用第二条链路，把自己的受控工具注册到思源对外提供的 `/mcp` 中。

### 3.2 启动过程

```text
启动思源内核
  ├─ 思源注册原生 POST /mcp
  ├─ 加载插件前端 index.js
  │    ├─ 创建设置页
  │    └─ 创建侧边栏 Dock
  └─ 加载插件内核 kernel.js
       ├─ 读取 policy.json
       ├─ 初始化权限引擎
       └─ 通过 siyuan.mcp.registerTool 注册工具
```

因此：

- 思源运行时，`http://127.0.0.1:6806/mcp` 已由思源内核提供。
- 启用插件后，插件工具被追加到这个 MCP 服务中。
- 禁用或卸载插件后，插件工具被注销。
- 插件不监听新的端口，不启动额外的 Node/Python 常驻进程。

### 3.3 已注册的语义工具

建议只注册以下小而清晰的工具：

| 工具 | 作用 | 默认风险 |
|---|---|---|
| `plugin__siyuanmaster__get_policy` | 返回 AI 可理解的权限和使用规则 | 只读 |
| `plugin__siyuanmaster__list_accessible_notebooks` | 只列出允许范围 | 只读 |
| `plugin__siyuanmaster__list_document_tree` | 在授权范围内有界列出文档层级，不返回正文 | 只读 |
| `plugin__siyuanmaster__search_notes` | 在允许范围内搜索 | 只读 |
| `plugin__siyuanmaster__read_note` | 读取允许的文档 | 只读 |
| `plugin__siyuanmaster__create_note` | 创建文档 | 写入 |
| `plugin__siyuanmaster__append_note` | 追加内容 | 写入 |
| `plugin__siyuanmaster__update_note` | 修改正文 | 需确认 |
| `plugin__siyuanmaster__rename_note` | 两阶段安全重命名 | 预演后确认 |
| `plugin__siyuanmaster__move_note` | 两阶段安全移动整棵文档树 | 预演后确认；跨笔记本默认禁止 |
| `plugin__siyuanmaster__delete_note` | 删除整篇文档 | 默认禁止且始终确认 |
| `plugin__siyuanmaster__suggest_tags` | 根据最终文档内容生成标签候选 | 只读提案 |
| `plugin__siyuanmaster__apply_tags` | 应用用户确认的标签 | 写入 |
| `plugin__siyuanmaster__prepare_summary` | 返回有界正文和总结约束 | 只读 |
| `plugin__siyuanmaster__save_memory` | 创建或追加已批准的记忆 | 写入 |
| `plugin__siyuanmaster__get_audit_log` | 查询插件审计记录 | 只读 |

每个工具处理器必须按以下顺序执行：

```text
参数校验
  → 根据块/文档 ID 反查所属笔记本
  → 权限判定
  → 操作级权限判定
  → 调用思源 API
  → 解析标签策略
  → 可选生成 AI 标签候选
  → 可选合并并写入标签
  → 写入审计
  → 返回最小必要结果
```

重命名和移动必须额外执行：

```text
首次调用
  → 校验源文档与目标笔记本/父文档
  → 检查目标是否为自身或后代
  → 检查同名冲突
  → 统计受影响的文档树规模
  → 生成十分钟有效的一次性预演令牌

执行调用
  → 校验预演令牌与参数完全匹配
  → 重新读取源文档和目标父文档
  → 检查标题、路径、笔记本和更新时间是否漂移
  → 重新检查权限和同名冲突
  → 调用 renameDocByID 或 moveDocsByID
  → 重新读取并验证最终状态
  → 消耗令牌并写入审计
```

## 4. 其他 Agent 如何使用

### 4.1 本机 Agent

支持 Streamable HTTP MCP 的 Agent 添加一个服务器配置：

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

不同 Agent 的配置字段可能不同，插件侧边栏应按客户端提供复制模板：

- Codex
- Claude Desktop / Claude Code
- Cursor
- OpenCode
- 通用 Streamable HTTP

连接后的推荐调用顺序：

1. Agent 连接 `/mcp`。
2. Agent 获取工具列表。
3. 首次调用 `get_policy`。
4. 只使用 `plugin__siyuanmaster__*` 工具。
5. 写入后读取工具返回的标签和审计结果。

### 4.2 多个 Agent

多个本机 Agent 可以同时连接同一个 `/mcp` 地址，共享同一套笔记本权限配置。

MVP 暂不承诺可靠的“每个 Agent 不同权限”，原因是当前思源 API Token 和 MCP 服务端都是管理员级鉴权，无法用同一个 Token 安全地区分客户端身份。

后续版本可增加：

- Agent 配置档案。
- 每个 Agent 独立凭证。
- 每个凭证独立工具白名单和笔记本范围。
- 凭证吊销、过期和调用限额。

这需要思源内核官方支持 scoped token/MCP profile，当前版本不自行开发独立安全网关。

### 4.3 远程 Agent

远程 Agent 无法访问本机的 `127.0.0.1`。

MVP 默认只支持本机访问，不自动开放公网。远程接入必须另行设计：

- 内网/VPN；
- TLS；
- 独立受限凭证；
- IP 和速率限制；
- 不将完整思源 API Token 暴露给云端 Agent。

## 5. 安全边界

当前思源 `/mcp` 是管理员级入口，并且会同时暴露思源原生高权限工具。插件可以新增安全工具，但不能阻止 Agent 绕过插件工具调用原生文件、SQL、笔记本或文档工具。

用户已经明确接受这一当前限制，决定等待思源官方后续改进。该风险必须继续在设置页和文档中透明展示，但不再阻塞插件 MVP，也不再要求本项目自行开发独立安全网关。

### 当前交付边界

- 插件工具内部严格执行笔记本权限。
- Skill 和接入模板要求 Agent 只调用插件工具。
- 尽可能在 Agent 客户端配置工具白名单。
- 有审计、确认和可选标签策略。

适用于可信的本机 Agent，不能承诺对恶意或失控客户端形成强隔离。

### 官方能力跟踪

持续关注思源内核是否增加 scoped token、工具白名单、笔记本范围和凭证吊销能力。官方支持后再纳入插件，不作为当前版本的自研交付项。

## 6. 配置数据模型

```json
{
  "schemaVersion": 1,
  "access": {
    "mode": "allowlist",
    "selectedNotebookIds": [],
    "defaultDecision": "deny"
  },
  "operations": {
    "search": "allow",
    "read": "allow",
    "create": "allow",
    "append": "allow",
    "update": "confirm",
    "delete": "deny",
    "export": "deny"
  },
  "tagging": {
    "mode": "ask",
    "operations": {
      "create": true,
      "append": true,
      "update": true,
      "summarize": true,
      "memory": true,
      "batchOrganize": false
    },
    "sources": {
      "fixed": true,
      "manual": true,
      "aiSuggested": true
    },
    "fixedTags": [],
    "ai": {
      "enabled": true,
      "provider": "calling_agent",
      "applyMode": "propose",
      "maxTags": 5,
      "preferExistingTags": true,
      "deduplicateSynonyms": true
    }
  },
  "audit": {
    "enabled": true,
    "retentionDays": 30,
    "recordReadOperations": true,
    "redactContent": true
  }
}
```

## 7. MVP 交付阶段

### Phase 0：技术探针

- 建立官方插件示例的前端/内核双构建。
- 在 SiYuan 3.7.1 中安装并启用。
- 在侧边栏显示插件状态。
- 内核插件注册一个只读测试工具。
- 使用真实 MCP 客户端连接并调用。

### Phase 1：插件壳和配置

- 完成 `plugin.json`、打包和本地安装。
- 完成设置页和 Dock。
- 完成插件私有存储读写。
- 完成正选/反选笔记本 GUI。
- 完成标签配置。

### Phase 2：受控读写工具

- 权限引擎。
- 搜索、读取、创建、追加工具。
- 标签策略解析、标签提案和标签合并。
- 审计日志。
- 权限绕过测试。

### Phase 3：Agent 接入体验

- Agent 配置模板。
- MCP 连接状态和诊断。
- 工具使用说明。
- 配套 Skill。
- Codex、Claude、Cursor 至少各完成一次真实调用验收。

### Phase 4：记忆沉淀

- 提案与应用分离。
- 重复检测和冲突处理。
- 来源引用。
- 用户确认。
- 可撤销记录。

### Phase 5：官方安全能力跟踪

- 跟踪思源 scoped MCP token。
- 官方支持后适配工具白名单。
- 官方支持后适配 Agent 身份和独立权限配置。
- 不作为当前 MVP 阻塞项。

## 8. MVP 验收标准

- [ ] 能以思源标准 `package.zip` 安装。
- [ ] 启用后侧边栏出现插件入口。
- [ ] 设置页可保存并重新读取配置。
- [ ] 可切换“只允许选中”和“禁止选中”两种模式。
- [ ] 权限变更无需重启思源即可生效。
- [ ] 新建笔记本在允许名单模式下默认不可访问。
- [ ] AI 写入不覆盖原有标签。
- [ ] 不配置标签策略时不自动添加任何标签。
- [ ] 支持不添加、每次询问、每次添加和仅首次添加。
- [ ] 标签内容可以完全自定义。
- [ ] AI 能根据最终文档内容生成候选标签。
- [ ] AI 候选默认不自动写入，除非用户确认或启用自动应用。
- [ ] 标签生成或写入失败不回滚主体笔记操作。
- [ ] 插件不启动额外端口或 Node/Python 常驻进程。
- [ ] 其他本机 Agent 能通过 `/mcp` 发现并调用插件工具。
- [ ] 未授权笔记本不会出现在插件搜索结果、读取结果和错误详情中。
- [ ] 文档树仅列出已授权笔记本中的元数据，支持指定父文档、深度和节点上限，并明确返回截断状态。
- [ ] 重命名必须经过一次性预演令牌，执行前后均验证标题和路径。
- [ ] 移动必须同时校验源、目标笔记本和目标父文档，禁止移入自身或后代。
- [ ] 跨笔记本移动拥有独立权限且默认禁止。
- [ ] 旧组合移动工具及其注册、别名和文档入口已删除。
- [ ] 所有允许、拒绝和失败操作可审计。
- [ ] 文档明确说明当前原生 MCP 管理员权限造成的安全边界。

## 9. 待后续需求确认

- 侧边栏默认放左侧还是右侧。
- 是否允许按文档路径、标签或块属性继续细分权限。
- 是否需要为不同 Agent 提供不同权限档案。
- 是否需要手机端配置，还是首版仅桌面端。
- 是否保留删除能力，或第一版彻底不提供删除工具。

## 10. 变更记录

### v0.1 - 2026-07-29

- 增加思源标准插件包要求。
- 增加配置页面和侧边栏要求。
- 增加必需来源标签与自定义附加标签。
- 增加笔记本正选/反选 GUI。
- 明确插件不是独立 MCP Server。
- 增加其他 Agent 的本机、并发和远程接入规划。

### v0.2 - 2026-07-29

- 记录用户接受思源原生 `/mcp` 管理员级鉴权风险。
- 取消独立安全网关作为当前产品方向。
- 取消 `siyuanMCP` 强制来源标签。
- 增加关闭、询问、每次添加和仅首次添加四种标签策略。
- 增加按操作类型配置标签。
- 增加完全自定义标签和 AI 标签提案。
- 增加 `suggest_tags` 与 `apply_tags` 工具规划。

### v0.3 - 2026-07-29

- 增加 `rename_note` 与 `move_note` 两阶段结构变更协议。
- 增加十分钟有效的一次性预演令牌、执行前漂移检测和操作后验证。
- 增加目标同名冲突、自身/后代目标、源目标双边界校验。
- 增加独立的跨笔记本移动权限并默认禁止。
- 删除旧组合移动工具的文件、注册、别名和文档入口，避免与新安全工具混淆。

### v0.4 - 2026-07-31

- 增加只读 `list_document_tree` 工具，在已授权笔记本内浏览文档层级。
- 支持指定父文档，并以 1–10 层、1–500 个节点的有界参数控制返回范围。
- 树结果只包含文档元数据，不返回正文，并区分深度截断与节点数截断。
