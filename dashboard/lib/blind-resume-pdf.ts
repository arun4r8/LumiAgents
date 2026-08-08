import { jsPDF } from "jspdf";

/**
 * Renders a redaction-verified resume onto Lumiture letterhead (#156).
 *
 * Client-side on purpose. The dashboard already ships jsPDF and already builds
 * the XLSX export in the browser, and `orchestration.artifacts` has never been
 * used (it wants a Supabase Storage path, and no bucket is configured). Doing it
 * here means no storage to stand up, no binary in the run output, and the file
 * lands in the user's downloads the moment it is ready.
 *
 * The mark is drawn rather than placed. public/lumiture-badge.png is 31x31, a
 * favicon rather than a logo, and upscaling it onto letterhead looks exactly as
 * bad as it sounds. The in-app identity is typographic anyway (a boxed "L" plus
 * the wordmark, components/sidebar.tsx), so this reproduces that in vector and
 * stays crisp at any zoom or print size. Swap in a real asset when there is one.
 */

/** --color-accent from app/lumi.css, as RGB. */
const ACCENT: [number, number, number] = [0x91, 0x84, 0xd9];
const INK: [number, number, number] = [0x1a, 0x1a, 0x1f];
const MUTED: [number, number, number] = [0x6b, 0x6b, 0x76];

const PAGE_W = 216; // Letter, mm
const PAGE_H = 279;
const MARGIN = 18;
const CONTENT_W = PAGE_W - MARGIN * 2;

/** A line is a section header if it is short and effectively all caps. */
function isSectionHeader(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > 48) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase();
}

function drawLetterhead(doc: jsPDF, candidateCode?: string): number {
  // Boxed "L" mark, top-left.
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.4);
  doc.roundedRect(MARGIN, MARGIN, 9, 9, 1.2, 1.2, "S");
  doc.setTextColor(...ACCENT);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("L", MARGIN + 4.5, MARGIN + 6.4, { align: "center" });

  // Wordmark beside it.
  doc.setTextColor(...INK);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("Lumiture", MARGIN + 12.5, MARGIN + 6.6);

  if (candidateCode) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(`Candidate ${candidateCode}`, PAGE_W - MARGIN, MARGIN + 6.4, { align: "right" });
  }

  doc.setDrawColor(0xe4, 0xe4, 0xea);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, MARGIN + 13, PAGE_W - MARGIN, MARGIN + 13);

  return MARGIN + 22;
}

function drawFooter(doc: jsPDF, page: number, pages: number): void {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  doc.text(
    "Confidential. Candidate identity withheld for client review.",
    MARGIN,
    PAGE_H - 10,
  );
  doc.text(`${page} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 10, { align: "right" });
}

export interface BlindResumeOptions {
  /** Redaction-verified text. Must already be clean; this function does not redact. */
  text: string;
  /** Optional non-identifying label, e.g. "LUM-0042". */
  candidateCode?: string;
}

/**
 * Build the PDF and return it as a Blob.
 *
 * Note the document metadata: it is set explicitly to non-identifying values.
 * jsPDF would otherwise leave title and author empty, but anything derived from
 * a filename or a default would survive text extraction and defeat the point of
 * redacting the body.
 */
export function buildBlindResumePdf({ text, candidateCode }: BlindResumeOptions): Blob {
  const doc = new jsPDF({ unit: "mm", format: "letter" });

  doc.setProperties({
    title: candidateCode ? `Candidate ${candidateCode}` : "Candidate profile",
    subject: "Blind resume prepared for client review",
    author: "Lumiture",
    creator: "Lumiture",
    keywords: "",
  });

  let y = drawLetterhead(doc, candidateCode);

  const lines = text.replace(/\r\n/g, "\n").split("\n");

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      y += 3;
      continue;
    }

    const header = isSectionHeader(line);
    doc.setFont("helvetica", header ? "bold" : "normal");
    doc.setFontSize(header ? 10 : 9.5);
    doc.setTextColor(...(header ? ACCENT : INK));

    if (header) y += 3;

    const wrapped = doc.splitTextToSize(line, CONTENT_W) as string[];
    for (const w of wrapped) {
      if (y > PAGE_H - 20) {
        doc.addPage();
        y = drawLetterhead(doc, candidateCode);
        doc.setFont("helvetica", header ? "bold" : "normal");
        doc.setFontSize(header ? 10 : 9.5);
        doc.setTextColor(...(header ? ACCENT : INK));
      }
      doc.text(w, MARGIN, y);
      y += header ? 5.4 : 4.6;
    }

    if (header) y += 1.2;
  }

  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawFooter(doc, p, pages);
  }

  return doc.output("blob");
}

/** Filename that carries no candidate identity either. */
export function blindResumeFilename(candidateCode?: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return candidateCode
    ? `lumiture-candidate-${candidateCode}-${stamp}.pdf`
    : `lumiture-blind-resume-${stamp}.pdf`;
}
