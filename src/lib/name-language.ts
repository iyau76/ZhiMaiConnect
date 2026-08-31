import { cleanArchiveText, type ArchiveAgentData } from "./archive-agent-tools";

export type NameLanguageKind = "pronunciation" | "writing" | "meaning" | "translation";

export interface NameLanguageAnswer {
  subject: string;
  kind: NameLanguageKind;
  value: string;
  targetRef?: string;
}

export interface NameLanguageValidationResult {
  ok: boolean;
  error?: string;
  answers: NameLanguageAnswer[];
  rendered?: string;
  pureLanguageRequest: boolean;
}

const KIND_LABELS: Record<NameLanguageKind, string> = {
  pronunciation: "读音",
  writing: "写法",
  meaning: "含义",
  translation: "翻译",
};

const REQUEST_SUFFIXES: Record<NameLanguageKind, RegExp> = {
  pronunciation:
    /^(?<subject>.+?)(?:(?:这个|这几个|的)?(?:名字|姓名|词语|词|字|称呼)的?|的)?(?:怎么读|如何读|怎么念|怎么发音|读音是什么|发音是什么|拼音是什么)$/u,
  writing:
    /^(?<subject>.+?)(?:(?:这个|这几个|的)?(?:名字|姓名|词语|词|字|称呼)的?|的)?(?:怎么写|如何写|写法是什么|写成什么)$/u,
  meaning:
    /^(?<subject>.+?)(?:(?:这个|这几个|的)?(?:名字|姓名|词语|词|字|称呼)的?|的)?(?:是什么意思|有什么含义|是什么含义|含义是什么|意思是什么|寓意是什么)$/u,
  translation:
    /^(?<subject>.+?)(?:(?:这个|这几个|的)?(?:名字|姓名|词语|词|字|称呼)的?|的)?(?:怎么翻译|如何翻译|翻译成什么|(?:用)?(?:英文|英语|中文|汉语)怎么说)$/u,
};

interface NameLanguageRequest {
  subject: string;
  kind: NameLanguageKind;
}

const REQUEST_PREFIX =
  /^(?:(?:请问|请告诉我|告诉我|我想知道|想问一下|想问|麻烦告诉我|麻烦问一下|另外|顺便|再问一下)\s*)+/u;
const NON_TERM_SUBJECT = /^(?:这|那|这样|这么|这样做|这么做|这件事|那件事|他|她|它|你|我|我们)$/u;
const UNSAFE_INLINE_FORMATTING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/[\p{P}\p{Z}\p{Cf}\s]+/gu, "");
}

function parseCandidate(value: unknown): NameLanguageAnswer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const subject = cleanArchiveText(candidate.subject, 80).trim();
  const languageValue = cleanArchiveText(candidate.value, 240).trim();
  const kind = candidate.kind;
  const targetRef = cleanArchiveText(candidate.targetRef, 120).trim() || undefined;
  if (
    !subject ||
    normalized(subject).length > 50 ||
    !languageValue ||
    languageValue.length > 160 ||
    UNSAFE_INLINE_FORMATTING.test(subject) ||
    UNSAFE_INLINE_FORMATTING.test(languageValue) ||
    (targetRef ? UNSAFE_INLINE_FORMATTING.test(targetRef) : false) ||
    !Object.hasOwn(KIND_LABELS, String(kind))
  ) {
    return null;
  }
  return { subject, kind: kind as NameLanguageKind, value: languageValue, targetRef };
}

function questionClauses(question: string) {
  return question
    .split(
      /(?:[\p{Dash_Punctuation}，,。！？!?；;：:/﹐\n]+|\s*(?:另外|顺便|以及|并且|同时|然后|再问(?:一下)?)\s*)/u,
    )
    .map((clause) => clause.trim().replace(REQUEST_PREFIX, "").trim())
    .filter(Boolean);
}

function parseRequestClause(clause: string): NameLanguageRequest | null {
  for (const [kind, pattern] of Object.entries(REQUEST_SUFFIXES) as Array<
    [NameLanguageKind, RegExp]
  >) {
    const match = pattern.exec(clause);
    const subject = match?.groups?.subject?.trim().replace(/^的|的$/gu, "");
    if (
      subject &&
      normalized(subject).length <= 50 &&
      !NON_TERM_SUBJECT.test(normalized(subject)) &&
      !UNSAFE_INLINE_FORMATTING.test(subject)
    ) {
      return { subject, kind };
    }
  }
  return null;
}

function subjectConflictsWithArchiveName(subject: string, people: ArchiveAgentData["persons"]) {
  const candidate = normalized(subject);
  return people.some((person) => {
    const name = normalized(person.name);
    return name && candidate.includes(name) && candidate !== name;
  });
}

