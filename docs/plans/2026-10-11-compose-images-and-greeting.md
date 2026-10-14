# 写信正文图片与签名问候语 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 写信正文默认支持「文字+图片」一体（富文本内嵌图片，移除纯文本模式），签名支持「问候语+正文+落款」三段式。

**Architecture:** 富文本（Tiptap）新增 Image 扩展与粘贴/拖拽/按钮插入，图片经 canvas 压缩为 data URL 内嵌于正文 HTML；发送沿用现有 `inline_images()`（data URL→cid→multipart/related，MIME 已是 multipart/alternative）。签名数据模型增加 greeting/greetingHtml（serde default 兼容旧数据），`withSignature` 发送时前置问候语，写信窗口三段式预览。

**Tech Stack:** Tauri + React + TypeScript + Tiptap 3 + shadcn/ui + Rust(rusqlite/lettre)。新增依赖 `@tiptap/extension-image@^3.31.3`。

**设计文档:** `docs/plans/2026-10-11-compose-images-and-greeting-design.md`

**发布口径:** 本计划不包含版本号调整；装机验证后与用户确认落入 0.1.4 修订还是 0.1.5（上游移植仍在搁置）。

---

### Task 1: Rust 签名问候语字段

**Files:**
- Modify: `src-tauri/src/signatures.rs`（MailSignature 加 greeting；ComposeSignature 加 greeting/greetingHtml；现有测试补字段）
- Test: `src-tauri/src/signatures.rs` 内 `mod tests`

**Step 1: 改结构体**

`MailSignature` 在 `use_html` 后加：
```rust
    #[serde(default)]
    pub greeting: String,
```
`ComposeSignature` 在 `included` 后加：
```rust
    #[serde(default)]
    pub greeting: String,
    #[serde(default)]
    pub greeting_html: String,
```

**Step 2: 修现有测试**

`draft_roundtrip_preserves_signature_snapshot_and_disabled_choice`（第 100 行）的 `ComposeSignature { ... }` 补 `greeting: "您好：".into(), greeting_html: "".into(),`。

**Step 3: 写新测试（先跑至失败/编译失败）**

```rust
    #[test]
    fn greeting_fields_roundtrip_and_legacy_rows_deserialize() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::new(dir.path().into()).unwrap();
        let a = crate::tests::account();
        store.save_account(&a).unwrap();
        let s = MailSignature {
            enabled: true,
            greeting: "您好：".into(),
            text: "祝您工作顺利".into(),
            ..Default::default()
        };
        store.save_mail_signature(&a.id, &s).unwrap();
        assert_eq!(
            Store::new(dir.path().into())
                .unwrap()
                .mail_signature(&a.id)
                .unwrap()
                .greeting,
            "您好："
        );
        // 旧 preferences 行（无 greeting 字段）反序列化为空
        let legacy = serde_json::json!({"enabled": true, "useHtml": false, "text": "t", "fileName": "", "fileText": "", "fileHtml": ""});
        let old: MailSignature = serde_json::from_value(legacy).unwrap();
        assert!(old.greeting.is_empty());
        // 旧草稿签名快照（无问候语字段）
        let mut value = serde_json::to_value(crate::tests::draft()).unwrap();
        value["signature"] = serde_json::json!({"accountId": "a", "included": true, "body": "b", "html": ""});
        let draft: crate::models::Compose = serde_json::from_value(value).unwrap();
        assert!(draft.signature.unwrap().greeting.is_empty());
    }
```

**Step 4: 验证**

Run: `cargo test --manifest-path src-tauri/Cargo.toml signatures`
Expected: 全绿（原 3 + 新 1）。

**Step 5: Commit**

```bash
git add src-tauri/src/signatures.rs
git commit -m "feat: 签名增加问候语字段（serde default 兼容旧数据）"
```

---

### Task 2: 前端签名类型与快照

