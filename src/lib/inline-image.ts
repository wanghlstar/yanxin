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
