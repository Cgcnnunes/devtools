export type Protocol = "http" | "https";
export type HeaderOperation = "set" | "append" | "remove";

export interface HeaderRule {
  id: number;
  enabled: boolean;
  site: string;
  includeSubdomains: boolean;
  protocols: Protocol[];
  name: string;
  operation: HeaderOperation;
  value: string;
}

const appendableHeaders = new Set([
  "accept", "accept-encoding", "accept-language", "access-control-request-headers",
  "cache-control", "connection", "content-language", "cookie", "forwarded", "if-match",
  "if-none-match", "keep-alive", "range", "te", "trailer", "transfer-encoding",
  "upgrade", "user-agent", "via", "want-digest", "x-forwarded-for",
]);

export function validateHeaderRule(rule: HeaderRule): string | null {
  if (!validHostname(rule.site)) return "Enter a valid hostname, such as example.com.";
  if (!rule.protocols.length || rule.protocols.some((protocol) => protocol !== "http" && protocol !== "https")) {
    return "Select at least one protocol.";
  }
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rule.name)) return "Enter a valid header name.";
  if (/[\r\n]/.test(rule.value)) return "Header values cannot contain line breaks.";
  if (rule.operation === "append" && !appendableHeaders.has(rule.name)) {
    return "Chrome only supports append for specific lowercase request headers.";
  }
  return null;
}

export function requestPattern(rule: HeaderRule): string {
  const scheme = rule.protocols.length === 2 ? "https?" : rule.protocols[0];
  const host = rule.site.replaceAll(".", "\\.");
  const subdomains = rule.includeSubdomains ? "(?:[a-z0-9-]+\\.)*" : "";
  return `^${scheme}://${subdomains}${host}(?::[0-9]+)?/`;
}

export function headerRulesOverlap(a: HeaderRule, b: HeaderRule): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false;
  if (!a.protocols.some((protocol) => b.protocols.includes(protocol))) return false;
  return a.site === b.site ||
    (a.includeSubdomains && b.site.endsWith(`.${a.site}`)) ||
    (b.includeSubdomains && a.site.endsWith(`.${b.site}`));
}

export function addHeaderRule(rules: HeaderRule[], rule: HeaderRule): HeaderRule[] {
  const error = validateHeaderRule(rule);
  if (error) throw new Error(error);
  if (rule.enabled && rules.some((existing) => existing.enabled && headerRulesOverlap(existing, rule))) {
    throw new Error("This header rule overlaps an existing enabled rule.");
  }
  return [...rules, rule];
}

export function networkRule(rule: HeaderRule) {
  const resourceTypes: NonNullable<chrome.declarativeNetRequest.RuleCondition["resourceTypes"]> = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
    "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
    "webbundle", "other",
  ];
  const modification = rule.operation === "remove"
    ? { header: rule.name, operation: rule.operation }
    : { header: rule.name, operation: rule.operation, value: rule.value };
  return {
    id: rule.id,
    action: { type: "modifyHeaders" as const, requestHeaders: [modification] },
    condition: { regexFilter: requestPattern(rule), resourceTypes },
  };
}
import { validHostname } from "./site.js";

