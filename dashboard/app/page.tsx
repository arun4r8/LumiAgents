import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { roleOf } from "@/lib/role";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  // Ops land on the fleet Overview; endusers on their agent-first page.
  redirect(roleOf(user) === "ops" ? "/overview" : "/agents");
}
