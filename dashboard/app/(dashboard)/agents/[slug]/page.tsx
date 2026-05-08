import { notFound } from "next/navigation";
import { AGENTS } from "../page";
import AgentChatClient from "@/components/agent-chat-client";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function AgentDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const agent = AGENTS.find((a) => a.slug === slug);

  if (!agent) notFound();

  return (
    <AgentChatClient
      slug={agent.slug}
      agentName={agent.name}
      agentEmoji={agent.emoji}
      description={agent.description}
      suggestedPrompts={agent.suggestedPrompts}
    />
  );
}

export function generateStaticParams() {
  return AGENTS.map((a) => ({ slug: a.slug }));
}
