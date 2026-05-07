import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(date));
}

export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "—";
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export const STATUS_COLORS: Record<string, string> = {
  pending:   "bg-yellow-100 text-yellow-800",
  running:   "bg-blue-100 text-blue-800",
  paused:    "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  failed:    "bg-red-100 text-red-800",
  cancelled: "bg-gray-100 text-gray-600",
};