**Files:**
- Modify: `src/lib/types.ts`（MailSignature 加 `greeting: string`；ComposeSignature 加 `greeting: string; greetingHtml: string`）
- Modify: `src/lib/signatures.ts`（emptySignature 加 greeting:""；signatureContent 带出问候语）
- Test: `src/lib/signatures.test.ts`

**Step 1: 写失败测试**

```ts
it("带出每账号问候语快照：纯文本转 html、HTML 模式保留、空值不透传", () => {
  const base = { ...emptySignature(), enabled: true };
  expect(signatureContent("a", { ...base, greeting: "您好：" })).toMatchObject({
    greeting: "您好：",
    greetingHtml: "",
  });
  expect(
    signatureContent("a", { ...base, useHtml: true, greeting: "<b>您好</b>：" }),
  ).toMatchObject({ greeting: "您好：", greetingHtml: expect.stringContaining("<b>您好</b>") });
  expect(signatureContent("a", { ...base, text: "落款" })).toMatchObject({
    greeting: "",
    greetingHtml: "",
  });
  // 只配问候语也应启用
  expect(signatureContent("a", { ...base, greeting: "您好：" }).included).toBe(true);
});
```

**Step 2: 实现**

`signatureContent` 返回体增加：
```ts
  const greeting = signature.useHtml
    ? htmlToText(signature.greeting)
    : signature.greeting;
  const greetingHtml = signature.greeting
    ? signature.useHtml
      ? sanitizeComposeHtml(signature.greeting)
      : textToHtml(signature.greeting)
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
    html: ...（不变）,
  };
```

**Step 3: 验证** `npx vitest run src/lib/signatures.test.ts` → 绿。

**Step 4: Commit** `feat: 前端签名模型支持问候语快照`

---

### Task 3: withSignature 前置问候语

**Files:**
- Modify: `src/lib/compose-format.ts`（重构 withSignature，提取 signaturePart 助手）
- Test: `src/lib/compose-format.test.ts`

**Step 1: 写失败测试**

```ts
it("发送时拼接 问候语+正文+落款", () => {
  const editor = {
    ...draft,
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
  expect(prepareCompose(editor).deliveryBody).toBe("您好：\n\n正文内容\n\n祝您工作顺利");
});
it("HTML 态问候语节点前置、落款节点后置", () => {
  const editor = {
    ...draft,
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
it("问候语为空时行为不变", () => {
  const editor = { ...draft, body: "正文", signature: { ...snapshot, greeting: "", greetingHtml: "" } };
  expect(prepareCompose(editor).deliveryBody).toBe("正文\n\n" + snapshot.body);
});
```
（`draft`/`snapshot` 用测试文件里现有夹具或最小构造。）

**Step 2: 实现**（完整替换 withSignature，提取助手）

```ts
function signaturePart(
  doc: Document,
  html: string,
  marker: "data-yanxin-greeting" | "data-yanxin-signature",
  margin: "marginBottom" | "marginTop",
) {
  const part = doc.createElement("div");
  const content = new DOMParser().parseFromString(
    sanitizeComposeHtml(html),
    "text/html",
  );
  for (const attribute of content.body.attributes)
    part.setAttribute(attribute.name, attribute.value);
  for (const style of content.head.querySelectorAll("style"))
    doc.head.append(doc.importNode(style, true));
  part.setAttribute(marker, "true");
  part.style[margin] = "24px";
  part.replaceChildren(
    ...[...content.body.childNodes].map((n) => doc.importNode(n, true)),
  );
  return part;
}

function withSignature(editor: Compose) {
  if (!editor.signature?.included)
    return { body: editor.body, html: editor.html || "" };
  const signature = editor.signature;
  const body = [signature.greeting, editor.body, signature.body]
    .filter(Boolean)
    .join("\n\n");
  if (!editor.html && !signature.html && !signature.greetingHtml)
    return { body, html: "" };
  const doc = new DOMParser().parseFromString(
    sanitizeComposeHtml(editor.html || textToHtml(editor.body)),
    "text/html",
  );
  if (signature.greetingHtml)
    doc.body.prepend(
      signaturePart(doc, signature.greetingHtml, "data-yanxin-greeting", "marginBottom"),
    );
  if (signature.html || signature.body)
    doc.body.append(
      signaturePart(
        doc,
        signature.html || textToHtml(signature.body),
        "data-yanxin-signature",
        "marginTop",
      ),
    );
  return { body, html: sanitizeComposeHtml(doc.documentElement.outerHTML) };
}
```

