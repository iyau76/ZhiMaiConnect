/**
 * 关系方向判定：对等关系（亲戚 / 同事 / 朋友 / 夫妻…）画双箭头，
 * 有明确上下位关系（上下级 / 父子 / 师徒 / 举报…）画单箭头。
 */

const MUTUAL_WORDS = [
  // 中文
  "亲戚", "亲属", "家人", "家属", "夫妻", "配偶", "爱人", "妻", "夫",
  "兄弟", "姐妹", "兄妹", "姐弟", "堂", "表亲", "亲家", "哥们", "哥儿们", "姐妹淘",
  "闺蜜", "死党", "发小", "铁哥们", "情侣", "恋人", "男女朋友", "男朋友", "女朋友",
  "对象", "未婚夫", "未婚妻", "搭伙", "拍档",
  "同事", "同僚", "同班", "同学", "校友", "同乡", "同期", "同组", "同部门",
  "朋友", "好友", "熟人", "认识", "邻居", "室友", "队友", "战友",

  "合作", "伙伴", "搭档", "合伙", "互相", "彼此", "往来", "联系", "通话",
  // English
  "relative", "family", "spouse", "wife", "husband", "sibling", "brother", "sister",
  "cousin", "colleague", "coworker", "co-worker", "classmate", "schoolmate", "alumni",
  "friend", "acquaintance", "neighbor", "neighbour", "roommate", "teammate",
  "partner", "peer", "knows", "mutual", "associate",
];

const DIRECTED_WORDS = [
  "上级", "下级", "上司", "下属", "领导", "主管", "汇报", "管理", "分管", "指挥",
  "父", "母", "子", "女", "儿", "爷", "奶", "外公", "外婆", "长辈", "晚辈",
  "师", "徒", "教", "带", "雇", "聘", "招", "投资", "出资", "转账", "打款",
  "举报", "介绍", "推荐", "供货", "供应", "客户", "甲方", "乙方", "债", "宠物", "主人",

  "boss", "manager", "supervisor", "subordinate", "report", "reports to",
  "father", "mother", "son", "daughter", "parent", "child",
  "mentor", "student", "teacher", "employer", "employee", "hired",
  "paid", "invested", "referred", "introduced", "supplier", "client", "vendor",
];

function longestMatch(text: string, words: string[]) {
  let best = 0;
  for (const word of words) {
    const w = word.toLowerCase();
    if (text.includes(w) && w.length > best) best = w.length;
  }
  return best;
}

/** 未显式指定 mutual 时，按关系词猜方向；对等关系 → true（双箭头）。
 *  取匹配最长的词判断，避免「女朋友」被「女」误判成有方向。 */
export function inferMutual(label: string): boolean {
  const text = (label || "").toLowerCase();
  if (!text) return false;
  const mutual = longestMatch(text, MUTUAL_WORDS);
  const directed = longestMatch(text, DIRECTED_WORDS);
  return mutual > 0 && mutual >= directed;
}


/** 取一条关系的最终方向：显式字段优先，否则按词判断 */
export function isMutualRelation(relation: { label: string; mutual?: boolean }): boolean {
  return relation.mutual ?? inferMutual(relation.label);
}
