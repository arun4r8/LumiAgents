import { PDFDocument, StandardFonts } from "pdf-lib";
import mammoth from "mammoth";
import type { FileAttachment } from "../agents/agent-chat";

// Tools that require PDF input: intercept and convert at dispatch time.
export const PDF_REQUIRED_TOOLS = new Set(["assess_opportunity", "score_resumes"]);
// Which of those tools accept multiple PDFs (batch).
export const PDF_BATCH_TOOLS = new Set(["score_resumes"]);

// ─── Format detection ─────────────────────────────────────────────────────────

export function isPdf(file: FileAttachment): boolean {
  if (file.mimeType === "application/pdf") return true;
  if (file.name.toLowerCase().endsWith(".pdf")) return true;
  // base64 of "%PDF" starts with "JVBE"
  if (file.content.startsWith("JVBE")) return true;
  return false;
}

function ext(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

function isDocx(file: FileAttachment): boolean {
  return (
    file.mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext(file.name) === "docx"
  );
}

function isLegacyDoc(file: FileAttachment): boolean {
  return file.mimeType === "application/msword" || ext(file.name) === "doc";
}

function isRtf(file: FileAttachment): boolean {
  return (
    file.mimeType === "text/rtf" ||
    file.mimeType === "application/rtf" ||
    ext(file.name) === "rtf"
  );
}

function isImage(file: FileAttachment): "jpeg" | "png" | null {
  if (file.mimeType === "image/jpeg" || file.mimeType === "image/jpg" || ext(file.name) === "jpg" || ext(file.name) === "jpeg") return "jpeg";
  if (file.mimeType === "image/png" || ext(file.name) === "png") return "png";
  return null;
}

function isTextLike(file: FileAttachment): boolean {
  return (
    file.mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/csv"].includes(file.mimeType) ||
    ["txt", "md", "csv", "json", "xml", "yaml", "yml"].includes(ext(file.name))
  );
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
}

// ─── Main conversion entry point ──────────────────────────────────────────────

/**
 * Returns a base64 PDF string.
 * Supported input formats:
 *   PDF              → pass-through
 *   DOCX             → mammoth extracts text → pdf-lib wraps to PDF
 *   RTF              → strip control words → pdf-lib
 *   TXT / MD / CSV   → pdf-lib
 *   JPEG / PNG       → pdf-lib image embed (preserves visual layout)
 *   DOC (legacy)     → error (LibreOffice required, not available in CF Workers)
 */
export async function ensurePdfBase64(file: FileAttachment): Promise<string> {
  if (isPdf(file)) return file.content;

  if (isLegacyDoc(file)) {
    throw new Error(
      `"${file.name}" is a legacy .doc file. Please save it as .docx or .pdf and re-upload.`,
    );
  }

  if (isDocx(file)) return docxToPdfBase64(file);
  if (isRtf(file)) return textToPdfBase64(file.name, stripRtf(file.content));
  if (isTextLike(file)) return textToPdfBase64(file.name, file.content);

  const imgFmt = isImage(file);
  if (imgFmt) return imageToPdfBase64(file.content, imgFmt);

  throw new Error(
    `"${file.name}" (${file.mimeType}) cannot be converted automatically. ` +
    `Supported formats: PDF, DOCX, RTF, TXT, MD, CSV, JPEG, PNG.`,
  );
}

// ─── DOCX ─────────────────────────────────────────────────────────────────────

async function docxToPdfBase64(file: FileAttachment): Promise<string> {
  const bytes = base64ToBytes(file.content);
  const result = await mammoth.extractRawText({ buffer: bytes.buffer as ArrayBuffer });
  if (!result.value.trim()) {
    throw new Error(`"${file.name}" appears to be empty or could not be read.`);
  }
  return textToPdfBase64(file.name, result.value);
}

// ─── RTF ──────────────────────────────────────────────────────────────────────

function stripRtf(rtf: string): string {
  return rtf
    .replace(/\\[a-z]+\-?\d*\s?/gi, " ") // control words
    .replace(/\\\*/g, "")                  // ignored destinations
    .replace(/[{}\\]/g, "")               // braces and backslashes
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Text → PDF ───────────────────────────────────────────────────────────────

async function textToPdfBase64(filename: string, text: string): Promise<string> {
  const FONT_SIZE = 10;
  const LINE_H = 14;
  const PAGE_W = 595;
  const PAGE_H = 842;
  const MARGIN = 50;
  const MAX_CHARS = 100;
  const LINES_PER_PAGE = Math.floor((PAGE_H - 2 * MARGIN) / LINE_H);

  const doc = await PDFDocument.create();
  doc.setTitle(filename);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Wrap long lines
  const allLines: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (raw.length <= MAX_CHARS) { allLines.push(raw); continue; }
    for (let i = 0; i < raw.length; i += MAX_CHARS) allLines.push(raw.slice(i, i + MAX_CHARS));
  }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let lineOnPage = 0;

  for (const line of allLines) {
    if (lineOnPage >= LINES_PER_PAGE) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      lineOnPage = 0;
    }
    const y = PAGE_H - MARGIN - lineOnPage * LINE_H;
    if (line) page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font });
    lineOnPage++;
  }

  return bytesToBase64(await doc.save());
}

// ─── Image → PDF ──────────────────────────────────────────────────────────────

async function imageToPdfBase64(base64: string, format: "jpeg" | "png"): Promise<string> {
  const bytes = base64ToBytes(base64);
  const doc = await PDFDocument.create();
  const image = format === "jpeg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);

  const PAGE_W = 612;
  const PAGE_H = 792;
  const MARGIN = 20;
  const maxW = PAGE_W - 2 * MARGIN;
  const maxH = PAGE_H - 2 * MARGIN;
  const { width, height } = image.scale(1);
  const scale = Math.min(maxW / width, maxH / height, 1);
  const drawW = width * scale;
  const drawH = height * scale;

  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawImage(image, {
    x: MARGIN + (maxW - drawW) / 2,
    y: PAGE_H - MARGIN - drawH,
    width: drawW,
    height: drawH,
  });

  return bytesToBase64(await doc.save());
}
