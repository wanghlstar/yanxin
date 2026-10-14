// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoveAccountDialog } from "./remove-account-dialog";
import * as api from "@/lib/api";
import { enterDemo, leaveDemo, snapshot } from "@/lib/api";
import { makeAccount } from "@/lib/providers";
import type { Account, Query } from "@/lib/types";

let root: Root, host: HTMLDivElement, account: Account;
const done = vi.fn();
const close = vi.fn();
let action: (args: Record<string, unknown>) => Promise<unknown>;
let calls: unknown;
function button(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function render() {
  await act(async () =>
    root.render(
      <RemoveAccountDialog
        account={account}
        open
        onOpenChange={close}
        onRemoved={done}
      />,
    ),
  );
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  done.mockClear();
  close.mockClear();
  account = makeAccount("qq");
  action = async () => undefined;
  calls = vi
    .spyOn(api, "call")
    .mockImplementation(
      async <T,>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "account_action") return (await action(args)) as T;
        throw new Error(command);
      },
    );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("defaults to keeping the local archive and cancels without removing", async () => {
  const keep = document.getElementById(
    "remove-account-keep-archive",
  ) as HTMLButtonElement;
  expect(keep.getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain(account.email);
  expect(button("移除账号，保留存档")).toBeTruthy();
  await click(button("取消"));
  expect(close).toHaveBeenCalledWith(false);
  expect(calls).not.toHaveBeenCalledWith("account_action", expect.anything());
  expect(done).not.toHaveBeenCalled();
});
it("keeps archives when confirmed with the default option", async () => {
  await click(button("移除账号，保留存档"));
  expect(calls).toHaveBeenCalledWith("account_action", {
    id: account.id,
    remove: true,
    purge: false,
  });
  expect(done).toHaveBeenCalledOnce();
});
it("purges archives only after the retention option is unchecked", async () => {
  expect(document.body.textContent).not.toContain("无法恢复");
  await click(document.getElementById("remove-account-keep-archive")!);
  expect(document.body.textContent).toContain("无法恢复");
  expect(button("移除账号并清除存档")).toBeTruthy();
  await click(button("移除账号并清除存档"));
  expect(calls).toHaveBeenCalledWith("account_action", {
    id: account.id,
    remove: true,
    purge: true,
  });
  expect(done).toHaveBeenCalledOnce();
});
it("keeps the dialog open with an error after a failed removal", async () => {
  action = async () => {
    throw new Error("正在发送邮件，请稍后修改账号");
  };
  await click(button("移除账号，保留存档"));
  expect(document.body.textContent).toContain("正在发送邮件");
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();
  expect(done).not.toHaveBeenCalled();
});
it("removes demo mails only when the archive is purged", async () => {
  vi.restoreAllMocks();
  enterDemo();
  const query: Query = {
    view: "all",
    accountId: "",
    search: "",
    folder: "",
    limit: 10,
    unreadOnly: false,
    listMode: "messages",
  };
  const before = await snapshot(query);
  expect(before.accounts.length).toBeGreaterThan(1);
  expect(before.messages.length).toBeGreaterThan(1);
  const target = before.accounts[0];
  const keep = before.accounts[1];
  await api.call("account_action", {
    id: keep.id,
    remove: true,
    purge: true,
  });
  const afterKeep = await snapshot(query);
  expect(afterKeep.accounts.some((a) => a.id === keep.id)).toBe(false);
  expect(afterKeep.messages.some((m) => m.accountId === keep.id)).toBe(false);
  expect(afterKeep.messages.some((m) => m.accountId === target.id)).toBe(true);
  await api.call("account_action", {
    id: target.id,
    remove: true,
    purge: false,
  });
  const afterRemove = await snapshot(query);
  expect(afterRemove.accounts.some((a) => a.id === target.id)).toBe(false);
  expect(afterRemove.messages.some((m) => m.accountId === target.id)).toBe(
    true,
  );
  leaveDemo();
});
