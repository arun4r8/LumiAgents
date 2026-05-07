import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";

const NAV = [
  { href: "/runs",           label: "Runs" },
  { href: "/orchestrations", label: "Orchestrations" },
  { href: "/analyst",        label: "Data Analyst" },
  { href: "/documents",      label: "Documents" },
  { href: "/approvals",      label: "Approvals" },
];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const role = user.user_metadata?.role as string | undefined;

  async function signOut() {
    "use server";
    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/login");
  }

  return (
    <div className="flex h-full min-h-screen">
      {/* Sidebar */}
      <aside className="w-56 bg-white border-r flex flex-col">
        <div className="px-5 py-5 border-b">
          <span className="font-bold text-base tracking-tight">LumiAgents</span>
          <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 uppercase">
            {role ?? "user"}
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center px-3 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 hover:text-gray-900 transition-colors"
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="px-3 py-4 border-t">
          <p className="text-xs text-gray-400 px-3 mb-2 truncate">{user.email}</p>
          <form action={signOut}>
            <button
              type="submit"
              className="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-100 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
