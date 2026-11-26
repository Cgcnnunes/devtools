import { cookieConflicts, cookieUnchanged, validateCookieRule, type CookieRule } from "../domain/cookie-rule.js";

export interface CookieUndo {
  rule: CookieRule;
  storeId: string;
  original: chrome.cookies.Cookie[];
  installed: chrome.cookies.Cookie | null;
  restoring?: boolean;
}

export interface CookiePort {
  stores(): Promise<string[]>;
  list(name: string, storeId: string): Promise<chrome.cookies.Cookie[]>;
  remove(cookie: chrome.cookies.Cookie): Promise<void>;
  set(rule: CookieRule, storeId: string): Promise<chrome.cookies.Cookie>;
  restore(cookie: chrome.cookies.Cookie): Promise<void>;
  readUndo(): Promise<CookieUndo[]>;
  writeUndo(entries: CookieUndo[]): Promise<void>;
}

function sameCookies(left: chrome.cookies.Cookie[], right: chrome.cookies.Cookie[]): boolean {
  return left.length === right.length && left.every((item) =>
    right.some((other) => cookieUnchanged(item, other)),
  );
}

export class CookieEngine {
  constructor(private readonly port: CookiePort) {}

  private async plan(rule: CookieRule): Promise<{
    undo: CookieUndo[];
    pending: { storeId: string; conflicts: chrome.cookies.Cookie[] }[];
  }> {
    const error = validateCookieRule(rule);
    if (error) throw new Error(error);
    const undo = await this.port.readUndo();
    const stores = await this.port.stores();
    const pending: { storeId: string; conflicts: chrome.cookies.Cookie[] }[] = [];

    for (const storeId of stores) {
      const current = await this.port.list(rule.name, storeId);
      const prior = undo.find((entry) => entry.rule.id === rule.id && entry.storeId === storeId);
      if (prior) {
        const saved = prior.rule;
        if (saved.site !== rule.site || saved.includeSubdomains !== rule.includeSubdomains ||
            saved.name !== rule.name || saved.value !== rule.value || saved.path !== rule.path ||
            saved.secure !== rule.secure || saved.httpOnly !== rule.httpOnly || saved.sameSite !== rule.sameSite) {
          throw new Error("The cookie rule changed while it was applied. Restore it before editing.");
        }
        const installed = prior.installed;
        if (prior.restoring || !installed || !current.some((cookie) => cookieUnchanged(installed, cookie))) {
          throw new Error("A managed cookie changed or an earlier operation was interrupted. Review it before continuing.");
        }
        continue;
      }
      pending.push({ storeId, conflicts: cookieConflicts(rule, current) });
    }
    return { undo, pending };
  }

