import "./styles.css";
import { validateHeaderRule, type HeaderRule, type HeaderOperation, type Protocol } from "../domain/header-rule.js";
import { readHeaderState } from "../infrastructure/chrome-headers.js";
import { validateQueryRule, type QueryRule } from "../domain/query-rule.js";
import { readQueryConflicts, readQueryRules } from "../infrastructure/chrome-query.js";
import { readWarnings } from "../infrastructure/chrome-status.js";
import { cookiePermissionOrigins, validateCookieRule, type CookieRule } from "../domain/cookie-rule.js";
import { readCookieRules } from "../infrastructure/chrome-cookies.js";
import { readCookieConflicts } from "../infrastructure/chrome-cookie-conflicts.js";
import { validHostname } from "../domain/site.js";

declare const __HEADERLAB_VERSION__: string;

function required<T extends Element>(selector: string, type: { new(): T }): T {
  const element = document.querySelector(selector);
  if (!(element instanceof type)) throw new Error(`Missing popup element: ${selector}`);
  return element;
}

const activation = required("#activation", HTMLInputElement);
const context = required("#context", HTMLElement);
const error = required("#error", HTMLElement);
const version = required("#version", HTMLElement);
const form = required("#rule-form", HTMLFormElement);
const fields = required("#rule-fields", HTMLFieldSetElement);
const ruleType = required("#rule-type", HTMLSelectElement);
const appendOption = required("#append-operation", HTMLOptionElement);
const nameLabel = required("#name-label", HTMLElement);
const hint = required("#rule-hint", HTMLElement);
const operation = required("#operation", HTMLSelectElement);
const operationField = required("#operation-field", HTMLElement);
const cookiePathField = required("#cookie-path-field", HTMLElement);
const cookieSameSiteField = required("#cookie-samesite-field", HTMLElement);
const cookieOptions = required("#cookie-options", HTMLElement);
const cookiePath = required("#cookie-path", HTMLInputElement);
const cookieSameSite = required("#cookie-samesite", HTMLSelectElement);
const cookieSecure = required("#cookie-secure", HTMLInputElement);
const cookieHttpOnly = required("#cookie-httponly", HTMLInputElement);
const httpsField = required("#https-field", HTMLElement);
const httpField = required("#http-field", HTMLElement);
const name = required("#header-name", HTMLInputElement);
const value = required("#header-value", HTMLInputElement);
const site = required("#site", HTMLInputElement);
const detectSite = required("#detect-site", HTMLButtonElement);
const subdomains = required("#subdomains", HTMLInputElement);
const https = required("#https", HTMLInputElement);
const http = required("#http", HTMLInputElement);
const submit = required("#submit-rule", HTMLButtonElement);
const cancel = required("#cancel-edit", HTMLButtonElement);
const list = required("#rules-list", HTMLElement);
const empty = required("#empty-rules", HTMLElement);
const issues = required("#issues", HTMLElement);
const warningsList = required("#warnings-list", HTMLUListElement);
const conflictsList = required("#conflicts-list", HTMLUListElement);
const clearWarnings = required("#clear-warnings", HTMLButtonElement);

version.textContent = `v${__HEADERLAB_VERSION__}`;
let editing: HeaderRule | undefined;
let editingQuery: QueryRule | undefined;
let editingCookie: CookieRule | undefined;
let busy = false;
let stateUnavailable = false;
let refreshSequence = 0;

function setControlsDisabled(disabled: boolean): void {
  activation.disabled = disabled;
  fields.disabled = disabled;
  list.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((control) => {
    control.disabled = disabled;
  });
  issues.querySelectorAll<HTMLButtonElement>("button").forEach((control) => { control.disabled = disabled; });
}

function showError(problem: unknown): void {
  error.textContent = problem instanceof Error ? problem.message : "The request failed.";
  error.hidden = false;
}

function resetForm(): void {
  const selectedType = ruleType.value;
  editing = undefined;
  editingQuery = undefined;
  editingCookie = undefined;
  form.reset();
  ruleType.value = selectedType;
  configureType();
}

