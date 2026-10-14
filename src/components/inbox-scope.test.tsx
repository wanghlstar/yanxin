// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { InboxScope } from "./inbox-scope";
import type { Account, RemoteFolder } from "@/lib/types";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/api", () => ({ call: mocks.call }));
let host: HTMLDivElement, root: Root;
const onSaved = vi.fn();
const accounts = [
  {
    id: "work",
    name: "工作邮箱",
    email: "work@example.com",
    inboxFolders: null,
  },
  {
    id: "personal",
    name: "个人邮箱",
    email: "personal@example.com",
    inboxFolders: ["Archive"],
  },
] as Account[];
const folders = [
  {
    accountId: "work",
    name: "INBOX",
    displayName: "收件箱",
    delimiter: "/",
    selectable: true,
  },
  {
    accountId: "work",
    name: "&bfFuL2XlaMA-",
    displayName: "工作",
    delimiter: "/",
    selectable: true,
  },
  {
    accountId: "work",
    name: "Archive",
    displayName: "",
    delimiter: "/",
    selectable: true,
  },
  {
    accountId: "personal",
    name: "INBOX",
    displayName: "收件箱",
    delimiter: "/",
    selectable: true,
  },
  {
    accountId: "personal",
    name: "Archive",
    displayName: "归档",
    delimiter: "/",
    selectable: true,
  },
] as RemoteFolder[];
function checkbox(label: string) {
  const row = [...host.querySelectorAll("label")].find(
    (l) => l.textContent === label,
  );
  expect(row).toBeTruthy();
  return host.querySelector(`#${row!.getAttribute("for")}`) as HTMLElement;
}
function checked(label: string) {
  return checkbox(label).getAttribute("aria-checked");
}
async function click(element: HTMLElement) {
  expect(element).toBeTruthy();
  await act(async () => element.click());
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
}
function collapseToggle() {
  return host.querySelector(
    '[aria-label="折叠收件箱范围"],[aria-label="展开收件箱范围"]',
  ) as HTMLButtonElement;
}
function collapsed() {
  return collapseToggle().getAttribute("aria-expanded") === "false";
}
// 勾选列表默认折叠，测试需先展开
async function expand() {
  await click(collapseToggle());
  expect(collapsed()).toBe(false);
}
async function selectAccount(name: string) {
  await act(async () => {
    host
      .querySelector('[aria-label="配置账号"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes(name),
    )!,
  );
}
async function render(
  view = <InboxScope accounts={accounts} folders={folders} onSaved={onSaved} />,
) {
  await act(async () => root.render(view));
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  mocks.call.mockReset();
  mocks.call.mockResolvedValue(undefined);
  onSaved.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it("collapses the scope by default and expands it with the arrow", async () => {
  expect(collapsed()).toBe(true);
  expect(collapseToggle().getAttribute("aria-controls")).toBe(
    "inbox-scope-content",
  );
  expect(host.querySelector("#inbox-scope-content")).toBeNull();
  expect(button("保存范围")).toBeUndefined();
  // 折叠态下头部仍显示当前口径。
  expect(host.textContent).toContain("未配置：只含收件箱");
  await expand();
  expect(host.querySelector("#inbox-scope-content")).toBeTruthy();
  expect(checked("收件箱")).toBe("true");
  await click(collapseToggle());
  expect(host.querySelector("#inbox-scope-content")).toBeNull();
});
it("lists the account folders and defaults an unconfigured account to the inbox", async () => {
  await expand();
  expect(host.textContent).toContain("全部收件箱");
  expect(host.textContent).toContain(
    "选择哪些文件夹计入全部/未读视图；未配置时只含收件箱",
  );
  // 只列当前账号的目录，按角色排序，displayName 为空时回退原始 IMAP 名。
  expect(
    [...host.querySelectorAll("label")]
      .map((l) => l.textContent)
      .filter((text) => text !== "配置账号"),
  ).toEqual(["收件箱", "Archive", "工作"]);
  expect(checked("收件箱")).toBe("true");
  expect(checked("工作")).toBe("false");
  expect(button("恢复默认")).toBeUndefined();
});
it("saves the picked folders and refreshes the app", async () => {
  await expand();
  await click(checkbox("工作"));
  expect(checked("工作")).toBe("true");
  await click(button("保存范围"));
  expect(mocks.call).toHaveBeenCalledWith("save_inbox_folders", {
    accountId: "work",
    folders: ["INBOX", "&bfFuL2XlaMA-"],
  });
  expect(onSaved).toHaveBeenCalledOnce();
  // 保存成功后自动折叠。
  expect(host.querySelector("#inbox-scope-content")).toBeNull();
});
it("drops an unpicked folder again before saving", async () => {
  await expand();
  await click(checkbox("工作"));
  await click(checkbox("工作"));
  expect(checked("工作")).toBe("false");
  await click(button("保存范围"));
  expect(mocks.call).toHaveBeenCalledWith("save_inbox_folders", {
    accountId: "work",
    folders: ["INBOX"],
  });
});
it("restores the default scope of a configured account", async () => {
  await selectAccount("个人邮箱");
  await expand();
  expect(checked("归档")).toBe("true");
  expect(checked("收件箱")).toBe("false");
  await click(button("恢复默认"));
  expect(mocks.call).toHaveBeenCalledWith("save_inbox_folders", {
    accountId: "personal",
    folders: null,
  });
  expect(onSaved).toHaveBeenCalledOnce();
  // 恢复默认成功后同样自动折叠。
  expect(host.querySelector("#inbox-scope-content")).toBeNull();
  await expand();
  expect(checked("收件箱")).toBe("true");
  expect(checked("归档")).toBe("false");
});
it("loads each account's own configuration when switching accounts", async () => {
  await expand();
  await selectAccount("个人邮箱");
  expect(checked("归档")).toBe("true");
  await click(checkbox("收件箱"));
  await selectAccount("工作邮箱");
  expect(checked("收件箱")).toBe("true");
  expect(checked("工作")).toBe("false");
  expect(host.textContent).toContain("未配置：只含收件箱");
  await selectAccount("个人邮箱");
  // 切回后重新加载已保存配置，此前的未保存勾选不残留。
  expect(checked("归档")).toBe("true");
  expect(checked("收件箱")).toBe("false");
});
it("switches accounts while collapsed and updates the status line", async () => {
  // 折叠态下账号选择器仍可见可切换。
  expect(host.textContent).toContain("未配置：只含收件箱");
  await selectAccount("个人邮箱");
  expect(host.textContent).toContain("已配置 1 个文件夹");
  expect(
    (host.querySelector('[aria-label="配置账号"]') as HTMLElement).textContent,
  ).toContain("个人邮箱");
  expect(collapsed()).toBe(true);
});
it("reports the failure and keeps the picks when saving fails", async () => {
  mocks.call.mockRejectedValueOnce(new Error("保存失败"));
  await expand();
  await click(checkbox("工作"));
  await click(button("保存范围"));
  expect(host.textContent).toContain("保存失败");
  expect(host.textContent).toContain("范围未保存");
  expect(onSaved).not.toHaveBeenCalled();
  // 保存失败不折叠，勾选保留。
  expect(host.querySelector("#inbox-scope-content")).toBeTruthy();
  expect(checked("工作")).toBe("true");
});
it("disables the controls without accounts or folders", async () => {
  await render(<InboxScope accounts={[]} folders={[]} onSaved={onSaved} />);
  expect(
    (host.querySelector('[aria-label="配置账号"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(collapseToggle().disabled).toBe(true);
  await render(
    <InboxScope accounts={accounts} folders={[]} onSaved={onSaved} />,
  );
  await expand();
  expect(host.textContent).toContain("暂无服务器目录");
  expect(button("保存范围").disabled).toBe(true);
});
