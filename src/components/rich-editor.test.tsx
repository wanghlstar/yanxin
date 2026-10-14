// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichEditor, fontFamilies, fontSizes } from "./rich-editor";
import { inlineImageDataUrl } from "@/lib/inline-image";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { FontFamily, FontSize, TextStyle } from "@tiptap/extension-text-style";

// jsdom 没有 canvas/createImageBitmap，压缩走真实浏览器路径，这里只验证编辑器接线。
vi.mock("@/lib/inline-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inline-image")>()),
  inlineImageDataUrl: vi.fn(async () => "data:image/png;base64,AAAA"),
}));
// RichEditor 不往外暴露 editor 实例：包一层 useEditor 把它留下来，用于断言光标落点。
const captured = vi.hoisted(() => ({ editor: null as unknown }));
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: (options: Parameters<typeof actual.useEditor>[0]) => {
      const editor = actual.useEditor(options);
      captured.editor = editor;
      return editor;
    },
  };
});

let root: Root, host: HTMLDivElement;

async function editorReady() {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(document.querySelector('[aria-label="邮件正文"]')).toBeTruthy();
  });
  await act(async () => {});
  return document.querySelector('[aria-label="邮件正文"]') as HTMLElement;
}

function imageFile(name = "shot.png") {
  return new File(["binary"], name, { type: "image/png" });
}

function editorState() {
  return (captured.editor as Editor).state;
}