function configureType(): void {
  const query = ruleType.value === "query";
  const cookie = ruleType.value === "cookie";
  operationField.hidden = cookie;
  cookiePathField.hidden = !cookie;
  cookieSameSiteField.hidden = !cookie;
  cookieOptions.hidden = !cookie;
  httpsField.hidden = cookie;
  httpField.hidden = cookie;
  appendOption.disabled = query;
  if (query && operation.value === "append") operation.value = "set";
  nameLabel.textContent = cookie ? "Cookie name" : query ? "Parameter name" : "Header name";
  name.placeholder = nameLabel.textContent;
  hint.hidden = !cookie && !query;
  hint.textContent = cookie
    ? "Session cookies only. Site and parent-host access is requested for HTTP and HTTPS. Backups are session-only and can be lost when Chrome restarts or the extension reloads."
    : query
    ? "Matching addresses change without reloading. Refresh the page to send the new query."
    : "";
  value.disabled = !cookie && operation.value === "remove";
  submit.textContent = cookie ? editingCookie ? "Save cookie" : "Add cookie" : query
    ? editingQuery ? "Save parameter" : "Add parameter"
    : editing ? "Save header" : "Add header";
  cancel.hidden = !editing && !editingQuery && !editingCookie;
}

async function send(message: object): Promise<void> {
  const response: unknown = await chrome.runtime.sendMessage(message);
  if (typeof response !== "object" || response === null || !("ok" in response)) {
    throw new Error("HeaderLab did not receive a valid response.");
  }
  if (response.ok !== true) {
    const detail = "error" in response && typeof response.error === "string"
      ? response.error : "The request failed.";
    throw new Error(detail);
  }
}

function ruleGroup(
  kind: "header" | "cookie" | "query",
  title: string,
  rules: { id: number; enabled: boolean }[],
  origins: string[] = [],
): HTMLUListElement {
  const section = document.createElement("section");
  section.className = "rule-group";
  section.dataset.ruleType = kind;
  const heading = document.createElement("h3");
  const label = document.createElement("label");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.setAttribute("aria-label", `Enable all ${title.toLowerCase()}`);
  const enabledCount = rules.filter((rule) => rule.enabled).length;
  toggle.checked = enabledCount === rules.length;
  toggle.indeterminate = enabledCount > 0 && enabledCount < rules.length;
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    void perform(async () => {
      if (enabled && origins.length && !await chrome.permissions.request({ origins })) {
        throw new Error("Cookie site access was not granted.");
      }
      try {
        for (const rule of rules) {
          if (rule.enabled !== enabled) await send({ type: `toggle-${kind}`, id: rule.id, enabled });
        }
      } catch (problem) {
        const detail = problem instanceof Error ? problem.message : "The request failed.";
        throw new Error(`Not all ${title.toLowerCase()} could be updated; some may have changed. ${detail}`, { cause: problem });
      }
    });
  });
  label.append(toggle, document.createTextNode(title));
  heading.append(label);
  const entries = document.createElement("ul");
  section.append(heading, entries);
  list.append(section);
  return entries;
}

function ruleName(name: string, id: string, details: [string, string][]): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "rule-name";
  const title = document.createElement("strong");
  title.textContent = name;
  title.tabIndex = 0;
  title.setAttribute("aria-describedby", id);
  const tooltip = document.createElement("div");
  tooltip.className = "rule-tooltip";
  tooltip.id = id;
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  const entries = document.createElement("dl");
  for (const [label, value] of details) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    entries.append(term, description);
  }
  tooltip.append(entries);
  wrapper.append(title, tooltip);
  let hovered = false;
  let focused = false;
  let dismissed = false;
  function update(): void {
    if (!hovered && !focused) dismissed = false;
    tooltip.hidden = dismissed || (!hovered && !focused);
    if (!tooltip.hidden) {
      tooltip.classList.remove("above");
      const bounds = wrapper.getBoundingClientRect();
      const popupBounds = document.body.classList.contains("preview-mode")
        ? wrapper.closest(".popup")?.getBoundingClientRect() : undefined;
      const top = Math.max(0, popupBounds?.top ?? 0);
      const bottom = Math.min(window.innerHeight, popupBounds?.bottom ?? window.innerHeight);
      tooltip.classList.toggle("above",
        tooltip.offsetHeight + 6 > bottom - bounds.bottom && bounds.top - top >= tooltip.offsetHeight + 6);
    }
  }
  wrapper.addEventListener("mouseenter", () => { hovered = true; update(); });
  wrapper.addEventListener("mouseleave", () => { hovered = false; update(); });
  title.addEventListener("focus", () => { focused = true; update(); });
  title.addEventListener("blur", () => { focused = false; update(); });
  wrapper.addEventListener("dismiss-tooltip", () => { dismissed = true; update(); });
  return wrapper;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    list.querySelectorAll(".rule-name").forEach((name) => name.dispatchEvent(new Event("dismiss-tooltip")));
  }
});

