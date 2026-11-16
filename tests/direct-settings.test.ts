import { describe, expect, it, vi } from "vitest";
import { frontendRuntime } from "./helpers/plugin-runtime";

interface FrontendPlugin {
  registerSettings(): void;
  openSetting(): void;
  openSettingsDialog(): Promise<void>;
  setting: unknown;
}

describe("plugin settings entry", () => {
  it("opens the existing configuration dialog directly", async () => {
    const { plugin } = await frontendRuntime<FrontendPlugin>();
    const openDialog = vi.spyOn(plugin, "openSettingsDialog").mockResolvedValue(undefined);
    plugin.registerSettings();
    expect(plugin.setting).toBeDefined();
    plugin.openSetting();
    expect(openDialog).toHaveBeenCalledOnce();
  });
});
