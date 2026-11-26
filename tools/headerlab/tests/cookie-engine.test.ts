import { describe, expect, it } from "vitest";
import { CookieEngine, type CookiePort, type CookieUndo } from "../src/application/cookie-engine.js";
import type { CookieRule } from "../src/domain/cookie-rule.js";

const rule: CookieRule = {
  id: 1, enabled: true, site: "example.com", includeSubdomains: false,
  name: "test", value: "managed", path: "/", secure: true, httpOnly: false, sameSite: "lax",
};

function cookie(path: string, value: string, storeId = "normal"): chrome.cookies.Cookie {
  return {
    name: "test", value, path, storeId, domain: "example.com", hostOnly: true,
    session: true, secure: true, httpOnly: false, sameSite: "lax",
  };
}

function fake(initial: chrome.cookies.Cookie[], stores = ["normal"]): CookiePort {
  let cookies = [...initial];
  let undo: CookieUndo[] = [];
  return {
    stores: async () => stores,
    list: async (name, store) => structuredClone(cookies.filter((item) => item.name === name && item.storeId === store)),
    remove: async (item) => {
      cookies = cookies.filter((other) => other.name !== item.name || other.storeId !== item.storeId ||
        other.domain !== item.domain || other.path !== item.path);
    },
    set: async (next, store) => {
      const item = cookie(next.path, next.value, store);
      cookies.push(item);
      return structuredClone(item);
    },
    restore: async (item) => { cookies.push(item); },
    readUndo: async () => structuredClone(undo),
    writeUndo: async (entries) => { undo = structuredClone(entries); },
  };
}