async function refresh(): Promise<void> {
  const sequence = ++refreshSequence;
  const [state, queryRules, conflicts, warnings, cookies, cookieConflicts] = await Promise.all([
    readHeaderState(), readQueryRules(), readQueryConflicts(), readWarnings(), readCookieRules(), readCookieConflicts(),
  ]);
  if (sequence !== refreshSequence) return;
  activation.checked = state.enabled;
  list.replaceChildren();
  empty.hidden = state.rules.length + queryRules.length + cookies.length > 0;
  const headersList = state.rules.length ? ruleGroup("header", "Headers", state.rules) : undefined;
  const cookiesList = cookies.length ? ruleGroup("cookie", "Cookies", cookies,
    [...new Set(cookies.filter((rule) => !rule.enabled).flatMap(cookiePermissionOrigins))]) : undefined;
  const queriesList = queryRules.length ? ruleGroup("query", "Query parameters", queryRules) : undefined;
  for (const rule of state.rules) {
    const item = document.createElement("li");
    item.dataset.ruleType = "header";
    const description = document.createElement("div");
    const title = ruleName(rule.name, `header-details-${rule.id}`, [
      ["Site", `${rule.site}${rule.includeSubdomains ? " and subdomains" : ""}`],
      ["Operation", rule.operation[0].toUpperCase() + rule.operation.slice(1)],
      ["Protocols", rule.protocols.map((protocol) => protocol.toUpperCase()).join(", ")],
    ]);
    const valueText = document.createElement("span");
    valueText.textContent = rule.operation === "remove" ? "Removed" : rule.value;
    description.append(title, valueText);

    const actions = document.createElement("div");
    actions.className = "rule-actions";
    const label = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled;
    toggle.setAttribute("aria-label", `Enable ${rule.name} for ${rule.site}`);
    toggle.addEventListener("change", () => {
      void perform(() => send({ type: "toggle-header", id: rule.id, enabled: toggle.checked }));
    });
    label.append(toggle);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editingQuery = undefined;
      editingCookie = undefined;
      editing = rule;
      ruleType.value = "header";
      operation.value = rule.operation;
      name.value = rule.name;
      value.value = rule.value;
      value.disabled = rule.operation === "remove";
      site.value = rule.site;
      subdomains.checked = rule.includeSubdomains;
      https.checked = rule.protocols.includes("https");
      http.checked = rule.protocols.includes("http");
      configureType();
      name.focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void perform(() => send({ type: "remove-header", id: rule.id }));
    });
    actions.append(edit, remove);
    item.append(label, description, actions);
    headersList?.append(item);
  }
  for (const rule of queryRules) {
    const item = document.createElement("li");
    item.dataset.ruleType = "query";
    const description = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = rule.name;
    const valueText = document.createElement("span");
    valueText.textContent = rule.operation === "remove" ? "Removed" : rule.value;
    description.append(title, valueText);
    const actions = document.createElement("div");
    actions.className = "rule-actions";
    const label = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled;
    toggle.setAttribute("aria-label", `Enable query ${rule.name} for ${rule.site}`);
    toggle.addEventListener("change", () => {
      void perform(() => send({ type: "toggle-query", id: rule.id, enabled: toggle.checked }));
    });
    label.append(toggle);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editing = undefined;
      editingCookie = undefined;
      editingQuery = rule;
      ruleType.value = "query";
      operation.value = rule.operation;
      name.value = rule.name;
      value.value = rule.value;
      site.value = rule.site;
      subdomains.checked = rule.includeSubdomains;
      https.checked = rule.protocols.includes("https");
      http.checked = rule.protocols.includes("http");
      configureType();
      name.focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void perform(() => send({ type: "remove-query", id: rule.id }));
    });
    actions.append(edit, remove);
    item.append(label, description, actions);
    queriesList?.append(item);
  }
  for (const rule of cookies) {
    const item = document.createElement("li");
    item.dataset.ruleType = "cookie";
    const description = document.createElement("div");
    const title = ruleName(rule.name, `cookie-details-${rule.id}`, [
      ["Site", `${rule.site}${rule.includeSubdomains ? " and subdomains" : ""}`],
      ["Path", rule.path],
      ["SameSite", rule.sameSite === "no_restriction" ? "None" : rule.sameSite],
      ["Secure", rule.secure ? "Yes" : "No"],
      ["HttpOnly", rule.httpOnly ? "Yes" : "No"],
    ]);
    const valueText = document.createElement("span");
    valueText.textContent = rule.value;
    description.append(title, valueText);
    const actions = document.createElement("div");
    actions.className = "rule-actions";
    const label = document.createElement("label");
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = rule.enabled;
    toggle.setAttribute("aria-label", `Enable cookie ${rule.name} for ${rule.site}`);
    toggle.addEventListener("change", () => {
      void perform(async () => {
        if (toggle.checked && !await chrome.permissions.request({ origins: cookiePermissionOrigins(rule) })) {
          throw new Error("Cookie site access was not granted.");
        }
        await send({ type: "toggle-cookie", id: rule.id, enabled: toggle.checked });
      });
    });
    label.append(toggle);
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      editing = undefined;
      editingQuery = undefined;
      editingCookie = rule;
      ruleType.value = "cookie";
      name.value = rule.name;
      value.value = rule.value;
      site.value = rule.site;
      subdomains.checked = rule.includeSubdomains;
      cookiePath.value = rule.path;
      cookieSameSite.value = rule.sameSite;
      cookieSecure.checked = rule.secure;
      cookieHttpOnly.checked = rule.httpOnly;
      configureType();
      name.focus();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      void perform(async () => {
        if (!await chrome.permissions.request({ origins: cookiePermissionOrigins(rule) })) {
          throw new Error("Cookie site access was not granted.");
        }
        await send({ type: "remove-cookie", id: rule.id });
      });
    });
    actions.append(edit, remove);
    item.append(label, description, actions);
    cookiesList?.append(item);
  }
  warningsList.replaceChildren();
  for (const warning of warnings) {
    const item = document.createElement("li");
    item.textContent = warning;
    warningsList.append(item);
  }
  clearWarnings.hidden = warnings.length === 0;
  conflictsList.replaceChildren();
  for (const conflict of conflicts.pending) {
    const rule = queryRules.find((item) => item.id === conflict.ruleId);
    if (!rule) continue;
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = "Query conflict";
    const detail = document.createElement("span");
    detail.textContent = `: ${rule.name} on ${rule.site} (tab ${conflict.tab.id}) already has a value. `;
    item.append(title, detail);
    for (const [decision, label] of [["replace", "Replace value"], ["keep", "Keep site value"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        void perform(() => send({ type: "resolve-query", id: rule.id, tabId: conflict.tab.id, decision }));
      });
      item.append(button);
    }
    conflictsList.append(item);
  }
  for (const conflict of cookieConflicts) {
    const rule = cookies.find((item) => item.id === conflict.ruleId);
    if (!rule) continue;
    const item = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = "Cookie conflict";
    const detail = document.createElement("span");
    detail.textContent = `: ${rule.name} on ${rule.site} would replace ${conflict.cookies.length} existing cookie(s). Backups are lost on browser restart or extension reload. `;
    item.append(title, detail);
    const affected = document.createElement("ul");
    for (const cookie of conflict.cookies) {
      const entry = document.createElement("li");
      entry.textContent = `${cookie.domain}${cookie.path} · store ${cookie.storeId}${cookie.secure ? " · Secure" : ""}${cookie.httpOnly ? " · HttpOnly" : ""}`;
      affected.append(entry);
    }
    item.append(affected);
    for (const [decision, label] of [["replace", "Replace cookies"], ["keep", "Keep cookies and disable rule"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        void perform(() => send({ type: "resolve-cookie", id: rule.id, revision: conflict.revision, decision }));
      });
      item.append(button);
    }
    conflictsList.append(item);
  }
  issues.hidden = !warnings.length && !conflictsList.children.length;
  setControlsDisabled(busy || stateUnavailable);
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (busy || stateUnavailable) return;
  busy = true;
  error.hidden = true;
  setControlsDisabled(true);
  try {
    await action();
  } catch (problem) {
    showError(problem);
    try {
      await send({ type: "reconcile" });
    } catch (recoveryProblem) {
      stateUnavailable = true;
      showError(recoveryProblem);
    }
  }
  try {
    await refresh();
  } catch (problem) {
    stateUnavailable = true;
    showError(problem);
  }
  busy = false;
  setControlsDisabled(stateUnavailable);
}

