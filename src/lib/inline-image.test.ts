// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  INLINE_IMAGE_PNG_LIMIT,
  imageFilesFromList,
  inlineImageDataUrl,
  inlineImageMime,
} from "./inline-image";

const imageFile = (name = "shot.png", type = "image/png", size = 1024) => {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
};

describe("inline image helpers", () => {
  it("PNG 小图保留 PNG，其余转 JPEG", () => {
    expect(inlineImageMime("image/png", 500 * 1024)).toBe("image/png");
    expect(inlineImageMime("image/png", INLINE_IMAGE_PNG_LIMIT)).toBe(
      "image/png",
    );
    expect(inlineImageMime("image/png", INLINE_IMAGE_PNG_LIMIT + 1)).toBe(
      "image/jpeg",
    );
    expect(inlineImageMime("image/jpeg", 1024)).toBe("image/jpeg");
    expect(inlineImageMime("image/gif", 1024)).toBe("image/jpeg");
  });

  it("只提取图片文件，空输入安全", () => {
    const text = new File(["x"], "a.txt", { type: "text/plain" });
    expect(imageFilesFromList([imageFile(), text])).toEqual([imageFile()]);
    expect(imageFilesFromList([])).toEqual([]);
    expect(imageFilesFromList(null)).toEqual([]);
    expect(imageFilesFromList(undefined)).toEqual([]);
  });

  it("超过 25 MB 的源图直接拒绝（不进入 canvas）", async () => {
    const huge = imageFile("huge.png", "image/png", 26 * 1024 * 1024);
    await expect(inlineImageDataUrl(huge)).rejects.toThrow("25 MB");
  });
});
