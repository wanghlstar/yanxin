// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StorageTools } from "./storage-tools";
import { enterDemo, leaveDemo, call } from "../lib/api";
import * as api from "../lib/api";
import { toast } from "sonner";
let root: Root, host: HTMLDivElement;
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  enterDemo();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  leaveDemo();
  vi.restoreAllMocks();
});
it("persists independent notification toggles and leaves the sync interval intact", async () => {
  await call("save_preferences", {
    preferences: {
      syncIntervalMinutes: 15,
      newMailNotifications: true,
      sendResultNotifications: true,
    },
  });
  await act(async () => root.render(<StorageTools />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>("#new-mail-notifications")!.click(),
  );
  expect(await call("get_preferences")).toEqual({
    syncIntervalMinutes: 15,
    newMailNotifications: false,
    sendResultNotifications: true,
  });
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>("#send-result-notifications")!
      .click(),
  );
  expect(await call("get_preferences")).toEqual({
    syncIntervalMinutes: 15,
    newMailNotifications: false,
    sendResultNotifications: false,
  });
  await act(async () =>
    host.querySelector<HTMLButtonElement>("#auto-start")!.click(),
  );
  expect(
    (await call<{ autoStart: boolean }>("desktop_settings")).autoStart,
  ).toBe(true);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<StorageTools />));
  expect(
    host.querySelector("#new-mail-notifications")?.getAttribute("aria-checked"),
  ).toBe("false");
  expect(host.querySelector("#auto-start")?.getAttribute("aria-checked")).toBe(
    "true",
  );
});
it("keeps the three notification and startup switches side by side in one row", async () => {
  await act(async () => root.render(<StorageTools />));
  const switches = host.querySelector(".settings-tool-switches")!;
  expect(switches).not.toBeNull();
  expect(switches.querySelectorAll('[role="switch"]')).toHaveLength(3);
  for (const id of [
    "new-mail-notifications",
    "send-result-notifications",
    "auto-start",
  ]) {
    expect(switches.querySelector(`#${id}`)).not.toBeNull();
  }
  expect(
    [...host.querySelectorAll("button")].some(
      (b) => b.textContent === "测试系统通知",
    ),
  ).toBe(false);
});
it("sends a test notification when the new mail notification switch is turned on", async () => {
  await call("save_preferences", {
    preferences: {
      syncIntervalMinutes: 5,
      newMailNotifications: false,
      sendResultNotifications: true,
    },
  });
  const calls = vi.spyOn(api, "call");
  const success = vi.spyOn(toast, "success").mockReturnValue(0);
  await act(async () => root.render(<StorageTools />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>("#new-mail-notifications")!.click(),
  );
  expect(calls).toHaveBeenCalledWith("test_notification");
  expect(success).toHaveBeenCalledWith("演示模式不发送系统通知");
  expect(await call("get_preferences")).toEqual({
    syncIntervalMinutes: 5,
    newMailNotifications: true,
    sendResultNotifications: true,
  });
});
it("does not send a test notification when the new mail notification switch is turned off", async () => {
  await call("save_preferences", {
    preferences: {
      syncIntervalMinutes: 5,
      newMailNotifications: true,
      sendResultNotifications: true,
    },
  });
  const calls = vi.spyOn(api, "call");
  await act(async () => root.render(<StorageTools />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>("#new-mail-notifications")!.click(),
  );
  expect(
    calls.mock.calls.filter(([command]) => command === "test_notification"),
  ).toHaveLength(0);
  expect(await call("get_preferences")).toEqual({
    syncIntervalMinutes: 5,
    newMailNotifications: false,
    sendResultNotifications: true,
  });
});
it("keeps the notification and background check descriptions on one line", async () => {
  await act(async () => root.render(<StorageTools />));
  const text = host.textContent ?? "";
  expect(text).toContain(
    "新邮件和发送结果使用系统通知；首次导入旧邮件不通知，横幅由 macOS 设置控制。",
  );
  expect(text).toContain("IMAP 优先实时收取；此间隔用于定时补查和 POP3。");
});
it("does not register a development preview as a broken login startup item", async () => {
  const original = api.call;
  vi.spyOn(api, "call").mockImplementation(
    async <T,>(command: string, args: Record<string, unknown> = {}) =>
      command === "desktop_settings"
        ? ({ autoStart: false, autoStartAvailable: false } as T)
        : original<T>(command, args),
  );
  await act(async () => root.render(<StorageTools />));
  expect(host.querySelector<HTMLButtonElement>("#auto-start")?.disabled).toBe(
    true,
  );
  expect(host.textContent).toContain("请在正式应用中开启开机自启");
});
it("stacks the taller cards in the left column and the shorter ones in the right", async () => {
  await act(async () => root.render(<StorageTools />));
  const titles = [...host.querySelectorAll(".storage-tools-col")].map(
    (column) =>
      [
        ...column.querySelectorAll(
          ".settings-tool > h3, .settings-tool-title h3",
        ),
      ].map((h3) => h3.textContent),
  );
  expect(titles).toEqual([
    ["后台检查", "外观", "存档完整性"],
    ["系统通知与启动", "存档分层"],
  ]);
});
it("keeps the appearance card with the scale row and the Dock icon switch", async () => {
  await act(async () => root.render(<StorageTools />));
  const appearance = [...host.querySelectorAll(".settings-tool")].find(
    (card) => card.querySelector("h3")?.textContent === "外观",
  );
  expect(appearance).not.toBeUndefined();
  expect(appearance?.querySelector('[aria-label="侧边栏字号"]')).not.toBeNull();
  const dock = appearance?.querySelector<HTMLButtonElement>("#dock-visible");
  expect(dock).not.toBeNull();
  expect(dock?.getAttribute("aria-checked")).toBe("true");
  expect(
    [...appearance!.querySelectorAll("p")].map((p) => p.textContent),
  ).toEqual(
    expect.arrayContaining([
      "开启时始终在 Dock 显示；关闭时仅在打开窗口时显示，关闭或最小化窗口会自动隐藏，菜单栏图标仍可打开主窗口。",
    ]),
  );
});
it("saves the Dock icon switch immediately without touching the scale selection", async () => {
  await call("save_preferences", {
    preferences: {
      syncIntervalMinutes: 15,
      sidebarScale: 1.15,
    },
  });
  const calls = vi.spyOn(api, "call");
  await act(async () => root.render(<StorageTools />));
  await act(async () =>
    host.querySelector<HTMLButtonElement>("#dock-visible")!.click(),
  );
  expect(calls.mock.calls).toContainEqual([
    "save_preferences",
    {
      preferences: {
        syncIntervalMinutes: 15,
        sidebarScale: 1.15,
        dockVisible: false,
      },
    },
  ]);
  expect(await call("get_preferences")).toEqual({
    syncIntervalMinutes: 15,
    sidebarScale: 1.15,
    dockVisible: false,
  });
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<StorageTools />));
  expect(
    host.querySelector("#dock-visible")?.getAttribute("aria-checked"),
  ).toBe("false");
  expect(
    host.querySelector<HTMLButtonElement>('[aria-label="侧边栏字号"]')
      ?.textContent,
  ).toBe("大");
});
it("shows the archived total and the recent tier log under the tiering card", async () => {
  await act(async () => root.render(<StorageTools />));
  expect(host.textContent).toContain("已归档 3 封");
  const trigger = [...host.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("最近归档记录"),
  );
  expect(trigger).not.toBeUndefined();
  // 折叠时只显示触发行，不显示条目
  expect(host.textContent).not.toContain("项目对账邮件");
  await act(async () => trigger!.click());
  expect(host.textContent).toContain("项目对账邮件");
  expect(host.textContent).toContain("alice@example.com");
});
it("reloads the tier log after archiving now", async () => {
  const original = api.call;
  vi.spyOn(api, "call").mockImplementation(
    async <T,>(command: string, args: Record<string, unknown> = {}) =>
      command === "archive_tier_info"
        ? ({
            externalDir: "/Volumes/Archive",
            retentionDays: 30,
            indexEnabled: true,
            pending: 0,
            pendingBytes: 0,
            externalReachable: true,
          } as T)
        : original<T>(command, args),
  );
  const logCalls = vi.spyOn(api, "call");
  const success = vi.spyOn(toast, "success").mockReturnValue(0);
  await act(async () => root.render(<StorageTools />));
  const before = logCalls.mock.calls.filter(
    ([command]) => command === "archive_tier_log",
  ).length;
  expect(before).toBeGreaterThan(0);
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent === "立即归档")!
      .click(),
  );
  expect(success).toHaveBeenCalledWith("已归档 0 封");
  expect(
    logCalls.mock.calls.filter(([command]) => command === "archive_tier_log")
      .length,
  ).toBeGreaterThan(before);
});
it("hints that the external drive is unplugged when no archive total exists", async () => {
  const original = api.call;
  vi.spyOn(api, "call").mockImplementation(
    async <T,>(command: string, args: Record<string, unknown> = {}) =>
      command === "archive_tier_log"
        ? ({ total: null, entries: [] } as T)
        : original<T>(command, args),
  );
  await act(async () => root.render(<StorageTools />));
  expect(host.textContent).toContain("外置盘未连接");
  await act(async () =>
    [...host.querySelectorAll("button")]
      .find((b) => b.textContent?.includes("最近归档记录"))!
      .click(),
  );
  expect(host.textContent).toContain("暂无归档记录");
});
