import type { Protocol } from "./header-rule.js";
import { validHostname } from "./site.js";

export interface QueryRule {
  id: number;
  enabled: boolean;
  site: string;
  includeSubdomains: boolean;
  protocols: Protocol[];
  name: string;
  operation: "set" | "remove";
  value: string;
}

export interface QueryUndo {
  origin: string;
  name: string;
  original: string[];
  installed: string[];
}

type QueryChange =
  | { kind: "unmatched" | "unchanged" }
  | { kind: "conflict"; values: string[] }
  | { kind: "changed"; url: string; undo: QueryUndo };

function sameValues(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function sameQueryRule(left: QueryRule, right: QueryRule): boolean {
  return left.id === right.id && left.site === right.site && left.name === right.name &&
    left.includeSubdomains === right.includeSubdomains && left.operation === right.operation &&
    left.value === right.value && left.protocols.length === right.protocols.length &&
    left.protocols.every((protocol) => right.protocols.includes(protocol));
}

export function validateQueryRule(rule: QueryRule): string | null {
  if (!validHostname(rule.site)) return "Enter a valid hostname, such as example.com.";
  if (!rule.protocols.length || rule.protocols.some((protocol) => protocol !== "http" && protocol !== "https")) {
    return "Select at least one protocol.";
  }
  if (!rule.name || containsControl(rule.name)) return "Enter a valid query parameter name.";
  if (containsControl(rule.value)) return "Query parameter values cannot contain control characters.";
  return null;
}

export function addQueryRule(rules: QueryRule[], rule: QueryRule): QueryRule[] {
  const error = validateQueryRule(rule);
  if (error) throw new Error(error);
  if (rule.enabled && rules.some((existing) => existing.enabled && existing.name === rule.name &&
    existing.protocols.some((protocol) => rule.protocols.includes(protocol)) &&
    (existing.site === rule.site ||
      (existing.includeSubdomains && rule.site.endsWith(`.${existing.site}`)) ||
      (rule.includeSubdomains && existing.site.endsWith(`.${rule.site}`))))) {
    throw new Error("This query rule overlaps an existing enabled rule.");
  }
  return [...rules, rule];
}

export function queryMatches(rule: QueryRule, url: URL): boolean {
  const protocol = url.protocol.slice(0, -1);
  return rule.enabled && rule.protocols.some((item) => item === protocol) &&
    (url.hostname === rule.site || (rule.includeSubdomains && url.hostname.endsWith(`.${rule.site}`)));
}

export function applyQueryRule(rule: QueryRule, address: string, approved?: string[]): QueryChange {
  const error = validateQueryRule(rule);
  if (error) throw new Error(error);
  const url = new URL(address);
  if (!queryMatches(rule, url)) return { kind: "unmatched" };
  const original = url.searchParams.getAll(rule.name);
  const installed = rule.operation === "set" ? [rule.value] : [];
  if (approved !== undefined && !sameValues(original, approved)) {
    throw new Error("Query parameters changed since confirmation. Review the conflict again.");
  }
  if (sameValues(original, installed)) return { kind: "unchanged" };
  if (original.length && approved === undefined) return { kind: "conflict", values: original };
  url.searchParams.delete(rule.name);
  for (const value of installed) url.searchParams.append(rule.name, value);
  return { kind: "changed", url: url.href, undo: { origin: url.origin, name: rule.name, original, installed } };
}

export function restoreQueryRule(
  undo: QueryUndo,
  address: string,
): { kind: "restored"; url: string } | { kind: "changed-by-site" | "already-original" } {
  const url = new URL(address);
  const current = url.searchParams.getAll(undo.name);
  if (url.origin !== undo.origin) return { kind: "changed-by-site" };
  if (sameValues(current, undo.original)) return { kind: "already-original" };
  if (!sameValues(current, undo.installed)) {
    return { kind: "changed-by-site" };
  }
  url.searchParams.delete(undo.name);
  for (const value of undo.original) url.searchParams.append(undo.name, value);
  return { kind: "restored", url: url.href };
}
