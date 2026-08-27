import { describe, expect, it } from "vitest";

import type { PersonRecord } from "./face-db";
import { matchIdentity, normalizeContact } from "./identity-match";

function person(id: string, name: string, contact?: string): PersonRecord {
  return {
    id,
    name,
    note: "",
    profile: { contact },
    descriptors: [],
    thumb: "",
    createdAt: 1,
  };
}

describe("matchIdentity", () => {
  it("never silently merges a same-name person", () => {
    const result = matchIdentity({ name: "王晨" }, [
      person("student", "王晨"),
      person("alumni", "王晨"),
    ]);
    expect(result.decision).toBe("choose");
    expect(result.matches).toHaveLength(2);
  });

  it("suggests a unique contact match even after a rename", () => {
    const result = matchIdentity({ name: "唐悦", contact: "demo@example.invalid" }, [
      person("old", "糖糖", " DEMO@example.invalid "),
    ]);
    expect(result.decision).toBe("update");
    expect(result.matches[0].id).toBe("old");
  });

  it("requires a choice for a historical alias without a strong account", () => {
    const target = person("old", "唐悦");
    target.profile = {
      identities: [{ platform: "摄影社", alias: "糖糖" }],
    };
    expect(matchIdentity({ name: "糖糖" }, [target]).decision).toBe("choose");
  });

  it("matches a unique platform account", () => {
    const target = person("account", "唐悦");
    target.profile = {
      identities: [{ platform: "摄影社", account: "photo-tang-demo", alias: "糖糖" }],
    };
    expect(
      matchIdentity(
        {
          name: "唐悦",
          identities: [{ platform: "摄影社", account: "photo-tang-demo", alias: "唐悦" }],
        },
        [target],
      ),
    ).toMatchObject({ decision: "update", matches: [target] });
  });

  it("normalizes Chinese phone prefixes, separators and full-width digits", () => {
    expect(normalizeContact("+86 138-0000-0000")).toBe("13800000000");
    expect(normalizeContact("（１３８）００００－００００")).toBe("13800000000");
    expect(
      matchIdentity({ name: "唐悦", contact: "+86 138-0000-0000" }, [
        person("phone", "糖糖", "13800000000"),
      ]),
    ).toMatchObject({ decision: "update", matches: [expect.objectContaining({ id: "phone" })] });
  });
});
