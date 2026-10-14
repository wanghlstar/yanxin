import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { FieldGroup, Field, FieldLabel, FieldError } from "./ui/field";
import { Input } from "./ui/input";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { FontFamily } from "@tiptap/extension-font-family";
import { FontSize, TextStyle } from "@tiptap/extension-text-style";
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link,
  Quote,
  Undo2,
  ImagePlus,
} from "lucide-react";
import DOMPurify from "dompurify";
import { Button } from "./ui/button";
import { SelectField, SelectOption } from "./ui/select-field";
import { textToHtml } from "@/lib/compose-format";
import { GreetingParagraph } from "@/lib/greeting-paragraph";
import {
  FONT_OPTIONS,
  SIZE_OPTIONS,
  FONT_DEFAULT,
  SIZE_DEFAULT,
} from "@/lib/fonts";
import type { GreetingSpec } from "@/lib/signatures";
import { imageFilesFromList, inlineImageDataUrl } from "@/lib/inline-image";
import { toast } from "sonner";

// 字体栈一律不带引号：带引号的栈在草稿重开后与下拉回显对不上（见 bareFont）。
export const fontFamilies = FONT_OPTIONS.map((option) => ({
  label: option.label,
  value: option.stack,
}));
export const fontSizes = SIZE_OPTIONS.map((size) => ({
  label: size,
  value: size,
}));
// 草稿重开后读回的字体栈可能带引号（CSSOM 序列化所致），比对时忽略。
const bareFont = (value: string) => value.replace(/["']/g, "");
type EditorInstance = NonNullable<ReturnType<typeof useEditor>>;
// 动态选项标签：字体取栈里第一个家族名，字号原样。
const firstFamily = (stack: string) =>
  stack.split(",")[0]?.replace(/["']/g, "").trim() || FONT_DEFAULT;
// 空正文判定：textToHtml("") 出来的 `<p><br></p>` 里硬换行是 leaf 节点，editor.isEmpty 会判成非空。
function blankBody(editor: EditorInstance) {
  const doc = editor.state.doc;
  return (
    !doc.textContent &&
    [...doc.content.content].every(
      (block) =>
        block.isTextblock &&
        [...block.content.content].every(
          (inline) => inline.type.name === "hardBreak",
        ),
    )
  );
}

export function RichEditor({
  body,
  html,
  disabled,
  onChange,
  toolbarExtras,
  greeting,
}: {
  body: string;
  html: string;
  disabled: boolean;
  onChange: (body: string, html: string) => void;
  toolbarExtras?: ReactNode;
  greeting?: GreetingSpec | null;
}) {
  const [linkDialog, setLinkDialog] = useState<{
    from: number;
    to: number;
  } | null>(null);
  const [href, setHref] = useState("");
  const [linkError, setLinkError] = useState("");
  const imageInput = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false, protocols: ["http", "https", "mailto"] },
        heading: { levels: [1, 2, 3] },
        // 内置 paragraph 换成带问候语标记的版本，否则同名节点会冲突
        paragraph: false,
      }),
      GreetingParagraph,
      Image.configure({ inline: false }),
      TextStyle,
      FontFamily,
      FontSize,
    ],
    content: html || textToHtml(body),
    editorProps: {
      attributes: {
        class: "rich-body",
        role: "textbox",
        "aria-label": "邮件正文",
        "aria-multiline": "true",
      },
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
    onUpdate: ({ editor }) =>
      onChange(
        editor.getText({ blockSeparator: "\n" }),
        DOMPurify.sanitize(editor.getHTML()),
      ),
  });
  // 粘贴/拖拽的 editorProps 在编辑器实例化前就冻结了，这里靠函数声明提升 + 闭包延迟读取 editor。
  async function insertImages(files: File[], at?: number | null) {
    for (const file of files) {
      try {
        const src = await inlineImageDataUrl(file);
        const node = {
          type: "image",
          attrs: { src, alt: file.name || "图片" },
        };
        const chain = editor?.chain().focus();
        (at == null
          ? chain?.insertContent(node)
          : chain?.insertContentAt(at, node)
        )?.run();
      } catch (e) {
        toast.error(String(e));
      }
    }
  }
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);
  const greetingInserted = useRef("");
  // 问候语作为正文第一行插入：空文档才插，插过一次或草稿里已有正文都不再动。
  useEffect(() => {
    if (!editor || !greeting?.text) return;
    if (greetingInserted.current === greeting.text || !blankBody(editor))
      return;
    const attrs: Record<string, string> = {};
    if (greeting.fontFamily) attrs.fontFamily = greeting.fontFamily;
    if (greeting.fontSize) attrs.fontSize = greeting.fontSize;
    const marks = Object.keys(attrs).length
      ? [{ type: "textStyle", attrs }]
      : [];
    editor
      .chain()
      .insertContentAt({ from: 0, to: editor.state.doc.content.size }, [
        // 称呼顶格：靠段落标记让 CSS 去掉首行缩进
        {
          type: "paragraph",
          attrs: { greeting: "true" },
          content: [{ type: "text", text: greeting.text, marks }],
        },
        // 问候语下方空一行正文，光标落在这里（不抢焦点）
        { type: "paragraph" },
      ])
      .run();
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    greetingInserted.current = greeting.text;
  }, [editor, greeting]);
  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      const marks = editor?.getAttributes("textStyle") ?? {};
      return {
        bold: editor?.isActive("bold"),
        italic: editor?.isActive("italic"),
        underline: editor?.isActive("underline"),
        bullet: editor?.isActive("bulletList"),
        ordered: editor?.isActive("orderedList"),
        quote: editor?.isActive("blockquote"),
        link: editor?.isActive("link"),
        fontFamily: marks.fontFamily,
        fontSize: marks.fontSize,
      };
    },
  });
  if (!editor) return null;
  // 值驱动下拉：无标记即正文默认（仿宋/14pt）；选项之外的值（粘贴带入的第三方字体/字号）补一个动态选项，保证触发器有显示。
  const fontOptions: { label: string; value: string }[] = [...fontFamilies];
  const fontValue = state?.fontFamily || FONT_DEFAULT;
  const matchedFont = fontOptions.find(
    (font) => bareFont(font.value) === bareFont(fontValue),
  );
  if (!matchedFont)
    fontOptions.push({ label: firstFamily(fontValue), value: fontValue });
  const sizeOptions = [...fontSizes];
  const sizeValue = state?.fontSize || SIZE_DEFAULT;
  if (!sizeOptions.some((size) => size.value === sizeValue))
    sizeOptions.push({ label: sizeValue, value: sizeValue });
  const tools = [
    {
      name: "加粗",
      icon: Bold,
      active: state?.bold,
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      name: "斜体",
      icon: Italic,
      active: state?.italic,
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      name: "下划线",
      icon: Underline,
      active: state?.underline,
      run: () => editor.chain().focus().toggleUnderline().run(),
    },
    {
      name: "无序列表",
      icon: List,
      active: state?.bullet,
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      name: "有序列表",
      icon: ListOrdered,
      active: state?.ordered,
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      name: "引用",
      icon: Quote,
      active: state?.quote,
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      name: "插入链接",
      icon: Link,
      active: state?.link,
      run: () => {
        setHref(editor.getAttributes("link").href || "https://");
        setLinkError("");
        setLinkDialog({
          from: editor.state.selection.from,
          to: editor.state.selection.to,
        });
      },
    },
    {
      name: "插入图片",
      icon: ImagePlus,
      active: false,
      run: () => imageInput.current?.click(),
    },
    {
      name: "撤销编辑",
      icon: Undo2,
      active: false,
      run: () => editor.chain().focus().undo().run(),
    },
  ];
  return (
    <div className="rich-editor">
      <div className="format-toolbar" role="toolbar" aria-label="正文格式">
        {tools.map((t) => (
          <Button
            key={t.name}
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t.name}
            aria-label={t.name}
            aria-pressed={!!t.active}
            disabled={disabled}
            onClick={t.run}
          >
            <t.icon size={15} />
          </Button>
        ))}
        <SelectField
          aria-label="字体"
          className="font-select w-[104px] text-xs"
          disabled={disabled}
          value={matchedFont?.value ?? fontValue}
          onValueChange={(value) => {
            editor.chain().focus().setFontFamily(value).run();
          }}
        >
          {fontOptions.map((font) => (
            <SelectOption key={font.value} value={font.value}>
              {font.label}
            </SelectOption>
          ))}
        </SelectField>
        <SelectField
          aria-label="字号"
          className="font-select w-[76px] text-xs"
          disabled={disabled}
          value={sizeValue}
          onValueChange={(value) => {
            editor.chain().focus().setFontSize(value).run();
          }}
        >
          {sizeOptions.map((size) => (
            <SelectOption key={size.value} value={size.value}>
              {size.label}
            </SelectOption>
          ))}
        </SelectField>
        {toolbarExtras && <div className="toolbar-extras">{toolbarExtras}</div>}
      </div>
      <EditorContent editor={editor} />
      <Input
        ref={imageInput}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        aria-label="插入图片"
        onChange={(event) => {
          void insertImages(
            imageFilesFromList([...(event.target.files ?? [])]),
          );
          event.target.value = "";
        }}
      />
      <Dialog
        open={!!linkDialog}
        onOpenChange={(open) => {
          if (!open) setLinkDialog(null);
        }}
      >
        <DialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            editor.commands.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>插入链接</DialogTitle>
            <DialogDescription>
              支持网页和邮箱地址。留空可移除当前链接。
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const url = href.trim();
              if (url) {
                try {
                  if (
                    !["http:", "https:", "mailto:"].includes(
                      new URL(url).protocol,
                    )
                  )
                    throw new Error();
                } catch {
                  setLinkError("请输入有效的 http、https 或 mailto 链接");
                  return;
                }
              }
              if (!linkDialog || disabled) return;
              const chain = editor
                .chain()
                .focus()
                .setTextSelection(linkDialog)
                .extendMarkRange("link");
              if (url) chain.setLink({ href: url }).run();
              else chain.unsetLink().run();
              setLinkDialog(null);
            }}
          >
            <FieldGroup>
              <Field data-invalid={!!linkError}>
                <FieldLabel htmlFor="rich-link-url">链接地址</FieldLabel>
                <Input
                  id="rich-link-url"
                  autoFocus
                  value={href}
                  aria-invalid={!!linkError}
                  disabled={disabled}
                  onChange={(e) => {
                    setHref(e.target.value);
                    setLinkError("");
                  }}
                />
                {linkError && <FieldError>{linkError}</FieldError>}
              </Field>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setLinkDialog(null)}
                >
                  取消
                </Button>
                <Button type="submit" disabled={disabled}>
                  保存链接
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
