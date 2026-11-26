type StorageListener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
type MessageListener = (message: unknown, sender: { id: string }, respond: (response: unknown) => void) => boolean;
type NavigationListener = (details: { tabId: number; frameId: number }) => void;

interface SimulatedTab {
  id: number;
  documentId: string;
  url: string;
  incognito: boolean;
}

function element<T extends Element>(selector: string, type: { new(): T }): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing preview element: ${selector}`);
  return found;
}

export async function startPreview(): Promise<void> {
  const panel = element("#preview", HTMLElement);
  const tabsList = element("#preview-tabs", HTMLUListElement);
  const headersList = element("#preview-headers", HTMLUListElement);
  const cookiesList = element("#preview-cookies", HTMLUListElement);
  const navigation = element("#preview-navigation", HTMLFormElement);
  const address = element("#preview-url", HTMLInputElement);
  const cookieForm = element("#preview-site-cookie", HTMLFormElement);
  const cookieName = element("#preview-cookie-name", HTMLInputElement);
  const cookieValue = element("#preview-cookie-value", HTMLInputElement);
  const cookieStore = element("#preview-cookie-store", HTMLSelectElement);
  const error = element("#preview-error", HTMLElement);
  const listeners: StorageListener[] = [];
  const navigationListeners: NavigationListener[] = [];
  let messageListener: MessageListener | undefined;
  let headers: chrome.declarativeNetRequest.Rule[] = [];
  let cookies: chrome.cookies.Cookie[] = [];
  const tabs: SimulatedTab[] = [
    { id: 1, documentId: crypto.randomUUID(), url: address.value, incognito: false },
    { id: 2, documentId: crypto.randomUUID(), url: address.value, incognito: true },
  ];

  function render(): void {
    tabsList.replaceChildren();
    for (const tab of tabs) {
      const item = document.createElement("li");
      item.textContent = `${tab.incognito ? "Incognito" : "Normal"}: ${tab.url}`;
      tabsList.append(item);
    }
    headersList.replaceChildren();
    for (const rule of headers) {
      const item = document.createElement("li");
      item.textContent = rule.action.requestHeaders?.map((header) =>
        `${header.operation} ${header.header}${header.value === undefined ? "" : `=${header.value}`}`).join(", ") ?? "";
      headersList.append(item);
    }
    cookiesList.replaceChildren();
    for (const cookie of cookies) {
      const item = document.createElement("li");
      item.textContent = `${cookie.storeId}: ${cookie.domain}${cookie.path} · ${cookie.name}=${cookie.value}`;
      cookiesList.append(item);
    }
  }

  function storage(area: string) {
    const data: Record<string, unknown> = {};
    return {
      async get(key: string) {
        return { [key]: structuredClone(data[key]) };
      },
      async set(items: Record<string, unknown>) {
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const [key, value] of Object.entries(items)) {
          changes[key] = { oldValue: structuredClone(data[key]), newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        queueMicrotask(() => listeners.forEach((listener) => listener(changes, area)));
      },
    };
  }

  const simulatedCookies = {
    async getAllCookieStores() {
      return [{ id: "normal", tabIds: [1] }, { id: "incognito", tabIds: [2] }];
    },
    async getAll(filter: { name?: string; storeId?: string }) {
      return structuredClone(cookies.filter((cookie) =>
        (!filter.name || cookie.name === filter.name) && (!filter.storeId || cookie.storeId === filter.storeId)));
    },
    async set(details: chrome.cookies.SetDetails) {
      const url = new URL(details.url);
      const domain = details.domain ? `.${details.domain.replace(/^\./, "")}` : url.hostname;
      const path = details.path ?? "/";
      const storeId = details.storeId ?? "normal";
      cookies = cookies.filter((cookie) => cookie.name !== details.name || cookie.storeId !== storeId ||
        cookie.domain.replace(/^\./, "") !== domain.replace(/^\./, "") || cookie.path !== path);
      if (details.expirationDate !== undefined && details.expirationDate <= Date.now() / 1000) {
        render();
        return null;
      }
      const cookie: chrome.cookies.Cookie = {
        name: details.name ?? "", value: details.value ?? "", domain, path, storeId,
        hostOnly: !details.domain, secure: details.secure ?? false, httpOnly: details.httpOnly ?? false,
        sameSite: details.sameSite ?? "unspecified", session: details.expirationDate === undefined,
      };
      if (details.expirationDate !== undefined) cookie.expirationDate = details.expirationDate;
      cookies.push(cookie);
      render();
      return structuredClone(cookie);
    },
  };

  const runtime = {
    id: "headerlab-preview",
    onStartup: { addListener() {} },
    onMessage: { addListener(listener: MessageListener) { messageListener = listener; } },
    sendMessage(message: unknown): Promise<unknown> {
      return new Promise((resolve, reject) => {
        if (!messageListener) {
          reject(new Error("The simulation is not ready."));
          return;
        }
        messageListener(message, { id: "headerlab-preview" }, resolve);
      });
    },
  };
  const simulatedChrome = {
    runtime,
    extension: { inIncognitoContext: false },
    storage: {
      local: storage("local"), session: storage("session"),
      onChanged: { addListener(listener: StorageListener) { listeners.push(listener); } },
    },
    permissions: { async contains() { return true; }, async request() { return true; } },
    action: { async setBadgeText() {} },
    declarativeNetRequest: {
      HeaderOperation: { SET: "set", APPEND: "append", REMOVE: "remove" },
      RuleActionType: { MODIFY_HEADERS: "modifyHeaders" },
      async getDynamicRules() { return structuredClone(headers); },
      async updateDynamicRules(update: { removeRuleIds?: number[]; addRules?: chrome.declarativeNetRequest.Rule[] }) {
        headers = headers.filter((rule) => !update.removeRuleIds?.includes(rule.id));
        headers.push(...structuredClone(update.addRules ?? []));
        render();
      },
    },
    cookies: simulatedCookies,
    tabs: {
      async query(options: { active?: boolean }) {
        return structuredClone(options.active ? tabs.filter((tab) => !tab.incognito) : tabs);
      },
      onRemoved: { addListener() {} },
    },
    webNavigation: {
      async getFrame(details: { tabId: number }) {
        const tab = tabs.find((item) => item.id === details.tabId);
        return tab ? { documentId: tab.documentId, url: tab.url } : null;
      },
      onCompleted: { addListener(listener: NavigationListener) { navigationListeners.push(listener); } },
      onHistoryStateUpdated: { addListener() {} },
    },
    scripting: {
      async executeScript(details: { target: { tabId: number; documentIds: string[] }; args: [string, string] }) {
        const tab = tabs.find((item) => item.id === details.target.tabId);
        const matches = !!tab && details.target.documentIds.includes(tab.documentId) && tab.url === details.args[0];
        if (tab && matches) tab.url = details.args[1];
        render();
        return [{ result: matches }];
      },
    },
  };

  Object.defineProperty(globalThis, "chrome", { value: simulatedChrome, configurable: true });
  document.body.classList.add("preview-mode");
  panel.hidden = false;
  render();
  await import("../background.js");

  async function reconcile(): Promise<void> {
    const result = await runtime.sendMessage({ type: "reconcile" });
    if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true) {
      throw new Error("The simulation could not update its rules.");
    }
  }
  function report(problem: unknown): void {
    error.textContent = problem instanceof Error ? problem.message : "The simulation failed.";
    error.hidden = false;
  }
  navigation.addEventListener("submit", (event) => {
    event.preventDefault();
    try {
      const url = new URL(address.value);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Use an HTTP or HTTPS address.");
      error.hidden = true;
      for (const tab of tabs) {
        tab.url = url.href;
        tab.documentId = crypto.randomUUID();
        for (const listener of navigationListeners) listener({ tabId: tab.id, frameId: 0 });
      }
      render();
      void reconcile().catch(report);
    } catch (problem) {
      report(problem);
    }
  });
  cookieForm.addEventListener("submit", (event) => {
    event.preventDefault();
    error.hidden = true;
    void simulatedCookies.set({
      url: tabs[0].url, name: cookieName.value, value: cookieValue.value, path: "/", storeId: cookieStore.value,
    }).then(reconcile).catch(report);
  });
}
