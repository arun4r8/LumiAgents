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

const fmtDate = (d: Date): string =>
  `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;

export async function fetchOpportunityAttachmentText(
  env: Env,
  noticeId: string,
  postedDate?: string | null,
  maxChars = 40000,
): Promise<string> {
  const parts: string[] = [];
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
    const res = await fetch(`https://api.sam.gov/opportunities/v2/search?${params.toString()}`, { headers: { Accept: "application/json" } });
    if (!res.ok) return "";
    const data = (await res.json()) as { opportunitiesData?: Array<{ description?: string; resourceLinks?: string[] }> };
    const opp = data.opportunitiesData?.[0];
    if (!opp) return "";

    // 2. Notice description (in SAM v2 `description` is usually a URL to the text).
    if (opp.description?.startsWith("http")) {
      try {
        const dres = await fetch(withKey(opp.description, env.SAM_GOV_API_KEY), { headers: { Accept: "application/json" } });
        if (dres.ok) {
          const dj = (await dres.json()) as { description?: string };
          if (dj.description) parts.push(`# Notice description\n${stripHtml(dj.description)}`);
        }
      } catch { /* best-effort */ }
    } else if (opp.description) {
      parts.push(`# Notice description\n${opp.description}`);
    }

    // 3. Attachments — PDFs → text via Haiku OCR; other types skipped for now.
    for (const link of (opp.resourceLinks ?? []).slice(0, 4)) {
      try {
        const ares = await fetch(withKey(link, env.SAM_GOV_API_KEY));
        if (!ares.ok) continue;
        const ct = ares.headers.get("content-type") ?? "";
        if (ct.includes("pdf") || link.toLowerCase().includes(".pdf")) {
          const b64 = arrayBufferToBase64(await ares.arrayBuffer());
          const text = await pdfToText(env, b64);
          if (text.trim()) parts.push(`# Attachment\n${text.trim()}`);
        }
      } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return parts.join("\n\n").slice(0, maxChars);
}
