import type { ComposeSignature, MailSignature } from "./types";
import { htmlToText, sanitizeComposeHtml, textToHtml } from "./compose-format";
import { canonicalFontFamily } from "./fonts";
export const emptySignature = (): MailSignature => ({
  enabled: false,
  useHtml: false,
  text: "",
  greeting: "",
  fileName: "",
  fileText: "",
  fileHtml: "",
});
export function signatureContent(
  accountId: string,
  signature: MailSignature,
): ComposeSignature {
  const html = [
    signature.useHtml
      ? sanitizeComposeHtml(signature.text)
      : textToHtml(signature.text),
    signature.fileHtml || textToHtml(signature.fileText),
  ]
    .filter(Boolean)
    .join("\n");
  const body = [
    signature.useHtml ? htmlToText(signature.text) : signature.text,
    signature.fileText || htmlToText(signature.fileHtml),
  ]
    .filter(Boolean)
    .join("\n");
  const greeting = signature.useHtml
    ? htmlToText(signature.greeting)
    : signature.greeting;
  const greetingHtml =
    signature.greeting && signature.useHtml
      ? sanitizeComposeHtml(signature.greeting)
      : "";
  return {
    accountId,
    included:
      signature.enabled &&
      !!(
        body.trim() ||
        htmlToText(html) ||
        /<img\b/i.test(html) ||
        greeting.trim()
      ),
    greeting,
    greetingHtml,
    body,
    html:
      signature.useHtml || signature.fileHtml ? sanitizeComposeHtml(html) : "",
  };
}
export type GreetingSpec = {
  text: string;
  fontFamily: string | null;
  fontSize: string | null;
};
// 问候语并入正文第一行：解析出纯文本与签名里配置的字体字号，插入时带回样式。
// 旧草稿的签名快照可能没有问候语字段，按空处理。
export function greetingSpec(
  greeting: string | undefined,
  greetingHtml: string | undefined,
): GreetingSpec | null {
  const html = greetingHtml?.trim() || textToHtml(greeting || "");
  if (!html.trim()) return null;
  // 图片或换行撑不出「第一行」，调用方回退整块 HTML 插入。
  if (/<img\b|<br\b/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const target: HTMLElement =
    (doc.body.firstElementChild as HTMLElement | null) ?? doc.body;
  const text = (target.textContent || "").trim();
  if (!text) return null;
  return {
    text,
    fontFamily: canonicalFontFamily(target.style.fontFamily || ""),
    fontSize: target.style.fontSize || null,
  };
}
export async function importSignature(file: File) {
  if (file.size > 2 * 1024 * 1024) throw new Error("签名文件不能超过 2 MB");
  if (/\.(txt|html?|htm)$/i.test(file.name)) {
    const content = await file.text();
    const html = /\.html?$/i.test(file.name)
      ? sanitizeComposeHtml(content)
      : "";
    return {
      fileName: file.name,
      fileText: html ? htmlToText(html) : content,
      fileHtml: html,
    };
  }
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type))
    throw new Error("请选择文本、HTML、PNG、JPEG、GIF 或 WebP 文件");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取签名图片"));
    reader.readAsDataURL(file);
  });
  const image = document.createElement("img");
  image.src = data;
  image.alt = file.name;
  image.style.cssText = "max-width:480px;max-height:180px;height:auto";
  return {
    fileName: file.name,
    fileText: `[图片签名：${file.name}]`,
    fileHtml: image.outerHTML,
  };
}
