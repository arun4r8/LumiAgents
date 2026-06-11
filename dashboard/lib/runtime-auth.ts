"use client";
import { createClient } from "@/lib/supabase/client";

// Bearer header for calls from client components to the runtime Worker.
// The runtime verifies the token via Supabase Auth and requires the ops role.
export async function runtimeAuthHeader(): Promise<Record<string, string>> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
