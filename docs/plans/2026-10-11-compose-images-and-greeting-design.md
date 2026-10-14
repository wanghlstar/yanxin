# 写信正文图片与签名问候语设计（2026-10-11）

## 背景

用户反馈两个问题：

1. **严重**：纯文本/富文本模式都不能把图片粘贴进正文，正文只能干文字。用户明确不要“图片走附件”的路线——附件会丢失排版、看不出图片与文字的对应关系。要求正文默认就是“文字+图片”一体的多样式。
2. 签名的结构预期：正文开头是可自定义的问候语（如「您好：」，可设字体），中间是正文，结尾是落款+分隔线。即「问候语 + 正文 + 落款」三段式。

调研结论：发送链路已具备内嵌图片能力（`network.rs` 的 `inline_images()` 把正文 HTML 里的 `data:image` 转成 cid 内嵌部件，multipart/related；收取端 `archive.rs` 会把 cid 还原为 data URL 显示），上游 anser 无现成实现可移植。两个功能都是净新增。

## 一、正文图片（文字+图片一体）

### 编辑器合并

- 格式选择移除「纯文本」，富文本为唯一默认编辑器；Markdown、HTML 源码模式保留。
- 历史 `format: "plain"` 的草稿打开时按富文本渲染（body 经 textToHtml 转 html）。
- 发送时 HTML 邮件带 `multipart/alternative` 的纯文本备用 part（正文纯文本版），兼容只收纯文本的收件人，弥补移除纯文本撰写模式的兼容性损失。

### 富文本图片能力

新增依赖 `@tiptap/extension-image`（版本对齐现有 `^3.31.3`）。

- **粘贴**：`handlePaste` 提取剪贴板图片文件，插入到光标处。
- **拖拽**：`handleDrop` 提取拖入的图片文件，插入到落点。
- **工具条**：格式栏新增「插入图片」按钮（文件选择），与粘贴/拖拽共用同一处理管线。
- **压缩管线**（新增 `src/lib/inline-image.ts`）：
  - 读入文件 → `createImageBitmap` → canvas 限制最长边 1600px（保持宽高比）→ 编码
  - PNG 源且编码后 ≤1MB 保留 PNG（保截图文字锐利），否则 JPEG quality 0.85
  - 源文件 >25MB 拒绝并提示（发送侧已有 50MB 总上限）
- **发送**：复用现有 `inline_images()` 链路（data URL → cid → multipart/related），图文对应不丢失。
- 附件系统不变，继续用于普通文件附件。

### 数据结构

图片以 data URL 形式存在于草稿 html 中，随草稿持久化；压缩管线控制体量。

## 二、签名问候语

### 数据模型

- `MailSignature`（Rust `signatures.rs`）与前端 `src/lib/types.ts` 增加 `greeting: String`、`greetingHtml: String`，`#[serde(default)]` 保证旧数据无感兼容；问候语为空则不拼接。
- `ComposeSignature`（草稿内冻结快照）同步增加问候语字段，换发件身份时与落款一起重读快照。
- `src/lib/signatures.ts` 的 `signatureContent()` 扩展为带出问候语。

### 签名设置页（mail-signatures.tsx）

在落款编辑区上方新增「问候语」编辑区，复用现有文本/HTML 双模编辑器与预览（HTML 模式可设字体，不另做字体控件）。默认占位文案「您好：」。

### 写信窗口（compose-dialog.tsx）

结构变为三段（与用户草图一致）：

```
[问候语预览]  ← 新增，正文上方（data-yanxin-greeting）
[编辑器]      ← 用户正文，随内容增高（现有 with-signature 类保持内容高度）
[落款预览]    ← 现有，正文下方（data-yanxin-signature）
```

- 问候语与落款共用原有「附加邮件签名」开关；回复/转发同样适用。
- `signaturePreview` 条件扩展为含问候语，驱动编辑器内容高度排布。

### 发送拼接（compose-format.ts `withSignature`）

- 文本态：`问候语\n\n正文\n\n落款`
- HTML 态：问候语节点前置（`data-yanxin-greeting`、marginBottom 24px）、落款节点后置（现有 `data-yanxin-signature`、marginTop 24px）
- 问候语为空时行为与现在完全一致

## 三、涉及文件

| 文件 | 改动 |
|---|---|
| package.json / package-lock.json | +@tiptap/extension-image |
| src/lib/inline-image.ts | 新增：压缩/编码/校验管线与可测决策函数 |
| src/components/rich-editor.tsx | Image 扩展、handlePaste/handleDrop、插入图片按钮 |
| src/components/compose-dialog.tsx | 格式选择移除纯文本、旧 plain 草稿转富文本、问候语预览 |
| src/lib/compose-format.ts | withSignature 前置问候语 |
| src/lib/types.ts / src/lib/signatures.ts | 问候语字段与快照 |
| src/components/mail-signatures.tsx | 问候语编辑区 |
| src-tauri/src/signatures.rs | 问候语字段 + serde default + 测试 |
| src-tauri/src/network.rs | multipart/alternative 纯文本备用 part |
| src/index.css | 问候语预览样式 |
| 测试 | compose-format 三态、inline-image 决策函数、剪贴板/拖拽提取、compose-dialog 预览、Rust 存取往返+旧数据兼容、MIME 结构 |

## 四、验收

- 富文本内粘贴/拖入/按钮插入图片均内嵌显示，随草稿保存恢复，发送后收件方看到内嵌图（cid）
- 长图自动压缩；超大图拒绝提示
- 每账号可配问候语（文本/HTML），写信窗口三段式预览，发送结果为「问候+正文+落款」
- 旧签名、旧草稿、演示模式均无回归
- 门禁：cargo test、vitest、prettier、check:ui、tsc、build 全绿
