import { readQueryConflicts } from "./chrome-query.js";
import { readCookieConflicts } from "./chrome-cookie-conflicts.js";

export async function readWarnings(): Promise<string[]> {
  const { warnings } = await chrome.storage.session.get("warnings");
  if (warnings === undefined) return [];
  if (!Array.isArray(warnings) || !warnings.every((item: unknown) => typeof item === "string")) {
    throw new Error("Saved warning data is invalid.");
  }
  return warnings;
}

export async function updateStatus(newWarnings: string[] = [], clear = false): Promise<void> {
  const previous = clear ? [] : await readWarnings();
  const warnings = [...new Set([...previous, ...newWarnings])];
  await chrome.storage.session.set({ warnings });
  const { pending } = await readQueryConflicts();
  const cookies = await readCookieConflicts();
  const count = pending.length + cookies.length;
  const text = warnings.length ? "!" : count ? String(Math.min(count, 99)) : "";
  await chrome.action.setBadgeText({ text });
}
