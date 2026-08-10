import { Dialog, Plugin, Setting, showMessage } from "siyuan";
import {
  clonePolicy,
  countAccessibleNotebooks,
  DEFAULT_POLICY,
  isNotebookAllowed,
  normalizePolicy,
  POLICY_STORAGE_KEY,
} from "./config";
import { listNotebooks } from "./siyuan-api";
import type {
  NotebookSummary,
  PluginPolicy,
  TaggingMode,
} from "./types";
import "./index.css";

// Dock type key intentionally retained across brand rename so user layouts
// do not reset when upgrading from Agent Access to SiYuanMaster.
const DOCK_TYPE = "siyuan-agent-access-dock";
const PRODUCT_DISPLAY_NAME = "思源大师";
const PRODUCT_BRAND = "SiYuanMaster";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\n]/)
        .map((tag) => tag.trim().replace(/^#+/, ""))
        .filter(Boolean),
    ),
  ];
}

function modeLabel(policy: PluginPolicy): string {
  return policy.access.mode === "allowlist"
    ? "只允许选中的笔记本"
    : "禁止选中的笔记本";
}

function taggingModeLabel(mode: TaggingMode): string {
  const labels: Record<TaggingMode, string> = {
    off: "不添加",
    ask: "每次询问",
    always: "每次添加",
    once: "仅首次",
  };
  return labels[mode];
}

export default class AgentAccessPlugin extends Plugin {
  private policy = clonePolicy(DEFAULT_POLICY);
  private notebooks: NotebookSummary[] = [];
  private dockElement?: HTMLElement;
  private dockEventsBound = false;
  private bootstrapped = false;

  onload(): void {
    this.registerDock();
    this.registerSettings();
    void this.bootstrap();
  }

  async onDataChanged(): Promise<void> {
    if (!this.bootstrapped) {
      return;
    }
    await this.loadPolicy();
    await this.notifyKernelPolicyChanged();
    this.renderDock();
  }