**Step 3: 验证** `npx vitest run src/lib/compose-format.test.ts` → 绿；确认既有用例（引用原文、定时发送）不回归。

**Step 4: Commit** `feat: 发送时拼接问候语（文本/HTML 双态）`

---

### Task 4: 签名设置页问候语编辑区

**Files:**
- Modify: `src/components/mail-signatures.tsx`
- Test: `src/components/mail-signatures.test.tsx`

**Step 1: 写失败测试**（参照现有测试风格）

- 渲染出「问候语」编辑区（`htmlFor`/label 含"问候语"），位于签名编辑区之前
- 输入问候语后保存，`save_mail_signature` 收到的 signature.greeting 有值
- 预览区问候语渲染在签名落款上方

**Step 2: 实现**

- 现有 `useHtml` Switch 同时管辖问候语与签名（不新增开关）：问候语编辑区 label 为 `useHtml ? "问候语 HTML" : "问候语"`，Textarea 绑定 `signature.greeting`，放在签名 Textarea 之前。
- 保存走现有 `save()`（state 已含 greeting，无需改 payload 逻辑）。
- 预览：在现有签名预览之前渲染问候语（`signature.greetingHtml || textToHtml(signature.greeting)`，用现有预览相同的 MailContent/iframe 机制）；无问候语时不渲染。
- 空签名初始化用 `emptySignature()`（已含 greeting:""）。

**Step 3: 验证** `npx vitest run src/components/mail-signatures.test.tsx` → 绿。

**Step 4: Commit** `feat: 签名设置支持每账号问候语`

---

### Task 5: 写信窗口三段式预览 + 移除纯文本模式

**Files:**
- Modify: `src/components/compose-dialog.tsx`
- Modify: `src/lib/compose-format.ts`（composeFormat 默认 rich、plain→rich）
- Test: `src/components/compose-dialog.test.tsx`

**Step 1: 写失败测试**

- 配了问候语的账号写信时，编辑器上方渲染问候语预览（`.reader-scroll` 无关，用 `data-yanxin-greeting` 或 title「本封邮件问候语」定位），且位于编辑器之前
- 格式 Select 无「纯文本」选项
- `composeFormat({ ...draft, format: "plain" })` 与 `composeFormat({ ...draft, format: undefined })` 均返回 "rich"

**Step 2: 实现**

1. `composeFormat` 改为：
```ts
export function composeFormat(draft: Compose): ComposeFormat {
  return !draft.format || draft.format === "plain" ? "rich" : draft.format;
}
```
2. Select 选项删除 `<SelectOption value="plain">纯文本</SelectOption>`。
3. `changeFormat` 删除 `if (format === "plain")` 分支。
4. 编辑器分支三元：`format === "rich" ? <RichEditor/> : (format === "markdown" || format === "html" ? <>源码+预览</> : null)`——原 plain Textarea 分支删除（因此失效的 import 一并清理）。
5. 新增派生值并渲染问候语预览（放在 `.compose-editor` 之前）：
```tsx
const greetingPreview = Boolean(
  signaturePreview && value?.signature?.greeting,
);
```
```tsx
{greetingPreview && (
  <section className="px-6 pt-4 pb-2 flex flex-col gap-3">
    <MailContent
      html={
        value.signature!.greetingHtml ||
        textToHtml(value.signature!.greeting)
      }
      title="本封邮件问候语"
      onOpenLink={() => {}}
    />
  </section>
)}
```
6. 编辑器类名条件扩展：`${greetingPreview || signaturePreview ? "with-signature" : ""}`。

