"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Play,
  GitBranch,
  CheckSquare,
  Database,
  Settings,
  LogOut,
  Bot,
  Clock,
  Server,
  BookOpen,
  Brain,
  Users,
  Briefcase,
  CalendarDays,
} from "lucide-react";
import { signOut } from "@/app/(dashboard)/actions";
import type { Role } from "@/lib/role";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
  // Surfaces an enduser is allowed to see. Untagged items are ops-only.
  enduserVisible?: boolean;
}

interface NavSection {
  /** Uppercase domain label. Null for the two ungrouped top items. */
  heading: string | null;
  items: NavItem[];
}

interface SidebarProps {
  userEmail: string;
  userRole: Role;
  pendingApprovals: number;
}

/**
 * Redesign phase 2: 16 flat nav rows collapse into 5 domains — the two
 * ungrouped entry points (Overview, Agents) plus OPERATIONS / RECORDS /
 * KNOWLEDGE / SYSTEM.
 *
 * Enduser gating is unchanged in behaviour: `enduserVisible` still marks the
 * surfaces an enduser may use (Agents, Runs, Orchestrations, Library, Settings)
 * and everything else stays ops-only. A section header only renders when that
 * section has at least one visible item, so an enduser never sees an empty
 * RECORDS heading.
 */
export default function Sidebar({ userEmail, userRole, pendingApprovals }: SidebarProps) {
  const pathname = usePathname();

  const isEnduser = userRole !== "ops";

  const sections: NavSection[] = [
    {
      heading: null,
      items: [
        { href: "/overview", label: "Overview", icon: <LayoutDashboard /> },
        { href: "/agents", label: "Agents", icon: <Bot />, enduserVisible: true },
      ],
    },
    {
      heading: "Operations",
      items: [
        { href: "/runs", label: "Runs", icon: <Play />, enduserVisible: true },
        { href: "/approvals", label: "Approvals", icon: <CheckSquare />, badge: pendingApprovals || undefined },
        { href: "/orchestrations", label: "Orchestrations", icon: <GitBranch />, enduserVisible: true },
        { href: "/schedules", label: "Schedules", icon: <Clock /> },
      ],
    },
    {
      heading: "Records",
      items: [
        { href: "/records/bd", label: "BD Pipeline", icon: <Briefcase /> },
        { href: "/records/content", label: "Content", icon: <CalendarDays /> },
        { href: "/records/talent", label: "Talent", icon: <Users /> },
        { href: "/records/data", label: "Data", icon: <Database /> },
      ],
    },
    {
      heading: "Knowledge",
      items: [
        // The route keeps its name; the redesign relabels the nav entry.
        { href: "/knowledge", label: "Library", icon: <BookOpen />, enduserVisible: true },
        { href: "/memory", label: "Memory", icon: <Brain /> },
      ],
    },
    {
      heading: "System",
      items: [
        { href: "/settings", label: "Settings", icon: <Settings />, enduserVisible: true },
        { href: "/infrastructure", label: "Infrastructure", icon: <Server /> },
      ],
    },
  ];

  // Endusers see only the surfaces they can use; ops sees everything. Sections
  // that end up empty drop their heading too.
  const visibleSections = sections
    .map((section) => ({
      ...section,
      items: isEnduser ? section.items.filter((item) => item.enduserVisible) : section.items,
    }))
    .filter((section) => section.items.length > 0);

  const initials = userEmail ? userEmail.slice(0, 2).toUpperCase() : "??";

  function isActive(href: string) {
    if (href === "/overview") return pathname === "/" || pathname === "/overview";
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <aside className="side">
      {/* Brand */}
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">L</div>
        <span className="brand-name">
          Lumi<em>Agents</em>
        </span>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1 }}>
        {visibleSections.map((section, i) => (
          <div key={section.heading ?? `top-${i}`}>
            {section.heading && <div className="nav-sect">{section.heading}</div>}
            {section.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-link${isActive(item.href) ? " active" : ""}`}
                aria-current={isActive(item.href) ? "page" : undefined}
              >
                {item.icon}
                <span className="grow">{item.label}</span>
                {item.badge != null && item.badge > 0 && (
                  <span className="count">{item.badge}</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div className="side-bot">
        <div className="user-card">
          <div className="avatar">{initials}</div>
          <div className="user-meta">
            <div className="nm">{userEmail}</div>
            {userRole && <div className="role">{userRole}</div>}
          </div>
          <form action={signOut}>
            <button type="submit" className="signout" title="Sign out">
              <LogOut />
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
