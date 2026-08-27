import type {
  FieldGrounding,
  GroundingWarning,
  GroundingWarningField,
  IngestCandidate,
  IngestEvent,
  IngestPerson,
  SensitivePersonField,
} from "./intake-draft";

interface SupportResult {
  supported: boolean;
  evidenceQuote?: string;
}

interface DateParts {
  year?: number;
  month: number;
  day: number;
}

const CONTACT_LABEL =
  /^(?:联系方式|联系|微信号?|wechat|weixin|wx|手机号?|手机|电话|tel|邮箱|电子邮箱|e-?mail|email|qq|telegram|tg)\s*[:：=-]?\s*/i;
const CONTACT_CONTEXT =
  /联系方式|联系|微信号?|wechat|weixin|wx|手机号?|手机|电话|tel|邮箱|电子邮箱|e-?mail|email|qq|telegram|tg/i;
const BIRTHDAY_KEYWORD = /生日|出生|birthday|born/gi;
const CLOSENESS_KEYWORD = /亲密度|亲近度|关系评分|closeness|intimacy/gi;
const LIKE_CONTEXT =
  /喜欢|爱好|擅长|善于|从事|会做|做|likes?|interests?|skilled|good at|works? on/i;
const DISLIKE_CONTEXT = /不喜欢|忌口|不吃|过敏|dislikes?|allerg/i;
const GIFT_CONTEXT = /送过|送了|礼物|赠送|gifts?|gave/i;
const TAG_CONTEXT = /标签|技能|擅长|专长|职业|职位|工作|负责|tags?|skills?|role|job/i;
const TITLE_CONTEXT = /职业|职位|职务|担任|任职|从事|工作是|works? as|title|role|job/i;
const PROJECT_CONTEXT = /项目|活动|计划|作品|负责|参与|合作|projects?|works? on/i;
const IDENTITY_ALIAS_CONTEXT = /昵称|别名|曾用名|用户名|账户名|账号名|alias|nickname|username/i;
const IDENTITY_ACCOUNT_CONTEXT = /账号|账户|用户名|用户 id|号码|号是|account|username|user id/i;
const VALID_FROM_CONTEXT = /从|自|开始|启用|生效|valid from|since/i;
const VALID_TO_CONTEXT = /至|到|结束|停用|失效|valid to|until/i;
const CLAUSE_NEGATION =
  /不是|并非|不属|不代表|不存在|非实际|不会|不能|不再|不曾|不打算|没有|没(?:有|参加|去|做|在|用|叫|发生)|未(?:参加|发生|确认|证实|曾)|从未|否认|别人的|他人的|她人的/i;

const FIXED_FIELD_CONTEXT: Partial<Record<SensitivePersonField, RegExp>> = {
  age: /年龄|年纪|周岁|\d\s*岁|age/i,
  gender: /性别|gender|(?:是|为)\s*(?:男|女|男性|女性|非二元)/i,
  relation:
    /关系|同学|校友|朋友|室友|同事|亲属|家人|老师|导师|学生|客户|搭档|合作伙伴|relation|partner/i,
  address: /地址|住址|居住|住在|办公地点|所在地|location|address/i,
  department: /部门|院系|学院|科室|department/i,
  org: /组织|单位|公司|学校|机构|任职于|就职于|工作于|organization|company|org/i,
  reportsTo: /汇报给|上级|主管|导师|负责人|reports? to|manager|supervisor/i,
  employeeId: /工号|员工编号|人员编号|employee\s*id|staff\s*id/i,
  circle: /圈层|分组|人脉圈|circle|group/i,
  metAt: /相识|认识于|初识|第一次见|结识|met at|first met/i,
};

