import { Dialog, Plugin, Setting, showMessage } from "siyuan";
import {
  clonePolicy,
  countAccessibleNotebooks,
  DEFAULT_POLICY,
  isNotebookAllowed,
  normalizePolicy,
} from "./config";
import {
  legacyPetalFilePath,
  parseWorkspaceJsonPayload,
  POLICY_STORAGE_KEY,
  runStorageMigration,
  type MigrationStorageIO,
} from "./migration";
import { listNotebooks, readWorkspaceJson } from "./siyuan-api";
import type {
  NotebookSummary,
  PluginPolicy,
  TaggingMode,
} from "./types";
import "./index.css";

// Dock type key follows technical id siyuanmaster.
const DOCK_TYPE = "siyuanmaster-dock";
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

export default class SiYuanMasterPlugin extends Plugin {
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
        "[data-sym-action]",
      );
      const action = target?.dataset.symAction;
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
      <div class="sym-dock">
        <header class="sym-dock__masthead">
          <div>
            <p class="sym-kicker">SIYUANMASTER / ACCESS BOUNDARY</p>
            <h2>${PRODUCT_DISPLAY_NAME}</h2>
          </div>
          <span class="sym-status sym-status--${statusTone}">
            <i></i>${status}
          </span>
        </header>

        <section class="sym-scope-card">
          <div class="sym-scope-card__line">
            <span>当前范围</span>
            <strong>${escapeHtml(modeLabel(this.policy))}</strong>
          </div>
          <div class="sym-metric-row">
            <div class="sym-metric">
              <strong>${accessible}</strong>
              <span>可访问</span>
            </div>
            <div class="sym-metric">
              <strong>${this.notebooks.length}</strong>
              <span>全部笔记本</span>
            </div>
            <div class="sym-metric">
              <strong>${selected}</strong>
              <span>已勾选</span>
            </div>
          </div>
        </section>

        <section class="sym-ledger">
          <div class="sym-ledger__row">
            <span>标签策略</span>
            <strong>${taggingModeLabel(this.policy.tagging.mode)}</strong>
          </div>
          <div class="sym-ledger__row">
            <span>AI 标签</span>
            <strong>${
              this.policy.tagging.ai.enabled ? "候选已启用" : "未启用"
            }</strong>
          </div>
          <div class="sym-ledger__row">
            <span>结构变更</span>
            <strong>先预演 · 再执行</strong>
          </div>
          <div class="sym-ledger__row">
            <span>MCP 命名空间</span>
            <code>plugin__siyuanmaster__*</code>
          </div>
          <div class="sym-ledger__row">
            <span>MCP 入口</span>
            <code>127.0.0.1:6806/mcp</code>
          </div>
        </section>

        <section class="sym-ledger">
          <div class="sym-ledger__row">
            <span>写前快照</span>
            <strong>已启用（强制）</strong>
          </div>
          <div class="sym-ledger__row">
            <span>引用保护</span>
            <strong>${
              safety.referenceProtection === "deny" ? "拒绝破坏引用" : "警告后可写"
            }</strong>
          </div>
          <div class="sym-ledger__row">
            <span>权限继承</span>
            <strong>文档树继承笔记本（强制）</strong>
          </div>
          <div class="sym-ledger__row">
            <span>长文窗口</span>
            <strong>≤${safety.longDocument.maxBlocksPerWindow} 块</strong>
          </div>
          <div class="sym-ledger__row">
            <span>块编辑确认</span>
            <strong>${safety.blockEdit.defaultConfirm ? "默认需确认" : "跟随策略"}</strong>
          </div>
        </section>

        <section class="sym-ledger">
          <div class="sym-ledger__row">
            <span>P1 能力</span>
            <strong>3 项 · Safe Write</strong>
          </div>
          <div class="sym-ledger__row">
            <span>路径查找</span>
            <strong>resolve_document 只读</strong>
          </div>
          <div class="sym-ledger__row">
            <span>分段读取</span>
            <strong>read_note_segments</strong>
          </div>
          <div class="sym-ledger__row">
            <span>安全块编辑</span>
            <strong>edit_block</strong>
          </div>
          <div class="sym-ledger__row">
            <span>知识复利 M1</span>
            <strong>Registry · Templates · Ingest Plan</strong>
          </div>
          <div class="sym-ledger__row">
            <span>技术 ID</span>
            <code>siyuanmaster</code>
          </div>
        </section>

        <aside class="sym-risk-note">
          <span>已知边界</span>
          <p>原生 MCP 使用管理员级鉴权；${PRODUCT_BRAND} 只约束本插件注册的工具，面向你已授权的可信本机 Agent。升级后会自动把旧 petal 策略/审计复制到 siyuanmaster（旧目录保留不删）；外部 Agent 的 MCP 工具名需手工改为 plugin__siyuanmaster__*。</p>
        </aside>

        <div class="sym-dock__actions">
          <button class="b3-button b3-button--text" data-sym-action="settings">
            打开完整设置
          </button>
          <button class="b3-button b3-button--outline" data-sym-action="copy-config">
            复制接入配置
          </button>
          <button class="sym-icon-button" data-sym-action="refresh" aria-label="刷新">
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
    const result = await runStorageMigration(this.createMigrationIO());
    this.policy = result.policy;
  }

  private createMigrationIO(): MigrationStorageIO {
    return {
      readCurrent: async (key) => {
        try {
          const value = await this.loadData(key);
          if (value === null || value === undefined || value === "") {
            return undefined;
          }
          return value;
        } catch {
          return undefined;
        }
      },
      writeCurrent: async (key, value) => {
        await this.saveData(key, value);
      },
      readLegacy: async (key) => {
        const raw = await readWorkspaceJson(legacyPetalFilePath(key));
        return parseWorkspaceJsonPayload(raw);
      },
    };
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
        <div class="sym-settings">
          <header class="sym-settings__hero">
            <div>
              <p class="sym-kicker">SIYUANMASTER / ACCESS BOUNDARY</p>
              <h2>决定 AI 能看见与写入什么</h2>
              <p>配置访问边界、安全写入、操作权限与标签策略。保存后立即生效。</p>
            </div>
            <div class="sym-settings__seal">
              <span>LOCAL</span>
              <strong>TRUSTED</strong>
            </div>
          </header>

          <main class="sym-settings__content">
            <section class="sym-section">
              <div class="sym-section__heading">
                <span>01</span>
                <div>
                  <h3>笔记本访问范围</h3>
                  <p>推荐使用允许名单；新建笔记本默认不可访问。</p>
                </div>
              </div>

              <div class="sym-mode-grid">
                <label class="sym-mode-card">
                  <input type="radio" name="sym-access-mode" value="allowlist"
                    ${draft.access.mode === "allowlist" ? "checked" : ""}>
                  <span class="sym-mode-card__mark">A</span>
                  <strong>只允许选中的笔记本</strong>
                  <small>未勾选内容对插件工具不可见</small>
                </label>
                <label class="sym-mode-card">
                  <input type="radio" name="sym-access-mode" value="denylist"
                    ${draft.access.mode === "denylist" ? "checked" : ""}>
                  <span class="sym-mode-card__mark">B</span>
                  <strong>禁止选中的笔记本</strong>
                  <small>未勾选内容默认可以访问</small>
                </label>
              </div>

              <div class="sym-notebook-toolbar">
                <label class="sym-search">
                  <span>⌕</span>
                  <input type="search" data-sym-field="notebook-search"
                    placeholder="搜索笔记本名称或 ID">
                </label>
                <label class="sym-check">
                  <input type="checkbox" data-sym-field="only-selected">
                  <span>仅看已选</span>
                </label>
                <button class="b3-button b3-button--outline" data-sym-dialog-action="select-visible">
                  选择当前列表
                </button>
                <button class="b3-button b3-button--outline" data-sym-dialog-action="clear-selection">
                  清空
                </button>
              </div>

              <div class="sym-effective" data-sym-effective></div>
              <div class="sym-notebook-list" data-sym-notebook-list></div>
            </section>

            <section class="sym-section">
              <div class="sym-section__heading">
                <span>02</span>
                <div>
                  <h3>Agent 操作权限</h3>
                  <p>“需确认”表示 Agent 必须先得到你的明确同意。重命名和移动还必须先生成一次性预演令牌。</p>
                </div>
              </div>

              <div class="sym-permission-grid">
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
                    <label class="sym-permission-row">
                      <span>
                        <strong>${label}</strong>
                        <small>${description}</small>
                      </span>
                      <select class="b3-select" data-sym-operation="${key}">
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

            <section class="sym-section">
              <div class="sym-section__heading">
                <span>03</span>
                <div>
                  <h3>标签策略</h3>
                  <p>没有明确选择时不强制添加任何固定标签。</p>
                </div>
              </div>

              <div class="sym-tag-modes">
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
                      <input type="radio" name="sym-tag-mode" value="${value}"
                        ${draft.tagging.mode === value ? "checked" : ""}>
                      <strong>${title}</strong>
                      <span>${description}</span>
                    </label>
                  `,
                  )
                  .join("")}
              </div>

              <div class="sym-field-grid">
                <label class="sym-field sym-field--wide">
                  <span>固定标签</span>
                  <input class="b3-text-field fn__block" data-sym-field="fixed-tags"
                    value="${escapeHtml(draft.tagging.fixedTags.join(", "))}"
                    placeholder="例如：AI整理, 待复核（逗号分隔）">
                  <small>写入时先读取现有标签，再追加并去重。</small>
                </label>

                <label class="sym-switch-field">
                  <span>
                    <strong>AI 总结标签</strong>
                    <small>根据最终文档内容生成候选</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-sym-field="ai-enabled"
                    ${draft.tagging.ai.enabled ? "checked" : ""}>
                </label>

                <label class="sym-field">
                  <span>候选来源</span>
                  <select class="b3-select fn__block" data-sym-field="ai-provider">
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

                <label class="sym-field">
                  <span>最多候选数</span>
                  <input class="b3-text-field fn__block" type="number" min="1" max="12"
                    data-sym-field="max-tags" value="${draft.tagging.ai.maxTags}">
                </label>
              </div>

              <div class="sym-operation-grid">
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
                    <label class="sym-check sym-check--tile">
                      <input type="checkbox" data-sym-tag-operation="${key}"
                        ${draft.tagging.operations[key] ? "checked" : ""}>
                      <span>${label}</span>
                    </label>
                  `,
                  )
                  .join("")}
              </div>
            </section>

            <section class="sym-section">
              <div class="sym-section__heading">
                <span>04</span>
                <div>
                  <h3>安全写入与 P1 能力</h3>
                  <p>Safe Write Transaction：写前快照、引用保护、长文硬上限、块编辑预期状态。技术 ID 为 siyuanmaster。</p>
                </div>
              </div>

              <div class="sym-permission-grid">
                <div class="sym-switch-field">
                  <span>
                    <strong>写前快照</strong>
                    <small>P0/P1 强制不变量：快照失败则停止，不执行写入</small>
                  </span>
                  <strong>已启用</strong>
                </div>
                <label class="sym-field">
                  <span>引用保护</span>
                  <select class="b3-select fn__block" data-sym-field="reference-protection">
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
                <div class="sym-switch-field">
                  <span>
                    <strong>文档树权限继承</strong>
                    <small>P0/P1 强制不变量：笔记本判定直接应用于全部子孙文档与块</small>
                  </span>
                  <strong>已启用</strong>
                </div>
                <label class="sym-field">
                  <span>长文每窗最大块数</span>
                  <input class="b3-text-field fn__block" type="number" min="1" max="200"
                    data-sym-field="max-blocks-per-window"
                    value="${draft.safety.longDocument.maxBlocksPerWindow}">
                </label>
                <label class="sym-field">
                  <span>每块最大字符</span>
                  <input class="b3-text-field fn__block" type="number" min="256" max="50000"
                    data-sym-field="max-chars-per-block"
                    value="${draft.safety.longDocument.maxCharsPerBlock}">
                </label>
                <label class="sym-field">
                  <span>大纲最大块数</span>
                  <input class="b3-text-field fn__block" type="number" min="10" max="2000"
                    data-sym-field="max-outline-blocks"
                    value="${draft.safety.longDocument.maxOutlineBlocks}">
                </label>
                <label class="sym-switch-field">
                  <span>
                    <strong>块编辑需要预期状态</strong>
                    <small>expectedContent 或 expectedHash</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-sym-field="require-expected-state"
                    ${draft.safety.blockEdit.requireExpectedState ? "checked" : ""}>
                </label>
                <label class="sym-switch-field">
                  <span>
                    <strong>块编辑默认确认</strong>
                    <small>edit_block 默认需 confirmed=true</small>
                  </span>
                  <input class="b3-switch" type="checkbox" data-sym-field="block-default-confirm"
                    ${draft.safety.blockEdit.defaultConfirm ? "checked" : ""}>
                </label>
              </div>

              <div class="sym-ledger sym-ledger--spaced">
                <div class="sym-ledger__row">
                  <span>P1 工具</span>
                  <strong>resolve_document · read_note_segments · edit_block</strong>
                </div>
                <div class="sym-ledger__row">
                  <span>知识复利 M1</span>
                  <strong>Source Manifest · Authority Registry · 候选查找</strong>
                </div>
                <div class="sym-ledger__row">
                  <span>工具总数</span>
                  <strong>27（含原 16）</strong>
                </div>
                <div class="sym-ledger__row">
                  <span>命名空间</span>
                  <code>plugin__siyuanmaster__*</code>
                </div>
              </div>
            </section>

            <section class="sym-section sym-section--risk">
              <div class="sym-section__heading">
                <span>!</span>
                <div>
                  <h3>已接受的安全边界</h3>
                  <p>思源原生 /mcp 仍是管理员级入口。本策略只约束插件注册的工具。品牌为 ${PRODUCT_BRAND}，技术 ID 为 siyuanmaster。升级时会自动复制旧存储到新路径（不删除旧目录）；外部 Agent 命名空间需手工更新。</p>
                </div>
              </div>
            </section>
          </main>

          <footer class="sym-settings__footer">
            <span data-sym-save-note>尚未保存本次修改</span>
            <div>
              <button class="b3-button b3-button--cancel" data-sym-dialog-action="cancel">取消</button>
              <button class="b3-button b3-button--text" data-sym-dialog-action="save">保存并立即生效</button>
            </div>
          </footer>
        </div>
      `,
    });

    const root = dialog.element.querySelector<HTMLElement>(".sym-settings");
    if (!root) {
      return;
    }

    const renderNotebookRows = () => {
      const list = root.querySelector<HTMLElement>("[data-sym-notebook-list]");
      const effective = root.querySelector<HTMLElement>("[data-sym-effective]");
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
          ? `<div class="sym-empty">没有符合条件的笔记本</div>`
          : visible
              .map((notebook, index) => {
                const selected = selectedIds.has(notebook.id);
                const allowed = isNotebookAllowed(notebook.id, draft);
                return `
                  <label class="sym-notebook-row" style="--row-index:${index}">
                    <input type="checkbox" data-sym-notebook-id="${escapeHtml(
                      notebook.id,
                    )}" ${selected ? "checked" : ""}>
                    <span class="sym-notebook-row__index">${String(
                      index + 1,
                    ).padStart(2, "0")}</span>
                    <span class="sym-notebook-row__body">
                      <strong>${escapeHtml(notebook.name)}</strong>
                      <code>${escapeHtml(notebook.id)}</code>
                    </span>
                    <span class="sym-access-chip sym-access-chip--${
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
      if (input.dataset.symField === "notebook-search") {
        searchTerm = input.value.trim().toLocaleLowerCase();
        renderNotebookRows();
      } else if (input.dataset.symField === "fixed-tags") {
        draft.tagging.fixedTags = parseTags(input.value);
      }
    });

    root.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement | HTMLSelectElement;
      if (input instanceof HTMLInputElement && input.name === "sym-access-mode") {
        draft.access.mode = input.value === "denylist" ? "denylist" : "allowlist";
        draft.access.defaultDecision =
          draft.access.mode === "allowlist" ? "deny" : "allow";
        renderNotebookRows();
        return;
      }
      if (input instanceof HTMLInputElement && input.name === "sym-tag-mode") {
        draft.tagging.mode = input.value as TaggingMode;
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symNotebookId
      ) {
        const ids = new Set(draft.access.selectedNotebookIds);
        if (input.checked) {
          ids.add(input.dataset.symNotebookId);
        } else {
          ids.delete(input.dataset.symNotebookId);
        }
        draft.access.selectedNotebookIds = [...ids];
        renderNotebookRows();
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "only-selected"
      ) {
        onlySelected = input.checked;
        renderNotebookRows();
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.symOperation
      ) {
        const operation = input.dataset
          .symOperation as keyof PluginPolicy["operations"];
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
        input.dataset.symField === "ai-enabled"
      ) {
        draft.tagging.ai.enabled = input.checked;
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.symField === "reference-protection"
      ) {
        draft.safety.referenceProtection =
          input.value === "deny" ? "deny" : "warn";
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "max-blocks-per-window"
      ) {
        draft.safety.longDocument.maxBlocksPerWindow = Math.min(
          200,
          Math.max(1, input.valueAsNumber || 50),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "max-chars-per-block"
      ) {
        draft.safety.longDocument.maxCharsPerBlock = Math.min(
          50000,
          Math.max(256, input.valueAsNumber || 8000),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "max-outline-blocks"
      ) {
        draft.safety.longDocument.maxOutlineBlocks = Math.min(
          2000,
          Math.max(10, input.valueAsNumber || 500),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "require-expected-state"
      ) {
        draft.safety.blockEdit.requireExpectedState = input.checked;
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "block-default-confirm"
      ) {
        draft.safety.blockEdit.defaultConfirm = input.checked;
        return;
      }
      if (
        input instanceof HTMLSelectElement &&
        input.dataset.symField === "ai-provider"
      ) {
        draft.tagging.ai.provider =
          input.value === "siyuan_ai" ? "siyuan_ai" : "calling_agent";
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symField === "max-tags"
      ) {
        draft.tagging.ai.maxTags = Math.min(
          12,
          Math.max(1, input.valueAsNumber || 5),
        );
        return;
      }
      if (
        input instanceof HTMLInputElement &&
        input.dataset.symTagOperation
      ) {
        const operation = input.dataset
          .symTagOperation as keyof PluginPolicy["tagging"]["operations"];
        draft.tagging.operations[operation] = input.checked;
      }
    });

    root.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>(
        "[data-sym-dialog-action]",
      );
      const action = button?.dataset.symDialogAction;
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
          "[data-sym-notebook-id]",
        );
        const ids = new Set(draft.access.selectedNotebookIds);
        visibleInputs.forEach((input) => {
          if (input.dataset.symNotebookId) {
            ids.add(input.dataset.symNotebookId);
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
