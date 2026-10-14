// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  compileSource,
  composeFormat,
  hasDraftContent,
  prepareCompose,
  prepareEditorCompose,
} from "./compose-format";
import { newDraft } from "./api";
import { FONT_DEFAULT, SIZE_DEFAULT } from "./fonts";
describe("mail source formats", () => {
  it("renders GFM headings, tables, lists and code with a readable plain alternative", () => {
    const content = compileSource(
      "# 周报\n\n**完成**\n\n- 邮件\n- 存档\n\n| 模块 | 状态 |\n|---|---|\n| 收信 | 完成 |\n\n```ts\nconst value = 1\n```",
      "markdown",
    );
    expect(content.html).toContain("<h1>周报</h1>");
    expect(content.html).toContain("<strong>完成</strong>");
    expect(content.html).toContain("<ul>");
    expect(content.html).toContain("<table style=");
    expect(content.body).toContain("收信\t完成");
    expect(content.body).toContain("const value = 1");
    expect(content.body).not.toContain("**");
  });
  it("keeps HTML document styles and table layout while excluding executable content", () => {
    const result = compileSource(
      '<html><head><style>.invoice{color:red}</style></head><body class="invoice"><table><tr><td>Invoice</td><td>42</td></tr></table><script>alert(1)</script><img src="https://example.com/logo.png" onerror="alert(1)"><a href="javascript:alert(1)">bad</a></body></html>',
      "html",
    );
    expect(result.html).toContain(".invoice{color:red}");
    expect(result.html).toContain('class="invoice"');
    expect(result.html).toContain("<table>");
    expect(result.html).not.toMatch(/<script|onerror|javascript:/i);
    expect(result.body).toContain("Invoice\t42");
    expect(result.body).not.toContain("color:red");
  });
  it("sanitizes embedded Markdown HTML and never interprets fenced source as markup", () => {
    const result = compileSource(
      "```html\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(2)>",
      "markdown",
    );
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toMatch(/<script|onerror=/);
  });
  it("recompiles source at send time and retains the editable source with legacy draft compatibility", () => {
    const d = {
      ...newDraft("account"),
      format: "markdown" as const,
      source: "**Newest**",
      html: "<p>stale</p>",
      body: "stale",
    };
    const result = prepareCompose(d);
    expect(result.html).toContain("<strong>Newest</strong>");
    expect(result.source).toBe("**Newest**");
    expect(result.body).toBe("Newest");
    expect(
      composeFormat({ ...newDraft("account"), html: "<p>old rich draft</p>" }),
    ).toBe("rich");
    expect(composeFormat(newDraft("account"))).toBe("rich");
    expect(composeFormat({ ...newDraft("account"), format: "plain" })).toBe(
      "rich",
    );
  });
  it("preserves original HTML tables, CSS, body attributes and images outside the editor", () => {
    const draft = {
      ...newDraft("account"),
      body: "我写的回复 <OK>",
      quote: {
        kind: "forward" as const,
        included: true,
        sender: "Lin <lin@example.com>",
        recipients: "me@example.com",
        date: "2026-10-01T10:00:00+08:00",
        subject: "<周报>",
        body: "原文正文",
        html: '<html><head><style>.report td{color:red}</style></head><body class="report"><table><tr><td>原文正文</td></tr></table><img src="data:image/png;base64,aGVsbG8="></body></html>',
      },
    };
    const result = prepareCompose(draft);
    expect(result.body).toBe(draft.body);
    expect(result.html || "").toBe("");
    expect(result.deliveryHtml).toContain(".report td{color:red}");
    expect(result.deliveryHtml).toContain('class="report"');
    expect(result.deliveryHtml).toContain("<table>");
    expect(result.deliveryHtml).toContain("data:image/png;base64,aGVsbG8=");
    expect(result.deliveryHtml).toContain("&lt;OK&gt;");
    expect(result.deliveryHtml).toContain("&lt;周报&gt;");
    expect(result.deliveryBody).toContain("收件人：me@example.com");
    expect(prepareCompose(result)).toEqual(result);
    expect(prepareEditorCompose(result).body).toBe(draft.body);
    const excluded = prepareCompose({
      ...result,
      quote: { ...result.quote!, included: false },
    });
    expect(excluded.deliveryBody).toBe(draft.body);
    expect(excluded.deliveryHtml).toBe("");
  });
  it("combines authored Markdown with HTML original without contaminating editable source", () => {
    const result = prepareCompose({
      ...newDraft("account"),
      format: "markdown",
      source: "**回复内容**",
      quote: {
        kind: "reply",
        included: true,
        sender: "lin@example.com",
        recipients: "",
        date: "2026-10-01T10:00:00Z",
        subject: "周报",
        body: "原文",
        html: "<table><tr><td>原文</td></tr></table>",
      },
    });
    expect(result.deliveryHtml).toContain("<strong>回复内容</strong>");
    expect(result.deliveryHtml).toContain("<table>");
    expect(result.deliveryBody).toContain("原文");
    expect(result.deliveryBody).not.toContain("收件人：");
    expect(result.source).toBe("**回复内容**");
    expect(result.body).toBe("回复内容");
    expect(result.html).not.toContain("原文");
  });
});