  private async bootstrap(): Promise<void> {
    try {
      await Promise.all([this.loadPolicy(), this.refreshNotebooks()]);
      await this.notifyKernelPolicyChanged();
      this.bootstrapped = true;
      this.renderDock();
    } catch (error) {
      console.error(`[${this.name}] bootstrap failed`, error);
      showMessage(
        `${PRODUCT_DISPLAY_NAME}初始化失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.renderDock(error);
    }
  }

  private registerDock(): void {
    const plugin = this;
    this.addDock({
      config: {
        position: "RightBottom",
        size: { width: 360, height: 0 },
        icon: "iconLock",
        title: PRODUCT_DISPLAY_NAME,
      },
      data: {},
      type: DOCK_TYPE,
      init() {
        plugin.dockElement = this.element as HTMLElement;
        plugin.renderDock();
        plugin.bindDockEvents();
      },
      update: () => {
        this.renderDock();
      },
      destroy: () => {
        this.dockElement = undefined;
        this.dockEventsBound = false;
      },
    });
  }

  private registerSettings(): void {
    const openButton = document.createElement("button");
    openButton.className =
      "b3-button b3-button--outline fn__flex-center fn__size200";
    openButton.textContent = "打开配置";
    openButton.addEventListener("click", () => {
      void this.openSettingsDialog();
    });

    this.setting = new Setting({
      confirmCallback: () => {
        void this.openSettingsDialog();
      },
    });
    this.setting.addItem({
      title: PRODUCT_DISPLAY_NAME,
      description: "配置访问边界、安全写入策略、操作权限和标签策略",
      actionElement: openButton,
    });
  }

  private bindDockEvents(): void {
    if (!this.dockElement || this.dockEventsBound) {
      return;
    }
    this.dockEventsBound = true;
    this.dockElement.addEventListener("click", (event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-saa-action]",
      );
      const action = target?.dataset.saaAction;
      if (action === "settings") {
        void this.openSettingsDialog();
      } else if (action === "refresh") {
        void this.refreshAll();
      } else if (action === "copy-config") {
        void this.copyConnectionConfig();
      }
    });
  }

  private renderDock(error?: unknown): void {
    if (!this.dockElement) {
      return;
    }
    const accessible = countAccessibleNotebooks(
      this.notebooks,
      this.policy,
    );
    const selected = this.policy.access.selectedNotebookIds.length;
    const status = error
      ? "异常"
      : this.bootstrapped
        ? "策略已就绪"
        : "正在同步";
    const statusTone = error
      ? "danger"
      : this.bootstrapped
        ? "ready"
        : "pending";

    const safety = this.policy.safety;
    this.dockElement.innerHTML = `
      <div class="saa-dock">
        <header class="saa-dock__masthead">
          <div>
            <p class="saa-kicker">SIYUANMASTER / ACCESS BOUNDARY</p>
            <h2>${PRODUCT_DISPLAY_NAME}</h2>
          </div>
          <span class="saa-status saa-status--${statusTone}">
            <i></i>${status}
          </span>
        </header>

        <section class="saa-scope-card">
          <div class="saa-scope-card__line">
            <span>当前范围</span>
            <strong>${escapeHtml(modeLabel(this.policy))}</strong>
          </div>
          <div class="saa-metric-row">
            <div class="saa-metric">
              <strong>${accessible}</strong>
              <span>可访问</span>
            </div>
            <div class="saa-metric">
              <strong>${this.notebooks.length}</strong>
              <span>全部笔记本</span>
            </div>
            <div class="saa-metric">
              <strong>${selected}</strong>
              <span>已勾选</span>
            </div>
          </div>
        </section>

        <section class="saa-ledger">
          <div class="saa-ledger__row">
            <span>标签策略</span>
            <strong>${taggingModeLabel(this.policy.tagging.mode)}</strong>
          </div>
          <div class="saa-ledger__row">
            <span>AI 标签</span>
            <strong>${
              this.policy.tagging.ai.enabled ? "候选已启用" : "未启用"
            }</strong>
          </div>
          <div class="saa-ledger__row">
            <span>结构变更</span>
            <strong>先预演 · 再执行</strong>
          </div>
          <div class="saa-ledger__row">
            <span>MCP 命名空间</span>
            <code>plugin__siyuan_agent_access__*</code>
          </div>
          <div class="saa-ledger__row">
            <span>MCP 入口</span>
            <code>127.0.0.1:6806/mcp</code>
          </div>
        </section>

        <section class="saa-ledger">
          <div class="saa-ledger__row">
            <span>写前快照</span>
            <strong>已启用（强制）</strong>
          </div>
          <div class="saa-ledger__row">
            <span>引用保护</span>
            <strong>${
              safety.referenceProtection === "deny" ? "拒绝破坏引用" : "警告后可写"
            }</strong>
          </div>
          <div class="saa-ledger__row">
            <span>权限继承</span>
            <strong>文档树继承笔记本（强制）</strong>
          </div>
          <div class="saa-ledger__row">
            <span>长文窗口</span>
            <strong>≤${safety.longDocument.maxBlocksPerWindow} 块</strong>
          </div>
          <div class="saa-ledger__row">
            <span>块编辑确认</span>
            <strong>${safety.blockEdit.defaultConfirm ? "默认需确认" : "跟随策略"}</strong>
          </div>
        </section>

        <section class="saa-ledger">
          <div class="saa-ledger__row">
            <span>P1 能力</span>
            <strong>19 工具 · Safe Write</strong>
          </div>
          <div class="saa-ledger__row">
            <span>路径查找</span>
            <strong>resolve_document 只读</strong>
          </div>
          <div class="saa-ledger__row">
            <span>分段读取</span>
            <strong>read_note_segments</strong>
          </div>
          <div class="saa-ledger__row">
            <span>安全块编辑</span>
            <strong>edit_block</strong>
          </div>
          <div class="saa-ledger__row">
            <span>技术 ID</span>
            <code>siyuan-agent-access</code>
          </div>
        </section>

        <aside class="saa-risk-note">
          <span>已知边界</span>
          <p>原生 MCP 使用管理员级鉴权；${PRODUCT_BRAND} 只约束本插件注册的工具，面向你已授权的可信本机 Agent。切换技术 ID 需双插件或迁移桥，本版本不自动迁移存储。</p>
        </aside>

        <div class="saa-dock__actions">
          <button class="b3-button b3-button--text" data-saa-action="settings">
            打开完整设置
          </button>
          <button class="b3-button b3-button--outline" data-saa-action="copy-config">
            复制接入配置
          </button>
          <button class="saa-icon-button" data-saa-action="refresh" aria-label="刷新">
            ↻
          </button>
        </div>
      </div>
    `;
  }

  private async refreshAll(): Promise<void> {
    try {
      await Promise.all([this.loadPolicy(), this.refreshNotebooks()]);
      this.renderDock();
      showMessage(`${PRODUCT_DISPLAY_NAME}状态已刷新`, 2500, "info");
    } catch (error) {
      this.renderDock(error);
      showMessage(
        `刷新失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async loadPolicy(): Promise<void> {
    const stored = await this.loadData(POLICY_STORAGE_KEY);
    this.policy = normalizePolicy(stored);
  }

  private async refreshNotebooks(): Promise<void> {
    this.notebooks = await listNotebooks();
  }

  private async persistPolicy(policy: PluginPolicy): Promise<void> {
    this.policy = normalizePolicy(policy);
    await this.saveData(POLICY_STORAGE_KEY, this.policy);
    await this.notifyKernelPolicyChanged();
    this.renderDock();
  }

  private async notifyKernelPolicyChanged(): Promise<void> {
    try {
      await this.kernel.rpc.call.reloadPolicy();
    } catch (error) {
      console.warn(`[${this.name}] kernel policy reload deferred`, error);
    }
  }

  private async copyConnectionConfig(): Promise<void> {
    const config = {
      mcpServers: {
        siyuan: {
          type: "streamable-http",
          url: "http://127.0.0.1:6806/mcp",
          headers: {
            Authorization: "Token ${SIYUAN_API_TOKEN}",
          },
        },
      },
    };
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    showMessage("MCP 接入配置已复制；请自行填入思源 API Token", 3500, "info");
  }

  private async openSettingsDialog(): Promise<void> {
    if (this.notebooks.length === 0) {
      try {
        await this.refreshNotebooks();
      } catch (error) {
        showMessage(
          `无法读取笔记本：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const draft = clonePolicy(this.policy);
    let searchTerm = "";
    let onlySelected = false;

    const dialog = new Dialog({
      title: PRODUCT_DISPLAY_NAME,
      width: "min(1040px, 94vw)",
      height: "82vh",
      content: `
        <div class="saa-settings">
          <header class="saa-settings__hero">
            <div>
              <p class="saa-kicker">SIYUANMASTER / ACCESS BOUNDARY</p>
              <h2>决定 AI 能看见与写入什么</h2>
              <p>配置访问边界、安全写入、操作权限与标签策略。保存后立即生效。</p>
            </div>
            <div class="saa-settings__seal">
              <span>LOCAL</span>
              <strong>TRUSTED</strong>
            </div>
          </header>

          <main class="saa-settings__content">
            <section class="saa-section">
              <div class="saa-section__heading">
                <span>01</span>
                <div>
                  <h3>笔记本访问范围</h3>
                  <p>推荐使用允许名单；新建笔记本默认不可访问。</p>
                </div>
              </div>

              <div class="saa-mode-grid">
                <label class="saa-mode-card">
                  <input type="radio" name="saa-access-mode" value="allowlist"
                    ${draft.access.mode === "allowlist" ? "checked" : ""}>
                  <span class="saa-mode-card__mark">A</span>
                  <strong>只允许选中的笔记本</strong>
                  <small>未勾选内容对插件工具不可见</small>
                </label>
                <label class="saa-mode-card">
                  <input type="radio" name="saa-access-mode" value="denylist"
                    ${draft.access.mode === "denylist" ? "checked" : ""}>
                  <span class="saa-mode-card__mark">B</span>
                  <strong>禁止选中的笔记本</strong>
                  <small>未勾选内容默认可以访问</small>
                </label>
              </div>

              <div class="saa-notebook-toolbar">
                <label class="saa-search">
                  <span>⌕</span>
                  <input type="search" data-saa-field="notebook-search"
                    placeholder="搜索笔记本名称或 ID">
                </label>
                <label class="saa-check">
                  <input type="checkbox" data-saa-field="only-selected">
                  <span>仅看已选</span>
                </label>
                <button class="b3-button b3-button--outline" data-saa-dialog-action="select-visible">
                  选择当前列表
                </button>
                <button class="b3-button b3-button--outline" data-saa-dialog-action="clear-selection">
                  清空
                </button>
              </div>

              <div class="saa-effective" data-saa-effective></div>
              <div class="saa-notebook-list" data-saa-notebook-list></div>
            </section>

            <section class="saa-section">
              <div class="saa-section__heading">
                <span>02</span>
                <div>
                  <h3>Agent 操作权限</h3>
                  <p>“需确认”表示 Agent 必须先得到你的明确同意。重命名和移动还必须先生成一次性预演令牌。</p>
                </div>
              </div>

              <div class="saa-permission-grid">
                ${(
                  [
                    ["search", "搜索", "查找匹配笔记"],
                    ["read", "读取", "读取 Markdown"],
                    ["create", "创建", "新建文档"],
                    ["append", "追加", "追加内容"],
                    ["update", "修改", "替换文档正文"],
                    ["rename", "重命名", "预演后修改文档标题"],
                    ["move", "移动", "预演后移动文档树"],
                    [
                      "moveAcrossNotebooks",
                      "跨笔记本移动",
                      "源和目标都必须在授权范围内",
                    ],
                    ["delete", "删除", "删除整篇文档"],
                    ["export", "导出", "导出或外发"],
                  ] as const
                )
                  .map(
                    ([key, label, description]) => `
                    <label class="saa-permission-row">
                      <span>
                        <strong>${label}</strong>
                        <small>${description}</small>
                      </span>
                      <select class="b3-select" data-saa-operation="${key}">
                        <option value="allow"
                          ${draft.operations[key] === "allow" ? "selected" : ""}>
                          允许
                        </option>
                        <option value="confirm"
                          ${draft.operations[key] === "confirm" ? "selected" : ""}>
                          需确认
                        </option>
                        <option value="deny"
                          ${draft.operations[key] === "deny" ? "selected" : ""}>
                          禁止
                        </option>
                      </select>
                    </label>
                  `,
                  )
                  .join("")}
              </div>
            </section>

            <section class="saa-section">
              <div class="saa-section__heading">
                <span>03</span>
                <div>
                  <h3>标签策略</h3>
                  <p>没有明确选择时不强制添加任何固定标签。</p>
                </div>
              </div>

              <div class="saa-tag-modes">
                ${(
                  [
                    ["off", "不添加", "完全保持原标签"],
                    ["ask", "每次询问", "生成候选后等待确认"],
                    ["always", "每次添加", "按当前规则自动应用"],
                    ["once", "仅首次", "每篇文档只应用一次"],
                  ] as const
                )
                  .map(
                    ([value, title, description]) => `
                    <label>
                      <input type="radio" name="saa-tag-mode" value="${value}"
                        ${draft.tagging.mode === value ? "checked" : ""}>
                      <strong>${title}</strong>
                      <span>${description}</span>
                    </label>
                  `,
                  )
                  .join("")}
              </div>

              <div class="saa-field-grid">
                <label class="saa-field saa-field--wide">
                  <span>固定标签</span>
                  <input class="b3-text-field fn__block" data-saa-field="fixed-tags"
                    value="${escapeHtml(draft.tagging.fixedTags.join(", "))}"
                    placeholder="例如：AI整理, 待复核（逗号分隔）">
                  <small>写入时先读取现有标签，再追加并去重。</small>
                </label>

                <label class="saa-switch-field">
                  <span>
                    <strong>AI 总结标签</strong>
                    <small>根据最终文档内容生成候选</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-saa-field="ai-enabled"
                    ${draft.tagging.ai.enabled ? "checked" : ""}>
                </label>

                <label class="saa-field">
                  <span>候选来源</span>
                  <select class="b3-select fn__block" data-saa-field="ai-provider">
                    <option value="calling_agent"
                      ${draft.tagging.ai.provider === "calling_agent" ? "selected" : ""}>
                      当前外部 Agent
                    </option>
                    <option value="siyuan_ai"
                      ${draft.tagging.ai.provider === "siyuan_ai" ? "selected" : ""}>
                      思源内置 AI
                    </option>
                  </select>
                </label>

                <label class="saa-field">
                  <span>最多候选数</span>
                  <input class="b3-text-field fn__block" type="number" min="1" max="12"
                    data-saa-field="max-tags" value="${draft.tagging.ai.maxTags}">
                </label>
              </div>

              <div class="saa-operation-grid">
                ${(
                  [
                    ["create", "创建"],
                    ["append", "追加"],
                    ["update", "修改"],
                    ["summarize", "总结"],
                    ["memory", "记忆沉淀"],
                    ["batchOrganize", "批量整理"],
                  ] as const
                )
                  .map(
                    ([key, label]) => `
                    <label class="saa-check saa-check--tile">
                      <input type="checkbox" data-saa-tag-operation="${key}"
                        ${draft.tagging.operations[key] ? "checked" : ""}>
                      <span>${label}</span>
                    </label>
                  `,
                  )
                  .join("")}
              </div>
            </section>

            <section class="saa-section">
              <div class="saa-section__heading">
                <span>04</span>
                <div>
                  <h3>安全写入与 P1 能力</h3>
                  <p>Safe Write Transaction：写前快照、引用保护、长文硬上限、块编辑预期状态。技术 ID 过渡期仍为 siyuan-agent-access。</p>
                </div>
              </div>

              <div class="saa-permission-grid">
                <div class="saa-switch-field">
                  <span>
                    <strong>写前快照</strong>
                    <small>P0/P1 强制不变量：快照失败则停止，不执行写入</small>
                  </span>
                  <strong>已启用</strong>
                </div>
                <label class="saa-field">
                  <span>引用保护</span>
                  <select class="b3-select fn__block" data-saa-field="reference-protection">
                    <option value="warn"
                      ${draft.safety.referenceProtection === "warn" ? "selected" : ""}>
                      警告后可写
                    </option>
                    <option value="deny"
                      ${draft.safety.referenceProtection === "deny" ? "selected" : ""}>
                      拒绝破坏引用
                    </option>
                  </select>
                </label>
                <div class="saa-switch-field">
                  <span>
                    <strong>文档树权限继承</strong>
                    <small>P0/P1 强制不变量：笔记本判定直接应用于全部子孙文档与块</small>
                  </span>
                  <strong>已启用</strong>
                </div>
                <label class="saa-field">
                  <span>长文每窗最大块数</span>
                  <input class="b3-text-field fn__block" type="number" min="1" max="200"
                    data-saa-field="max-blocks-per-window"
                    value="${draft.safety.longDocument.maxBlocksPerWindow}">
                </label>
                <label class="saa-field">
                  <span>每块最大字符</span>
                  <input class="b3-text-field fn__block" type="number" min="256" max="50000"
                    data-saa-field="max-chars-per-block"
                    value="${draft.safety.longDocument.maxCharsPerBlock}">
                </label>
                <label class="saa-field">
                  <span>大纲最大块数</span>
                  <input class="b3-text-field fn__block" type="number" min="10" max="2000"
                    data-saa-field="max-outline-blocks"
                    value="${draft.safety.longDocument.maxOutlineBlocks}">
                </label>
                <label class="saa-switch-field">
                  <span>
                    <strong>块编辑需要预期状态</strong>
                    <small>expectedContent 或 expectedHash</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-saa-field="require-expected-state"
                    ${draft.safety.blockEdit.requireExpectedState ? "checked" : ""}>
                </label>
                <label class="saa-switch-field">
                  <span>
                    <strong>块编辑默认确认</strong>
                    <small>edit_block 默认需 confirmed=true</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-saa-field="block-default-confirm"
                    ${draft.safety.blockEdit.defaultConfirm ? "checked" : ""}>
                </label>
              </div>

              <div class="saa-ledger saa-ledger--spaced">
                <div class="saa-ledger__row">
                  <span>P1 工具</span>
                  <strong>resolve_document · read_note_segments · edit_block</strong>
                </div>
                <div class="saa-ledger__row">
                  <span>工具总数</span>
                  <strong>19（含原 16）</strong>
                </div>
                <div class="saa-ledger__row">
                  <span>命名空间</span>
                  <code>plugin__siyuan_agent_access__*</code>
                </div>
              </div>
            </section>

            <section class="saa-section saa-section--risk">
              <div class="saa-section__heading">
                <span>!</span>
                <div>
                  <h3>已接受的安全边界</h3>
                  <p>思源原生 /mcp 仍是管理员级入口。本策略只约束插件注册的工具。品牌为 ${PRODUCT_BRAND}，技术 ID 过渡期保留 siyuan-agent-access；未来切换 ID 需要双插件或迁移桥。</p>
                </div>
              </div>
            </section>
          </main>

          <footer class="saa-settings__footer">
            <span data-saa-save-note>尚未保存本次修改</span>
            <div>
              <button class="b3-button b3-button--cancel" data-saa-dialog-action="cancel">取消</button>
              <button class="b3-button b3-button--text" data-saa-dialog-action="save">保存并立即生效</button>
            </div>
          </footer>
        </div>
      `,
    });

    const root = dialog.element.querySelector<HTMLElement>(".saa-settings");
    if (!root) {
      return;
    }

    const renderNotebookRows = () => {
      const list = root.querySelector<HTMLElement>("[data-saa-notebook-list]");
      const effective = root.querySelector<HTMLElement>("[data-saa-effective]");
      if (!list || !effective) {
        return;
      }
      const selectedIds = new Set(draft.access.selectedNotebookIds);
      const visible = this.notebooks.filter((notebook) => {
        const matches =
          !searchTerm ||
          notebook.name.toLocaleLowerCase().includes(searchTerm) ||
          notebook.id.toLocaleLowerCase().includes(searchTerm);
        return matches && (!onlySelected || selectedIds.has(notebook.id));
      });
      const accessibleCount = countAccessibleNotebooks(
        this.notebooks,
        draft,
      );
      effective.innerHTML = `
        <strong>${accessibleCount}</strong>
        <span>个笔记本最终可访问 · ${escapeHtml(modeLabel(draft))}</span>
      `;
      list.innerHTML =
        visible.length === 0
          ? `<div class="saa-empty">没有符合条件的笔记本</div>`
          : visible
              .map((notebook, index) => {
                const selected = selectedIds.has(notebook.id);
                const allowed = isNotebookAllowed(notebook.id, draft);
                return `
                  <label class="saa-notebook-row" style="--row-index:${index}">
                    <input type="checkbox" data-saa-notebook-id="${escapeHtml(
                      notebook.id,
                    )}" ${selected ? "checked" : ""}>
                    <span class="saa-notebook-row__index">${String(
                      index + 1,
                    ).padStart(2, "0")}</span>
                    <span class="saa-notebook-row__body">
                      <strong>${escapeHtml(notebook.name)}</strong>
                      <code>${escapeHtml(notebook.id)}</code>
                    </span>
                    <span class="saa-access-chip saa-access-chip--${
                      allowed ? "allow" : "deny"
                    }">${allowed ? "可访问" : "已拒绝"}</span>
                  </label>
                `;
              })
              .join("");
    };

    renderNotebookRows();

    root.addEventListener("input", (event) => {
      const input = event.target as HTMLInputElement;
      if (input.dataset.saaField === "notebook-search") {
        searchTerm = input.value.trim().toLocaleLowerCase();
        renderNotebookRows();
      } else if (input.dataset.saaField === "fixed-tags") {
        draft.tagging.fixedTags = parseTags(input.value);
      }
    });

    root.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (input instanceof HTMLInputElement && input.name === "saa-access-mode") {
        draft.access.mode = input.value === "denylist" ? "denylist" : "allowlist";
        draft.access.defaultDecision =
          draft.access.mode === "allowlist" ? "deny" : "allow";
        renderNotebookRows();
        return;
      }
      if (input instanceof HTMLInputElement && input.name === "saa-tag-mode") {
        draft.tagging.mode = input.value as TaggingMode;
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaNotebookId
      ) {
        const ids = new Set(draft.access.selectedNotebookIds);
        if (input.checked) {
          ids.add(input.dataset.saaNotebookId);
        } else {
          ids.delete(input.dataset.saaNotebookId);
        }
        draft.access.selectedNotebookIds = [...ids];
        renderNotebookRows();
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "only-selected"
      ) {
        onlySelected = input.checked;
        renderNotebookRows();
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.saaOperation
      ) {
        const operation = input.dataset
          .saaOperation as keyof PluginPolicy["operations"];
        draft.operations[operation] =
          input.value === "deny"
            ? "deny"
            : input.value === "confirm"
              ? "confirm"
              : "allow";
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "ai-enabled"
      ) {
        draft.tagging.ai.enabled = input.checked;
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.saaField === "reference-protection"
      ) {
        draft.safety.referenceProtection =
          input.value === "deny" ? "deny" : "warn";
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "max-blocks-per-window"
      ) {
        draft.safety.longDocument.maxBlocksPerWindow = Math.min(
          200,
          Math.max(1, input.valueAsNumber || 50),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "max-chars-per-block"
      ) {
        draft.safety.longDocument.maxCharsPerBlock = Math.min(
          50000,
          Math.max(256, input.valueAsNumber || 8000),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "max-outline-blocks"
      ) {
        draft.safety.longDocument.maxOutlineBlocks = Math.min(
          2000,
          Math.max(10, input.valueAsNumber || 500),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "require-expected-state"
      ) {
        draft.safety.blockEdit.requireExpectedState = input.checked;
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "block-default-confirm"
      ) {
        draft.safety.blockEdit.defaultConfirm = input.checked;
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.saaField === "ai-provider"
      ) {
        draft.tagging.ai.provider =
          input.value === "siyuan_ai" ? "siyuan_ai" : "calling_agent";
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaField === "max-tags"
      ) {
        draft.tagging.ai.maxTags = Math.min(
          12,
          Math.max(1, input.valueAsNumber || 5),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.saaTagOperation
      ) {
        const operation = input.dataset
          .saaTagOperation as keyof PluginPolicy["tagging"]["operations"];
        draft.tagging.operations[operation] = input.checked;
      }
    });

    root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-saa-dialog-action]",
      );
      const action = button?.dataset.saaDialogAction;
      if (!action) {
        return;
      }
      if (action === "cancel") {
        dialog.destroy();
        return;
      }
      if (action === "clear-selection") {
        draft.access.selectedNotebookIds = [];
        renderNotebookRows();
        return;
      }
      if (action === "select-visible") {
        const visibleInputs = root.querySelectorAll<HTMLInputElement>(
          "[data-saa-notebook-id]",
        );
        const ids = new Set(draft.access.selectedNotebookIds);
        visibleInputs.forEach((input) => {
          if (input.dataset.saaNotebookId) {
            ids.add(input.dataset.saaNotebookId);
          }
        });
        draft.access.selectedNotebookIds = [...ids];
        renderNotebookRows();
        return;
      }
      if (action === "save") {
        const saveButton = button as HTMLButtonElement;
        saveButton.disabled = true;
        saveButton.textContent = "正在保存…";
        void this.persistPolicy(draft)
          .then(() => {
            showMessage("访问策略已保存并立即生效", 3000, "info");
            dialog.destroy();
          })
          .catch((error) => {
            saveButton.disabled = false;
            saveButton.textContent = "保存并立即生效";
            showMessage(
              `保存失败：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
    });
  }
}
