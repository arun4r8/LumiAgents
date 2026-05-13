import { createClient } from "@/lib/supabase/server";
import { SettingsClient } from "@/components/settings-client";

export const dynamic = "force-dynamic";

const RUNTIME = process.env.NEXT_PUBLIC_RUNTIME_URL ?? "http://localhost:8787";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Try to get role from public.users if linked
  const { data: profile } = user
    ? await supabase.from("users").select("role").eq("auth_id", user.id).maybeSingle()
    : { data: null };

  async function triggerVaultSync(formData: FormData) {
    "use server";
    const supabase = await createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw new Error("No active session");

    const repoOwner = (formData.get("repoOwner") as string)?.trim();
    const repoName = (formData.get("repoName") as string)?.trim();
    const branch = (formData.get("branch") as string)?.trim() || undefined;

    if (!repoOwner || !repoName) throw new Error("repoOwner and repoName are required");

    const res = await fetch(`${RUNTIME}/api/vault/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ repoOwner, repoName, ...(branch ? { branch } : {}) }),
    });
    if (!res.ok) throw new Error(await res.text());
  }

  return (
    <SettingsClient
      userEmail={user?.email ?? ""}
      userRole={(profile as { role?: string } | null)?.role ?? "ops"}
      userCreatedAt={user?.created_at ?? null}
      triggerVaultSync={triggerVaultSync}
    />
  );
}
