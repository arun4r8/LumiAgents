import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Sidebar from "@/components/sidebar";
import Topbar from "@/components/topbar";
import { roleOf } from "@/lib/role";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Fetch pending approvals count for the sidebar badge
  const { count: pendingCount } = await supabase
    .schema("orchestration")
    .from("approvals")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  // Roles live in app_metadata (surfaced as the user_role claim); read them via
  // the shared helper so the sidebar badge + gating see the real role.
  const role = roleOf(user);

  return (
    <div className="lumi-app">
      <Sidebar
        userEmail={user.email ?? ""}
        userRole={role}
        pendingApprovals={pendingCount ?? 0}
      />
      <div className="lumi-main">
        <Topbar isOps={role === "ops"} />
        {children}
      </div>
    </div>
  );
}
