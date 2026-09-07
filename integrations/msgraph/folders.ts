/**
 * Per-project SharePoint folders for the BD pipeline (#207).
 *
 * Layout, from the LumiAgents BD Figma:
 *
 *   Shared Documents/General/
 *     Opportunity Tracking/
 *       {solicitation-number} — {short title}/
 *         NOTES/            human space; automation never writes here
 *         SOLICITATION/     received documents: the RFI/RFP, pricing template
 *         RESPONSE/         everything we generate
 *
 * Three decisions worth disagreeing with explicitly rather than discovering later:
 *
 * FOLDER NAMES KEY ON THE SOLICITATION NUMBER. Unique, stable, already on the card,
 * and short. Titles get edited and carry characters SharePoint rejects.
 *
 * AUTOMATION WRITES ONLY TO RESPONSE. The Figma puts humans in NOTES. If generated
 * content only ever lands in one place, "did a person or a machine write this" is
 * answerable by location -- which matters given the concern about AI-generated
 * output going out under the company's name.
 *
 * PRICING SITS UNDER SOLICITATION, matching the Figma, even though pricing is
 * something we produce rather than receive. That is the open question on #207. This
 * implements the design as drawn; moving it later is a folder rename, not a
 * migration, so following the drawing is the cheaper way to be wrong.
 */

import { graphGet, graphPost, type MsGraphEnv } from "./base";

export const PROJECT_SUBFOLDERS = ["NOTES", "SOLICITATION", "RESPONSE"] as const;
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
 * The folder name for an opportunity: solicitation number first because it is the
 * stable half, title after it because that is what a human scans for.
 */
export function projectFolderName(opts: { solicitationNumber?: string | null; title?: string | null }): string {
  const num = opts.solicitationNumber?.trim();
  const title = opts.title?.trim();
  if (num && title) return sanitiseFolderName(`${num} - ${title}`);
  if (num) return sanitiseFolderName(num);
  return sanitiseFolderName(title ?? "untitled opportunity");
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
