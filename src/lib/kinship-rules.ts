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
- 事实字段与关系字段分轨处理：联系方式、生日、账号、单位、数值等事实字段只保留材料明确写出的值，绝对不要编造；关系字段允许“原文明说”和“有依据的亲属推导”两类输出。
- 原文明说的关系：basis 写“原文：最短支持片段”，confidence 为 0.9–1。可规范化称谓和方向，但不得改变血亲/姻亲性质。
- 推导关系：仅当材料中每个中间关系都明确出现、且能按下列规则一步推出时输出；basis 必须写“推断依据：…”，note 写“AI 亲属推导，需核验”，confidence 为 0.5–0.75。没有短依据就不要输出。
- “X 的爸爸/妈妈/儿子/女儿/哥哥/姐姐/弟弟/妹妹”等是关系短语。创建被提到的人；未具名时使用不会混淆的上下文称谓，如“爸爸”“爷爷”“大姑的儿子”，并建立短语中明说的父子、母子或兄弟姐妹关系。缺少必要中间人时补建该称谓人物，不要丢掉关系。
- 连续父母/子女两跳可推一个隔代关系：爸爸的爸爸→祖孙，妈妈的妈妈→外祖孙，儿子的女儿→祖孙。祖辈放 from，孙辈放 to；不得造“孙祖”标签。
- 共同父母、同一父亲或同一母亲名下的多个子女，两两建立兄弟/兄妹/姐弟/姐妹。不同母亲注明“同父异母”，不同父亲注明“同母异父”；不能把半血缘写成同母所生。
- 配偶及配偶一侧亲属属于姻亲，可用翁媳、婆媳、岳婿、叔嫂等准确标签，不得写成亲兄弟、亲姐妹等血亲。
- 父亲的兄弟之子女是堂亲；父亲的姐妹之子女是姑表；母亲的兄弟之子女是舅表；母亲的姐妹之子女是姨表。关系链不足时只保留已明确的边，不猜堂/表。
- 规范 label 优先使用：父子、母子、父女、母女、兄弟、兄妹、姐弟、姐妹、夫妻、祖孙、外祖孙、叔侄、姑侄、舅甥、姨甥、堂兄弟、堂兄妹、姑表兄妹、舅表姐弟、姨表姐弟、翁媳、婆媳、岳婿、继姐妹。父母/祖辈放 from，子女/孙辈放 to；夫妻和同辈关系可双向。
- 每条输出关系只允许一个可复核的推导结论。遇到“舅姥爷的表侄”等连续多跳或亲疏不明的链条，不继续推导，留给用户补充。

示例一：材料“贾母有两个儿子贾赦和贾政。贾政的小儿子是贾宝玉。”应包含：
{"from":"贾母","to":"贾赦","label":"母子","basis":"原文：贾母有两个儿子贾赦和贾政","confidence":0.96}
{"from":"贾赦","to":"贾政","label":"兄弟","note":"AI 亲属推导，需核验","basis":"推断依据：同为贾母之子","confidence":0.7}
{"from":"贾母","to":"贾宝玉","label":"祖孙","note":"AI 亲属推导，需核验","basis":"推断依据：贾母是贾政之母，贾政是贾宝玉之父","confidence":0.68}

示例二：材料“我大姑有一个儿子和一个女儿。”应补建“大姑”“大姑的儿子”“大姑的女儿”，保留两条原文明说的母子/母女关系，并输出：
{"from":"大姑的儿子","to":"大姑的女儿","label":"兄妹","note":"AI 亲属推导，需核验","basis":"推断依据：两人同为大姑的子女","confidence":0.7}
`;

export const KINSHIP_RULES_EN = `
- Treat facts and relations separately. Never invent contact details, birthdays, accounts, organisations or numeric facts. Relations may be either explicit or auditable kinship inferences.
- For an explicit relation, basis starts with “Original:”, confidence is 0.9–1. For a derived relation, every intermediate edge must be explicit, basis starts with “Inference basis:”, note says it needs review, and confidence is 0.5–0.75.
- Create people named by relational phrases such as “X's father/mother/son/daughter/sibling”; use an unambiguous contextual placeholder when no name is given.
- Two explicit parent/child edges may yield one grandparent relation. Children sharing a parent may yield sibling relations; distinguish half-siblings. In-laws must never be labelled as blood relatives.
- Distinguish paternal cousins, paternal-aunt cousins, maternal-uncle cousins and maternal-aunt cousins only when the full supporting chain is explicit. Do not continue through long or ambiguous chains.
- Prefer canonical labels and put the parent/grandparent in from and the child/grandchild in to. Every inferred relation requires a short basis and confidence no higher than 0.75.
`;
