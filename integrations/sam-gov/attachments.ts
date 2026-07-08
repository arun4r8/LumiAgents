import type { Env } from "../../runtime/src/types";
import { pdfToText } from "../anthropic/govcon";

// Fetch the full notice text for a SAM opportunity — its description plus the text
// of any PDF attachments (the RFI itself, where the specific questions live). Used
// by cleo/rfi-draft so the response can answer the notice's actual questions.
// Best-effort: returns "" if nothing is retrievable; non-PDF attachments (e.g. docx)
// are skipped for now.

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const withKey = (url: string, key: string): string => `${url}${url.includes("?") ? "&" : "?"}api_key=${key}`;

// ─── .docx → text (no dependency: ZIP parse + built-in DecompressionStream) ─────
// SAM Sources Sought attachments are usually .docx (the questions live there). We
// unzip word/document.xml via the central directory and strip the XML to text.

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findZipEntry(buf: Uint8Array, name: string): { offset: number; compSize: number; method: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let n = 0; n < cdCount; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const fnLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const fn = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + fnLen));
    if (fn === name) return { offset: localOffset, compSize, method };
    p += 46 + fnLen + extraLen + commentLen;
  }
  return null;
}

function docxXmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>/g, "\n")
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function docxToText(buf: Uint8Array): Promise<string> {
  const entry = findZipEntry(buf, "word/document.xml");
  if (!entry) return "";
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(entry.offset, true) !== 0x04034b50) return "";
  const fnLen = dv.getUint16(entry.offset + 26, true);
  const extraLen = dv.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + fnLen + extraLen;
  const comp = buf.subarray(start, start + entry.compSize);
  const raw = entry.method === 0 ? comp : await inflateRaw(comp);
  return docxXmlToText(new TextDecoder().decode(raw));
}

const fmtDate = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

export interface AttachmentResult {
  text: string;
  /** Human-readable trace of what happened — surfaced in the run step for observability. */
  note: string;
}

// Retry transient SAM failures (429 / 5xx) with linear backoff. Returns the last
// response either way; the caller inspects .ok / .status.
async function fetchWithRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let res = await fetch(url, init);
  for (let a = 1; a < tries && (res.status === 429 || res.status >= 500); a++) {
    await new Promise((r) => setTimeout(r, 500 * a));
    res = await fetch(url, init);
  }
  return res;
}

export async function fetchOpportunityAttachmentText(
  env: Env,
  noticeId: string,
  postedDate?: string | null,
  maxChars = 40000,
): Promise<AttachmentResult> {
  const parts: string[] = [];
  const notes: string[] = [];
  try {
    // SAM v2 search REQUIRES a postedFrom/postedTo window (<= 1 year). Center it on
    // the notice's posted date when known, else use the last ~year.
    const anchor = postedDate ? new Date(postedDate) : new Date();
    const from = new Date(isNaN(anchor.getTime()) ? Date.now() : anchor.getTime());
    from.setDate(from.getDate() - 5);
    const to = new Date(from);
    to.setDate(to.getDate() + 360);

    // 1. Look the opportunity up to get its description link + resourceLinks.
    const params = new URLSearchParams({
      api_key: env.SAM_GOV_API_KEY,
      noticeid: noticeId,
      postedFrom: fmtDate(from),
      postedTo: fmtDate(to),
      limit: "1",
    });
    const res = await fetchWithRetry(`https://api.sam.gov/opportunities/v2/search?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      return { text: "", note: `SAM search failed: HTTP ${res.status}${res.status === 429 ? " (rate-limited — shares the daily SAM quota with the sweep)" : ""}` };
    }
    const data = (await res.json()) as { opportunitiesData?: Array<{ description?: string; resourceLinks?: string[] }> };
    const opp = data.opportunitiesData?.[0];
    if (!opp) return { text: "", note: "notice not found in SAM (may have aged out of the 1-year window)" };

    // 2. Notice description (in SAM v2 `description` is usually a URL to the text).
    if (opp.description?.startsWith("http")) {
      const dres = await fetchWithRetry(withKey(opp.description, env.SAM_GOV_API_KEY), { headers: { Accept: "application/json" } });
      if (dres.ok) {
        const dj = (await dres.json()) as { description?: string };
        if (dj.description) { parts.push(`# Notice description\n${stripHtml(dj.description)}`); notes.push("description"); }
      } else notes.push(`description HTTP ${dres.status}`);
    } else if (opp.description) {
      parts.push(`# Notice description\n${opp.description}`); notes.push("description");
    }

    // 3. Attachments — PDFs → Haiku OCR; .docx → unzip word/document.xml.
    const links = opp.resourceLinks ?? [];
    for (const link of links.slice(0, 4)) {
      try {
        const ares = await fetchWithRetry(withKey(link, env.SAM_GOV_API_KEY), {});
        if (!ares.ok) { notes.push(`attachment HTTP ${ares.status}`); continue; }
        const ct = ares.headers.get("content-type") ?? "";
        const lower = link.toLowerCase();
        if (ct.includes("pdf") || lower.includes(".pdf")) {
          const b64 = arrayBufferToBase64(await ares.arrayBuffer());
          const text = await pdfToText(env, b64);
          if (text.trim()) { parts.push(`# Attachment\n${text.trim()}`); notes.push("pdf"); }
          else notes.push("pdf (no text)");
        } else if (ct.includes("wordprocessingml") || ct.includes("officedocument.word") || /\.docx(\?|$)/.test(lower)) {
          const text = await docxToText(new Uint8Array(await ares.arrayBuffer()));
          if (text.trim()) { parts.push(`# Attachment\n${text.trim()}`); notes.push("docx"); }
          else notes.push("docx (no text extracted)");
        } else {
          notes.push(`attachment skipped (${ct || "unknown type"})`);
        }
      } catch (e) { notes.push(`attachment error: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (links.length === 0) notes.push("no attachments listed");

    return { text: parts.join("\n\n").slice(0, maxChars), note: notes.join(", ") || "nothing retrieved" };
  } catch (e) {
    return { text: "", note: `error: ${e instanceof Error ? e.message : String(e)}` };
  }
}
