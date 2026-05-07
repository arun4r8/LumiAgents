import { createClient } from "@/lib/supabase/server";
import { SettingsClient } from "@/components/settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  // Try to get role from public.users if linked
  const { data: profile } = user
    ? await supabase.from("users").select("role").eq("auth_id", user.id).maybeSingle()
    : { data: null };

  return (
    <SettingsClient
      userEmail={user?.email ?? ""}
      userRole={(profile as { role?: string } | null)?.role ?? "ops"}
      userCreatedAt={user?.created_at ?? null}
    />
  );
}
