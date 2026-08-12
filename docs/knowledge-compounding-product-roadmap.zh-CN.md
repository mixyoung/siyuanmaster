# SiYuanMaster 知识复利产品路线与能力差距基线

> 状态：持续实现中；M1 确定性注册表、模板与单来源 Ingest 预演已进入 0.6.0 源码，尚未实机安装验收
> 基线日期：2026-08-12
> 当前开发版本：SiYuanMaster 0.6.0；已实机验证基线仍为 0.5.2
> 适用范围：思源笔记 + 外部 LLM Agent + SiYuanMaster 受控工具

## 1. 结论

思源笔记能够承载 Karpathy LLM Wiki 的核心模式。SiYuanMaster 0.6.0 源码已经补上 Source Manifest、Authority Registry、确定性状态统计、低上下文候选查找、版本化模板目录、预览渲染和结构校验，以及只读单来源 Ingest 状态机，但仍没有达到成熟 Obsidian/VS Code 实现的“一键知识复利产品体验”。

现在已经成立的是**安全受控的 Agent 读写底座与可执行 Skill 工作流**；仍需建设的是**确定性知识编译引擎和产品交互层**。正确路线不是把分类语义全部写死进插件，也不是让 LLM 在后台随意改库，而是：

```text
分类 Skill：决定知识应放哪里、是否值得生成、采用哪种 Wiki 页面类型
SiYuanMaster Skill：规定低上下文发现、Ingest / Query / Lint / Promote 工作流
插件：提供权限、清单、哈希、索引、任务、预览、事务、审计和确定性统计
LLM：在上述约束内完成语义提取、综合、比较、矛盾判断和内容草拟
```

持续更新插件可达到目标，但必须按“确定性基础 → 证据和健康 → 安全批处理 → 大规模检索”的顺序演进。

## 2. 比较基准

### 2.1 方法来源

