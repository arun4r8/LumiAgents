import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Sidebar from "@/components/sidebar";

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

  const role = user.user_metadata?.role as string | undefined;

  return (
    <div className="lumi-app">
      <Sidebar
        userEmail={user.email ?? ""}
        userRole={role}
        pendingApprovals={pendingCount ?? 0}
      />
      <div className="lumi-main">
        {children}
      </div>
    </div>
  );
}