describe("account signatures", () => {
  it("adds signature before the quote, preserves editable content and never doubles it", () => {
    const draft = {
      ...newDraft("a"),
      body: "Reply text",
      signature: {
        accountId: "a",
        included: true,
        greeting: "",
        greetingHtml: "",
        body: "Regards\nAlex",
        html: '<p><b>Regards</b><br>Alex</p><img src="data:image/png;base64,aGVsbG8=">',
      },
      quote: {
        kind: "reply" as const,
        included: true,
        sender: "other@example.com",
        recipients: "",
        date: "2026-10-01T00:00:00Z",
        subject: "Example",
        body: "Original",
        html: "<p>Original</p>",
      },
    };
    const result = prepareCompose(draft);
    expect(result.body).toBe("Reply text");
    expect(result.deliveryBody!.indexOf("Alex")).toBeLessThan(
      result.deliveryBody!.indexOf("Original"),
    );
    expect(result.deliveryHtml).toContain("data-yanxin-signature");
    expect(result.deliveryHtml).toContain("data:image/png;base64,aGVsbG8=");
    expect(prepareCompose(result)).toEqual(result);
    const excluded = prepareCompose({
      ...result,
      signature: { ...result.signature!, included: false },
    });
    expect(excluded.deliveryBody).not.toContain("Alex");
    expect(excluded.deliveryHtml).not.toContain("data-yanxin-signature");
  });
  it("keeps a plain signature plain and escapes user markup in the HTML alternative", () => {
    const draft = {
      ...newDraft("a"),
      body: "<Authored>",
      signature: {
        accountId: "a",
        included: true,
        greeting: "",
        greetingHtml: "",
        body: "<Name>",
        html: "",
      },
    };
    expect(prepareCompose(draft).deliveryBody).toBe("<Authored>\n\n<Name>");
    expect(prepareCompose(draft).deliveryHtml).toBe("");
    expect(
      prepareCompose({ ...draft, html: "<p>Authored</p>" }).deliveryHtml,
    ).toContain("&lt;Name&gt;");
  });
  it("sends the greeting before the body and the signature after it", () => {
    const editor = {
      ...newDraft("a"),
      body: "正文内容",
      signature: {
        accountId: "a",
        included: true,
        greeting: "您好：",
        greetingHtml: "",
        body: "祝您工作顺利",
        html: "",
      },
    };
    expect(prepareCompose(editor).deliveryBody).toBe(
      "您好：\n\n正文内容\n\n祝您工作顺利",
    );
  });
  it("prepends the greeting node and appends the signature node in HTML", () => {
    const editor = {
      ...newDraft("a"),
      body: "正文",
      html: "<p>正文</p>",
      signature: {
        accountId: "a",
        included: true,
        greeting: "您好",
        greetingHtml: "<p>您好：</p>",
        body: "祝好",
        html: "<p>祝好</p>",
      },
    };
    const html = prepareCompose(editor).deliveryHtml!;
    const greetingAt = html.indexOf("data-yanxin-greeting");
    const bodyAt = html.indexOf("<p>正文</p>");
    const signatureAt = html.indexOf("data-yanxin-signature");
    expect(greetingAt).toBeGreaterThan(-1);
    expect(greetingAt).toBeLessThan(bodyAt);
    expect(bodyAt).toBeLessThan(signatureAt);
  });
  it("keeps the delivery unchanged when no greeting is configured", () => {
    const editor = {
      ...newDraft("a"),
      body: "正文",
      signature: {
        accountId: "a",
        included: true,
        greeting: "",
        greetingHtml: "",
        body: "落款",
        html: "",
      },
    };
    expect(prepareCompose(editor).deliveryBody).toBe("正文\n\n落款");
    expect(prepareCompose(editor).deliveryHtml).toBe("");
  });
  it("does not greet twice when the body already starts with the greeting", () => {
    const signature = {
      accountId: "a",
      included: true,
      greeting: "您好：",
      greetingHtml:
        '<div style="font-family:楷体;font-size:16pt;">您好：</div>',
      body: "祝您工作顺利",
      html: "",
    };
    const greeted = {
      ...newDraft("a"),
      body: "您好：\n正文内容",
      html: '<p><span style="font-family:楷体;font-size:16pt;">您好：</span></p><p>正文内容</p>',
      signature,
    };
    const text = prepareCompose(greeted).deliveryBody!;
    expect(text.match(/您好：/g)!.length).toBe(1);
    expect(text).toBe("您好：\n正文内容\n\n祝您工作顺利");
    const html = prepareCompose(greeted).deliveryHtml!;
    expect(html.match(/您好：/g)!.length).toBe(1);
    expect(html).not.toContain("data-yanxin-greeting");
    expect(html).toContain("data-yanxin-signature");
    // 草稿里还没有问候语时照旧拼接
    expect(
      prepareCompose({ ...greeted, body: "正文内容", html: "<p>正文内容</p>" })
        .deliveryBody,
    ).toBe("您好：\n\n正文内容\n\n祝您工作顺利");
    expect(
      prepareCompose({ ...greeted, body: "正文内容", html: "<p>正文内容</p>" })
        .deliveryHtml,
    ).toContain("data-yanxin-greeting");
  });
});