- [Karpathy《LLM Wiki》原始提案](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)：Raw、Wiki、Schema 三层，以及 Ingest、Query、Lint 等持续编译思想。
- [Microsoft LLM Wiki](https://github.com/microsoft/llmwiki)：VS Code 扩展与 MCP 实现，包含初始化、批量摄取、查询、状态、刷新、Raw 扫描、索引和健康能力。
- [green-dalii/obsidian-llm-wiki](https://github.com/green-dalii/obsidian-llm-wiki)：Obsidian 原生插件实现，包含一键摄取、文件夹批量、队列取消、实体/概念生成、重复检测、矛盾状态、Lint 和图检索。
- [hsuanguo/llm-wiki](https://github.com/hsuanguo/llm-wiki)：Skill + CLI 实现，提供操作 playbook、页面模板、Raw 漂移检测和级联更新工作流。

这些项目是能力基准，不是要逐行复制的依赖。尤其不能照搬“LLM 全权维护 Wiki”的写入姿势，因为 SiYuanMaster 的定位包含笔记本权限、状态复核、确认和审计。

### 2.2 当前 SiYuanMaster 基线

当前已经实现并通过仓库门禁的核心能力：

- 笔记本访问名单和操作级策略；
- 有界文档树、权限范围内的 `search_notes`、完整与分段读取；
- 精确 ID 写入、块编辑、写前快照、状态复核、单次执行和回读；
- 两阶段重命名与移动预演；
- 标签策略和无正文审计；
- Skill 中已经固定 Raw → 已有 Wiki 发现 → 更新/创建 → 回读验证流程；
- Skill 中已经固定 topic、concept、entity、comparison、insight、source_summary 六类模板。
- 0.6.0 源码已经实现插件私有的 Source Manifest 与 Authority Registry，不存笔记正文；
- `register_knowledge_source`、`register_wiki_authority`、`knowledge_status`、`find_wiki_candidates` 已有能力目录、类型检查和自动化测试；真实思源安装/重载后的工具发现与写入烟测仍待独立验收。
- `list_wiki_templates`、`render_wiki_template`、`validate_wiki_template` 已实现六类中英模板、版本化目录、只读草稿渲染和结构/元数据校验；它们不创建或修改思源笔记。
- `plan_source_ingest` 已把重复来源、失败复核、已摄取、更新既有页、候选选择、搜索回退、创建门槛、新建页和保留 Raw 表达为只读状态与有序操作计划；同时返回受影响既有 Wiki、是否拟建新页、是否需登记 Raw、计划写操作数等结构化影响摘要。它不读取正文、不执行写入，也不替分类 Skill 做语义决定。

必须诚实区分：模板现在已有插件确定性基础，但语义填充和真实写入仍由 Agent 按 Skill 与独立授权完成；它还不是单来源一键 Ingest、任务队列或健康面板。

## 3. SiYuan + LLM 相对成熟 Obsidian/VS Code + LLM 的差距

| 能力 | 成熟实现的体验 | SiYuanMaster 0.6.0 开发现状 | 差距性质 | 目标 |
|---|---|---|---|---|
| 安装后初始化 | 一条命令或一个按钮创建 Raw/Wiki/Schema、索引和日志 | 使用既有思源分类与 Skill，不创建固定三目录 | 有意不同 | 提供“启用知识复利”的向导，只登记逻辑层和规则，不强迫全库改结构 |
| Raw 自动发现 | 文件监听、`scanRaw`、未摄取提示 | 无 Raw 清单和 watcher | 产品缺口 | 只检测并生成候选，默认不自动语义写入 |
| 来源去重 | 文件哈希、路径和摄取状态 | Source Manifest 已实现 source ID、文档 ID、SHA-256、URL、状态和 operation ID 去重；未含附件自动哈希/Raw 扫描 | 部分完成 | 增加来源 adapter、自动哈希和扫描候选 |
| 已有 Wiki 发现 | 页面索引、别名、分层重复检测 | Authority Registry + `find_wiki_candidates` 已实现；空结果回退 `search_notes` + 有界树 | 确定性基础已完成 | 补证据索引与治理预览 |
| Wiki 模板 | 插件或 Skill 确定性生成实体、概念、摘要等页面 | 六类中英模板目录、版本、preview renderer 和结构 validator 已实现；无自动语义填充/写入 | 确定性基础已完成 | 接入单来源 Ingest plan 和写前影响预览 |
| 单条摄取 | 一键选择来源后自动生成和更新页面 | `plan_source_ingest` 已生成来源登记、候选/回退、更新/新建、回读和登记顺序；语义填充与执行仍由 Agent 逐项完成 | 预演基础完成 | 增加可恢复执行会话、逐项状态复核和最终回读报告 |
| 批量摄取 | 文件夹、多选、实时队列、跳过与取消 | 无知识摄取队列 | 产品缺口 | 先做可恢复任务与逐项提交，再开放批量 |
| 实体/概念页 | 自动抽取、去重、合并 | LLM 可按 Skill 提案，无阈值和 registry | 确定性缺口 | 以复用价值、证据覆盖和独立维护门槛控制生成，避免页面爆炸 |
| 主题索引 | 自动更新实体、概念、来源、反向链接视图 | 依赖思源文档树、反链和人工页面 | 统计缺口 | 由 registry 和证据索引生成只读视图，不维护重复数字 |
| 覆盖率与状态 | 来源数、页面数、覆盖率、上次摄取/体检时间 | `knowledge_status` 已按访问范围计算来源状态、权威页类型、链接覆盖率与最近更新时间 | 基础完成 | M2 增加主张覆盖率、过时、争议和健康面板 |
| 来源—主张—页面 | 来源与生成页面可双向追踪 | 主要依赖正文链接和人工来源段 | 数据模型缺口 | 稳定 source/claim/block/page ID 与 evidence state 双向索引 |
| 矛盾管理 | 检测、标记、保护人工复核页、状态迁移 | Skill 要求保留矛盾，但无状态机 | 产品缺口 | `detected → triaged → supported_both/resolved/superseded` |
| Lint | 重复、断链、空页、孤立页、矛盾和一键修复 | Skill 定义只读 Lint，无专用工具和面板 | 产品缺口 | 先做确定性只读检查，语义问题只提案；修复另行授权 |
| 级联更新 | 摄取时扫描受影响页面并更新索引/交叉链接 | Agent 可逐页处理，无统一影响图 | 安全缺口 | 先展示受影响页面、顺序、补丁和预期状态 |
| 批量事务 | 多文档写入、失败恢复和操作历史 | `update_note`/`edit_block` 是单目标安全事务 | 安全缺口 | 幂等操作 ID、逐文档状态、检查点、补偿回滚、部分失败报告 |
| 后台任务 | 进度、取消、恢复、失败重试 | 无 Ingest/Lint job | 产品缺口 | 持久队列、checkpoint、cancel/resume；恢复前重新检查状态 |
| 查询 | 原生聊天面板、带 Wiki 链接回答 | `find_wiki_candidates` 提供紧凑候选；正文读取与回答仍由外部 Agent 完成 | 交互缺口 | 增加查询入口、证据索引与一键 Promote preview |
| 查询回写 | `/save` 或一键保存高价值答案 | Agent 按 Promote 门禁写回 | 交互缺口 | 生成目标、引用、补丁和影响预览，确认后写入 |
| 检索排序 | 加权全文、图检索或混合检索 | SQL `LIKE`，按更新时间返回后按文档去重 | 规模缺口 | 先加权词法，再评估图/向量混合；权限过滤先于内容返回 |
| PDF/网页来源 | 原生或外接 PDF 摄取、缓存和 OCR 路线 | 已能受控归档网页和附件，但非知识摄取产品管线 | 产品缺口 | 来源 adapter 与哈希清单统一，OCR 结果与原件分离 |
| 权限和安全写入 | 多数方案默认以整个 vault 为信任边界 | 已有笔记本策略、确认、状态复核、回读和审计 | SiYuanMaster 优势 | 保持为所有知识复利能力的强制底座 |
| 块级知识与引用 | Markdown 文件链接为主 | 思源原生块、块引用、反链和文档树 | 思源潜在优势 | 证据索引落到块级，避免只能追踪整篇文件 |

## 4. Token 与检索策略

检查已有 Wiki 不采用“官方搜索或全库遍历”二选一，而采用分级混合策略：

1. Raw 清单、`authority_document` 或精确路径已知时直接定位；
2. 未知时在目标笔记本调用 `search_notes`，优先规范标题、别名、DOI/URL 和少数区别性概念，每次约 5—10 个结果；
3. 搜索歧义时只遍历相关 `parentDocumentId` 分支，通常深度 2—3；
4. 只分段读取约 3—5 个高可能候选；
5. 找到唯一权威页就更新，出现竞争权威页则停止并生成治理提案。

当前 `search_notes` 在思源内核侧搜索允许笔记本、按文档去重，并把每条片段限制为最多 360 字符。内核扫描本身不等量占用模型上下文；真正昂贵的是返回宽树、大量候选和完整正文。

0.6.0 起优先调用 `find_wiki_candidates`：已知 `sourceId` 时直接做来源到权威页定位，未知时用标题/别名候选；无结果再回退 `search_notes`。这把大多数已登记任务推进到“直接定位”，不需要首先增加向量数据库。

## 5. 产品架构目标

```text
Raw 来源/附件
  │  扫描、哈希、登记
  ▼
Source Manifest ──→ Authority Registry
  │                    │
  │ 来源状态            │ Wiki 候选/别名/页面类型
  └────────┬───────────┘
           ▼
      Ingest Plan
  来源 → 主张/证据 → 页面补丁 → 索引影响
           │
           ▼ 用户与策略门禁
   Safe Batch Execution
           │
           ▼
 Wiki + Evidence Index + Health Views
```

插件只对清单、哈希、索引、状态、计划和执行结果作确定性声明。页面含义、主张抽取、矛盾判定和综合文本属于 LLM 语义输出，必须携带来源和置信/争议状态。

## 6. 分阶段开发计划

### M1：确定性基础与一条来源闭环

目标：让一条 Raw 来源能够低上下文、可重复、可预览地进入既有 Wiki。

范围：

1. 模板 registry、schema version、preview renderer 和结构 validator；
2. Source Manifest：source ID、SHA-256、URL、采集时间、原路径、摄取状态、目标页和 operation ID；
3. Authority Registry：canonical page ID、标题、别名、页面类型、知识角色、source container 和笔记本范围；
4. `scanRaw`/register/status 的只读或登记能力；
5. 紧凑 `find_wiki_candidates`；
6. 单来源 Ingest plan：候选目标、拟新增/修改页面、引用和影响；
7. Query 结果 Promote preview。

当前完成度（0.6.0 源码）：

- 已完成：Source Manifest、Authority Registry、六类版本化 Wiki 模板、只读 preview renderer/validator、单来源 Ingest 状态机，以及 `register_knowledge_source`、`register_wiki_authority`、`knowledge_status`、`find_wiki_candidates`、`list_wiki_templates`、`render_wiki_template`、`validate_wiki_template`、`plan_source_ingest`；
- 已覆盖：串行化并发写、来源 ID/文档/哈希/URL 去重、双向引用、竞争权威页报告、访问范围过滤、确定性排序和空结果回退；
- 尚未完成：`scanRaw`、可恢复的多步 Ingest 执行会话、Promote preview；
- 尚未完成门禁：把 0.6.0 安装到真实思源后做 27 工具发现、模板与 Ingest 预演只读调用、登记/重复/权限拒绝/重载持久化烟测。

验收：

- 同一来源重复摄取不会创建第二份 Raw 或第二个权威页；
- 已有权威页场景通常不需要全树遍历；
- 模板输出在相同 schema version 下结构确定；
- 所有写入仍服从访问策略、标签策略和回读；
- 真实思源上通过新增、重复、已有目标、无目标和状态漂移五类烟测。

### M2：证据索引与知识健康

目标：能解释“这个结论来自哪里、哪些页面受影响、知识库哪里不健康”。

范围：

1. `source → claim/block → Wiki page` 双向证据索引；
2. 来源覆盖率、页面覆盖率、待摄取、过时、争议和未复核统计；
3. 断链、孤立页、空页、重复权威页和缺证据主张的确定性 Lint；
4. 矛盾状态机与人工复核保护；
5. 自动生成主题索引和健康面板；
6. 受门槛约束的实体/概念页提案。

验收：

- 任一生成主张能够反查来源，任一来源能够列出影响页面；
- 健康数字由 manifest/index 计算，模型不参与计数；
- Lint 默认只读；确定性修复与语义修复分开；
- 不可访问笔记本的标题、路径和正文不会通过索引泄露。

### M3：安全批处理与后台任务

目标：支持真正可取消、可恢复、可审计的批量 Ingest/Lint。

范围：

1. 多文档级联更新预览和依赖顺序；
2. 幂等 operation ID、逐目标 expected state、快照和 checkpoint；
3. 部分失败报告和补偿式恢复；
4. 可持久化 job 队列、进度、cancel/resume；
5. opt-in watcher 和批量 Raw 扫描；
6. 操作历史与失败诊断面板。

验收：

- 中途取消后不继续写入，恢复时重新检查全部剩余目标；
- 崩溃后能区分已提交、未执行和结果未知目标；
- 不宣称数据库级原子性，除非思源内核提供并验证了对应事务；
- watcher 默认只创建候选任务，不静默创建 Wiki 或移动来源。

### M4：规模化检索与体验收敛

目标：在大 Wiki 上提供稳定召回、可解释排序和接近一键的查询/维护体验。

范围：

1. 标题、别名、页面类型、标题块、正文、标签、时效和证据质量的加权全文检索；
2. 思源链接图/反链的图扩展与 rerank；
3. 可选本地向量召回，形成词法 + 图 + 向量混合检索；
4. 一键 Ingest、Query、Status、Lint、Promote 入口；
5. 代表性知识库的召回、重复率、Token、延迟和写入质量评测。

验收：

- 权限过滤发生在候选内容进入模型之前；
- 和 M1 的索引搜索基线比较，而不是仅凭主观体验宣称节省 Token；
- 混合检索只有在评测明显优于加权词法 + 图检索时才成为默认；
- GUI 清楚区分“扫描结果、LLM 提案、等待确认、已提交和结果未知”。

## 7. 优先级与不建议事项

最高优先级已经从“单条来源预演”推进到“可恢复的单条来源执行会话”：在不放松逐项权限、确认和回读的前提下记录步骤、状态与失败恢复。随后再做 Promote preview；`scanRaw` 仍只发现候选，不自动触发语义写入。

暂不建议：

- 一开始就接入向量数据库；
- 让 watcher 检测到文件后直接写 Wiki；
- 为每个实体自动生成页面；
- 把 Raw/Wiki/Schema 强制变成所有笔记本的顶层目录；
- 把分类规则硬编码到 TypeScript 插件；
- 在没有跨文档预览和失败恢复前开放大批量自动更新；
- 用“检查通过”掩盖仍未实机验证或仍由 Skill 承担的能力。

## 8. 每个阶段的统一质量门禁

1. 代码级：生成目录新鲜度、类型检查、单元/集成测试和安装包结构通过；
2. 安全级：笔记本策略、确认、状态漂移、结果未知、审计脱敏和标签策略不回归；
3. 实机级：在真实思源版本上完成只读、单写、并发漂移、取消/恢复和失败注入；
4. 知识级：来源追溯、重复权威页率、矛盾保留、模板一致性和无来源主张率；
5. 体验级：完成一条来源所需步骤、首次可用时间、状态可见性和错误恢复说明；
6. 经济级：统计 LLM 调用、输入/输出 Token、延迟和后续复用次数，不预设知识复利一定比 RAG 便宜。

## 9. 当前决策记录

- 三层是逻辑职责，不是强制全库目录。
- Raw 原件不可变；source summary 属于可演进 Wiki，不替代原件。
- 检查已有 Wiki 默认使用精确定位与索引搜索，相关分支遍历只作兜底。
- Query 和 Lint 默认只读；Promote 与修复继续要求当前任务写入意图和策略许可。
- 插件可持续迭代，但优先提供确定性基础，不获得后台自治改库权限。
- SiYuanMaster 不以完全复刻 Obsidian 插件为目标；它应保留思源块级知识、反链、权限和安全写入的差异化优势。
