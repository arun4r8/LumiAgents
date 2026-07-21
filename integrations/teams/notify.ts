/**
 * Drop-in replacements for the n8n teams-message / teams-card tools.
 * Import from here instead of integrations/n8n/teams-message.
 */

import { z } from "zod";
import { defineTool } from "../../runtime/src";
import { sendIncomingWebhookMessage, sendIncomingWebhookCard } from "./incoming-webhook";

// ─── sendTeamsMessage ─────────────────────────────────────────────────────────

export const sendTeamsMessage = defineTool({
  name: "sendTeamsMessage",
  inputSchema: z.object({
    channel: z.string().describe("Teams channel name or ID (informational; the webhook URL determines the destination)"),
    message: z.string(),
    subject: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
  }),
  async run(ctx, input) {
    await sendIncomingWebhookMessage(ctx.env, {
      ...(input.subject !== undefined && { title: input.subject }),
      text: input.message,
    });
    return { success: true };
  },
});

// ─── sendTeamsCard ────────────────────────────────────────────────────────────

export const sendTeamsCard = defineTool({
  name: "sendTeamsCard",
  inputSchema: z.object({
    channel: z.string(),
    title: z.string(),
    body: z.string(),
    actions: z
      .array(z.object({ label: z.string(), url: z.string() }))
      .optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string().optional(),
  }),
  async run(ctx, input) {
    await sendIncomingWebhookCard(ctx.env, {
      title: input.title,
      body: input.body,
      ...(input.actions !== undefined && { actions: input.actions }),
    });
    return { success: true };
  },
});
