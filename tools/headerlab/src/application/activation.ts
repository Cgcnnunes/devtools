interface ActivationStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function getActivation(storage: ActivationStorage): Promise<boolean> {
  const { enabled } = await storage.get("enabled");
  if (enabled === undefined) return true;
  if (typeof enabled !== "boolean") throw new Error("Invalid activation setting");
  return enabled;
}

export async function setActivation(storage: ActivationStorage, enabled: boolean): Promise<void> {
  await storage.set({ enabled });
}
