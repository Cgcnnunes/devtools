import type { CookieUndo } from "./cookie-engine.js";
import type { CookieRule } from "../domain/cookie-rule.js";

export interface CookieReconciliationPort {
  read(): Promise<CookieRule[]>;
  active(): Promise<boolean>;
  records(): Promise<CookieUndo[]>;
  permitted(rule: CookieRule): Promise<boolean>;
  recover(id: number): Promise<string[]>;
  undo(id: number): Promise<string[]>;
  apply(rule: CookieRule): Promise<{ conflicts: chrome.cookies.Cookie[] }>;
  conflicts(id: number, cookies: chrome.cookies.Cookie[]): Promise<void>;
}

function sameRule(left: CookieRule, right: CookieRule): boolean {
  return left.id === right.id && left.site === right.site &&
    left.includeSubdomains === right.includeSubdomains && left.name === right.name &&
    left.value === right.value && left.path === right.path && left.secure === right.secure &&
    left.httpOnly === right.httpOnly && left.sameSite === right.sameSite;
}

export async function reconcileCookies(port: CookieReconciliationPort): Promise<string[]> {
  const rules = await port.read();
  const active = await port.active();
  let records = await port.records();
  const warnings: string[] = [];
  const blocked = new Set<number>();
  const ids = new Set(records.map((record) => record.rule.id));
  for (const id of ids) {
    const saved = records.find((record) => record.rule.id === id);
    if (!saved) continue;
    const desired = rules.find((rule) => rule.id === id);
    if (!active || !desired?.enabled || !sameRule(saved.rule, desired)) {
      await port.conflicts(id, []);
    }
    if (!await port.permitted(saved.rule)) {
      blocked.add(id);
      warnings.push(`Cannot restore cookies for ${saved.rule.site}; restore site access and retry.`);
      continue;
    }
    let problems: string[];
    try {
      problems = !active || !desired?.enabled || !sameRule(saved.rule, desired)
        ? await port.undo(id) : await port.recover(id);
    } catch {
      blocked.add(id);
      warnings.push(`Cookies for ${saved.rule.site} could not be restored. Review site access and retry.`);
      continue;
    }
    warnings.push(...problems);
    if (problems.length) blocked.add(id);
  }
  records = await port.records();
  for (const rule of rules) {
    if (!active || !rule.enabled || blocked.has(rule.id)) {
      await port.conflicts(rule.id, []);
      continue;
    }
    if (!await port.permitted(rule)) {
      warnings.push(`Cookie site access for ${rule.site} was not granted. Restore access or disable the rule.`);
      continue;
    }
    if (records.some((record) => record.rule.id === rule.id && !sameRule(record.rule, rule))) {
      warnings.push(`The previous cookie rule for ${rule.site} must be restored before applying changes.`);
      continue;
    }
    try {
      const result = await port.apply(rule);
      await port.conflicts(rule.id, result.conflicts);
    } catch {
      warnings.push(`Cookies for ${rule.site} could not be applied or verified. Review the rule and retry.`);
    }
  }
  return warnings;
}
