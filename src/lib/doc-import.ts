/** 把简历、截图、PDF、Word 等文件读成纯文本，交给「AI 整理」用 */

import { askModel } from "./vision-client";
import { assertVision, type ProviderPreset } from "./vision-providers";

export interface ImportedDoc {
  name: string;
  text: string;
}

const TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".log", ".vtt", ".srt", ".html", ".htm"];

const OCR_PROMPT =
  "这是一份人物资料（简历、名片、登记表或聊天/资料截图）。请把画面里所有文字按原样抄录出来，" +
  "保留姓名、年龄、性别、联系方式、住址、单位职务、教育与工作经历、社会关系等信息。" +
  "不要总结、不要评价、不要编造看不清的内容，看不清就写「[不清]」。";

function readAsDataUrl(file: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
}

/** 用多模态模型抄录一张图里的文字 */
async function ocrImage(dataUrl: string, preset: ProviderPreset) {
  assertVision(preset);
  let out = "";
  await askModel(preset, OCR_PROMPT, dataUrl, [], (chunk) => {
    out += chunk;
  }, new AbortController().signal);
  return out.trim();
}

async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
  return pdfjs;
}

async function readPdf(file: File, preset: ProviderPreset, onStep?: (text: string) => void) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages = Math.min(doc.numPages, 8);
  const parts: string[] = [];
  for (let i = 1; i <= pages; i += 1) {
    onStep?.(`正在读取 ${file.name} 第 ${i}/${pages} 页`);
    // eslint-disable-next-line no-await-in-loop
    const page = await doc.getPage(i);
    // eslint-disable-next-line no-await-in-loop
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 40) {
      parts.push(text);
      continue;
    }
    // 扫描件没有文字层：把这一页画成图，交给多模态模型抄录
    const viewport = page.getViewport({ scale: 1.6 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    // eslint-disable-next-line no-await-in-loop
    await page.render({ canvas, canvasContext: ctx, viewport } as never).promise;
    onStep?.(`${file.name} 第 ${i} 页是扫描件，正在用 AI 抄录`);
    // eslint-disable-next-line no-await-in-loop
    parts.push(await ocrImage(canvas.toDataURL("image/jpeg", 0.85), preset));
  }
  return parts.join("\n");
}

/**
 * 读取一批文件：文本直接读，图片/扫描件用多模态模型抄录，PDF/Word 抽文字层。
 * 返回每个文件抽到的纯文本，调用方把它拼进「随手写」的输入框即可。
 */
export async function importFiles(
  files: File[],
  preset: ProviderPreset,
  onStep?: (text: string) => void,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportedDoc[]> {
  const out: ImportedDoc[] = [];
  let done = 0;
  onProgress?.(0, files.length);
  for (const file of files) {
    const lower = file.name.toLowerCase();
    onStep?.(`正在读取 ${file.name}`);
    try {
      if (file.type.startsWith("image/")) {
        // eslint-disable-next-line no-await-in-loop
        const dataUrl = await readAsDataUrl(file);
        onStep?.(`正在用 AI 抄录 ${file.name}`);
        // eslint-disable-next-line no-await-in-loop
        out.push({ name: file.name, text: await ocrImage(dataUrl, preset) });
      } else if (lower.endsWith(".pdf")) {
        // eslint-disable-next-line no-await-in-loop
        out.push({ name: file.name, text: await readPdf(file, preset, onStep) });
      } else if (lower.endsWith(".docx")) {
        // eslint-disable-next-line no-await-in-loop
        const mammoth = (await import("mammoth")) as unknown as {
          extractRawText: (o: unknown) => Promise<{ value: string }>;
        };
        // eslint-disable-next-line no-await-in-loop
        const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
        out.push({ name: file.name, text: result.value.trim() });

      } else if (TEXT_EXT.some((ext) => lower.endsWith(ext)) || file.type.startsWith("text/")) {
        // eslint-disable-next-line no-await-in-loop
        out.push({ name: file.name, text: (await file.text()).trim() });
      } else {
        throw new Error("暂不支持这种格式，可以先截图或另存为 PDF/Word/纯文本");
      }
    } catch (error) {
      out.push({ name: file.name, text: `[读取失败：${(error as Error).message}]` });
    }
    done += 1;
    onProgress?.(done, files.length);
  }
  return out;
}