async function initialize(): Promise<void> {
  const preview = import.meta.env.DEV && (typeof chrome === "undefined" || !chrome.runtime?.id);
  if (preview) {
    const { startPreview } = await import("./preview.js");
    await startPreview();
  }
  if (typeof chrome === "undefined" || !chrome.runtime?.id || !chrome.storage?.local) {
    context.textContent = "Browser preview · extension controls unavailable";
    return;
  }
  context.textContent = preview ? "Interactive simulation · no real browser changes"
    : chrome.extension.inIncognitoContext ? "Incognito window" : "Normal window";

  try {
    await send({ type: "reconcile" });
    await refresh();
  } catch (problem) {
    showError(problem);
    return;
  }
  setControlsDisabled(false);

  activation.addEventListener("change", () => {
    void perform(() => send({ type: "set-activation", enabled: activation.checked }));
  });
  ruleType.addEventListener("change", () => {
    editing = undefined;
    editingQuery = undefined;
    editingCookie = undefined;
    configureType();
  });
  clearWarnings.addEventListener("click", () => {
    void perform(() => send({ type: "clear-warnings" }));
  });
  operation.addEventListener("change", () => { value.disabled = ruleType.value !== "cookie" && operation.value === "remove"; });
  detectSite.addEventListener("click", () => {
    detectSite.disabled = true;
    error.hidden = true;
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) throw new Error("Cannot read the active tab. Open a website and reopen HeaderLab.");
        let url: URL;
        try {
          url = new URL(tab.url);
        } catch (problem) {
          throw new Error("Cannot read the active tab's address.", { cause: problem });
        }
        if ((url.protocol !== "http:" && url.protocol !== "https:") || !validHostname(url.hostname)) {
          throw new Error("Open an HTTP or HTTPS website with a supported hostname to detect its site.");
        }
        site.value = url.hostname;
      } catch (problem) {
        showError(problem);
      } finally {
        detectSite.disabled = false;
      }
    })();
  });
  cancel.addEventListener("click", resetForm);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (ruleType.value === "cookie") {
      const sameSite = cookieSameSite.value;
      if (sameSite !== "lax" && sameSite !== "strict" && sameSite !== "no_restriction" && sameSite !== "unspecified") {
        showError(new Error("Select a valid SameSite value."));
        return;
      }
      const rule: CookieRule = {
        id: editingCookie?.id ?? 1, enabled: editingCookie?.enabled ?? true,
        site: site.value.trim().toLowerCase(), includeSubdomains: subdomains.checked,
        name: name.value.trim(), value: value.value, path: cookiePath.value,
        secure: cookieSecure.checked, httpOnly: cookieHttpOnly.checked, sameSite,
      };
      const validation = validateCookieRule(rule);
      if (validation) {
        showError(new Error(validation));
        return;
      }
      const origins = [...new Set([...cookiePermissionOrigins(rule), ...(editingCookie ? cookiePermissionOrigins(editingCookie) : [])])];
      void perform(async () => {
        if (!await chrome.permissions.request({ origins })) throw new Error("Cookie site access was not granted.");
        await send({ type: editingCookie ? "update-cookie" : "add-cookie", rule });
        resetForm();
      });
      return;
    }
    const selectedOperation = operation.value;
    if (selectedOperation !== "set" && selectedOperation !== "append" && selectedOperation !== "remove") {
      showError(new Error("Select a valid operation."));
      return;
    }
    const protocols: Protocol[] = [];
    if (https.checked) protocols.push("https");
    if (http.checked) protocols.push("http");
    if (ruleType.value === "query") {
      if (selectedOperation === "append") {
        showError(new Error("Select a valid query operation."));
        return;
      }
      const rule: QueryRule = {
        id: editingQuery?.id ?? 1,
        enabled: editingQuery?.enabled ?? true,
        site: site.value.trim().toLowerCase(),
        includeSubdomains: subdomains.checked,
        protocols,
        name: name.value.trim(),
        operation: selectedOperation,
        value: value.value,
      };
      const validation = validateQueryRule(rule);
      if (validation) {
        showError(new Error(validation));
        return;
      }
      const origins = protocols.map((protocol) =>
        `${protocol}://${rule.includeSubdomains ? "*." : ""}${rule.site}/*`,
      );
      void perform(async () => {
        if (!await chrome.permissions.request({ origins })) throw new Error("Site access was not granted.");
        await send({ type: editingQuery ? "update-query" : "add-query", rule });
        resetForm();
      });
      return;
    }
    const rule: HeaderRule = {
      id: editing?.id ?? 1,
      enabled: editing?.enabled ?? true,
      site: site.value.trim().toLowerCase(),
      includeSubdomains: subdomains.checked,
      protocols,
      name: name.value.trim(),
      operation: selectedOperation satisfies HeaderOperation,
      value: value.value,
    };
    const validation = validateHeaderRule(rule);
    if (validation) {
      showError(new Error(validation));
      return;
    }
    const origins = protocols.map((protocol) =>
      `${protocol}://${rule.includeSubdomains ? "*." : ""}${rule.site}/*`,
    );
    void perform(async () => {
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error("Site access was not granted.");
      await send({ type: editing ? "update-header" : "add-header", rule });
      resetForm();
    });
  });
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local" || area === "session") void refresh().catch((problem: unknown) => {
      stateUnavailable = true;
      setControlsDisabled(true);
      showError(problem);
    });
  });
}

void initialize();
