/**
 * DOUBLE PROVENANCE: Microsoft Graph attachment payloads, modelled on the shapes
 * documented at https://learn.microsoft.com/graph/api/resources/chatmessageattachment.
 * Not modelled: Graph's throttling (429 + Retry-After) and the fact that
 * `contentUrl` can be present with `content` null for hosted files. If either
 * matters to a future change, extend the double from the docs first -- see
 * docs/testing-doubles.md.
 */
import { describe, it, expect, vi } from "vitest";
import { downloadTeamsFiles } from "../../../integrations/teams/bot";
import type { BotAttachment } from "../../../integrations/teams/bot";

/**
 * Covers Teams file ingestion (#159).
 *
 * The behaviour that matters is not the happy path, it is that a file which
 * cannot be read is REPORTED rather than dropped. The original route parsed
 * attachments and ignored them, so uploading a resume did nothing at all and
 * nobody noticed for months. Silence is the failure mode to defend against.
 */

const FILE_TYPE = "application/vnd.microsoft.teams.file.download.info";

function fileAttachment(name: string, downloadUrl = "https://example.test/f"): BotAttachment {
  return { contentType: FILE_TYPE, name, content: { downloadUrl } };
}

function fetchReturning(body: string, ok = true, status = 200): typeof fetch {
  return vi.fn(async () => ({
    ok,
    status,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  })) as unknown as typeof fetch;
}

describe("downloadTeamsFiles", () => {
  it("downloads a text file and passes it through as text", async () => {
    const res = await downloadTeamsFiles([fileAttachment("resume.txt")], fetchReturning("Jane Doe\nEngineer"));
    expect(res.skipped).toEqual([]);
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.mimeType).toBe("text/plain");
    expect(res.files[0]!.content).toBe("Jane Doe\nEngineer");
  });

  it("base64-encodes a binary file rather than mangling it as text", async () => {
    const res = await downloadTeamsFiles([fileAttachment("resume.pdf")], fetchReturning("%PDF-1.7 binary"));
    expect(res.files[0]!.mimeType).toBe("application/pdf");
    expect(res.files[0]!.content).toBe(btoa("%PDF-1.7 binary"));
  });

  it("ignores attachments that are not uploaded files", async () => {
    const inlineImage: BotAttachment = { contentType: "image/png", name: "signature.png" };
    const card: BotAttachment = { contentType: "application/vnd.microsoft.card.adaptive" };
    const res = await downloadTeamsFiles([inlineImage, card], fetchReturning("x"));
    expect(res.files).toEqual([]);
    // Not "skipped" either: these were never candidates, so reporting them would be noise.
    expect(res.skipped).toEqual([]);
  });

  it("reports an unsupported file type instead of dropping it silently", async () => {
    const res = await downloadTeamsFiles([fileAttachment("headshot.heic")], fetchReturning("x"));
    expect(res.files).toEqual([]);
    expect(res.skipped[0]).toContain("headshot.heic");
    expect(res.skipped[0]).toContain("unsupported");
  });

  it("reports a failed download instead of dropping it silently", async () => {
    const res = await downloadTeamsFiles([fileAttachment("resume.pdf")], fetchReturning("", false, 403));
    expect(res.files).toEqual([]);
    expect(res.skipped[0]).toContain("403");
  });

  it("reports a missing download link", async () => {
    const broken: BotAttachment = { contentType: FILE_TYPE, name: "resume.pdf", content: {} };
    const res = await downloadTeamsFiles([broken], fetchReturning("x"));
    expect(res.skipped[0]).toContain("no download link");
  });

  it("survives a fetch that throws", async () => {
    const throwing = vi.fn(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const res = await downloadTeamsFiles([fileAttachment("resume.pdf")], throwing);
    expect(res.files).toEqual([]);
    expect(res.skipped[0]).toContain("resume.pdf");
  });

  it("refuses an implausibly large file", async () => {
    const huge = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(13 * 1024 * 1024),
    })) as unknown as typeof fetch;
    const res = await downloadTeamsFiles([fileAttachment("resume.pdf")], huge);
    expect(res.files).toEqual([]);
    expect(res.skipped[0]).toContain("too large");
  });

  it("keeps the good files when one of several fails", async () => {
    let call = 0;
    const mixed = vi.fn(async () => {
      call++;
      return call === 1
        ? { ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }
        : { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("ok").buffer };
    }) as unknown as typeof fetch;
    const res = await downloadTeamsFiles(
      [fileAttachment("broken.pdf"), fileAttachment("good.txt")],
      mixed,
    );
    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.name).toBe("good.txt");
    expect(res.skipped).toHaveLength(1);
  });
});
