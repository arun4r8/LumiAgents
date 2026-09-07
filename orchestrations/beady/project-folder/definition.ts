import { z } from "zod";
import { defineOrchestration, step } from "@/runtime";
import { sbHeaders } from "@/runtime/utils/supabase";
import { ensureProjectFolder, projectFolderName } from "../../../integrations/msgraph/folders";

/**
 * Create the SharePoint folder tree for a pursued opportunity (#207).
 *
 * An orchestration rather than a dashboard action, for two reasons. The MSGRAPH_*
 * secrets live in the runtime Worker, not the dashboard. And folder creation is
 * several Graph calls that can fail independently of the triage decision: marking
 * something Pursue must not fail because SharePoint is having a moment, so this runs
 * separately and the board reflects it when it lands.
 *
 * Idempotent end to end -- safe on every Pursue, including a re-Pursue after an
 * Ignore, and safe to re-run after a partial failure.
 */

export const inputSchema = z.object({
  opportunityId: z.string().uuid().describe("public.opportunities.id to create a folder for."),
  driveId: z
    .string()
    .optional()
    .describe("Graph drive hosting the Lumiture Labs document library (default: BD_DRIVE_ID)."),
});

export const outputSchema = z.object({
  created: z.boolean(),
  folderId: z.string().nullable(),
  webUrl: z.string().nullable(),
  folderName: z.string().nullable(),
  skipped: z.string().nullable().describe("Why nothing happened, when nothing happened."),
});

interface OppRow {
  id: string;
  title: string | null;
  solicitation_number: string | null;
  sharepoint_folder_id: string | null;
}

export default defineOrchestration({
  name: "beady/project-folder",
  version: 1,
  description:
    "Create (or find) the per-project SharePoint folder tree for a pursued opportunity, and record its driveItem id on the row.",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    const driveId = input.driveId ?? ctx.env.BD_DRIVE_ID;
    if (!driveId || !ctx.env.MSGRAPH_TENANT_ID || !ctx.env.MSGRAPH_CLIENT_ID || !ctx.env.MSGRAPH_CLIENT_SECRET) {
      // Not an error. Graph may simply not be configured in this environment, and a
      // pursued opportunity without a folder is a smaller problem than a failed run
      // that makes the triage look broken.
      return {
        created: false,
        folderId: null,
        webUrl: null,
        folderName: null,
        skipped: "Microsoft Graph or BD_DRIVE_ID not configured",
      };
    }

    const opp = await step(ctx, "load-opportunity", async () => {
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${encodeURIComponent(input.opportunityId)}&select=id,title,solicitation_number,sharepoint_folder_id&limit=1`,
        { headers: sbHeaders(ctx.env) },
      );
      if (!res.ok) throw new Error(`load opportunity → ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as OppRow[];
      if (!rows[0]) throw new Error(`opportunity ${input.opportunityId} not found`);
      return rows[0];
    });

    const folderName = projectFolderName({ solicitationNumber: opp.solicitation_number, title: opp.title });

    const folder = await step(ctx, "ensure-folder", async () =>
      ensureProjectFolder(ctx.env, driveId, {
        solicitationNumber: opp.solicitation_number,
        title: opp.title,
      }),
    );

    await step(ctx, "record-folder", async () => {
      const res = await ctx.fetch(
        `${ctx.env.SUPABASE_URL}/rest/v1/opportunities?id=eq.${encodeURIComponent(opp.id)}`,
        {
          method: "PATCH",
          headers: sbHeaders(ctx.env, { extra: { Prefer: "return=minimal" } }),
          body: JSON.stringify({ sharepoint_folder_id: folder.folderId, sharepoint_folder_url: folder.webUrl }),
        },
      );
      if (!res.ok) throw new Error(`record folder → ${res.status}: ${await res.text()}`);
    });

    return {
      // `created` means "the tree exists now", not "it did not exist before". The
      // point of the idempotent path is that the caller need not care which.
      created: true,
      folderId: folder.folderId,
      webUrl: folder.webUrl,
      folderName,
      skipped: null,
    };
  },
});
