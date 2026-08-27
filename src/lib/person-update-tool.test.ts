import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

function useFreshIndexedDb() {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
    writable: true,
  });
}

beforeEach(() => {
  vi.resetModules();
  useFreshIndexedDb();
});

describe("approved person update tool", () => {
  it("does not write while proposing and writes only after explicit apply", async () => {
    const { facesDb } = await import("./face-db");
    const { applyPersonUpdateProposal, createPersonUpdateProposal } =
      await import("./person-update-tool");
    const person = {
      id: "p1",
      name: "小雨",
      note: "旧备注",
      profile: { title: "经理" },
      descriptors: [],
      thumb: "",
      createdAt: 10,
    };
    await facesDb.putPerson(person);

    const proposal = createPersonUpdateProposal(
      { personId: "p1", changes: { title: "品牌总监" } },
      [person],
    );
    expect((await facesDb.listPersons())[0].profile?.title).toBe("经理");

    await applyPersonUpdateProposal(proposal);
    const updated = (await facesDb.listPersons())[0];
    expect(updated.profile?.title).toBe("品牌总监");
    expect(updated.profile?.fieldSources?.title.kind).toBe("ai");
  });

  it("rejects a stale proposal instead of overwriting newer edits", async () => {
    const { facesDb } = await import("./face-db");
    const { applyPersonUpdateProposal, createPersonUpdateProposal } =
      await import("./person-update-tool");
    const person = {
      id: "p1",
      name: "小雨",
      note: "",
      descriptors: [],
      thumb: "",
      createdAt: 10,
    };
    await facesDb.putPerson(person);
    const proposal = createPersonUpdateProposal({ personId: "p1", changes: { note: "AI 修改" } }, [
      person,
    ]);
    await facesDb.putPerson({ ...person, note: "人工先改了", updatedAt: 11 });

    await expect(applyPersonUpdateProposal(proposal)).rejects.toThrow("已发生变化");
    expect((await facesDb.listPersons())[0].note).toBe("人工先改了");
  });
});
