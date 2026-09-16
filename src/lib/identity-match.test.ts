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

function personWithIdentity(
  id: string,
  name: string,
  identity: { platform: string; account?: string; alias: string },
): PersonRecord {
  const record = person(id, name);
  record.profile = { identities: [identity] };
  return record;
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

  it("matches a unique platform account on the same platform", () => {
    const target = personWithIdentity("account", "唐悦", {
      platform: "摄影社",
      account: "photo-tang-demo",
      alias: "糖糖",
    });
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

  it("does not strongly match the same account across different platforms", () => {
    const target = personWithIdentity("github", "合成人物甲", {
      platform: "GitHub",
      account: "synthetic-alex",
      alias: "alex-demo",
    });
    const result = matchIdentity(
      {
        name: "合成人物乙",
        identities: [{ platform: "微信", account: "synthetic-alex" }],
      },
      [target],
    );
    expect(result.decision).not.toBe("update");
    expect(result.matches).toHaveLength(0);
  });

  it("requires a choice when the same cross-platform account comes with the same name", () => {
    const target = personWithIdentity("github", "王晨", {
      platform: "GitHub",
      account: "synthetic-alex",
      alias: "alex-demo",
    });
    const result = matchIdentity(
      { name: "王晨", identities: [{ platform: "微信", account: "synthetic-alex" }] },
      [target],
    );
    expect(result.decision).toBe("choose");
  });

  it("does not collapse account-like free text onto shared trailing digits", () => {
    const result = matchIdentity({ name: "甲", contact: "微信 alice123" }, [
      person("other", "乙", "微信 bob123"),
    ]);
    expect(result.decision).not.toBe("update");
  });

  it("still matches identical free-text contact", () => {
    const result = matchIdentity({ name: "甲", contact: "微信 alice123" }, [
      person("same", "乙", "微信 alice 123"),
    ]);
    expect(result.decision).toBe("update");
    expect(result.matches[0].id).toBe("same");
  });

  it("requires a choice when a home phone is shared by two people", () => {
    const result = matchIdentity({ name: "爸爸", contact: "010-65601234" }, [
      person("mom", "妈妈", "01065601234"),
      person("child", "我", "010-6560-1234"),
    ]);
    expect(result.decision).toBe("choose");
    expect(result.matches).toHaveLength(2);
  });

  it("does not treat a platform-unknown account as a strong key", () => {
    const target = personWithIdentity("known", "唐悦", {
      platform: "微信",
      account: "tang-demo",
      alias: "糖糖",
    });
    const result = matchIdentity({ name: "唐悦", identities: [{ account: "tang-demo" }] }, [
      target,
    ]);
    expect(result.decision).toBe("choose");
  });

  it("reports the rule that actually fired", () => {
    const target = personWithIdentity("account", "唐悦", {
      platform: "摄影社",
      account: "photo-tang-demo",
      alias: "糖糖",
    });
    const result = matchIdentity(
      {
        name: "唐悦",
        contact: "未命中的自由文本",
        identities: [{ platform: "摄影社", account: "photo-tang-demo" }],
      },
      [target],
    );
    expect(result.decision).toBe("update");
    expect(result.reasons).toContain("平台账号唯一匹配");
  });
});
