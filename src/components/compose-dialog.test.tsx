// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ComposeDialog } from "./compose-dialog";
import * as api from "@/lib/api";
import { toast } from "sonner";
import { call, enterDemo, leaveDemo, newDraft, snapshot } from "@/lib/api";
import type { Compose, OutboxRecord } from "@/lib/types";
import { localDateTime } from "@/lib/schedule-time";
let root: Root, host: HTMLDivElement;
let seed: Compose;
let renderHarness: () => Promise<void>;
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (e) =>
      e.textContent?.trim() === label || e.getAttribute("aria-label") === label,
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}
async function input(selector: string, value: string) {
  const e = document.querySelector(selector) as HTMLInputElement;
  await act(async () => {
    const prototype =
      e.tagName === "TEXTAREA"
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(e, value);
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
// 富文本编辑器是 contenteditable，jsdom 里用 DOM 变更 + selectionchange 让 ProseMirror 读回输入。
async function richBody(value: string) {
  const editor = await bodyEditor();
  await act(async () => {
    const paragraph = editor.querySelector("p") ?? editor;
    paragraph.replaceChildren(document.createTextNode(value));
    editor.ownerDocument.dispatchEvent(new Event("selectionchange"));
  });
}
// 富文本编辑器懒加载，等待它替换掉 Suspense 占位。
async function bodyEditor() {
  let element: Element | null = null;
  await vi.waitFor(async () => {
    await act(async () => {});
    element = document.querySelector('[aria-label="邮件正文"]');
    expect(element).toBeTruthy();
  });
  await act(async () => {});
  return element as unknown as HTMLElement;
}
async function format(value: string) {
  await act(async () => {
    document
      .querySelector('button[aria-label="正文格式"]')!
      .dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  const labels: Record<string, string> = {
    rich: "富文本",
    markdown: "Markdown",
    html: "HTML 源码",
  };
  const item = [...document.querySelectorAll('[role="option"]')].find((e) =>
    e.textContent?.includes(labels[value]),
  );
  expect(item).toBeTruthy();
  await act(async () => (item as HTMLElement).click());
}
// DOM 顺序断言：earlier 必须出现在 later 之前
function follows(earlier: Element, later: Element) {
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // 预加载懒加载的富文本编辑器，让 Suspense 只在 act 作用域内解析。
  await act(async () => {
    await import("./rich-editor");
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(cb, 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  localStorage.clear();
  enterDemo();
  const data = await snapshot({
    view: "all",
    accountId: "",
    folder: "",
    search: "",
    limit: 100,
    unreadOnly: false,
  });
  seed = {
    ...newDraft(data.accounts[0].id),
    to: "receiver@example.com",
    subject: "Source test",
  };
  function Harness() {
    const [draft, setDraft] = useState<Compose | null>(seed);
    return (
      <ComposeDialog
        draft={draft}
        accounts={data.accounts}
        onClose={() => setDraft(null)}
        onSent={() => {}}
      />
    );
  }
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  renderHarness = async () => {
    await act(async () => root.render(<Harness key={seed.id} />));
    // 富文本编辑器懒加载：等它挂载，避免后续状态更新落在 act 之外。
    await bodyEditor();
  };
  await renderHarness();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  leaveDemo();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("compose formats and scheduling", () => {
  it("renders original separately, previews delivery, and saves the include-original choice", async () => {
    seed = {
      ...seed,
      id: "quote-test",
      body: "新写内容",
      quote: {
        kind: "forward",
        included: true,
        sender: "lin@example.com",
        recipients: "me@example.com",
        date: "2026-10-01T10:00:00Z",
        subject: "Report",
        body: "Original",
        html: '<style>.report td{color:red}</style><table class="report"><tr><td>Original</td></tr></table>',
      },
    };
    await renderHarness();
    expect((await bodyEditor()).textContent).toBe("新写内容");
    expect(
      document
        .querySelector('iframe[title="引用原文"]')
        ?.getAttribute("srcdoc"),
    ).toContain('<table class="report">');
    await click("发送预览");
    expect(
      document
        .querySelector('iframe[title="发送效果预览正文"]')
        ?.getAttribute("srcdoc"),
    ).toContain("新写内容");
    expect(
      document
        .querySelector('iframe[title="发送效果预览正文"]')
        ?.getAttribute("srcdoc"),
    ).toContain("Original");
    await act(async () =>
      (
        document.querySelector(
          '.delivery-preview-dialog button[data-slot="dialog-close"]',
        ) as HTMLButtonElement
      ).click(),
    );
    const toggle = document.querySelector(
      '[role="switch"]',
    ) as HTMLButtonElement;
    await act(async () => toggle.click());
    expect(document.querySelector('iframe[title="引用原文"]')).toBeNull();
    await click("发送预览");
    expect(
      document
        .querySelector('iframe[title="发送效果预览正文"]')
        ?.getAttribute("srcdoc"),
    ).not.toContain("Original");
    await act(async () =>
      (
        document.querySelector(
          '.delivery-preview-dialog button[data-slot="dialog-close"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await click("保存草稿并关闭");
    const saved = (await call<Compose[]>("list_drafts"))[0];
    expect(saved.quote?.included).toBe(false);
    expect(saved.quote?.html).toContain("<table");
    expect(saved.body).toBe("新写内容");
  });
  it("can maximize and restore without losing typed content", async () => {
    await richBody("Still here");
    await click("最大化写信窗口");
    expect(document.querySelector(".compose-expanded")).toBeTruthy();
    await click("还原写信窗口");
    expect(document.querySelector(".compose-expanded")).toBeNull();
    expect((await bodyEditor()).textContent).toBe("Still here");
  });
  it("saves Markdown source and preview, reopens without switching to rich text", async () => {
    await format("markdown");
    await input(
      'textarea[aria-label="Markdown 源码"]',
      "# Heading\n\n**bold**",
    );
    expect(
      document
        .querySelector('iframe[title="写信正文预览"]')
        ?.getAttribute("srcdoc"),
    ).toContain("<strong>bold</strong>");
    await click("保存草稿并关闭");
    const drafts = await call<Compose[]>("list_drafts");
    expect(drafts[0].format).toBe("markdown");
    expect(drafts[0].source).toContain("**bold**");
    expect(drafts[0].body).not.toContain("**");
  });
  it("offers rich text as the default body mode without a plain text option", async () => {
    await act(async () => {
      document
        .querySelector('button[aria-label="正文格式"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    expect(
      [...document.querySelectorAll('[role="option"]')].map((e) =>
        e.textContent?.trim(),
      ),
    ).toEqual(["富文本", "Markdown", "HTML 源码"]);
    expect(document.querySelector(".rich-editor")).toBeTruthy();
    expect(
      document.querySelector('textarea[aria-label="邮件正文"]'),
    ).toBeNull();
  });
  it("merges the format controls into the editor toolbar in rich text mode", async () => {
    // 富文本是默认模式：格式/预览/导入控件并入编辑器工具条，独立格式栏消失
    expect(document.querySelector(".compose-format")).toBeNull();
    expect(
      document
        .querySelector('button[aria-label="正文格式"]')!
        .closest(".format-toolbar"),
    ).toBeTruthy();
    await format("markdown");
    const formatBar = document.querySelector(".compose-format");
    expect(formatBar).toBeTruthy();
    expect(
      formatBar!.querySelector('button[aria-label="正文格式"]'),
    ).toBeTruthy();
  });
  it("creates a frozen demo plan and cancellation returns a new editable draft", async () => {
    seed = {
      ...seed,
      id: "scheduled-quote",
      quote: {
        kind: "forward",
        included: true,
        sender: "lin@example.com",
        recipients: "",
        date: "2026-10-01T10:00:00Z",
        subject: "Report",
        body: "original quote",
        html: "<p>original quote</p>",
      },
    };
    await renderHarness();
    await format("html");
    await input(
      'textarea[aria-label="HTML 源码"]',
      "<style>td{color:red}</style><table><tr><td>planned</td></tr></table>",
    );
    await click("定时发送");
    const selectedTime = localDateTime(new Date(Date.now() + 86400000));
    await click("选择发送日期");
    const nextDay = new Date(selectedTime);
    const day = document.querySelector(
      `[data-day="${nextDay.toLocaleDateString()}"]`,
    ) as HTMLButtonElement;
    expect(day).toBeTruthy();
    await act(async () => day.click());
    for (const [label, time] of [
      ["发送小时", selectedTime.slice(11, 13)],
      ["发送分钟", selectedTime.slice(14, 16)],
    ]) {
      await act(async () => {
        document
          .querySelector(`button[aria-label="${label}"]`)!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          );
      });
      const option = [...document.querySelectorAll('[role="option"]')].find(
        (e) => e.textContent?.trim() === time,
      );
      expect(option).toBeTruthy();
      await act(async () => (option as HTMLElement).click());
    }
    await click("确认定时发送");
    const records = await call<OutboxRecord[]>("list_outbox");
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("scheduled");
    expect(records[0].scheduledAt).toBe(new Date(selectedTime).toISOString());
    expect(records[0].draft.html).toContain("td{color:red}");
    expect(records[0].draft.deliveryHtml).toContain("original quote");
    expect(records[0].draft.html).not.toContain("original quote");
    expect(await call<Compose[]>("list_drafts")).toHaveLength(0);
    const restored = await call<Compose>("cancel_schedule", { id: seed.id });
    expect(restored.id).not.toBe(seed.id);
    expect(restored.source).toContain("<table>");
    expect(restored.quote?.included).toBe(true);
    expect(restored.quote?.html).toBe("<p>original quote</p>");
    expect((await call<OutboxRecord[]>("list_outbox"))[0].status).toBe(
      "cancelled",
    );
  });
});

it("uses a shadcn confirmation for an empty subject and cancellation keeps the draft", async () => {
  seed = { ...seed, id: "empty-subject", subject: "" };
  await renderHarness();
  await click("定时发送");
  await click("确认定时发送");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
    "邮件主题为空",
  );
  const cancel = [
    ...document.querySelectorAll('[role="alertdialog"] button'),
  ].find(
    (button) => button.textContent?.trim() === "取消",
  ) as HTMLButtonElement;
  await act(async () => cancel.click());
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(document.querySelector(".compose-dialog")).toBeTruthy();
  expect(document.body.textContent).not.toContain("撤销发送 · 8s");
});

describe("signature composition", () => {
  it("loads the account signature, saves a disabled choice and retains the draft snapshot", async () => {
    await call("save_mail_signature", {
      accountId: seed.accountId,
      signature: {
        enabled: true,
        useHtml: false,
        text: "Snapshot signature",
        fileName: "",
        fileText: "",
        fileHtml: "",
      },
    });
    seed = {
      ...seed,
      id: "signature-test",
      body: "正文内容",
      signature: undefined,
    };
    await renderHarness();
    expect(
      document
        .querySelector('iframe[title="本封邮件签名"]')
        ?.getAttribute("srcdoc"),
    ).toContain("Snapshot signature");
    await act(async () =>
      (
        document.querySelector(
          '[id^="include-signature-"]',
        ) as HTMLButtonElement
      ).click(),
    );
    await click("保存草稿并关闭");
    const saved = (await call<Compose[]>("list_drafts")).find(
      (d) => d.id === seed.id,
    )!;
    expect(saved.body).toBe(seed.body);
    expect(saved.signature?.included).toBe(false);
    expect(saved.signature?.body).toBe("Snapshot signature");
    await call("save_mail_signature", {
      accountId: seed.accountId,
      signature: {
        enabled: true,
        useHtml: false,
        text: "Changed settings",
        fileName: "",
        fileText: "",
        fileHtml: "",
      },
    });
    seed = { ...saved, id: "signature-reopen" };
    await renderHarness();
    expect(document.querySelector('iframe[title="本封邮件签名"]')).toBeNull();
    await act(async () =>
      (
        document.querySelector(
          '[id^="include-signature-"]',
        ) as HTMLButtonElement
      ).click(),
    );
    expect(
      document
        .querySelector('iframe[title="本封邮件签名"]')
        ?.getAttribute("srcdoc"),
    ).toContain("Snapshot signature");
    expect(
      document
        .querySelector('iframe[title="本封邮件签名"]')
        ?.getAttribute("srcdoc"),
    ).not.toContain("Changed settings");
  });
});

describe("greeting in the body", () => {
  const greetingSeed = (id: string) => ({
    ...seed,
    id,
    body: "正文内容",
    signature: {
      accountId: seed.accountId,
      included: true,
      greeting: "您好：",
      greetingHtml: "",
      body: "祝您工作顺利",
      html: "",
    },
  });
  it("puts the account greeting into the editable body as its first line", async () => {
    seed = { ...greetingSeed("greeting-first-line"), body: "" };
    await renderHarness();
    // 问候语不再是正文上方的预览块，而是可编辑正文的第一行
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
    const body = (await bodyEditor()) as HTMLElement;
    expect(body.querySelectorAll("p")[0].textContent).toBe("您好：");
    expect(document.querySelector(".compose-editor")!.className).toContain(
      "with-signature",
    );
    follows(document.querySelector(".format-toolbar")!, body);
    expect(
      document
        .querySelector('iframe[title="本封邮件签名"]')
        ?.getAttribute("srcdoc"),
    ).toContain("祝您工作顺利");
  });
  it("keeps the greeting out of the way when the draft already has a body", async () => {
    seed = greetingSeed("greeting-existing-body");
    await renderHarness();
    expect((await bodyEditor()).textContent).toBe("正文内容");
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
  });
  it("puts the toolbar right under the subject row in rich text mode", async () => {
    seed = greetingSeed("greeting-toolbar-order");
    await renderHarness();
    const editor = document.querySelector(".compose-editor")!;
    const subjectRow = document
      .querySelector("#subject")!
      .closest(".compose-row")!;
    // 主题行之后直接进入正文区，工具条是其中的第一个元素
    expect(subjectRow.nextElementSibling).toBe(editor);
    expect(editor.querySelector(".compose-format")).toBeNull();
    const toolbar = document.querySelector(".format-toolbar")!;
    expect(toolbar.closest(".compose-editor")).toBe(editor);
    follows(subjectRow, toolbar);
    expect(editor.previousElementSibling).toBe(subjectRow);
  });
  it("leaves the greeting to send time in markdown mode", async () => {
    seed = {
      ...seed,
      id: "greeting-markdown",
      body: "正文内容",
      signature: {
        accountId: seed.accountId,
        included: true,
        greeting: "您好：",
        greetingHtml: "<p>您好：</p>",
        body: "祝您工作顺利",
        html: "",
      },
    };
    await renderHarness();
    await format("markdown");
    const editor = document.querySelector(".compose-editor")!;
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
    expect(document.querySelector(".rich-editor")).toBeNull();
    expect(
      (
        document.querySelector(
          'textarea[aria-label="Markdown 源码"]',
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("正文内容");
    expect(
      document
        .querySelector(".compose-format")!
        .compareDocumentPosition(editor) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // 问候语不在编辑区，发送时才拼到正文之前
    await click("发送预览");
    expect(
      document
        .querySelector('iframe[title="发送效果预览正文"]')
        ?.getAttribute("srcdoc"),
    ).toContain("data-yanxin-greeting");
  });
  it("reads the HTML greeting snapshot into the first editable line", async () => {
    seed = {
      ...seed,
      id: "greeting-html",
      signature: {
        accountId: seed.accountId,
        included: true,
        greeting: "您好：",
        greetingHtml: "<p><b>尊敬的</b>同事：</p>",
        body: "落款",
        html: "",
      },
    };
    await renderHarness();
    expect((await bodyEditor()).querySelector("p")!.textContent).toBe(
      "尊敬的同事：",
    );
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
  });
  it("greets nothing when the account has none or it is switched off", async () => {
    seed = {
      ...seed,
      id: "greeting-none",
      signature: {
        accountId: seed.accountId,
        included: true,
        greeting: "",
        greetingHtml: "",
        body: "落款",
        html: "",
      },
    };
    await renderHarness();
    expect((await bodyEditor()).textContent).toBe("");
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
    seed = {
      ...seed,
      id: "greeting-off",
      signature: {
        accountId: seed.accountId,
        included: false,
        greeting: "您好：",
        greetingHtml: "",
        body: "落款",
        html: "",
      },
    };
    await renderHarness();
    expect((await bodyEditor()).textContent).toBe("");
    expect(document.querySelector('iframe[title="本封邮件问候语"]')).toBeNull();
    expect(document.querySelector(".compose-editor")?.className).not.toContain(
      "with-signature",
    );
  });
});

describe("empty drafts", () => {
  it("never autosaves a new empty message with an automatic signature and discards it on close", async () => {
    seed = {
      ...newDraft(seed.accountId),
      id: "blank-new",
      signature: {
        accountId: seed.accountId,
        included: true,
        greeting: "",
        greetingHtml: "",
        body: "Automatic signature",
        html: "<p>Automatic signature</p>",
      },
    };
    await renderHarness();
    expect(document.body.textContent).toContain("空白邮件不会保存");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(await call<Compose[]>("list_drafts")).toEqual([]);
    await click("舍弃空白邮件");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(await call<Compose[]>("list_drafts")).toEqual([]);
  });
  it("still saves a message that only has a recipient", async () => {
    seed = {
      ...newDraft(seed.accountId),
      id: "recipient-only",
      to: "recipient@example.com",
    };
    await renderHarness();
    await click("保存草稿并关闭");
    expect(
      (await call<Compose[]>("list_drafts")).find((d) => d.id === seed.id)?.to,
    ).toBe("recipient@example.com");
  });
  it("waits for an in-flight autosave before deleting content that was cleared, so the draft cannot reappear", async () => {
    seed = { ...newDraft(seed.accountId), id: "blank-after-edit" };
    await renderHarness();
    const original = api.call;
    let finishSave!: () => Promise<void>;
    vi.spyOn(api, "call").mockImplementation(
      async <T,>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "save_draft")
          return new Promise<T>((resolve) => {
            finishSave = async () => {
              const result = await original<T>(command, args);
              resolve(result);
            };
          });
        return original<T>(command, args);
      },
    );
    await richBody("Temporary content");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(finishSave).toBeTypeOf("function");
    await richBody("");
    await click("舍弃空白邮件");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => finishSave());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700));
    });
    expect(await call<Compose[]>("list_drafts")).toEqual([]);
  });
  it("keeps the editor open and reports a failure when empty-draft cleanup fails", async () => {
    seed = { ...newDraft(seed.accountId), id: "blank-delete-fails" };
    await renderHarness();
    const original = api.call;
    const error = vi.spyOn(toast, "error").mockReturnValue(0);
    vi.spyOn(api, "call").mockImplementation(
      async <T,>(command: string, args: Record<string, unknown> = {}) => {
        if (command === "delete_draft") throw new Error("database unavailable");
        return original<T>(command, args);
      },
    );
    await click("舍弃空白邮件");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(error).toHaveBeenCalledWith(
      "空白邮件舍弃失败：Error: database unavailable",
    );
  });
});
