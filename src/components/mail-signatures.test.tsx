// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { MailSignatures } from "./mail-signatures";
import type { Account, MailSignature } from "@/lib/types";
import { emptySignature } from "@/lib/signatures";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("@/lib/api", () => ({ call: mocks.call }));
vi.mock("./mail-content", () => ({ MailContent: () => null }));
let host: HTMLDivElement, root: Root;
let configurations: Record<string, MailSignature>;
const accounts = [
  { id: "work", name: "工作邮箱", email: "work@example.com" },
  { id: "personal", name: "个人邮箱", email: "personal@example.com" },
] as Account[];
function toggle() {
  return host.querySelector('[aria-label="启用邮件签名"]') as HTMLButtonElement;
}
function collapseToggle() {
  return host.querySelector(
    '[aria-label="折叠签名设置"],[aria-label="展开签名设置"]',
  ) as HTMLButtonElement;
}
async function click(element: HTMLElement) {
  expect(element).toBeTruthy();
  await act(async () => element.click());
}
async function selectAccount(name: string) {
  await act(async () => {
    host
      .querySelector('[aria-label="签名所属账号"]')!
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
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  configurations = {
    work: { ...emptySignature(), text: "Saved work signature" },
    personal: { ...emptySignature(), text: "Saved personal signature" },
  };
  mocks.call.mockReset();
  mocks.call.mockImplementation(async (command, args) => {
    if (command === "mail_signature")
      return structuredClone(configurations[args.accountId]);
    if (command === "save_mail_signature")
      configurations[args.accountId] = structuredClone(args.signature);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<MailSignatures accounts={accounts} />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
it("persists the header toggle, collapses controls and preserves unsaved edits without publishing them", async () => {
  expect(host.querySelector("#signature-text")).toBeNull();
  await click(toggle());
  expect(configurations.work.enabled).toBe(true);
  // 启用不再自动展开：内容仍收起，点折叠按钮才露出编辑器。
  expect(host.querySelector("#signature-text")).toBeNull();
  await click(collapseToggle());
  const editor = host.querySelector("#signature-text") as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(editor, "Unsaved work signature");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(toggle());
  expect(configurations.work).toMatchObject({
    enabled: false,
    text: "Saved work signature",
  });
  expect(host.querySelector("#signature-text")).toBeNull();
  await click(toggle());
  // 重新启用后沿用用户此前的展开选择，未保存的修改不丢失。
  expect(
    (host.querySelector("#signature-text") as HTMLTextAreaElement).value,
  ).toBe("Unsaved work signature");
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "保存签名",
    )!,
  );
  expect(configurations.work.text).toBe("Unsaved work signature");
  expect(host.textContent).not.toContain("自动附加邮件签名");
});
it("retains the disabled state and shows errors when saving the toggle fails", async () => {
  mocks.call.mockRejectedValueOnce(new Error("保存失败"));
  await click(toggle());
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("#signature-text")).toBeNull();
  expect(host.textContent).toContain("保存失败");
  expect(configurations.work.enabled).toBe(false);
});
it("selects an account while collapsed and only enables that account's saved configuration", async () => {
  await act(async () => {
    host
      .querySelector('[aria-label="签名所属账号"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  await click(
    [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((e) =>
      e.textContent?.includes("个人邮箱"),
    )!,
  );
  expect(host.querySelector("#signature-text")).toBeNull();
  await click(toggle());
  expect(configurations.personal).toMatchObject({
    enabled: true,
    text: "Saved personal signature",
  });
  expect(configurations.work.enabled).toBe(false);
  // 启用不自动展开：点折叠按钮后才读到编辑器内容。
  expect(host.querySelector("#signature-text")).toBeNull();
  await click(collapseToggle());
  expect(
    (host.querySelector("#signature-text") as HTMLTextAreaElement).value,
  ).toBe("Saved personal signature");
});
it("renders the greeting editor before the signature editor", async () => {
  await click(toggle());
  await click(collapseToggle());
  const labels = [...host.querySelectorAll("label")];
  const greeting = labels.find(
    (l) => l.getAttribute("for") === "signature-greeting",
  );
  const signature = labels.find(
    (l) => l.getAttribute("for") === "signature-text",
  );
  expect(greeting?.textContent).toContain("问候语");
  expect(signature?.textContent).toMatch(/签名内容|HTML 源码/);
  expect(
    greeting!.compareDocumentPosition(signature!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
it("saves the typed greeting together with the signature", async () => {
  await click(toggle());
  await click(collapseToggle());
  const greeting = host.querySelector(
    "#signature-greeting",
  ) as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(greeting, "您好：");
    greeting.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(
    [...host.querySelectorAll("button")].find(
      (b) => b.textContent === "保存签名",
    )!,
  );
  const saves = mocks.call.mock.calls.filter(
    ([command]) => command === "save_mail_signature",
  );
  expect(saves.at(-1)?.[1].signature).toMatchObject({ greeting: "您好：" });
  expect(configurations.work.greeting).toBe("您好：");
});
it("previews the greeting above the signature of a configured account", async () => {
  configurations.work = {
    ...emptySignature(),
    enabled: true,
    useHtml: true,
    greeting: "<p>您好：</p>",
    text: "<p>祝工作顺利</p>",
  };
  await selectAccount("个人邮箱");
  await selectAccount("工作邮箱");
  // 默认收起：点折叠按钮后才显示问候语与签名预览。
  await click(collapseToggle());
  const greeting = host.querySelector(
    '[aria-labelledby="greeting-preview-label"]',
  );
  const signature = host.querySelector(
    '[aria-labelledby="signature-preview-label"]',
  );
  expect(greeting).toBeTruthy();
  expect(signature).toBeTruthy();
  expect(
    greeting!.compareDocumentPosition(signature!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
it("collapses and re-expands the settings independently of the enable switch", async () => {
  await click(toggle());
  // 启用不自动展开：默认仍是收起状态。
  expect(host.querySelector("#signature-settings-content")).toBeNull();
  await click(collapseToggle());
  expect(host.querySelector("#signature-settings-content")).toBeTruthy();
  await click(collapseToggle());
  expect(host.querySelector("#signature-settings-content")).toBeNull();
  await click(collapseToggle());
  expect(host.querySelector("#signature-settings-content")).toBeTruthy();
  expect(
    (host.querySelector("#signature-text") as HTMLTextAreaElement).value,
  ).toBe("Saved work signature");
});
it("disables the collapse button until the signature is enabled", () => {
  expect(collapseToggle().disabled).toBe(true);
  expect(collapseToggle().getAttribute("aria-controls")).toBe(
    "signature-settings-content",
  );
});
it("keeps the settings collapsed once the signature is enabled until the collapse button is pressed", async () => {
  expect(host.querySelector("#signature-settings-content")).toBeNull();
  await click(toggle());
  // 启用只切换开关，内容保持收起。
  expect(host.querySelector("#signature-settings-content")).toBeNull();
  await click(collapseToggle());
  expect(host.querySelector("#signature-settings-content")).toBeTruthy();
});
