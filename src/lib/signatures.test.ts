// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  emptySignature,
  signatureContent,
  importSignature,
  greetingSpec,
} from "./signatures";
import { FONT_OPTIONS } from "./fonts";
describe("signature imports", () => {
  it("does not activate an empty signature and keeps account identity", () => {
    const value = signatureContent("a", { ...emptySignature(), enabled: true });
    expect(value.included).toBe(false);
    expect(value.accountId).toBe("a");
  });
  it("renders HTML with a plain alternative and removes active content", () => {
    const value = signatureContent("a", {
      ...emptySignature(),
      enabled: true,
      useHtml: true,
      text: '<b>Alex</b><script>alert(1)</script><img src="x" onerror="bad()">',
    });
    expect(value.included).toBe(true);
    expect(value.body).toContain("Alex");
    expect(value.html).not.toMatch(/<script|onerror/);
  });
  it("rejects unsupported and oversized signature files", async () => {
    await expect(
      importSignature(new File(["x"], "unsafe.svg", { type: "image/svg+xml" })),
    ).rejects.toThrow("请选择");
    await expect(
      importSignature(new File(["x".repeat(2 * 1024 * 1024 + 1)], "big.txt")),
    ).rejects.toThrow("2 MB");
  });
  it("snapshots imported image bytes rather than persisting a local path", async () => {
    const result = await importSignature(
      new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" }),
    );
    expect(result.fileHtml).toContain("data:image/png;base64,AQID");
    expect(result.fileName).toBe("logo.png");
    expect(
      signatureContent("a", { ...emptySignature(), enabled: true, ...result })
        .included,
    ).toBe(true);
  });
  it("带出每账号问候语快照：纯文本转 html、HTML 模式保留、空值不透传", () => {
    const base = { ...emptySignature(), enabled: true };
    expect(
      signatureContent("a", { ...base, greeting: "您好：" }),
    ).toMatchObject({
      greeting: "您好：",
      greetingHtml: "",
    });
    expect(
      signatureContent("a", {
        ...base,
        useHtml: true,
        greeting: "<b>您好</b>：",
      }),
    ).toMatchObject({
      greeting: "您好：",
      greetingHtml: expect.stringContaining("<b>您好</b>"),
    });
    expect(signatureContent("a", { ...base, text: "落款" })).toMatchObject({
      greeting: "",
      greetingHtml: "",
    });
    // 只配问候语（无落款）也应启用
    expect(
      signatureContent("a", { ...base, greeting: "您好：" }).included,
    ).toBe(true);
  });
});

describe("greeting spec", () => {
  const kaiti = FONT_OPTIONS.find((option) => option.label === "楷体")!.stack;
  it("reads the text, font family and size out of the configured greeting HTML", () => {
    // 用户真实配置：div 未闭合、行尾带换行，DOMParser 会自动闭合
    expect(
      greetingSpec(
        "您好：",
        '<div style="font-family:楷体, KaiTi, STKaiti; font-size:16pt;">您好：\n',
      ),
    ).toEqual({ text: "您好：", fontFamily: kaiti, fontSize: "16pt" });
  });
  it("falls back to the plain greeting text without styling", () => {
    expect(greetingSpec("您好：", "")).toEqual({
      text: "您好：",
      fontFamily: null,
      fontSize: null,
    });
    expect(
      greetingSpec("您好：", '<div style="font-family:Arial;">您好：</div>'),
    ).toMatchObject({ text: "您好：", fontFamily: null, fontSize: null });
  });
  it("returns null for empty text and for greetings that are not a single line", () => {
    expect(greetingSpec("", "")).toBeNull();
    expect(greetingSpec("   ", "")).toBeNull();
    expect(greetingSpec("您好：", "<div><br>您好：</div>")).toBeNull();
    expect(
      greetingSpec(
        "您好：",
        '<div><img src="data:image/png;base64,aA=="></div>',
      ),
    ).toBeNull();
  });
});