export const SENSITIVE_PERSON_FIELDS: readonly SensitivePersonField[] = [
  "name",
  "note",
  "age",
  "gender",
  "relation",
  "contact",
  "address",
  "department",
  "org",
  "reportsTo",
  "employeeId",
  "birthday",
  "circle",
  "title",
  "projects",
  "likes",
  "dislikes",
  "gifts",
  "metAt",
  "tags",
  "closeness",
  "identities",
];

const EXACT_TEXT_FIELDS: readonly SensitivePersonField[] = [
  "note",
  "age",
  "gender",
  "relation",
  "address",
  "department",
  "org",
  "reportsTo",
  "employeeId",
  "circle",
  "metAt",
];

export function isSensitivePersonField(value: string): value is SensitivePersonField {
  return (SENSITIVE_PERSON_FIELDS as readonly string[]).includes(value);
}

function compact(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_@]+/gu, "");
}

function excerpt(material: string, probes: string[]) {
  const lower = material.toLocaleLowerCase();
  let index = -1;
  for (const probe of probes) {
    const candidate = probe.trim().toLocaleLowerCase();
    if (candidate.length < 2) continue;
    index = lower.indexOf(candidate);
    if (index >= 0) break;
  }
  if (index < 0) return undefined;
  const start = Math.max(0, index - 18);
  const end = Math.min(material.length, index + 48);
  return `${start > 0 ? "…" : ""}${material.slice(start, end).trim()}${
    end < material.length ? "…" : ""
  }`;
}

