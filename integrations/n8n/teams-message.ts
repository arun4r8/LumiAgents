import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { callN8nWebhook } from "./base";

export const teamsMessageInputSchema = z.object({
  channel: z.string().describe("Teams channel name or ID"),
  message: z.string(),
  subject: z.string().optional(),
});

export const teamsMessageOutputSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
});

export const sendTeamsMessage = defineTool({
  name: "sendTeamsMessage",
  inputSchema: teamsMessageInputSchema,
  outputSchema: teamsMessageOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      "teams-message",
      input,
      ctx.idempotencyKey("teams-message", input.channel, input.subject ?? input.message.slice(0, 20)),
    );
  },
});

export const teamsCardInputSchema = z.object({
  channel: z.string(),
  title: z.string(),
  body: z.string(),
  actions: z.array(z.object({ label: z.string(), url: z.string() })).optional(),
});

export const teamsCardOutputSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
});

export const sendTeamsCard = defineTool({
  name: "sendTeamsCard",
  inputSchema: teamsCardInputSchema,
  outputSchema: teamsCardOutputSchema,
  async run(ctx, input) {
    return callN8nWebhook(
      ctx,
      "teams-card",
      input,
      ctx.idempotencyKey("teams-card", input.channel, input.title),
    );
  },
});
