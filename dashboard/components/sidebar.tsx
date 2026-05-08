"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Play,
  GitBranch,
  CheckSquare,
  BarChart2,
  FileText,
  Database,
  Settings,
  LogOut,
} from "lucide-react";
import { signOut } from "@/app/(dashboard)/actions";

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

interface SidebarProps {
  userEmail: string;
  userRole?: string;
  pendingApprovals: number;
}

export default function Sidebar({ userEmail, userRole, pendingApprovals }: SidebarProps) {
  const pathname = usePathname();

  const nav: NavItem[] = [
    { href: "/overview",       label: "Overview",        icon: <LayoutDashboard /> },
    { href: "/runs",           label: "Runs",            icon: <Play /> },
    { href: "/orchestrations", label: "Orchestrations",  icon: <GitBranch /> },
    { href: "/approvals",      label: "Approvals",       icon: <CheckSquare />, badge: pendingApprovals || undefined },
    { href: "/analyst",        label: "Data Analyst",    icon: <BarChart2 /> },
    { href: "/documents",      label: "Documents",       icon: <FileText /> },
    { href: "/data",           label: "Data",            icon: <Database /> },
    { href: "/settings",       label: "Settings",        icon: <Settings /> },
  ];

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
        <div className="nav-sect">Ops</div>
        {nav.map((item) => (
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
