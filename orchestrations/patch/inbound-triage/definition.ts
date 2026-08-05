import { z } from "zod";
import { defineOrchestration, step, llm_decide, llm_extract, await_approval } from "@/runtime";
import { sendTeamsMessage, sendTeamsCard } from "./tools";

export const inputSchema = z.object({
  source: z.enum(["email", "teams"]).describe("Channel the message arrived on"),
  messageId: z.string().describe("External message ID for deduplication"),
  from: z.string().describe("Sender email or Teams user"),
  subject: z.string().optional().describe("Message subject line, when the channel has one"),
  body: z.string().describe("Full message body"),
  receivedAt: z.string().datetime().optional().describe("ISO timestamp the message was received. Defaults to now"),
});

export const outputSchema = z.object({
  action: z.enum(["ticket", "reply", "card", "discard"]),
  intent: z.enum(["inquiry", "task", "escalation", "noise"]),
  referenceId: z.string().optional().describe("Jira ticket key or Teams message ID if created"),
  summary: z.string(),
});

export default defineOrchestration({
  name: "patch/inbound-triage",
  version: 1,
  description: "Triage inbound email or Teams messages: classify, extract action items, route or auto-respond",
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
    });

    // Step 3: Route based on intent
    if (intent === "escalation") {
      // Post a Teams card and pause for human approval before responding
      await step(ctx, "post-escalation-card", () =>
        sendTeamsCard(ctx, {
          channel: "ops-alerts",
          title: `Escalation: ${input.subject ?? "No subject"} from ${input.from}`,
          body: extracted.summary,
          actions: [{ label: "View message", url: `https://outlook.office.com/mail/${input.messageId}` }],
        }),
      );

      const decision = await await_approval(ctx, {
        name: "approve-escalation-response",
        prompt: `Escalation from ${input.from}: "${extracted.summary}". Approve to send acknowledgement reply, reject to hold.`,
        from: { role: "ops" },
        expiresInHours: 4,
      });

      return {
        action: decision.approved ? "reply" : "card",
        intent,
        summary: extracted.summary,
      };
    }

    if (intent === "task" && extracted.actionItems.length > 0) {
      // Post to Teams ops channel
      await step(ctx, "post-task-card", () =>
        sendTeamsCard(ctx, {
          channel: "ops-tasks",
          title: `New task: ${extracted.summary}`,
          body: extracted.actionItems.map((a, i) => `${i + 1}. ${a}`).join("\n"),
        }),
      );

      return { action: "card", intent, summary: extracted.summary };
    }

    // inquiry: post simple Teams message
    await step(ctx, "post-inquiry-message", () =>
      sendTeamsMessage(ctx, {
        channel: "ops-general",
        subject: input.subject,
        message: `Inquiry from ${input.from}:\n${extracted.summary}`,
      }),
    );

    return { action: "reply", intent, summary: extracted.summary };
  },
});
