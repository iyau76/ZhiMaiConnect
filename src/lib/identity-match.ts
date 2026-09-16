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

type ContactKind = "phone" | "email" | "text";

interface ClassifiedContact {
  kind: ContactKind;
  key: string;
}

function normalizeName(value?: string) {
  return (value ?? "").trim().toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
}

function toHalfWidthLower(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - "０".charCodeAt(0)));
}

/**
 * 联系方式先分类再归一化：只有纯数字（允许 +、括号、空格、短横线）且位数像电话
 * （7–15 位，含 0086/86 前缀剥离）才做电话归一化；含 @ 视为邮箱；其余是自由
 * 文本，只做去空格与大小写归一，整串相等才算同一联系方式。避免“微信 alice123”
 * 与“微信 bob123”因尾部数字相同而被折叠成同一联系人。
 */
function classifyContact(value?: string): ClassifiedContact | null {
  const lowered = toHalfWidthLower(value ?? "");
  if (!lowered) return null;
  if (lowered.includes("@")) {
    return { kind: "email", key: lowered.replace(/\s+/g, "") };
  }
  const compact = lowered.replace(/[\s\-－()（）+＋]/g, "");
  if (compact && /^[\d+]+$/.test(compact)) {
    let digits = compact.replace(/\D/g, "");
    if (digits.length === 15 && digits.startsWith("0086")) digits = digits.slice(4);
    if (digits.length === 13 && digits.startsWith("86")) digits = digits.slice(2);
    if (digits.length >= 7 && digits.length <= 15) {
      return { kind: "phone", key: digits };
    }
  }
  return { kind: "text", key: lowered.replace(/\s+/g, "") };
}

export function normalizeContact(value?: string) {
  return classifyContact(value)?.key ?? "";
}

function normalizeAccount(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

function normalizePlatform(value?: string) {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/**
 * 平台账号的强匹配键是“平台＋账号”。任一侧缺少平台时无法确认是同一平台的
 * 账号，不构成强键，交给名称与昵称的弱匹配路径。
 */
function accountKeysOf(identities?: Array<{ platform?: string; account?: string }>) {
  const keys = new Set<string>();
  for (const identity of identities ?? []) {
    const account = normalizeAccount(identity.account);
    const platform = normalizePlatform(identity.platform);
    if (account && platform) keys.add(`${platform}::${account}`);
  }
  return keys;
}

/**
 * 姓名永远不作为自动合并的唯一依据。联系方式按类型整串匹配；平台账号按
 * “平台＋账号”联合匹配；唯一命中时可建议更新。同名、历史昵称、缺平台的账号
 * 或多重命中一律交给用户选择，不做批量自动合并。
 */
export function matchIdentity(
  candidate: IdentityCandidate,
  persons: PersonRecord[],
): IdentityMatchResult {
  const candidateContact = classifyContact(candidate.contact);
  const candidateAccounts = accountKeysOf(candidate.identities);
  const strong: PersonRecord[] = [];
  let firedByContact = false;
  let firedByAccount = false;
  for (const person of persons) {
    const personContact = classifyContact(person.profile?.contact);
    const contactHit =
      candidateContact !== null &&
      personContact !== null &&
      personContact.kind === candidateContact.kind &&
      personContact.key === candidateContact.key;
    const accountHit =
      candidateAccounts.size > 0 &&
      [...candidateAccounts].some((key) => accountKeysOf(person.profile?.identities).has(key));
    if (contactHit) firedByContact = true;
    if (accountHit) firedByAccount = true;
    if (contactHit || accountHit) strong.push(person);
  }
  if (strong.length === 1) {
    return {
      decision: "update",
      matches: strong,
      reasons: [firedByContact ? "联系方式唯一匹配" : "平台账号唯一匹配"],
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
