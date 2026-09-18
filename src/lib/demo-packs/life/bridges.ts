import type { DemoCrossEventSeed, DemoCrossRelationSeed } from "../types";

/**
 * 跨包桥：让「完整生活库」不是四个孤岛。使用 `<packId>/<key>` 复合键，
 * 仅在载入完整库（all）时由装配器合并；单独载入某个场景时不可见。
 */
export const LIFE_BRIDGE_RELATIONS: DemoCrossRelationSeed[] = [
  {
    from: "campus/lizhe",
    to: "family/chenan",
    predicate: "knows",
    label: "法律讲座认识",
    note: "李哲在校友法律讲座中认识陈安",
  },
  {
    from: "campus/mengxin",
    to: "small_business/yuanye",
    predicate: "collaborates_with",
    label: "公益活动搭档",
    note: "共同组织校友公益日",
  },
  {
    from: "campus/jiangbo",
    to: "small_business/gongming",
    predicate: "collaborates_with",
    label: "技术沙龙搭档",
    note: "共同维护活动报名系统",
  },
  {
    from: "campus/qinyue",
    to: "small_business/kongjia",
    predicate: "collaborates_with",
    label: "纪实摄影搭档",
    note: "共同拍摄校友口述史",
  },
  {
    from: "campus/xieyang",
    to: "workplace/wenyan",
    predicate: "knows",
    label: "创业辅导认识",
    note: "谢扬在创业营中认识温言",
  },
  {
    from: "campus/yufei",
    to: "workplace/yanke",
    predicate: "collaborates_with",
    label: "用户访谈搭档",
    note: "共同完成社群需求调研",
  },
  {
    from: "campus/duanxing",
    to: "small_business/gongming",
    predicate: "collaborates_with",
    label: "航拍技术搭档",
    note: "共同保障校友活动直播",
  },
  {
    from: "workplace/jianghe",
    to: "small_business/gongming",
    predicate: "collaborates_with",
    label: "技术分享搭档",
    note: "共同准备机器学习技术沙龙",
  },
  {
    from: "workplace/weilan",
    to: "family/chenan",
    predicate: "knows",
    label: "可能认识",
    note: "两人曾出现在同一场合名单中，尚未人工确认",
    pending: true,
  },
  {
    from: "workplace/fangying",
    to: "small_business/yuanye",
    predicate: "collaborates_with",
    label: "学术活动搭档",
    note: "共同组织校友学术论坛",
  },
  {
    from: "workplace/zhangchi",
    to: "campus/gaoyuan",
    predicate: "collaborates_with",
    label: "视觉课程搭档",
    note: "共同开设校园影像工作坊",
  },
];

export const LIFE_BRIDGE_EVENTS: DemoCrossEventSeed[] = [
  {
    date: "2026-08-19",
    title: "科研成果路演彩排",
    kind: "其它",
    people: ["campus/xieyang", "workplace/wenyan", "workplace/jianghe", "small_business/yuanye"],
    detail: "试讲推荐算法和隐私边界。",
  },
  {
    date: "2026-08-17",
    title: "志愿者排班会",
    kind: "聚会",
    people: ["campus/mengxin", "campus/wangchen-media", "small_business/yuanye"],
    detail: "确认接待、引导和布展班次。",
  },
  {
    date: "2026-08-15",
    title: "活动报名系统联调",
    kind: "帮忙",
    people: ["campus/jiangbo", "workplace/xujia", "small_business/gongming"],
    detail: "联调报名接口、数据看板与现场签到。",
  },
  {
    date: "2026-08-09",
    title: "校友口述史采访",
    kind: "其它",
    people: [
      "campus/wangchen-media",
      "campus/qinyue",
      "small_business/tanya",
      "small_business/kongjia",
    ],
    detail: "完成第一位校友的采访与纪实拍摄。",
  },
  {
    date: "2026-07-01",
    precision: "month",
    title: "去年暑期项目回访",
    kind: "通话",
    people: ["campus/yufei", "workplace/yanke"],
    detail: "只记得七月，回访参与者对项目的长期感受。",
  },
  {
    date: "2026-04-21",
    title: "校友技术沙龙",
    kind: "聚会",
    people: ["workplace/jianghe", "small_business/gongming", "small_business/xueqi"],
    detail: "分享机器学习项目并认识招聘团队。",
  },
  {
    date: "2025-09-01",
    precision: "month",
    title: "创业营相识",
    kind: "其它",
    people: ["campus/xieyang", "workplace/wenyan", "small_business/yuanye"],
    detail: "秋季创业营期间建立联系。",
  },
  {
    date: "2025-01-01",
    precision: "year",
    title: "开始筹备校园口述史",
    kind: "其它",
    people: ["campus/qinyue", "small_business/tanya", "small_business/kongjia"],
    detail: "只记得发生在 2025 年。",
  },
];