function supportText(material: string, value: string): SupportResult {
  const trimmed = value.trim();
  const normalized = compact(trimmed);
  if (normalized.length < 2 || !compact(material).includes(normalized)) {
    return { supported: false };
  }
  return { supported: true, evidenceQuote: excerpt(material, [trimmed]) };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasNegativeAssociation(clause: string, value: string) {
  const source = clause.normalize("NFKC").toLocaleLowerCase();
  const probe = value.trim().normalize("NFKC").toLocaleLowerCase();
  if (!probe) return true;
  let offset = source.indexOf(probe);
  while (offset >= 0) {
    const before = source.slice(Math.max(0, offset - 20), offset);
    const after = source.slice(offset + probe.length, offset + probe.length + 16);
    const negativeBefore =
      /(?:不是|并非|不(?:是|叫|喜欢|爱|吃|会|能|在|去|做|负责|参加|属于|使用|有)|没(?:有|参加|去|做|在|用|叫|发生)?|没有|未(?:曾|参加|发生|确认|证实)?|从未|无|否认)[^，,。！？!?；;\n]{0,12}$/i.test(
        before,
      );
    const negativeAfter =
      /^[^，,。！？!?；;\n]{0,6}(?:不是|并非|不属|不代表|不存在|非实际|是别人|为别人|属于别人|别人的|他人的|她人的)/i.test(
        after,
      );
    if (!negativeBefore && !negativeAfter) return false;
    offset = source.indexOf(probe, offset + probe.length);
  }
  return true;
}

function supportPositiveText(material: string, value: string): SupportResult {
  for (const clause of materialClauses(material)) {
    const result = supportText(clause, value);
    if (result.supported && !hasNegativeAssociation(clause, value)) {
      return { supported: true, evidenceQuote: result.evidenceQuote ?? clause.trim() };
    }
  }
  return { supported: false };
}

function hasNegatedSubject(clause: string, name: string) {
  const source = clause.normalize("NFKC").toLocaleLowerCase();
  const probe = name.trim().normalize("NFKC").toLocaleLowerCase();
  if (!probe) return true;
  let offset = source.indexOf(probe);
  while (offset >= 0) {
    const before = source.slice(Math.max(0, offset - 10), offset);
    const after = source.slice(offset + probe.length, offset + probe.length + 12);
    if (
      !/(?:不是|并非|而非|非)\s*$/i.test(before) &&
      !/^\s*(?:不是|并非)\s*(?:本人|该人|这个人|实际主体)/i.test(after)
    ) {
      return false;
    }
    offset = source.indexOf(probe, offset + probe.length);
  }
  return true;
}

function supportPersonName(material: string, name: string): SupportResult {
  for (const sentence of materialSentences(material)) {
    const result = supportText(sentence, name);
    if (result.supported && !hasNegatedSubject(sentence, name)) {
      return { supported: true, evidenceQuote: result.evidenceQuote ?? sentence.trim() };
    }
  }
  return { supported: false };
}

function supportContextualText(
  material: string,
  value: string,
  context: RegExp,
  allowNegation = false,
): SupportResult {
  for (const clause of materialClauses(material)) {
    const result = supportText(clause, value);
    context.lastIndex = 0;
    if (
      result.supported &&
      context.test(clause) &&
      (allowNegation || !hasNegativeAssociation(clause, value))
    ) {
      return { supported: true, evidenceQuote: result.evidenceQuote ?? clause.trim() };
    }
  }
  return { supported: false };
}

function supportLabelBeforeValue(material: string, value: string, label: RegExp): SupportResult {
  const valuePattern = escapeRegExp(value.trim().normalize("NFKC"));
  if (!valuePattern) return { supported: false };
  const association = new RegExp(
    `(?:${label.source})[^。！？!?；;\\n]{0,18}${valuePattern}`,
    label.ignoreCase ? "i" : undefined,
  );
  for (const clause of materialClauses(material)) {
    const normalized = clause.normalize("NFKC");
    if (
      supportText(normalized, value).supported &&
      association.test(normalized) &&
      !hasNegativeAssociation(normalized, value)
    ) {
      return {
        supported: true,
        evidenceQuote: excerpt(normalized, [value]) ?? normalized.trim(),
      };
    }
  }
  return { supported: false };
}

function supportFixedField(
  material: string,
  field: SensitivePersonField,
  value: string,
): SupportResult {
  if (field === "note") return supportText(material, value);
  const context = FIXED_FIELD_CONTEXT[field];
  if (!context) return { supported: false };
  if (field === "age") {
    const valuePattern = escapeRegExp(value.trim());
    const ageContext = new RegExp(
      `(?:年龄|年纪|age)[^。！？!?；;\\n]{0,10}${valuePattern}|${valuePattern}\\s*岁`,
      "i",
    );
    return supportContextualText(material, value, ageContext);
  }
  return supportContextualText(material, value, context);
}

function contactTokens(value: string) {
  const tokens = value
    .split(/[\s,，;；、|/]+/u)
    .map((part) => part.replace(CONTACT_LABEL, "").trim())
    .map(compact)
    .filter((part) => part.length >= 3 && !CONTACT_LABEL.test(part));
  if (tokens.length) return [...new Set(tokens)];
  const fallback = compact(value.replace(CONTACT_LABEL, ""));
  return fallback.length >= 3 ? [fallback] : [];
}

function supportContact(material: string, value: string): SupportResult {
  const tokens = contactTokens(value);
  for (const clause of materialClauses(material)) {
    const source = compact(clause);
    CONTACT_CONTEXT.lastIndex = 0;
    const supported =
      tokens.length > 0 &&
      CONTACT_CONTEXT.test(clause) &&
      tokens.every((token) => source.includes(token) && !hasNegativeAssociation(clause, token));
    if (supported) {
      return { supported: true, evidenceQuote: excerpt(clause, tokens) ?? clause.trim() };
    }
  }
  return { supported: false };
}

function parseDateParts(value: string): DateParts | undefined {
  const match = value
    .normalize("NFKC")
    .match(/(?:(\d{4})\s*(?:年|[-/.]))?\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/u);
  if (!match) return undefined;
  const year = match[1] ? Number(match[1]) : undefined;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { year, month, day };
}

function datesIn(value: string) {
  return [
    ...value
      .normalize("NFKC")
      .matchAll(/(?:(\d{4})\s*(?:年|[-/.]))?\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/gu),
  ].map((match) => ({
    year: match[1] ? Number(match[1]) : undefined,
    month: Number(match[2]),
    day: Number(match[3]),
  }));
}

function dateOccurrences(value: string) {
  return [
    ...value
      .normalize("NFKC")
      .matchAll(/(?:(\d{4})\s*(?:年|[-/.]))?\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/gu),
  ].map((match) => ({
    parts: {
      year: match[1] ? Number(match[1]) : undefined,
      month: Number(match[2]),
      day: Number(match[3]),
    },
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

function sameDate(candidate: DateParts, source: DateParts) {
  return (
    source.month === candidate.month &&
    source.day === candidate.day &&
    (candidate.year === undefined || source.year === candidate.year)
  );
}

function supportDateAnywhere(material: string, value: string): SupportResult {
  const candidate = parseDateParts(value);
  if (!candidate) return { supported: false };
  const matched = datesIn(material).some((source) => sameDate(candidate, source));
  return matched
    ? { supported: true, evidenceQuote: excerpt(material, [value]) }
    : { supported: false };
}

function supportBirthday(material: string, value: string): SupportResult {
  const candidate = parseDateParts(value);
  if (!candidate) return { supported: false };
  BIRTHDAY_KEYWORD.lastIndex = 0;
  const normalized = material.normalize("NFKC");
  const keywords = [...normalized.matchAll(BIRTHDAY_KEYWORD)];
  for (const date of dateOccurrences(normalized)) {
    if (!sameDate(candidate, date.parts)) continue;
    for (const keyword of keywords) {
      const keywordStart = keyword.index ?? 0;
      const keywordEnd = keywordStart + keyword[0].length;
      const between =
        keywordEnd <= date.start
          ? normalized.slice(keywordEnd, date.start)
          : date.end <= keywordStart
            ? normalized.slice(date.end, keywordStart)
            : "";
      const linked =
        (keywordEnd <= date.start && /^(?:\s|是|为|在|[:：]){0,8}$/u.test(between)) ||
        (date.end <= keywordStart && /^(?:\s|是|为|的){0,4}$/u.test(between));
      if (!linked) continue;
      const start = Math.max(0, Math.min(keywordStart, date.start) - 18);
      const end = Math.min(normalized.length, Math.max(keywordEnd, date.end) + 24);
      return { supported: true, evidenceQuote: normalized.slice(start, end).trim() };
    }
  }
  return { supported: false };
}

function supportCloseness(material: string, value: number): SupportResult {
  CLOSENESS_KEYWORD.lastIndex = 0;
  for (const match of material.matchAll(CLOSENESS_KEYWORD)) {
    const keywordIndex = match.index ?? 0;
    const start = Math.max(0, keywordIndex - 12);
    const end = Math.min(material.length, keywordIndex + match[0].length + 20);
    const context = material.slice(start, end);
    if (
      new RegExp(`(?:^|\\D)${value}(?:\\s*[/／]\\s*5|\\s*星|\\s*级)?(?:\\D|$)`).test(context) &&
      !hasNegativeAssociation(context, String(value))
    ) {
      return { supported: true, evidenceQuote: context.trim() };
    }
  }
  return { supported: false };
}

function materialClauses(material: string) {
  return material.match(/[^。！？!?\n；;]+[。！？!?\n；;]?/gu) ?? [material];
}

function materialSentences(material: string) {
  return material.match(/[^。！？!?\n]+[。！？!?\n]?/gu) ?? [material];
}

/** Restrict evidence to a sentence that explicitly names exactly this known person. */
function materialForPerson(material: string, name: string, allNames: string[]) {
  const target = compact(name);
  if (!target || allNames.filter((candidate) => compact(candidate) === target).length !== 1) {
    return "";
  }
  const otherNames = allNames.map(compact).filter((candidate) => candidate && candidate !== target);
  return materialSentences(material)
    .filter((sentence) => {
      const normalized = compact(sentence);
      return (
        normalized.includes(target) &&
        !otherNames.some((other) => normalized.includes(other)) &&
        !hasNegatedSubject(sentence, name)
      );
    })
    .join("");
}

function makeWarning(
  personIndex: number,
  personDraftId: string,
  personName: string,
  field: GroundingWarningField,
  rejectedValue: string,
): GroundingWarning {
  return { personIndex, personDraftId, personName, field, rejectedValue };
}

function setSupportedOrClear(
  person: IngestPerson,
  original: IngestPerson,
  field: SensitivePersonField,
  result: SupportResult,
  grounding: NonNullable<IngestPerson["_fieldGrounding"]>,
  warnings: GroundingWarning[],
  personIndex: number,
  personDraftId: string,
  personName: string,
) {
  const value = person[field];
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
  if (original._fieldGrounding?.[field]?.status === "manual") {
    grounding[field] = { status: "manual" };
    return;
  }
  if (result.supported) {
    grounding[field] = { status: "supported", evidenceQuote: result.evidenceQuote };
    return;
  }
  warnings.push(makeWarning(personIndex, personDraftId, personName, field, String(value)));
  grounding[field] = { status: "unverified" };
}

function listSupport(material: string, values: string[] | undefined, context?: RegExp) {
  const kept: string[] = [];
  const rejected: string[] = [];
  const quotes: string[] = [];
  for (const value of values ?? []) {
    const result = context
      ? supportContextualText(material, value, context, context === DISLIKE_CONTEXT)
      : supportPositiveText(material, value);
    if (result.supported) {
      kept.push(value);
      if (result.evidenceQuote) quotes.push(result.evidenceQuote);
    } else rejected.push(value);
  }
  return { kept, rejected, quote: [...new Set(quotes)].join("；").slice(0, 300) || undefined };
}

function factGrounded(fact: NonNullable<IngestCandidate["facts"]>[number], personMaterial: string) {
  const key = compact(fact.key);
  const value = compact(fact.value);
  if (!key || !value) return false;
  return materialClauses(personMaterial).some((clause) => {
    const normalized = compact(clause);
    const keyIndex = normalized.indexOf(key);
    const valueIndex = normalized.indexOf(value, Math.max(0, keyIndex + key.length));
    if (keyIndex < 0 || valueIndex < 0 || valueIndex - keyIndex - key.length > 24) return false;
    const link = normalized.slice(keyIndex + key.length, valueIndex);
    if (!/(?:是|为|变为|处于|等于|记录为|:|=)|^.{0,2}$/u.test(link)) return false;
    if (hasNegativeAssociation(clause, fact.value)) return false;
    if (fact.validFrom && !supportPositiveText(clause, fact.validFrom).supported) return false;
    if (fact.validTo && !supportPositiveText(clause, fact.validTo).supported) return false;
    return true;
  });
}

function eventGrounded(event: IngestEvent, material: string) {
  const normalizedTitle = compact(event.title ?? "");
  if (!normalizedTitle) return false;
  return materialClauses(material).some((clause) => {
    if (!compact(clause).includes(normalizedTitle) || CLAUSE_NEGATION.test(clause)) return false;
    if (!supportPositiveText(clause, event.title ?? "").supported) return false;
    if (event.detail && !supportPositiveText(clause, event.detail).supported) return false;
    if (event.date && !supportDateAnywhere(clause, event.date).supported) return false;
    if (event.dateEnd && !supportDateAnywhere(clause, event.dateEnd).supported) return false;
    if (event.place && !supportPositiveText(clause, event.place).supported) return false;
    if (event.kind && !supportPositiveText(clause, event.kind).supported) return false;
    if ((event.people ?? []).some((name) => !supportPositiveText(clause, name).supported)) {
      return false;
    }
    return true;
  });
}

/**
 * Keeps AI-provided fields in the review draft, while marking values that cannot
 * be located in a person-scoped part of the current input as unverified. Manual
 * overrides are preserved and remain explicitly marked manual.
 */
export function enforceSensitiveFieldGrounding(
  candidate: IngestCandidate,
  material: string,
): IngestCandidate {
  const warnings: GroundingWarning[] = [...(candidate._groundingWarnings ?? [])];
  const allNames = (candidate.people ?? []).map((person) => person.name?.trim()).filter(Boolean);
  const personContexts = new Map<string, string>();
  const people: IngestPerson[] = [];

  (candidate.people ?? []).forEach((original, personIndex) => {
    const personDraftId = original._draftId ?? crypto.randomUUID();
    const personName = original.name?.trim() || `#${personIndex + 1}`;
    const nameSupport = supportPersonName(material, personName);
    const nameIsManual = original._fieldGrounding?.name?.status === "manual";
    if (!nameSupport.supported && !nameIsManual) {
      warnings.push(makeWarning(personIndex, personDraftId, personName, "name", personName));
    }

    const person = { ...original, _draftId: personDraftId };
    const scopedMaterial = materialForPerson(material, personName, allNames);
    personContexts.set(personName, scopedMaterial);
    const grounding: NonNullable<IngestPerson["_fieldGrounding"]> = {
      name: nameIsManual
        ? { status: "manual" }
        : nameSupport.supported
          ? {
              status: "supported",
              evidenceQuote: nameSupport.evidenceQuote,
            }
          : { status: "unverified" },
    };

    for (const field of EXACT_TEXT_FIELDS) {
      const value = person[field];
      if (typeof value !== "string" || !value.trim()) continue;
      setSupportedOrClear(
        person,
        original,
        field,
        supportFixedField(scopedMaterial, field, value),
        grounding,
        warnings,
        personIndex,
        personDraftId,
        personName,
      );
    }

    if (person.contact) {
      setSupportedOrClear(
        person,
        original,
        "contact",
        supportContact(scopedMaterial, person.contact),
        grounding,
        warnings,
        personIndex,
        personDraftId,
        personName,
      );
    }
    if (person.birthday) {
      setSupportedOrClear(
        person,
        original,
        "birthday",
        supportBirthday(scopedMaterial, person.birthday),
        grounding,
        warnings,
        personIndex,
        personDraftId,
        personName,
      );
    }
    if (person.title) {
      setSupportedOrClear(
        person,
        original,
        "title",
        supportContextualText(scopedMaterial, person.title, TITLE_CONTEXT),
        grounding,
        warnings,
        personIndex,
        personDraftId,
        personName,
      );
    }

    for (const [field, context] of [
      ["projects", PROJECT_CONTEXT],
      ["likes", LIKE_CONTEXT],
      ["dislikes", DISLIKE_CONTEXT],
      ["gifts", GIFT_CONTEXT],
      ["tags", TAG_CONTEXT],
    ] as const) {
      if (original._fieldGrounding?.[field]?.status === "manual") {
        if (person[field]?.length) grounding[field] = { status: "manual" };
        continue;
      }
      const result = listSupport(scopedMaterial, person[field], context);
      result.rejected.forEach((value) =>
        warnings.push(makeWarning(personIndex, personDraftId, personName, field, value)),
      );
      if (person[field]?.length) {
        grounding[field] = result.rejected.length
          ? { status: "unverified" }
          : { status: "supported", evidenceQuote: result.quote };
      }
    }

    if (typeof person.closeness === "number") {
      setSupportedOrClear(
        person,
        original,
        "closeness",
        supportCloseness(scopedMaterial, person.closeness),
        grounding,
        warnings,
        personIndex,
        personDraftId,
        personName,
      );
    }

    if (person.identities?.length) {
      if (original._fieldGrounding?.identities?.status === "manual") {
        grounding.identities = { status: "manual" };
      } else {
        const quotes: string[] = [];
        let hasUnverifiedIdentityValue = false;
        person.identities = person.identities
          .map((identity) => {
            const next = { ...identity };
            const identityMaterial = materialClauses(scopedMaterial)
              .filter(
                (clause) =>
                  supportText(clause, next.platform ?? "").supported &&
                  supportText(clause, next.alias ?? "").supported,
              )
              .join("");
            const checks: Array<[keyof typeof next, SupportResult]> = [
              ["platform", supportPositiveText(identityMaterial, next.platform ?? "")],
              [
                "alias",
                supportLabelBeforeValue(identityMaterial, next.alias ?? "", IDENTITY_ALIAS_CONTEXT),
              ],
              [
                "account",
                next.account
                  ? supportLabelBeforeValue(
                      identityMaterial,
                      next.account,
                      IDENTITY_ACCOUNT_CONTEXT,
                    )
                  : { supported: true },
              ],
              [
                "validFrom",
                next.validFrom
                  ? supportLabelBeforeValue(identityMaterial, next.validFrom, VALID_FROM_CONTEXT)
                  : { supported: true },
              ],
              [
                "validTo",
                next.validTo
                  ? supportLabelBeforeValue(identityMaterial, next.validTo, VALID_TO_CONTEXT)
                  : { supported: true },
              ],
            ];
            for (const [field, result] of checks) {
              const value = next[field];
              if (!value) continue;
              if (result.supported) {
                if (result.evidenceQuote) quotes.push(result.evidenceQuote);
              } else {
                hasUnverifiedIdentityValue = true;
                warnings.push(
                  makeWarning(
                    personIndex,
                    personDraftId,
                    personName,
                    "identities",
                    `${String(field)}: ${value}`,
                  ),
                );
              }
            }
            return next.platform && next.alias ? next : null;
          })
          .filter((identity): identity is NonNullable<typeof identity> => Boolean(identity));
        if (person.identities.length) {
          grounding.identities = {
            status: hasUnverifiedIdentityValue ? "unverified" : "supported",
            evidenceQuote: hasUnverifiedIdentityValue
              ? undefined
              : [...new Set(quotes)].join("；").slice(0, 300) || undefined,
          };
        } else person.identities = undefined;
      }
    }

    person._fieldGrounding = grounding;
    people.push(person);
  });

  const facts = (candidate.facts ?? []).map((fact) => {
    if (fact._audit?.humanEdited) return fact;
    const personIndex = allNames.findIndex((name) => name === fact.person.trim());
    const person = people.find((item) => item.name.trim() === fact.person.trim());
    const context = personContexts.get(fact.person.trim()) ?? "";
    const supported = Boolean(person) && factGrounded(fact, context);
    if (!supported) {
      warnings.push(
        makeWarning(
          Math.max(0, personIndex),
          person?._draftId ?? `fact-${personIndex}-${compact(fact.person)}`,
          fact.person || "#fact",
          "facts",
          `${fact.key}: ${fact.value}`,
        ),
      );
    }
    return fact;
  });

  const uniqueWarnings = [
    ...new Map(
      warnings.map((warning) => [
        `${warning.personDraftId}\u0000${warning.field}\u0000${warning.rejectedValue}`,
        warning,
      ]),
    ).values(),
  ];

  return {
    ...candidate,
    people,
    facts,
    events: (candidate.events ?? []).map((event) => ({
      ...event,
      _groundingVerified: !event._audit?.humanEdited && eventGrounded(event, material),
    })),
    _groundingWarnings: uniqueWarnings,
  };
}

export function markSensitiveFieldsManual(
  person: IngestPerson,
  fields: SensitivePersonField[],
): IngestPerson {
  if (!fields.length) return person;
  const next = { ...(person._fieldGrounding ?? {}) };
  for (const field of fields) next[field] = { status: "manual" };
  return { ...person, _fieldGrounding: next };
}
