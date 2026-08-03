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
  Mail,
  Brain,
  Trophy,
  FileSignature,
  CalendarDays,
  CalendarClock,
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

interface SidebarProps {
  userEmail: string;
  userRole: Role;
  pendingApprovals: number;
}

export default function Sidebar({ userEmail, userRole, pendingApprovals }: SidebarProps) {
  const pathname = usePathname();

  const isEnduser = userRole !== "ops";

  const nav: NavItem[] = [
    { href: "/overview",       label: "Overview",        icon: <LayoutDashboard /> },
    { href: "/runs",           label: "Runs",            icon: <Play />, enduserVisible: true },
    { href: "/orchestrations", label: "Orchestrations",  icon: <GitBranch />, enduserVisible: true },
    { href: "/schedules",      label: "Schedules",       icon: <Clock /> },
    { href: "/subscriptions",  label: "Subscriptions",   icon: <Mail /> },
    { href: "/awards",         label: "Awards",          icon: <Trophy /> },
    { href: "/industry-days",  label: "Industry Days",   icon: <CalendarClock /> },
    { href: "/rfi-drafts",     label: "RFI Drafts",      icon: <FileSignature /> },
    { href: "/content-calendar", label: "Content Calendar", icon: <CalendarDays /> },
    { href: "/memory",         label: "Memory",          icon: <Brain /> },
    { href: "/approvals",      label: "Approvals",       icon: <CheckSquare />, badge: pendingApprovals || undefined },
    { href: "/knowledge",      label: "Knowledge Base",  icon: <BookOpen />, enduserVisible: true },
    { href: "/data",           label: "Records",         icon: <Database /> },
    { href: "/settings",        label: "Settings",        icon: <Settings />, enduserVisible: true },
    { href: "/infrastructure",  label: "Infrastructure",  icon: <Server /> },
  ];

  // Endusers see only the surfaces they can use; ops sees everything.
  const visibleNav = isEnduser ? nav.filter((item) => item.enduserVisible) : nav;

  const initials = userEmail
    ? userEmail.slice(0, 2).toUpperCase()
    : "??";

  function isActive(href: string) {
    if (href === "/overview") return pathname === "/" || pathname === "/overview";
    return pathname.startsWith(href);
  }

  return (
    <aside className="side">
      {/* Brand */}
      <div className="brand">
        <div className="brand-mark" />
        <span className="brand-name">
          Lumi<em>Agents</em>
        </span>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1 }}>
        <div className="nav-sect">Agents</div>
        <Link
          href="/agents"
          className={`nav-link${isActive("/agents") ? " active" : ""}`}
        >
          <Bot />
          <span className="grow">Agents</span>
        </Link>
        {!isEnduser && <div className="nav-sect">Ops</div>}
        {visibleNav.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-link${isActive(item.href) ? " active" : ""}`}
          >
            {item.icon}
            <span className="grow">{item.label}</span>
            {item.badge != null && item.badge > 0 && (
              <span className="count">{item.badge}</span>
            )}
          </Link>
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