**Step 3: 验证** `npx vitest run src/components/compose-dialog.test.tsx` → 绿（既有格式化切换测试按新语义修正）。

**Step 4: Commit** `feat: 写信窗口问候语预览 + 富文本为默认正文模式`

---

### Task 6: 正文图片压缩管线

**Files:**
- Create: `src/lib/inline-image.ts`
- Test: `src/lib/inline-image.test.ts`

**Step 1: 写失败测试**

```ts
it("PNG 小图保留 PNG，其余转 JPEG", () => {
  expect(inlineImageMime("image/png", 500 * 1024)).toBe("image/png");
  expect(inlineImageMime("image/png", 2 * 1024 * 1024)).toBe("image/jpeg");
  expect(inlineImageMime("image/jpeg", 1024)).toBe("image/jpeg");
});
it("只提取图片文件", () => {
  // 构造 DataTransfer 不可用时直接测数组过滤：imageFilesFromList 接收 File[]
  expect(imageFilesFromList([imageFile, textFile])).toEqual([imageFile]);
  expect(imageFilesFromList(null)).toEqual([]);
});
it("超过 25 MB 的源图拒绝", async () => {
  await expect(inlineImageDataUrl(hugeFile)).rejects.toThrow("25 MB");
});
```

**Step 2: 实现**（完整文件）

```ts
export const INLINE_IMAGE_MAX_EDGE = 1600;
export const INLINE_IMAGE_SOURCE_LIMIT = 25 * 1024 * 1024;
export const INLINE_IMAGE_PNG_LIMIT = 1024 * 1024;

/** 纯决策：PNG 源且压缩后够小就保留 PNG（截图文字锐利），否则 JPEG 压体积 */
export function inlineImageMime(source: string, pngBytes: number): string {
  return source === "image/png" && pngBytes <= INLINE_IMAGE_PNG_LIMIT
    ? "image/png"
    : "image/jpeg";
}

export function imageFilesFromList(files: File[] | null | undefined): File[] {
  return (files ?? []).filter((file) => file.type.startsWith("image/"));
}

const dataUrlBytes = (dataUrl: string) =>
  Math.floor((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);

/** 读入 → 限长边 1600px → 编码 data URL；jsdom 无 canvas，浏览器路径由装机验证覆盖 */
export async function inlineImageDataUrl(file: File): Promise<string> {
  if (file.size > INLINE_IMAGE_SOURCE_LIMIT)
    throw new Error("图片不能超过 25 MB，请压缩后重试");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(
      1,
      INLINE_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法处理图片");
    if (file.type !== "image/png") {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const png = canvas.toDataURL("image/png");
    return inlineImageMime(file.type, dataUrlBytes(png)) === "image/png"
      ? png
      : canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
```
（`imageFilesFromList` 在 rich-editor 里对 `FileList` 先展开为数组：`imageFilesFromList([...list])`。）

**Step 3: 验证** `npx vitest run src/lib/inline-image.test.ts` → 绿。

**Step 4: Commit** `feat: 正文图片压缩管线（限长边/PNG 保锐利/JPEG 压体积）`

---

### Task 7: 富文本编辑器图片能力

**Files:**
- Modify: `package.json` / `package-lock.json`（`npm install @tiptap/extension-image@^3.31.3`）
- Modify: `src/components/rich-editor.tsx`
- Test: `src/components/rich-editor.test.tsx`（无则新建，轻量：工具条按钮存在、扩展加载不报错）

**Step 1: 装依赖**

Run: `npm install @tiptap/extension-image@^3.31.3`

**Step 2: 实现**

```tsx
import Image from "@tiptap/extension-image";
import { ImagePlus } from "lucide-react"; // 图标名以项目现有 lucide 用法为准
import {
  imageFilesFromList,
  inlineImageDataUrl,
} from "@/lib/inline-image";
import { toast } from "sonner";
```