describe("default font in delivered HTML", () => {
  const styledSignature = {
    accountId: "a",
    included: true,
    greeting: "您好：",
    greetingHtml:
      '<div style="font-family:楷体, KaiTi, Kaiti SC, STKaiti, serif;font-size:16pt;">您好：</div>',
    body: "祝好",
    html: '<p style="font-family:楷体, KaiTi, Kaiti SC, STKaiti, serif;">祝好</p>',
  };
  const wrapperOf = (html: string) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body.firstElementChild as HTMLElement;
  };
  it("wraps the signed delivery HTML in a div carrying the default font", () => {
    const html = prepareCompose({
      ...newDraft("a"),
      body: "正文",
      html: "<p>正文</p>",
      signature: styledSignature,
    }).deliveryHtml!;
    expect(html).toContain("font-family");
    const wrapper = wrapperOf(html);
    expect(wrapper.tagName).toBe("DIV");
    expect(wrapper.style.fontFamily).toBe(FONT_DEFAULT);
    expect(wrapper.style.fontSize).toBe(SIZE_DEFAULT);
    // 问候语、正文、落款都在包裹内，各自字体不被默认字体覆盖
    expect(wrapper.querySelector("[data-yanxin-greeting]")).toBeTruthy();
    expect(wrapper.querySelector("[data-yanxin-signature]")).toBeTruthy();
    expect(wrapper.querySelector("p")!.textContent).toBe("正文");
    const greeting = wrapper.querySelector<HTMLElement>(
      "[data-yanxin-greeting] div",
    )!;
    expect(greeting.style.fontFamily).toContain("楷体");
    expect(greeting.style.fontSize).toBe("16pt");
    expect(
      wrapper.querySelector<HTMLElement>("[data-yanxin-signature] p")!.style
        .fontFamily,
    ).toContain("楷体");
  });
  it("applies the default font wrapper even when the signature is disabled", () => {
    const html = prepareCompose({
      ...newDraft("a"),
      body: "正文",
      html: "<p>正文</p>",
    }).deliveryHtml!;
    const wrapper = wrapperOf(html);
    expect(wrapper.style.fontFamily).toBe(FONT_DEFAULT);
    expect(wrapper.style.fontSize).toBe(SIZE_DEFAULT);
    expect(wrapper.innerHTML).toBe("<p>正文</p>");
  });
  it("leaves plain-text mail unwrapped", () => {
    const result = prepareCompose({ ...newDraft("a"), body: "正文" });
    expect(result.deliveryHtml).toBe("");
    expect(result.deliveryHtml).not.toContain("font-family");
  });
});

describe("draft content detection", () => {
  it("ignores the selected sender, automatic signature and empty rich text markup", () => {
    const draft = newDraft("work");
    draft.signature = {
      accountId: "work",
      included: true,
      greeting: "",
      greetingHtml: "",
      body: "Automatic signature",
      html: "<p>Automatic signature</p>",
    };
    expect(hasDraftContent(draft)).toBe(false);
    expect(
      hasDraftContent({ ...draft, body: " \n\t ", html: "<p>&nbsp;<br></p>" }),
    ).toBe(false);
  });
  it("treats a body that only repeats the greeting as an empty draft", () => {
    const draft = {
      ...newDraft("work"),
      // 问候语作为正文第一行写进草稿后的样子：称呼段 + 空正文行
      body: "您好：\n",
      html: '<p data-yanxin-greeting="true"><span style="font-family:楷体;font-size:16pt;">您好：</span></p><p></p>',
      signature: {
        accountId: "work",
        included: true,
        greeting: "您好：",
        greetingHtml: "",
        body: "祝您工作顺利",
        html: "",
      },
    };
    expect(hasDraftContent(draft)).toBe(false);
    // 真的在问候语下面写了正文就照旧存草稿
    expect(hasDraftContent({ ...draft, body: "您好：\n正文内容" })).toBe(true);
    expect(
      hasDraftContent({
        ...draft,
        html: `${draft.html}<p><img src="data:image/png;base64,aA=="></p>`,
      }),
    ).toBe(true);
    // 填了收件人一样保留
    expect(hasDraftContent({ ...draft, to: "me@example.com" })).toBe(true);
  });
  it("preserves recipients, subject, attachments, visible HTML resources and reply context", () => {
    const draft = newDraft("work");
    for (const fields of [
      { to: "recipient@example.com" },
      { cc: "copy@example.com" },
      { bcc: "hidden@example.com" },
      { subject: "Subject" },
      { body: "Content" },
      { attachments: ["/test/attachment.txt"] },
      { html: '<img src="data:image/png;base64,aA==">' },
      { inReplyTo: "<reply@example.com>" },
      { format: "html" as const, source: "<p></p>" },
    ])
      expect(hasDraftContent({ ...draft, ...fields })).toBe(true);
  });
});
