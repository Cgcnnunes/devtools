import { addHeaderRule, type HeaderRule } from "../domain/header-rule.js";

export interface HeaderState {
  enabled: boolean;
  rules: HeaderRule[];
}

export interface HeaderAdapter {
  read(): Promise<HeaderState>;
  write(state: HeaderState): Promise<void>;
  apply(rules: HeaderRule[]): Promise<void>;
}

function activeRules(state: HeaderState): HeaderRule[] {
  return state.enabled ? state.rules.filter((rule) => rule.enabled) : [];
}

export class HeaderEngine {
  constructor(private readonly adapter: HeaderAdapter) {}

  async reconcile(): Promise<void> {
    try {
      await this.adapter.apply(activeRules(await this.adapter.read()));
    } catch (error) {
      try {
        await this.adapter.apply([]);
      } catch (clearError) {
        throw new AggregateError(
          [error, clearError],
          "Could not reconcile or clear installed header rules.",
          { cause: clearError },
        );
      }
      throw error;
    }
  }

  async add(rule: HeaderRule): Promise<void> {
    const previous = await this.adapter.read();
    await this.replace(previous, { ...previous, rules: addHeaderRule(previous.rules, rule) });
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const previous = await this.adapter.read();
    await this.replace(previous, { ...previous, enabled });
  }

  async setRuleEnabled(id: number, enabled: boolean): Promise<void> {
    const previous = await this.adapter.read();
    const rule = previous.rules.find((item) => item.id === id);
    if (!rule) throw new Error("Header rule was not found.");
    const others = previous.rules.filter((item) => item.id !== id);
    const updated = addHeaderRule(others, { ...rule, enabled });
    await this.replace(previous, { ...previous, rules: updated });
  }

  async update(rule: HeaderRule): Promise<void> {
    const previous = await this.adapter.read();
    if (!previous.rules.some((item) => item.id === rule.id)) {
      throw new Error("Header rule was not found.");
    }
    const others = previous.rules.filter((item) => item.id !== rule.id);
    addHeaderRule(others, rule);
    await this.replace(previous, {
      ...previous,
      rules: previous.rules.map((item) => item.id === rule.id ? rule : item),
    });
  }

  async remove(id: number): Promise<void> {
    const previous = await this.adapter.read();
    if (!previous.rules.some((rule) => rule.id === id)) {
      throw new Error("Header rule was not found.");
    }
    await this.replace(previous, {
      ...previous,
      rules: previous.rules.filter((rule) => rule.id !== id),
    });
  }

  private async replace(previous: HeaderState, next: HeaderState): Promise<void> {
    await this.adapter.apply(activeRules(next));
    try {
      await this.adapter.write(next);
    } catch (error) {
      try {
        await this.adapter.apply(activeRules(previous));
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Could not save settings or restore previous header rules.",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  }
}
