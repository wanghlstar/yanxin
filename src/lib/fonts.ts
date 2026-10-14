// 字体/字号下拉的选项与归一：问候语等处的 font-family 串要归一到我们认识的栈，回填下拉才能匹配上。
export const FONT_OPTIONS = [
  { label: "宋体", stack: "宋体, SimSun, Songti SC, serif" },
  { label: "楷体", stack: "楷体, KaiTi, Kaiti SC, STKaiti, serif" },
  { label: "黑体", stack: "黑体, SimHei, Heiti SC, sans-serif" },
  { label: "仿宋", stack: "仿宋, FangSong, STFangsong, serif" },
  {
    label: "微软雅黑",
    stack: "微软雅黑, Microsoft YaHei, PingFang SC, sans-serif",
  },
] as const;
export const SIZE_OPTIONS = [
  "10.5pt",
  "12pt",
  "14pt",
  "16pt",
  "18pt",
  "22pt",
] as const;
// 正文默认值（.rich-body 的 font-family/font-size）：下拉没有对应标记时按默认回显，不做计算样式兜底。
export const FONT_DEFAULT =
  FONT_OPTIONS.find((option) => option.label === "仿宋")?.stack ??
  FONT_OPTIONS[0].stack;
export const SIZE_DEFAULT = "14pt";
// 通用关键字不参与匹配：否则任意栈里的 serif/sans-serif 都会命中第一个选项。
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
]);
const familyKey = (name: string) =>
  name.replace(/["']/g, "").replace(/\s+/g, "").toLowerCase();
const optionFamilies = FONT_OPTIONS.map((option) => ({
  stack: option.stack,
  families: option.stack
    .split(",")
    .map(familyKey)
    .filter((family) => family && !GENERIC_FAMILIES.has(family)),
}));
export function canonicalFontFamily(stack: string): string | null {
  for (const family of stack
    .split(",")
    .map(familyKey)
    .filter((name) => name && !GENERIC_FAMILIES.has(name)))
    for (const option of optionFamilies)
      if (
        option.families.some(
          (known) =>
            known === family ||
            // 「KaiTi」对上「Kaiti SC」这类同名不同写的家族名
            (family.length > 1 &&
              (family.startsWith(known) || known.startsWith(family))),
        )
      )
        return option.stack;
  return null;
}
