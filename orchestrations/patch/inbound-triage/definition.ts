import { z } from "zod";
import { defineOrchestration, step, llm_decide, llm_extract, await_approval } from "@/runtime";
import { sendAlertEmail, subscriptionRecipients } from "../../../integrations/resend/alert";
import { senderFor } from "../../../integrations/resend/sender";
import type { Env } from "@/runtime";

// Where these notifications go, and why by email.
//
// Every branch below used to post an Office 365 Connector card into a Teams channel.
// Microsoft retired Office 365 Connectors in the 18-22 May 2026 rollout, after which
// the incoming webhook stopped delivering, so those posts have gone nowhere since.
// Email is the path that already reaches people (the digests and the watchdog use it),
// so the notifications move there rather than picking up a new dependency.
//
// Recipients are the operational alert list (#233), plus anything in ALERT_EMAIL. sendAlertEmail degrades to { sent: false } when there is no recipient
// or no RESEND_API_KEY, so a notification can never fail a run.
async function notifyOps(
  env: Env,
  opts: { subject: string; text: string },
): Promise<{ sent: boolean; recipients: number }> {
  const to = await subscriptionRecipients(env, "alert");
  const result = await sendAlertEmail(env, {
    to,
    subject: opts.subject,
    text: opts.text,
    from: senderFor(env, "patch"),
  });
  return { sent: result.sent, recipients: to.length };
}

export const inputSchema = z.object({
  source: z.enum(["email"]).describe("Channel the message arrived on"),
  messageId: z.string().describe("External message ID for deduplication"),
  from: z.string().describe("Sender email address"),
  subject: z.string().optional().describe("Message subject line, when the channel has one"),
  body: z.string().describe("Full message body"),
  receivedAt: z.string().datetime().optional().describe("ISO timestamp the message was received. Defaults to now"),
});

export const outputSchema = z.object({
  action: z.enum(["ticket", "reply", "notified", "discard"]),
  intent: z.enum(["inquiry", "task", "escalation", "noise"]),
  referenceId: z.string().optional().describe("Jira ticket key, if one was created"),
  summary: z.string(),
});

export default defineOrchestration({
  name: "patch/inbound-triage",
  version: 1,
  description: "Triage inbound email: classify, extract action items, route or auto-respond",
  inputSchema,
  outputSchema,
  access: {
    triggerableBy: ["role:ops"],
    visibleTo: ["role:ops"],
  },

  async run(ctx, input): Promise<z.infer<typeof outputSchema>> {
    // Step 1: Classify the message intent
    const intent = await llm_decide(ctx, {
      name: "classify-intent",
      prompt: "Classify the intent of this inbound message for a government contracting firm.",
      input: {
        from: input.from,
        subject: input.subject,
        body: input.body.slice(0, 2000),
        source: input.source,
      },
      options: ["inquiry", "task", "escalation", "noise"] as const,
    });

    // Discard noise immediately
    if (intent === "noise") {
      return { action: "discard", intent, summary: "Message classified as noise. No action taken." };
    }

    // Step 2: Extract structured action items
    const extracted = await llm_extract(ctx, {
      name: "extract-action-items",
      prompt: "Extract structured action items and a summary from this message.",
      input: { from: input.from, subject: input.subject, body: input.body, intent },
      schema: z.object({
        summary: z.string().describe("1-2 sentence summary of the message"),
        priority: z.enum(["high", "medium", "low"]),
        actionItems: z.array(z.string()).describe("Concrete tasks or follow-ups needed"),
        suggestedAssignee: z.string().nullable().describe("Who should handle this, if determinable"),
      }),
      maxTokens: 16384,
    });

    // Step 3: Route based on intent
    if (intent === "escalation") {
      // Email ops, then pause for human approval before responding
      await step(ctx, "email-escalation", () =>
        notifyOps(ctx.env, {
          subject: `🚨 Escalation: ${input.subject ?? "No subject"} from ${input.from}`,
          text:
            `${extracted.summary}\n\n` +
            `From: ${input.from}\n` +
            `Subject: ${input.subject ?? "No subject"}\n` +
            `Priority: ${extracted.priority}\n` +
            (extracted.suggestedAssignee ? `Suggested owner: ${extracted.suggestedAssignee}\n` : "") +
            `\nView message: https://outlook.office.com/mail/${input.messageId}`,
        }),
      );

      const decision = await await_approval(ctx, {
        name: "approve-escalation-response",
        prompt: `Escalation from ${input.from}: "${extracted.summary}". Approve to send acknowledgement reply, reject to hold.`,
        from: { role: "ops" },
        expiresInHours: 4,
      });

      return {
        action: decision.approved ? "reply" : "notified",
        intent,
        summary: extracted.summary,
      };
    }

    if (intent === "task" && extracted.actionItems.length > 0) {
      // Email the ops task list
      await step(ctx, "email-task", () =>
        notifyOps(ctx.env, {
          subject: `New task: ${extracted.summary}`,
          text:
            `${extracted.summary}\n\n` +
            `From: ${input.from}\n` +
            `Priority: ${extracted.priority}\n` +
            (extracted.suggestedAssignee ? `Suggested owner: ${extracted.suggestedAssignee}\n` : "") +
            `\nAction items:\n` +
            extracted.actionItems.map((a, i) => `${i + 1}. ${a}`).join("\n"),
        }),
      );

      return { action: "notified", intent, summary: extracted.summary };
    }

    // inquiry: a plain note to ops
    await step(ctx, "email-inquiry", () =>
      notifyOps(ctx.env, {
        subject: `Inquiry: ${input.subject ?? extracted.summary}`,
        text: `Inquiry from ${input.from}:\n\n${extracted.summary}`,
      }),
    );

    return { action: "reply", intent, summary: extracted.summary };
  },
});