function pasteEvent(files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.assign(event, {
    clipboardData: { files, getData: () => "" },
  });
  return event;
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
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
    setTimeout(cb, 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <RichEditor body="正文" html="" disabled={false} onChange={() => {}} />,
    );
  });
  await editorReady();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("rich editor images", () => {
  it("renders an insert-image tool wired to a hidden multi-image picker", async () => {
    const button = document.querySelector('button[aria-label="插入图片"]');
    expect(button).toBeTruthy();
    expect(
      document.querySelectorAll(".format-toolbar button").length,
    ).toBeGreaterThan(8);
    const picker = document.querySelector(
      'input[type="file"][accept="image/*"]',
    ) as HTMLInputElement | null;
    expect(picker).toBeTruthy();
    expect(picker!.multiple).toBe(true);
    await act(async () => (button as HTMLElement).click());
    expect(picker).toBeTruthy();
  });

  it("renders toolbarExtras inside the format toolbar", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          body="正文"
          html=""
          disabled={false}
          onChange={() => {}}
          toolbarExtras={<span data-testid="extras" />}
        />,
      );
    });
    await act(async () => {});
    const extras = document.querySelector('[data-testid="extras"]');
    expect(extras).toBeTruthy();
    const toolbar = extras!.closest(".format-toolbar");
    expect(toolbar).toBeTruthy();
    expect(toolbar!.querySelector(".toolbar-extras")).toBe(
      extras!.parentElement,
    );
  });

  it("inserts the greeting as the first editable paragraph in its configured style", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          key="greeting"
          body=""
          html=""
          disabled={false}
          onChange={() => {}}
          greeting={{
            text: "您好：",
            fontFamily: fontFamilies[1].value,
            fontSize: "16pt",
          }}
        />,
      );
    });
    const editor = await editorReady();
    const paragraphs = editor.querySelectorAll("p");
    // 称呼独占第一段并标记顶格，下面紧跟一段空正文行
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0].textContent).toBe("您好：");
    expect(paragraphs[0].getAttribute("data-yanxin-greeting")).toBe("true");
    expect(paragraphs[0].innerHTML).toContain(
      `font-family: ${fontFamilies[1].label}`,
    );
    expect(paragraphs[0].innerHTML).toContain("font-size: 16pt");
    expect(paragraphs[1].textContent).toBe("");
    // 光标落在第二段里：工具条显示正文默认字体字号，而不是称呼上的楷体/16pt
    expect(
      document.querySelector('button[aria-label="字体"]')!.textContent,
    ).toBe("仿宋");
    expect(
      document.querySelector('button[aria-label="字号"]')!.textContent,
    ).toBe("14pt");
    const state = editorState();
    expect(state.doc.resolve(state.selection.from).parent).toEqual(
      state.doc.child(1),
    );
  });

  it("leaves an existing body alone instead of greeting it again", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          key="greeting-existing"
          body="正文内容"
          html=""
          disabled={false}
          onChange={() => {}}
          greeting={{
            text: "您好：",
            fontFamily: fontFamilies[1].value,
            fontSize: "16pt",
          }}
        />,
      );
    });
    const editor = await editorReady();
    expect(editor.querySelector("p")!.textContent).toBe("正文内容");
    expect(editor.textContent).not.toContain("您好：");
  });

  it("inserts pasted images into the document and blocks the native paste", async () => {
    const editor = await editorReady();
    const event = pasteEvent([imageFile()]);
    await act(async () => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    await act(async () => {});
    expect(inlineImageDataUrl).toHaveBeenCalledTimes(1);
    expect(editor.querySelector("img")?.getAttribute("src")).toBe(
      "data:image/png;base64,AAAA",
    );
    expect(editor.querySelector("img")?.getAttribute("alt")).toBe("shot.png");
  });

  it("ignores pastes that carry no image files", async () => {
    const editor = await editorReady();
    const event = pasteEvent([]);
    await act(async () => {
      editor.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(editor.querySelector("img")).toBeNull();
    expect(inlineImageDataUrl).not.toHaveBeenCalled();
  });
  // 拖入分支不在此覆盖：jsdom 无 elementFromPoint，ProseMirror 在调用 handleDrop 前就因定位失败提前返回。
});

describe("font toolbar", () => {
  function fontEditor(content = "<p>hi</p>") {
    return new Editor({
      extensions: [Document, Paragraph, Text, TextStyle, FontFamily, FontSize],
      content,
    });
  }

  it("marks the selection with the chosen font family and size", () => {
    const editor = fontEditor();
    editor.commands.selectAll();
    editor
      .chain()
      .setFontFamily(fontFamilies[0].value)
      .setFontSize(fontSizes[1].value)
      .run();
    const html = editor.getHTML();
    // 序列化时 CSSOM 会给多单词字体名补引号（&quot;Songti SC&quot;），只断言前缀与同一 span。
    expect(html).toContain(`font-family: ${fontFamilies[0].label}`);
    expect(html).toContain(`font-size: ${fontSizes[1].value}`);
    expect(html).toMatch(
      new RegExp(`font-family: [^"]*font-size: ${fontSizes[1].value}`),
    );
    expect(editor.getAttributes("textStyle").fontFamily).toBe(
      fontFamilies[0].value,
    );
    expect(editor.getAttributes("textStyle").fontSize).toBe(fontSizes[1].value);
  });

  it("reads the font back out of a quoted stack so the dropdown still matches", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          key="quoted-stack"
          body=""
          html={
            '<p><span style="font-family: 宋体, SimSun, &quot;Songti SC&quot;, serif">正文</span></p>'
          }
          disabled={false}
          onChange={() => {}}
        />,
      );
    });
    await editorReady();
    expect(
      document.querySelector('button[aria-label="字体"]')!.textContent,
    ).toBe(fontFamilies[0].label);
  });

  it("shows the marked font and size in the dropdowns", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          key="marked-labels"
          body=""
          html='<p><span style="font-family: 楷体, KaiTi, STKaiti; font-size:16pt;">楷体正文</span></p>'
          disabled={false}
          onChange={() => {}}
        />,
      );
    });
    await editorReady();
    expect(
      document.querySelector('button[aria-label="字体"]')!.textContent,
    ).toBe(fontFamilies[1].label);
    expect(
      document.querySelector('button[aria-label="字号"]')!.textContent,
    ).toBe("16pt");
  });

  it("clears the marks again through the unset commands", () => {
    const editor = fontEditor();
    editor.commands.selectAll();
    editor
      .chain()
      .setFontFamily(fontFamilies[0].value)
      .setFontSize(fontSizes[1].value)
      .run();
    editor.commands.selectAll();
    editor.chain().unsetFontFamily().unsetFontSize().run();
    const html = editor.getHTML();
    expect(html).not.toContain("font-family");
    expect(html).not.toContain("font-size");
    expect(editor.getAttributes("textStyle").fontFamily).toBeFalsy();
    expect(editor.getAttributes("textStyle").fontSize).toBeFalsy();
  });

  it("falls back to the body default 仿宋/14pt when no marks are set", async () => {
    // 值驱动：无标记即正文默认值，不读计算样式（jsdom 与浏览器下都确定）。
    expect(
      document.querySelector('button[aria-label="字体"]')!.textContent,
    ).toBe("仿宋");
    expect(
      document.querySelector('button[aria-label="字号"]')!.textContent,
    ).toBe("14pt");
  });

  it("keeps a trigger label for font values outside the options", async () => {
    await act(async () => {
      root.render(
        <RichEditor
          key="unknown-values"
          body=""
          html='<p><span style="font-family: Arial, sans-serif; font-size: 20pt;">第三方正文</span></p>'
          disabled={false}
          onChange={() => {}}
        />,
      );
    });
    await editorReady();
    // 动态选项：字体取第一个家族名，字号原样，触发器不至于空白。
    expect(
      document.querySelector('button[aria-label="字体"]')!.textContent,
    ).toBe("Arial");
    expect(
      document.querySelector('button[aria-label="字号"]')!.textContent,
    ).toBe("20pt");
  });

  // Radix Select 在 jsdom 里不能点 trigger 展开，用 keydown 打开后点 portal 里的 option。
  async function pick(label: string, option: string) {
    await act(async () => {
      document
        .querySelector(`button[aria-label="${label}"]`)!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
        );
    });
    const item = [...document.querySelectorAll('[role="option"]')].find((e) =>
      e.textContent?.includes(option),
    );
    expect(item).toBeTruthy();
    await act(async () => (item as HTMLElement).click());
    await act(async () => {});
  }

  // jsdom 的 Range 没有布局盒，ProseMirror 同步选区后滚动定位会抛错；
  // 零矩形会让它走「跳过滚动」分支，不影响标记落库。run 期间保持打桩。
  async function withSelection(editor: HTMLElement, run: () => Promise<void>) {
    const clientRects = Range.prototype.getClientRects;
    const boundingRect = Range.prototype.getBoundingClientRect;
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    try {
      const paragraph = editor.querySelector("p")!;
      await act(async () => {
        paragraph.replaceChildren(document.createTextNode("雁信正文"));
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = editor.ownerDocument.defaultView!.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        editor.ownerDocument.dispatchEvent(new Event("selectionchange"));
      });
      await run();
    } finally {
      Range.prototype.getClientRects = clientRects;
      Range.prototype.getBoundingClientRect = boundingRect;
    }
  }

  it("applies the picked font to the selected text", async () => {
    const editor = await editorReady();
    await withSelection(editor, async () => {
      await pick("字体", fontFamilies[0].label);
      expect(editor.innerHTML).toContain(
        `font-family: ${fontFamilies[0].label}`,
      );
      expect(
        document.querySelector('button[aria-label="字体"]')!.textContent,
      ).toBe(fontFamilies[0].label);
      await pick("字号", fontSizes[1].label);
      expect(editor.innerHTML).toContain(`font-size: ${fontSizes[1].value}`);
      expect(
        document.querySelector('button[aria-label="字号"]')!.textContent,
      ).toBe(fontSizes[1].label);
    });
  });

  it("applies 楷体/16pt from the dropdowns and shows them in the triggers", async () => {
    const editor = await editorReady();
    await withSelection(editor, async () => {
      await pick("字体", fontFamilies[1].label);
      await pick("字号", fontSizes[3].label);
      expect(editor.innerHTML).toContain(
        `font-family: ${fontFamilies[1].label}`,
      );
      expect(editor.innerHTML).toContain(`font-size: ${fontSizes[3].value}`);
      expect(
        document.querySelector('button[aria-label="字体"]')!.textContent,
      ).toBe(fontFamilies[1].label);
      expect(
        document.querySelector('button[aria-label="字号"]')!.textContent,
      ).toBe(fontSizes[3].label);
    });
  });
});
