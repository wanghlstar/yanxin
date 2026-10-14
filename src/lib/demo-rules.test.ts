// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { makeDemo } from "./demo";
import type { Rule, Snapshot } from "./types";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));
afterEach(() => {
  vi.resetModules();
  localStorage.clear();
});
const query = {
  view: "all",
  accountId: "",
  folder: "",
  search: "",
  limit: 100,
  unreadOnly: false,
  listMode: "messages",
} as const;
const rule: Rule = {
  id: "test-save",
  name: "保存示例",
  accountId: "",
  enabled: true,
  mode: "all",
  conditions: [
    { field: "subject", operator: "notContains", value: "not-existing" },
  ],
  action: "folder",
  destination: "保存示例",
  stop: false,
};
async function setup(data: Snapshot) {
  localStorage.setItem("mail-desktop-demo-v1", JSON.stringify(data));
  const api = await import("./api");
  api.restoreDemo();
  return api;
}
it("classifies already complete fictional mail without contacting any server", async () => {
  const api = await setup(makeDemo());
  await api.call("save_rules", { rules: [rule] });
  expect(await api.call<number>("run_rules")).toBeGreaterThan(0);
  expect(
    (await api.snapshot(query)).messages.every(
      (m) => m.localFolder === "保存示例",
    ),
  ).toBe(true);
  const { invoke } = await import("@tauri-apps/api/core");
  expect(invoke).not.toHaveBeenCalled();
});
it("server budget inspection cannot access real servers or disk from fictional preview", async () => {
  const api = await setup(makeDemo());
  const before = await api.snapshot(query);
  await expect(
    api.call("inspect_retention_budget", {
      account: before.accounts[0],
      overrides: [],
      requestId: "fixture",
    }),
  ).rejects.toThrow("不连接真实服务器或读取磁盘");
  expect((await api.snapshot(query)).messages).toEqual(before.messages);
});
