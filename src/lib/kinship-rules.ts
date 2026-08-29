/** 亲属关系推导的提示词与审计边界。 */

const INFERRED_BASIS = /^推断依据\s*[:：]|^inference\s+basis\s*[:：]/i;

export function isInferredRelationBasis(basis?: string) {
  return INFERRED_BASIS.test(basis?.trim() ?? "");
}

export function relationNeedsInferenceReview(input: {
  basis?: string;
  note?: string;
  confidence?: number;
}) {
  return (
    isInferredRelationBasis(input.basis) ||
    /推断|推导|inference|derived/i.test(input.note ?? "") ||
    (typeof input.confidence === "number" && input.confidence <= 0.75)
  );
}

/** 推导关系漏填置信度时给保守默认值，填得过高时在解析边界压到 0.75。 */
export function normalizeRelationConfidence(basis?: string, confidence?: number) {
  if (!isInferredRelationBasis(basis)) return confidence;
  return Math.min(confidence ?? 0.7, 0.75);
}

export const KINSHIP_RULES_ZH = `
- 模型只负责抽取材料明确表达的实体和关系断言，不负责推导兄弟姐妹、祖孙、叔侄、堂表亲或姻亲。所有传递推导由提交后的本地规则引擎在稳定人物 ID 上统一重建。
- 每条关系的 basis 必须写“原文：最短支持片段”，confidence 通常为 0.9–1。禁止输出以“推断依据：”开头的关系，也不要把常识补全成原文事实。
- “X 的爸爸/妈妈/儿子/女儿/哥哥/姐姐/弟弟/妹妹”等关系短语本身就是材料明说的断言：建立短语直接表达的那一条边。未具名人物使用带上下文的称谓，如“大姑的儿子”，不要把不同材料里的“爸爸”当成同一人。
- 逐句建立“原文 claim → 关系任务”的一一对应：并列人物逐个展开；“他们的儿子/女儿”同时建立两位明确父母到该子女的直接断言；妾、正妻、丈夫、妻子本身就是配偶断言。不能因为同一人物已在另一条边出现而跳过本句。
- 中文并列分句会省略主语：如“A 的正妻 B……；妾 C……”中的“妾 C”仍承接 A，必须建立 A↔C 的妾关系；不要只抽取 C 与子女。
- 每条关系必须是两个端点之间的原子关系。“B、C 是 A 的继母的女儿”不能直接写成 A→B“继母的女儿”；应建立带上下文的未具名继母实体再连接，无法可靠拆分时保留人物与原文，不制造多跳关系边。
- 亲属称谓明确表达性别时，把这个实体的 gender 同步写为男/女（如儿子、父亲、丈夫为男，女儿、母亲、妻子、妾为女）。最终 parentRole/childRole 由本地编译器结合人物字段确定，不能只靠 label 猜测。
- 父母/祖辈放 from，子女/孙辈放 to；夫妻和同辈关系任选材料自然顺序。未写长幼时用“兄弟姐妹”等中性标签，不猜哥哥/弟弟。
- 只保留材料明确写出的血亲、姻亲、同事、同学、合作、暗恋等关系，不从共同出现、共同单位或同一事件继续猜朋友/伙伴。
- label 保留用户语义，如“前同事”“大学室友”“暗恋”；不要为了套少量枚举而损失“前任、方向、堂表分支”等信息。语义谓词和角色限定由本地关系本体统一生成。

示例：材料“贾母有两个儿子贾赦和贾政。贾政的小儿子是贾宝玉。”只输出三条原文明说的父母子女断言：贾母→贾赦、贾母→贾政、贾政→贾宝玉。不要输出贾赦↔贾政或贾母→贾宝玉；它们会由本地规则投影产生。
`;

export const KINSHIP_RULES_EN = `
- The model extracts only entities and relationship assertions explicitly stated by the material. It must not derive siblings, grandparents, cousins or in-laws. A deterministic local rule engine rebuilds those projections after entity resolution.
- Every relationship basis starts with “Original:” and quotes the shortest supporting passage. Do not output “Inference basis:” relationships or complete facts from common knowledge.
- Relational phrases such as “X's father/mother/son/daughter/sibling” directly state one edge. Create a context-scoped placeholder when unnamed; do not merge every person called “father”.
- Expand coordinated clauses one assertion at a time. “Their son/daughter” creates one explicit parent assertion from each named parent; wife, husband and concubine are explicit spouse assertions. Kinship nouns also populate explicit entity gender so the local compiler, not display wording, fixes parent/child roles.
- Put a parent before a child. Preserve meaningful labels such as former colleague, college roommate or has a crush on; the local ontology supplies stable predicates and qualifiers.
`;