function expandRequestSubjects(request: NameLanguageRequest, people: ArchiveAgentData["persons"]) {
  const wholeSubject = normalized(request.subject);
  if (people.some((person) => normalized(person.name) === wholeSubject)) return [request];
  const parts = request.subject
    .split(/[、和与及]/u)
    .map((subject) => subject.trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    return subjectConflictsWithArchiveName(request.subject, people) ? [] : [request];
  }
  const containsArchiveName = people.some((person) =>
    wholeSubject.includes(normalized(person.name)),
  );
  const everyPartIsArchivePerson = parts.every((part) =>
    people.some((person) => normalized(person.name) === normalized(part)),
  );
  if (everyPartIsArchivePerson) {
    return parts.map((subject) => ({ subject, kind: request.kind }));
  }
  return containsArchiveName ? [] : [request];
}

function requestedLanguagePairs(question: string, people: ArchiveAgentData["persons"] = []) {
  const clauses = questionClauses(question);
  let parsedClauseCount = 0;
  const requests = clauses.flatMap((clause) => {
    const request = parseRequestClause(clause);
    if (!request) return [];
    const expanded = expandRequestSubjects(request, people);
    if (expanded.length) parsedClauseCount += 1;
    return expanded;
  });
  return {
    requests,
    pure: requests.length > 0 && parsedClauseCount === clauses.length,
  };
}

function pairKey(value: Pick<NameLanguageAnswer, "subject" | "kind">) {
  return `${normalized(value.subject)}\u0000${value.kind}`;
}

export function questionHasNameLanguageIntent(
  question: string,
  people: ArchiveAgentData["persons"] = [],
) {
  if (requestedLanguagePairs(question, people).requests.length > 0) return true;
  return (
    people.some((person) => normalized(question).includes(normalized(person.name))) &&
    /(?:怎么读|如何读|怎么念|怎么发音|怎么写|如何写|是什么意思|有什么含义|怎么翻译|如何翻译|怎么说)/u.test(
      question,
    )
  );
}

function renderAnswers(answers: NameLanguageAnswer[]) {
  const rows = answers.map((answer) => {
    const target = answer.targetRef ? `${answer.subject}（${answer.targetRef}）` : answer.subject;
    return `对象：${target}\n${KIND_LABELS[answer.kind]}：${answer.value}`;
  });
  return `AI 语言说明（模型生成，未写入档案）\n${rows.join("\n\n")}\n请自行核对读音、写法或释义。`;
}

/**
 * Language output is a separate provenance channel. We bind its subject and
 * optional archive target to the question, then render it under a fixed local
 * "model generated" heading. We intentionally do not pretend that character
 * allowlists can prove a pronunciation or gloss is semantically true.
 */
export function validateNameLanguageAnswers(options: {
  question: string;
  languageAnswers: unknown;
  freeAnswer?: unknown;
  archive: ArchiveAgentData;
  includeArchive: boolean;
}): NameLanguageValidationResult {
  const raw = Array.isArray(options.languageAnswers) ? options.languageAnswers.slice(0, 4) : [];
  const people = options.includeArchive ? options.archive.persons : [];
  const requested = requestedLanguagePairs(options.question, people);
  if (!raw.length) return { ok: true, answers: [], pureLanguageRequest: requested.pure };
  if (cleanArchiveText(options.freeAnswer, 8_000).trim()) {
    return {
      ok: false,
      error: "存在 languageAnswers 时，answer 必须为空，语言说明只能出现在固定命名空间",
      answers: [],
      pureLanguageRequest: requested.pure,
    };
  }
  const answers: NameLanguageAnswer[] = [];
  const expectedPairs = new Set(requested.requests.map(pairKey));
  const answeredPairs = new Set<string>();

  for (const item of raw) {
    const answer = parseCandidate(item);
    if (!answer) {
      return {
        ok: false,
        error: "languageAnswers 的字段、类型或单行格式无效",
        answers: [],
        pureLanguageRequest: requested.pure,
      };
    }
    const answerPair = pairKey(answer);
    if (!expectedPairs.has(answerPair) || answeredPairs.has(answerPair)) {
      return {
        ok: false,
        error: "languageAnswers 的 subject 与 kind 必须共同匹配同一条明确语言请求",
        answers: [],
        pureLanguageRequest: requested.pure,
      };
    }
    answeredPairs.add(answerPair);
    const subject = normalized(answer.subject);

    const matchingPeople = people.filter((person) => normalized(person.name) === subject);
    if (matchingPeople.length) {
      const matchingRefs = new Set(matchingPeople.map((person) => `person:${person.id}`));
      if (!answer.targetRef || !matchingRefs.has(answer.targetRef)) {
        return {
          ok: false,
          error: "语言说明命中档案人物时，targetRef 必须绑定该人物的稳定 ID",
          answers: [],
          pureLanguageRequest: requested.pure,
        };
      }
    } else if (answer.targetRef) {
      return {
        ok: false,
        error: "通用语言说明不得绑定不存在或不匹配的档案人物",
        answers: [],
        pureLanguageRequest: requested.pure,
      };
    }
    answers.push(answer);
  }

  if (answeredPairs.size !== expectedPairs.size) {
    return {
      ok: false,
      error: "languageAnswers 必须逐项覆盖问题中的全部语言请求",
      answers: [],
      pureLanguageRequest: requested.pure,
    };
  }

  return {
    ok: true,
    answers,
    rendered: renderAnswers(answers),
    pureLanguageRequest: requested.pure,
  };
}