describe("cookie engine", () => {
  it("can inspect a new store without creating or replacing cookies", async () => {
    const port = fake([]);
    const engine = new CookieEngine(port);

    expect(await engine.inspect(rule)).toEqual({ conflicts: [] });
    expect(await port.list("test", "normal")).toEqual([]);
    expect(await port.readUndo()).toEqual([]);
  });

  it("requires confirmation before replacing cookies on different paths", async () => {
    const port = fake([cookie("/", "old"), cookie("/account", "other")]);
    const engine = new CookieEngine(port);

    const result = await engine.apply(rule);

    expect(result.conflicts).toHaveLength(2);
    expect((await port.list("test", "normal")).map((item) => item.value)).toEqual(["old", "other"]);
  });

  it("restores replaced cookies when the managed cookie is unchanged", async () => {
    const originals = [cookie("/", "old"), cookie("/account", "other")];
    const port = fake(originals);
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);

    await engine.apply(rule, plan.conflicts);
    expect((await port.list("test", "normal")).map((item) => item.value)).toEqual(["managed"]);
    expect(await engine.undo(rule.id)).toEqual([]);
    expect(await port.list("test", "normal")).toEqual(originals);
  });

  it("preserves site changes and warns instead of restoring over them", async () => {
    const port = fake([cookie("/", "old")]);
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);
    await engine.apply(rule, plan.conflicts);
    const [managed] = await port.list("test", "normal");
    managed.value = "site-changed";
    await port.remove(managed);
    await port.restore(managed);

    expect(await engine.undo(rule.id)).toHaveLength(1);
    expect((await port.list("test", "normal")).map((item) => item.value)).toEqual(["site-changed"]);
  });

  it("refuses confirmation when cookies changed since the user reviewed conflicts", async () => {
    const port = fake([cookie("/", "old")]);
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);
    await port.restore(cookie("/new", "new"));

    await expect(engine.apply(rule, plan.conflicts)).rejects.toThrow(/changed/i);
    expect((await port.list("test", "normal")).map((item) => item.value)).toEqual(["old", "new"]);
  });

  it("restores removed cookies when installing the replacement fails", async () => {
    const original = cookie("/", "old");
    const port = fake([original]);
    port.set = async () => { throw new Error("Cannot set cookie"); };
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);

    await expect(engine.apply(rule, plan.conflicts)).rejects.toThrow("Cannot set cookie");
    expect(await port.list("test", "normal")).toEqual([original]);
    expect(await port.readUndo()).toEqual([]);
  });

  it("rolls back earlier stores if a later store cannot be updated", async () => {
    const originals = [cookie("/", "normal-old"), cookie("/", "private-old", "private")];
    const port = fake(originals, ["normal", "private"]);
    const set = port.set;
    port.set = async (next, store) => {
      if (store === "private") throw new Error("Cannot set private cookie");
      return set(next, store);
    };
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);

    await expect(engine.apply(rule, plan.conflicts)).rejects.toThrow("Cannot set private cookie");
    expect(await port.list("test", "normal")).toEqual([originals[0]]);
    expect(await port.list("test", "private")).toEqual([originals[1]]);
    expect(await port.readUndo()).toEqual([]);
  });

  it("retains a rollback journal when saving its removal fails", async () => {
    const originals = [cookie("/", "normal-old"), cookie("/", "private-old", "private")];
    const port = fake(originals, ["normal", "private"]);
    const set = port.set;
    const write = port.writeUndo;
    let failed = false;
    let privateFailed = false;
    port.set = async (next, store) => {
      if (store === "private") {
        privateFailed = true;
        throw new Error("Cannot set private cookie");
      }
      return set(next, store);
    };
    port.writeUndo = async (entries) => {
      if (privateFailed && !failed && entries.length === 1 && entries[0].storeId === "normal") {
        failed = true;
        throw new Error("Cannot save rollback");
      }
      await write(entries);
    };
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);

    await expect(engine.apply(rule, plan.conflicts)).rejects.toThrow("Could not apply or safely restore cookies");
    expect(await port.readUndo()).toEqual([expect.objectContaining({ storeId: "private", restoring: true })]);
  });

  it("resumes a restoration interrupted after some originals were restored", async () => {
    const originals = [cookie("/", "old"), cookie("/account", "other")];
    const port = fake(originals);
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);
    await engine.apply(rule, plan.conflicts);
    const restore = port.restore;
    port.restore = async (item) => {
      if (item.path === "/account") throw new Error("Cannot restore cookie");
      await restore(item);
    };

    await expect(engine.undo(rule.id)).rejects.toThrow("Cannot restore cookie");
    port.restore = restore;
    expect(await engine.undo(rule.id)).toEqual([]);
    expect(await port.list("test", "normal")).toEqual(originals);
    expect(await port.readUndo()).toEqual([]);
  });

  it("can resume a rollback after installing and restoring both fail", async () => {
    const original = cookie("/", "old");
    const port = fake([original]);
    const restore = port.restore;
    port.set = async () => { throw new Error("Cannot set cookie"); };
    port.restore = async () => { throw new Error("Cannot restore cookie"); };
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);

    await expect(engine.apply(rule, plan.conflicts)).rejects.toThrow("Could not apply or safely restore cookies");
    port.restore = restore;
    expect(await engine.undo(rule.id)).toEqual([]);
    expect(await port.list("test", "normal")).toEqual([original]);
    expect(await port.readUndo()).toEqual([]);
  });

  it("does not treat a cookie pending restoration as active", async () => {
    const port = fake([]);
    const engine = new CookieEngine(port);
    await engine.apply(rule);
    const undo = await port.readUndo();
    undo[0].restoring = true;
    await port.writeUndo(undo);

    await expect(engine.inspect(rule)).rejects.toThrow(/interrupted/i);
  });

  it("recovers originals after interruption before installation", async () => {
    const original = cookie("/", "old");
    const port = fake([]);
    await port.writeUndo([{ rule, storeId: "normal", original: [original], installed: null }]);
    const engine = new CookieEngine(port);

    expect(await engine.recover(rule.id)).toEqual([]);
    expect(await port.list("test", "normal")).toEqual([original]);
    expect(await port.readUndo()).toEqual([]);
  });

  it("preserves an unverified cookie after an interrupted installation", async () => {
    const original = cookie("/", "old");
    const changed = cookie("/", "site-changed");
    const port = fake([changed]);
    await port.writeUndo([{ rule, storeId: "normal", original: [original], installed: null }]);
    const engine = new CookieEngine(port);

    expect(await engine.recover(rule.id)).toHaveLength(1);
    expect(await port.list("test", "normal")).toEqual([changed]);
    expect(await port.readUndo()).toHaveLength(1);
  });

  it("does not treat a different rule with the same id as already applied", async () => {
    const port = fake([]);
    const engine = new CookieEngine(port);
    await engine.apply(rule);

    await expect(engine.inspect({ ...rule, value: "different" })).rejects.toThrow(/rule.*changed/i);
    expect((await port.list("test", "normal"))[0].value).toBe("managed");
  });

  it("discards a closed private store journal without touching another store", async () => {
    const stores = ["normal", "private"];
    const port = fake([cookie("/", "private-old", "private")], stores);
    const engine = new CookieEngine(port);
    const plan = await engine.apply(rule);
    await engine.apply(rule, plan.conflicts);
    stores.splice(stores.indexOf("private"), 1);
    const list = port.list;
    port.list = async (name, store) => {
      if (!stores.includes(store)) throw new Error("Store no longer exists");
      return list(name, store);
    };

    expect(await engine.undo(rule.id)).toEqual([expect.stringMatching(/closed/i)]);
    expect(await port.readUndo()).toEqual([]);
    expect(await port.list("test", "normal")).toEqual([]);
  });

  it("discards a closed private store journal during recovery even if installation completed", async () => {
    const stores = ["normal", "private"];
    const port = fake([], stores);
    const engine = new CookieEngine(port);
    await engine.apply(rule);
    stores.splice(stores.indexOf("private"), 1);

    expect(await engine.recover(rule.id)).toEqual([expect.stringMatching(/closed/i)]);
    expect((await port.readUndo()).map((entry) => entry.storeId)).toEqual(["normal"]);
  });
});
