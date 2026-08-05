import type { CSSProperties } from "react";
import { agentHue } from "@/lib/agent-style";

/**
 * AgentMark — the abstract letter-mark that replaces the SVG portraits and
 * emoji fallbacks as the agents' identity system.
 *
 * A rounded square (radius ≈ ¼ of its size) filled with
 * `oklch(var(--mark-l) 0.05 <hue>)`, carrying a single capital letter in
 * Inter 500 at `oklch(var(--mtext-l) 0.09 <hue>)`. --mark-l / --mtext-l flip
 * with the theme (0.28/0.8 dark, 0.9/0.38 light) and the hue comes from the
 * per-agent custom properties in app/lumi.css, so the whole mark is CSS —
 * no raster assets, no per-theme variants.
 *
 * Config agents (no designer-assigned hue) take their letter from the display
 * name's first character and render on the neutral fallback hue.
 *
 * Sizes from the handoff: 44 catalog card · 34 fleet tile · 32 chat header ·
 * 30 approval card · 28 memory row.
 *
 * Phase 1 ships the component; phases 4–6 swap the remaining portrait/emoji
 * call sites over as each screen is rebuilt.
 */

export type AgentMarkSize = 44 | 34 | 32 | 30 | 28;

export interface AgentMarkProps {
  /** Agent slug — picks the hue. Unknown slugs get the neutral fallback. */
  slug: string;
  /** Display name; its first character becomes the letter. Defaults to the slug. */
  name?: string;
  size?: AgentMarkSize;
  className?: string;
  style?: CSSProperties;
  /** Set when the mark is the only thing identifying the agent. */
  title?: string;
}

function initial(name: string | undefined, slug: string): string {
  const source = (name ?? "").trim() || slug.trim();
  // Prefer the first letter or digit; fall back to "?" for an empty/symbol name.
  const match = source.match(/[\p{L}\p{N}]/u);
  return (match ? match[0] : "?").toUpperCase();
}

export function AgentMark({
  slug,
  name,
  size = 34,
  className,
  style,
  title,
}: AgentMarkProps) {
  const hue = agentHue(slug);
  return (
    <span
      className={className ? `agent-mark ${className}` : "agent-mark"}
      title={title}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        background: `oklch(var(--mark-l) 0.05 ${hue})`,
        color: `oklch(var(--mtext-l) 0.09 ${hue})`,
        fontSize: Math.round(size * 0.45),
        ...style,
      }}
    >
      {initial(name, slug)}
    </span>
  );
}

export default AgentMark;