编辑器配置：
```tsx
extensions: [
  StarterKit.configure({ ...现有配置 }),
  Image.configure({ inline: false }),
],
editorProps: {
  handlePaste: (_view, event) => {
    const files = imageFilesFromList([
      ...(event.clipboardData?.files ?? []),
    ]);
    if (!files.length) return false;
    event.preventDefault();
    void insertImages(files);
    return true;
  },
  handleDrop: (view, event) => {
    const files = imageFilesFromList([
      ...(event.dataTransfer?.files ?? []),
    ]);
    if (!files.length) return false;
    event.preventDefault();
    const at = view.posAtCoords({
      left: event.clientX,
      top: event.clientY,
    })?.pos;
    void insertImages(files, at);
    return true;
  },
},
```

组件内助手与隐藏文件选择：
```tsx
const imageInput = useRef<HTMLInputElement>(null);
async function insertImages(files: File[], at?: number | null) {
  for (const file of files) {
    try {
      const src = await inlineImageDataUrl(file);
      const node = { type: "image", attrs: { src, alt: file.name || "图片" } };
      const chain = editor?.chain().focus();
      (at == null ? chain?.insertContent(node) : chain?.insertContentAt(at, node))?.run();
    } catch (e) {
      toast.error(String(e));
    }
  }
}
```
tools 数组追加：
```tsx
{
  name: "插入图片",
  icon: ImagePlus,
  active: false,
  run: () => imageInput.current?.click(),
},
```
JSX 在 `.rich-editor` 内（format-toolbar 之后）加：
```tsx
<input
  ref={imageInput}
  type="file"
  accept="image/*"
  multiple
  className="sr-only"
  aria-label="插入图片"
  onChange={(event) => {
    void insertImages(imageFilesFromList([...(event.target.files ?? [])]));
    event.target.value = "";
  }}
/>
```
注意：`editor` 变量在 tools 定义处可能尚未初始化（useEditor 返回在 tools 之后）——若如此，insertImages 内在运行时读取最新的 editor（用 `editorRef` 或在 run 时经 `useEditor` 返回值闭包；以实现时实际作用域为准，保证点击工具条/粘贴时 editor 已就绪）。

**Step 3: 验证** `npx vitest run`（rich-editor 新增用例 + 全量 196+ 不回归）；`npx tsc --noEmit`。

**Step 4: Commit** `feat: 富文本支持粘贴/拖拽/按钮插入内嵌图片`

---

### Task 8: 全量门禁与装机

**Step 1: 门禁**

```bash
cd ~/Mytools/yanxin
cargo test --manifest-path src-tauri/Cargo.toml   # 基线 261+1
npx vitest run                                     # 基线 196+新增
npx prettier --check "src/**/*.{ts,tsx,css}"
npm run check:ui
npx tsc --noEmit
```

**Step 2: 编译装机**（用户既有流程）

```bash
npx tauri build --config '{"plugins":{"updater":{"createUpdaterArtifacts":false}}}' --bundles app
osascript -e 'quit app "雁信"'; sleep 2
rm -rf /Applications/雁信.app
cp -R src-tauri/target/release/bundle/macos/雁信.app /Applications/
open /Applications/雁信.app
```

**Step 3: 人工验收清单**（交用户）

- 富文本粘贴/拖入/按钮插入图片 → 内嵌显示；关闭重开写信窗口图片仍在；发送后用另一邮箱确认收到内嵌图
- 长图自动压缩；>25MB 拒绝提示
- 签名设置配问候语 → 写信窗口「问候语/正文/落款」三段式 → 发送结果三段齐全
- 旧草稿（纯文本格式、无问候语签名）打开与发送无异常
- 版本号口径与用户确认后提交

**Step 4: Commit**（如有门禁产生的修正，随对应任务提交；本任务不单独提交）
