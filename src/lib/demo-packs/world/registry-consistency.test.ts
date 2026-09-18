import { describe, expect, it } from "vitest";

import { loadPack, PACK_META, WORLD_PACK_IDS, type DemoPackMeta } from "../registry";
import type { DemoPack } from "../types";

async function loadWorldPacks() {
  return Promise.all(WORLD_PACK_IDS.map((id) => loadPack(id)));
}

describe("world theater registry consistency", () => {
  it("keeps every world pack's metadata identical to PACK_META", async () => {
    const metaById = PACK_META as Record<string, DemoPackMeta | undefined>;
    for (const pack of await loadWorldPacks()) {
      const meta = metaById[pack.id];
      expect(meta, `PACK_META 缺少 ${pack.id}`).toBeDefined();
      expect(pack.group).toBe(meta?.group);
      expect(pack.name).toBe(meta?.name);
      expect(pack.description).toBe(meta?.description);
      expect(pack.example).toBe(meta?.example);
      expect(pack.universe?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("keeps person keys globally unique across world packs", async () => {
    const packs = await loadWorldPacks();
    const seen = new Map<string, string>();
    for (const pack of packs) {
      for (const person of pack.people) {
        const owner = seen.get(person.key);
        expect(
          owner,
          `人物 key 冲突：${person.key} 同时出现在 ${owner} 与 ${pack.id}`,
        ).toBeUndefined();
        seen.set(person.key, pack.id);
      }
    }
  });

  it("declares an in-pack anchor that exists for every pack", async () => {
    for (const pack of await loadWorldPacks()) {
      const keys = new Set(pack.people.map((person) => person.key));
      expect(pack.egoKey, `${pack.id} 缺少 egoKey`).toBeTruthy();
      expect(keys.has(pack.egoKey as string), `${pack.id} 的 egoKey 不在人物表中`).toBe(true);
    }
  });

  it("uses only synthetic contact addresses", async () => {
    for (const pack of (await loadWorldPacks()) as DemoPack[]) {
      for (const person of pack.people) {
        const contact = person.profile.contact;
        if (contact)
          expect(contact.endsWith("@example.invalid"), `${pack.id}/${person.key}`).toBe(true);
      }
    }
  });
});
