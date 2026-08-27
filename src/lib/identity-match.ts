import type { PersonRecord } from "./face-db";

export interface IdentityCandidate {
  name: string;
  contact?: string;
  identities?: Array<{ platform?: string; account?: string; alias?: string }>;
}

export interface IdentityMatchResult {
  decision: "create" | "update" | "choose";
  matches: PersonRecord[];
  reasons: string[];
}

function normalizeName(value?: string) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function normalizeContact(value?: string) {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.includes("@")) return raw;
  return raw.replace(/[^\d+]/g, "");
}

function normalizeAccount(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function accountsOf(person: PersonRecord) {
  return new Set(
    (person.profile?.identities ?? [])
      .map((identity) => normalizeAccount(identity.account))
      .filter(Boolean),
  );
}

/**
 * 姓名永远不作为自动合并的唯一依据。联系方式或平台账号唯一命中时可建议更新，
 * 同名、历史昵称或多重命中一律交给用户选择。
 */
export function matchIdentity(
  candidate: IdentityCandidate,
  persons: PersonRecord[],
): IdentityMatchResult {
  const contact = normalizeContact(candidate.contact);
  const accounts = new Set(
    (candidate.identities ?? [])
      .map((identity) => normalizeAccount(identity.account))
      .filter(Boolean),
  );
  const strong = persons.filter((person) => {
    if (contact && normalizeContact(person.profile?.contact) === contact) return true;
    if (accounts.size) {
      const existing = accountsOf(person);
      if ([...accounts].some((account) => existing.has(account))) return true;
    }
    return false;
  });
  if (strong.length === 1) {
    return {
      decision: "update",
      matches: strong,
      reasons: [contact ? "联系方式唯一匹配" : "平台账号唯一匹配"],
    };
  }
  if (strong.length > 1) {
    return { decision: "choose", matches: strong, reasons: ["联系方式或账号命中多份档案"] };
  }

  const name = normalizeName(candidate.name);
  const aliases = new Set([
    name,
    ...(candidate.identities ?? []).map((identity) => normalizeName(identity.alias)),
  ]);
  aliases.delete("");
  const weak = persons.filter((person) => {
    const names = [
      normalizeName(person.name),
      ...(person.profile?.identities ?? []).map((identity) => normalizeName(identity.alias)),
    ];
    return names.some((value) => aliases.has(value));
  });
  if (weak.length) {
    return {
      decision: "choose",
      matches: weak,
      reasons: [
        weak.some((person) => normalizeName(person.name) === name)
          ? "存在同名档案"
          : "命中历史昵称",
      ],
    };
  }
  return { decision: "create", matches: [], reasons: ["未发现可靠身份匹配"] };
}
