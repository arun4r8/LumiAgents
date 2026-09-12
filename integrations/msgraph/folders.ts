/**
 * Per-project SharePoint folders for the BD pipeline (#207).
 *
 * Layout, as it EXISTS in the Lumiture Labs library:
 *
 *   Shared Documents/General/
 *     Opportunity Tracking/
 *       {title}/
 *         Notes/            human space; automation never writes here
 *         Solicitation/     received documents: the RFI/RFP, pricing template
 *         Response/         everything we generate
 *
 * THE NAMING HERE IS OBSERVED, NOT DESIGNED. An earlier version of this keyed
 * folders on the solicitation number ("W91QF026QA015 - Some Title") and uppercased
 * the subfolders, reasoning from the Figma that a number is unique, stable and
 * short. Then BD created one by hand on 2026-09-10:
 *
 *   Opportunity Tracking/Advana and Army Vantage Data Engineering and A365
 *     Dataverse Foundation Support/{Notes,Response,Solicitation}
 *
 * Title only, title case. Shipping the designed convention would have produced a
 * SECOND folder beside that one for the same pursuit, which is the worst outcome
 * available: documents split across two directories that both look right. The
 * people who use this have answered the question, so this follows them.
 *
 * Two decisions that stand:
 *
 * AUTOMATION WRITES ONLY TO Response. The Figma puts humans in Notes. If generated
 * content only ever lands in one place, "did a person or a machine write this" is
 * answerable by location -- which matters given the concern about AI-generated
 * output going out under the company's name.
 *
 * PRICING SITS UNDER Solicitation, matching both the Figma and the folder BD built,
 * even though pricing is something we produce rather than receive. Moving it later
 * is a rename, not a migration.
 */

import { graphGet, graphPost, type MsGraphEnv } from "./base";

export const PROJECT_SUBFOLDERS = ["Notes", "Solicitation", "Response"] as const;
export const OPPORTUNITY_ROOT = "General/Opportunity Tracking";

export interface DriveItem {
  id: string;
  name: string;
  webUrl: string;
}

/**
 * SharePoint rejects " * : < > ? / \ | and leading/trailing whitespace or dots in
 * item names, and silently truncates very long ones. Solicitation numbers are tame
 * but titles are free text straight from SAM, so both go through this.
 */
export function sanitiseFolderName(raw: string, maxLength = 90): string {
  const cleaned = raw
    .replace(/["*:<>?/\\|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, maxLength)
    .replace(/[\s.]+$/g, "");
  return cleaned.length > 0 ? cleaned : "untitled";
}

/**
 * The folder name for an opportunity: its TITLE, matching what BD already creates
 * by hand. The solicitation number is deliberately not prefixed -- see the header.
 *
 * Falls back to the solicitation number when a notice has no title, which happens,
 * and to a fixed string when it has neither, so this never returns "" or "null".
 */
export function projectFolderName(opts: { solicitationNumber?: string | null; title?: string | null }): string {
  const title = opts.title?.trim();
  if (title) return sanitiseFolderName(title);
  const num = opts.solicitationNumber?.trim();
  if (num) return sanitiseFolderName(num);
  return sanitiseFolderName("untitled opportunity");
}

/** Create a child folder, treating "already exists" as success. */
async function ensureChild(env: MsGraphEnv, driveId: string, parentPath: string, name: string): Promise<DriveItem> {
  const parent = parentPath ? `root:/${encodeURI(parentPath)}:` : "root";
  try {
    return await graphPost<DriveItem>(env, `/drives/${driveId}/${parent}/children`, {
      name,
      folder: {},
      // Idempotent by construction: a second run returns the existing folder rather
      // than creating "NOTES 1". Without this the retry of a partially-failed run
      // quietly produces a duplicate tree.
      "@microsoft.graph.conflictBehavior": "fail",
    });
  } catch (err) {
    // 409 means it is already there, which is the outcome we wanted.
    if (err instanceof Error && /\b409\b/.test(err.message)) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      return await graphGet<DriveItem>(env, `/drives/${driveId}/root:/${encodeURI(path)}`);
    }
    throw err;
  }
}

export interface ProjectFolderResult {
  folderId: string;
  webUrl: string;
  created: string[];
}

/**
 * Create (or find) the folder tree for one opportunity. Idempotent: safe to call on
 * every Pursue, including a re-Pursue after an Ignore.
 *
 * Costs one Graph request per folder that does not yet exist, plus one lookup per
 * folder that does -- four in the worst case, against a 50-subrequest Worker
 * ceiling. The Graph token is cached (#221), so it is not doubled.
 */
export async function ensureProjectFolder(
  env: MsGraphEnv,
  driveId: string,
  opts: { solicitationNumber?: string | null; title?: string | null },
): Promise<ProjectFolderResult> {
  const name = projectFolderName(opts);
  const created: string[] = [];

  const project = await ensureChild(env, driveId, OPPORTUNITY_ROOT, name);
  created.push(name);

  for (const sub of PROJECT_SUBFOLDERS) {
    await ensureChild(env, driveId, `${OPPORTUNITY_ROOT}/${name}`, sub);
    created.push(`${name}/${sub}`);
  }

  return { folderId: project.id, webUrl: project.webUrl, created };
}
