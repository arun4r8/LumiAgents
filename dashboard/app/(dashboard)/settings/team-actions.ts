"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireOps } from "@/lib/require-ops";
import { createAdminClient } from "@/lib/supabase/admin";

export type TeamRole = "ops" | "enduser";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function siteOrigin(): Promise<string> {
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const host = h.get("host") ?? "";
  return `${proto}://${host}`;
}

/**
 * Invite a person by email as ops or enduser. Generates a single-use invite link
 * (no email is sent) that the caller copies and hands to the invitee.
 * Ops-only.
 */
export async function inviteMember(
  formData: FormData,
): Promise<{ link: string; email: string; role: TeamRole }> {
  await requireOps();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const role = String(formData.get("role") ?? "") as TeamRole;

  if (!email || !EMAIL_RE.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  if (role !== "ops" && role !== "enduser") {
    throw new Error("Role must be ops or enduser.");
  }

  const origin = await siteOrigin();
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: `${origin}/auth/confirm?next=/accept` },
  });

  if (error || !data?.user || !data.properties?.hashed_token) {
    const msg = error?.message?.toLowerCase() ?? "";
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      throw new Error("That email is already invited or a member.");
    }
    throw new Error(error?.message ?? "Could not generate an invite link.");
  }

  // Assign the requested role in app_metadata so the JWT hook surfaces user_role.
  const { error: roleError } = await admin.auth.admin.updateUserById(data.user.id, {
    app_metadata: { role },
  });
  if (roleError) {
    throw new Error(roleError.message);
  }

  const hashedToken = data.properties.hashed_token;
  const link = `${origin}/auth/confirm?token_hash=${hashedToken}&type=invite&next=/accept`;

  revalidatePath("/settings");
  return { link, email, role };
}

/**
 * Remove a member (deletes the auth user). Ops-only. Cannot remove yourself.
 */
export async function revokeMember(formData: FormData): Promise<void> {
  const caller = await requireOps();

  const userId = String(formData.get("userId") ?? "").trim();
  if (!userId) {
    throw new Error("Missing user id.");
  }
  if (userId === caller.id) {
    throw new Error("You can't remove yourself.");
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    throw new Error(error.message);
  }

  revalidatePath("/settings");
}

/**
 * Regenerate a fresh single-use invite link for an existing pending user. Ops-only.
 */
export async function resendInvite(formData: FormData): Promise<{ link: string }> {
  await requireOps();

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    throw new Error("Enter a valid email address.");
  }

  const origin = await siteOrigin();
  const admin = createAdminClient();

  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { redirectTo: `${origin}/auth/confirm?next=/accept` },
  });

  if (error || !data?.properties?.hashed_token) {
    throw new Error(error?.message ?? "Could not regenerate the invite link.");
  }

  const link = `${origin}/auth/confirm?token_hash=${data.properties.hashed_token}&type=invite&next=/accept`;

  revalidatePath("/settings");
  return { link };
}
