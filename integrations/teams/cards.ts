/**
 * Adaptive Card builders for Teams notifications.
 * All cards use Adaptive Cards schema v1.4 (supported by Teams).
 */

export interface CardAction {
  label: string;
  url: string;
}

// ─── Generic card ─────────────────────────────────────────────────────────────

export function buildAdaptiveCard(
  title: string,
  body: string,
  actions?: CardAction[],
): Record<string, unknown> {
  const card: Record<string, unknown> = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        size: "Medium",
        weight: "Bolder",
        text: title,
        wrap: true,
      },
      {
        type: "TextBlock",
        text: body,
        wrap: true,
        spacing: "Small",
      },
    ],
  };

  if (actions?.length) {
    card.actions = actions.map((a) => ({
      type: "Action.OpenUrl",
      title: a.label,
      url: a.url,
    }));
  }

  return card;
}

// ─── Run notification card ────────────────────────────────────────────────────

export function buildRunCard(options: {
  orchestrationName: string;
  runId: string;
  status: "running" | "completed" | "failed" | "paused";
  summary?: string;
  dashboardUrl: string;
}): Record<string, unknown> {
  const statusEmoji = {
    running: "⏳",
    completed: "✅",
    failed: "❌",
    paused: "⏸️",
  }[options.status];

  return buildAdaptiveCard(
    `${statusEmoji} ${options.orchestrationName}`,
    options.summary ?? `Run ${options.runId.slice(0, 8)} — ${options.status}`,
    [{ label: "View run →", url: `${options.dashboardUrl}/runs/${options.runId}` }],
  );
}

// ─── Jira ticket card ─────────────────────────────────────────────────────────

export function buildTicketCard(options: {
  ticketKey: string;
  summary: string;
  priority: string;
  requestedBy?: string;
  jiraUrl: string;
}): Record<string, unknown> {
  const priorityEmoji = { Highest: "🔴", High: "🟠", Medium: "🟡", Low: "🟢" }[options.priority] ?? "⚪";
  const lines = [
    `**${options.summary}**`,
    `Priority: ${priorityEmoji} ${options.priority}`,
    ...(options.requestedBy ? [`Requested by: ${options.requestedBy}`] : []),
  ];

  return buildAdaptiveCard(
    `🎫 ${options.ticketKey}`,
    lines.join("\n"),
    [{ label: "Open in Jira", url: options.jiraUrl }],
  );
}

// ─── Approval request card ────────────────────────────────────────────────────

export function buildApprovalCard(options: {
  prompt: string;
  requestedBy?: string;
  dashboardUrl: string;
  runId: string;
}): Record<string, unknown> {
  return buildAdaptiveCard(
    "⏸️ Approval required",
    `${options.prompt}${options.requestedBy ? `\n\nRequested by: ${options.requestedBy}` : ""}`,
    [{ label: "Review in dashboard →", url: `${options.dashboardUrl}/approvals` }],
  );
}