  async inspect(rule: CookieRule): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const { pending } = await this.plan(rule);
    return { conflicts: pending.flatMap((item) => item.conflicts) };
  }

  async apply(rule: CookieRule, approved?: chrome.cookies.Cookie[]): Promise<{ conflicts: chrome.cookies.Cookie[] }> {
    const { undo, pending } = await this.plan(rule);
    const conflicts = pending.flatMap((item) => item.conflicts);
    if (approved === undefined && conflicts.length > 0) return { conflicts };
    if (approved !== undefined && !sameCookies(conflicts, approved)) {
      throw new Error("Cookies changed since confirmation. Review the conflicts again.");
    }

    const created: CookieUndo[] = [];
    try {
      for (const item of pending) {
        const entry: CookieUndo = { rule, storeId: item.storeId, original: item.conflicts, installed: null };
        created.push(entry);
        undo.push(entry);
        await this.port.writeUndo(undo);
        for (const original of item.conflicts) await this.port.remove(original);
        entry.installed = await this.port.set(rule, item.storeId);
        await this.port.writeUndo(undo);
      }
    } catch (error) {
      const failures: unknown[] = [];
      for (const entry of created.reverse()) {
        try {
          entry.restoring = true;
          await this.port.writeUndo(undo);
          let current = cookieConflicts(rule, await this.port.list(rule.name, entry.storeId));
          const installed = entry.installed;
          if (installed && current.some((cookie) => cookieUnchanged(installed, cookie))) {
            await this.port.remove(installed);
            current = cookieConflicts(rule, await this.port.list(rule.name, entry.storeId));
          }
          if (current.some((cookie) => !entry.original.some((original) => cookieUnchanged(original, cookie)))) {
            throw new Error("Cookies changed during rollback; they were preserved for review.", { cause: error });
          }
          for (const original of entry.original) {
            if (!current.some((cookie) => cookieUnchanged(original, cookie))) await this.port.restore(original);
          }
          const index = undo.indexOf(entry);
          undo.splice(index, 1);
          try {
            await this.port.writeUndo(undo);
          } catch (writeError) {
            undo.splice(index, 0, entry);
            throw writeError;
          }
        } catch (rollbackError) {
          failures.push(rollbackError);
        }
      }
      if (failures.length) {
        throw new AggregateError([error, ...failures], "Could not apply or safely restore cookies.", { cause: error });
      }
      throw error;
    }
    return { conflicts: [] };
  }

  async undo(ruleId: number): Promise<string[]> {
    return this.restore(ruleId, false);
  }

  async recover(ruleId: number): Promise<string[]> {
    return this.restore(ruleId, true);
  }

  private async restore(ruleId: number, interruptedOnly: boolean): Promise<string[]> {
    const undo = await this.port.readUndo();
    const stores = new Set(await this.port.stores());
    const warnings: string[] = [];
    for (const entry of [...undo]) {
      if (entry.rule.id !== ruleId) continue;
      if (!stores.has(entry.storeId)) {
        warnings.push(`The cookie store for ${entry.rule.site} closed; its session backup was discarded.`);
        undo.splice(undo.indexOf(entry), 1);
        await this.port.writeUndo(undo);
        continue;
      }
      if (interruptedOnly && entry.installed && !entry.restoring) continue;
      let current = cookieConflicts(entry.rule, await this.port.list(entry.rule.name, entry.storeId));
      const installed = entry.installed;
      if (!installed && !entry.restoring) {
        if (current.some((cookie) => !entry.original.some((original) => cookieUnchanged(original, cookie)))) {
          warnings.push(`The cookie for ${entry.rule.site} could not be verified; it was preserved.`);
          continue;
        }
        entry.restoring = true;
        await this.port.writeUndo(undo);
      }
      if (!entry.restoring && (!installed || !current.some((cookie) => cookieUnchanged(installed, cookie)))) {
        warnings.push(`The cookie for ${entry.rule.site} changed or could not be verified; it was preserved.`);
        continue;
      }
      if (current.some((cookie) => (!installed || !cookieUnchanged(installed, cookie)) &&
          (!entry.restoring || !entry.original.some((original) => cookieUnchanged(original, cookie))))) {
        warnings.push(`Other cookies for ${entry.rule.site} changed; they were preserved.`);
        continue;
      }
      if (!entry.restoring) {
        entry.restoring = true;
        await this.port.writeUndo(undo);
      }
      if (installed && current.some((cookie) => cookieUnchanged(installed, cookie))) {
        await this.port.remove(installed);
        current = cookieConflicts(entry.rule, await this.port.list(entry.rule.name, entry.storeId));
        if (current.some((cookie) => !entry.original.some((original) => cookieUnchanged(original, cookie)))) {
          warnings.push(`Other cookies for ${entry.rule.site} changed; they were preserved.`);
          continue;
        }
      }
      for (const original of entry.original) {
        if (!current.some((cookie) => cookieUnchanged(original, cookie))) await this.port.restore(original);
      }
      undo.splice(undo.indexOf(entry), 1);
      await this.port.writeUndo(undo);
    }
    return warnings;
  }
}
