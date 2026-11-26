import { addCookieRule, type CookieRule } from "../domain/cookie-rule.js";

export interface CookieRulesPort {
  read(): Promise<CookieRule[]>;
  write(rules: CookieRule[]): Promise<void>;
  active(): Promise<boolean>;
  permitted(rule: CookieRule): Promise<boolean>;
  apply(rule: CookieRule, approved?: chrome.cookies.Cookie[]): Promise<{ conflicts: chrome.cookies.Cookie[] }>;
  undo(id: number): Promise<string[]>;
}

export class CookieRules {
  constructor(private readonly port: CookieRulesPort) {}

  async disable(id: number): Promise<string[]> {
    const previous = await this.port.read();
    if (!previous.some((rule) => rule.id === id)) throw new Error("Cookie rule was not found.");
    await this.port.write(previous.map((rule) => rule.id === id ? { ...rule, enabled: false } : rule));
    return this.port.undo(id);
  }

  async update(rule: CookieRule): Promise<{ conflicts: chrome.cookies.Cookie[]; warnings: string[] }> {
    const previous = await this.port.read();
    const old = previous.find((item) => item.id === rule.id);
    if (!old) throw new Error("Cookie rule was not found.");
    addCookieRule(previous.filter((item) => item.id !== rule.id), rule);
    if (!await this.port.permitted(old) || (rule.enabled && await this.port.active() && !await this.port.permitted(rule))) {
      throw new Error("Cookie site access was not granted.");
    }
    await this.port.write(previous.map((item) => item.id === rule.id ? rule : item));
    const warnings = await this.port.undo(rule.id);
    if (warnings.length || !rule.enabled || !await this.port.active()) return { conflicts: [], warnings };
    const result = await this.port.apply(rule);
    return { ...result, warnings };
  }

  async remove(id: number): Promise<string[]> {
    const previous = await this.port.read();
    const rule = previous.find((item) => item.id === id);
    if (!rule) throw new Error("Cookie rule was not found.");
    if (!await this.port.permitted(rule)) throw new Error("Cookie site access was not granted.");
    await this.port.write(previous.filter((item) => item.id !== id));
    return this.port.undo(id);
  }

  async add(rule: CookieRule, approved?: chrome.cookies.Cookie[]): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const previous = await this.port.read();
    if (!Number.isSafeInteger(rule.id) || rule.id <= 0 || previous.some((item) => item.id === rule.id)) {
      throw new Error("Invalid or duplicate cookie rule ID.");
    }
    const next = addCookieRule(previous, rule);
    return this.applyAndSave(rule, next, approved);
  }

  async enable(id: number, approved?: chrome.cookies.Cookie[]): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const previous = await this.port.read();
    const rule = previous.find((item) => item.id === id);
    if (!rule) throw new Error("Cookie rule was not found.");
    if (rule.enabled) return { conflicts: [] };
    const updated = { ...rule, enabled: true };
    addCookieRule(previous.filter((item) => item.id !== id), updated);
    const next = previous.map((item) => item.id === id ? updated : item);
    return this.applyAndSave(updated, next, approved);
  }

  async applySaved(id: number, approved?: chrome.cookies.Cookie[]): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const rule = (await this.port.read()).find((item) => item.id === id);
    if (!rule?.enabled || !await this.port.active()) throw new Error("The cookie rule is no longer active.");
    if (!await this.port.permitted(rule)) throw new Error("Cookie site access was not granted.");
    return this.port.apply(rule, approved);
  }

  private async applyAndSave(
    rule: CookieRule,
    next: CookieRule[],
    approved?: chrome.cookies.Cookie[],
  ): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const applies = rule.enabled && await this.port.active();
    if (applies && !await this.port.permitted(rule)) throw new Error("Cookie site access was not granted.");
    await this.port.write(next);
    if (applies) return this.port.apply(rule, approved);
    return { conflicts: [] };
  }
}
