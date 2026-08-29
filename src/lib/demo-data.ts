import {
  facesDb,
  type CollectionMembershipRecord,
  type CollectionRecord,
  type LifeEventRecord,
  type PersonRecord,
  type RelationAssertionRecord,
  type ReminderRecord,
} from "./face-db";
import type { Provenance } from "./provenance";
import type { RelationPredicate, RelationQualifiers } from "./relation-ontology";

const DEMO_PREFIX = "demo-zhimai-";
const DEMO_AT = new Date(2026, 7, 20, 10).getTime();
const demoSource: Provenance = { kind: "manual", detail: "合成演示数据", at: DEMO_AT };

type Seed = [
  name: string,
  collection: string,
  relation: string,
  title: string,
  skill: string,
  closeness: number,
];

const SEEDS: Seed[] = [
  ["林慧", "家人", "姐姐", "中学教师", "语文写作", 5],
  ["陈安", "家人", "表哥", "律师", "合同审阅", 4],
  ["许兰", "家人", "小姨", "社区医生", "健康咨询", 4],
  ["赵宇", "家人", "堂弟", "前端工程师", "网站开发", 4],
  ["苏琴", "家人", "母亲", "退休会计", "预算管理", 5],
  ["顾川", "亲戚", "表弟", "研究生", "数据分析", 3],
  ["沈芳", "亲戚", "舅妈", "烘焙店主", "活动茶歇", 3],
  ["陆鸣", "亲戚", "舅舅", "建筑师", "空间设计", 3],
  ["何静", "亲戚", "表姐", "人力资源经理", "招聘面试", 4],
  ["方睿", "亲戚", "堂哥", "产品经理", "需求梳理", 3],
  ["唐悦", "大学同学", "大学摄影社搭档", "活动摄影师", "摄影与短视频", 5],
  ["周宁", "大学同学", "大学室友", "品牌设计师", "海报与视觉设计", 5],
  ["王晨", "大学同学", "学生会同事", "校园媒体编辑", "文案宣传", 4],
  ["李哲", "大学同学", "辩论队队友", "法学院学生", "主持与表达", 4],
  ["孟欣", "大学同学", "志愿活动搭档", "社团负责人", "活动组织", 3],
  ["蒋博", "大学同学", "课程队友", "后端工程师", "接口开发", 3],
  ["秦月", "大学同学", "校报记者", "新闻摄影记者", "采访摄影", 5],
  ["韩松", "大学同学", "篮球队友", "体育部部长", "场地协调", 3],
  ["罗佳", "大学同学", "班长", "行政助理", "流程与物资", 4],
  ["谢扬", "大学同学", "创业赛队友", "创业者", "赞助洽谈", 3],
  ["于菲", "大学同学", "前室友", "用户研究员", "访谈研究", 4],
  ["王晨", "大学同学", "同名校友", "音乐社成员", "现场音响", 2],
  ["江禾", "科研", "实验室同门", "博士生", "机器学习", 4],
  ["夏知", "科研", "课题组同门", "数据工程师", "数据清洗", 4],
  ["魏岚", "科研", "合作课题成员", "统计师", "统计分析", 3],
  ["邱然", "科研", "导师助理", "科研秘书", "会议协调", 3],
  ["宋清", "科研", "论文合作者", "英文编辑", "学术写作", 4],
  ["杜衡", "科研", "开源项目搭档", "算法工程师", "模型评测", 3],
  ["严可", "科研", "访学认识", "交互研究员", "可用性测试", 3],
  ["白璐", "科研", "会议志愿者", "会务负责人", "学术活动组织", 3],
  ["温言", "科研", "校友导师", "投资经理", "创业辅导", 2],
  ["章驰", "科研", "课程助教", "讲师", "技术教学", 3],
  ["叶青", "摄影社", "摄影社社长", "人像摄影师", "人像摄影", 5],
  ["程诺", "摄影社", "后期搭档", "视频剪辑师", "剪辑调色", 4],
  ["乔木", "摄影社", "器材管理员", "器材租赁顾问", "相机灯光", 3],
  ["段星", "摄影社", "活动搭档", "无人机飞手", "航拍", 3],
  ["米雪", "摄影社", "模特朋友", "造型师", "妆造搭配", 3],
  ["高远", "摄影社", "社团指导老师", "艺术教师", "视觉策划", 3],
  ["范雨", "摄影社", "展览搭档", "策展助理", "展览执行", 3],
  ["金澄", "摄影社", "音乐节认识", "现场导演", "舞台统筹", 2],
  ["石磊", "摄影社", "器材群认识", "灯光师", "舞台灯光", 2],
  ["姚桃", "摄影社", "短片搭档", "编剧", "故事策划", 3],
  ["袁野", "校友社群", "校友会负责人", "社群运营", "校友活动", 4],
  ["冯帆", "校友社群", "公益活动搭档", "公益项目经理", "志愿者协调", 3],
  ["毛欣", "校友社群", "创业营同学", "市场经理", "品牌传播", 3],
  ["谭雅", "校友社群", "读书会朋友", "出版编辑", "内容策划", 3],
  ["龚明", "校友社群", "技术沙龙认识", "云平台工程师", "现场技术保障", 2],
  ["薛琪", "校友社群", "招聘会认识", "校园招聘经理", "招聘资源", 3],
  ["廖星", "校友社群", "主持人朋友", "播客主播", "主持采访", 3],
  ["孔嘉", "校友社群", "长期志愿者", "摄影志愿者", "纪实摄影", 3],
];

const PERSON_GENDERS: Partial<Record<number, "男" | "女">> = {
  0: "女",
  1: "男",
  2: "女",
  3: "男",
  4: "女",
  5: "男",
  6: "女",
  7: "男",
  8: "女",
  9: "男",
};

function demoPeople(): PersonRecord[] {
  return SEEDS.map(([name, collection, relation, title, skill, closeness], index) => ({
    id: `${DEMO_PREFIX}person-${String(index + 1).padStart(2, "0")}`,
    name,
    note: `合成角色：${relation}，可协助${skill}。`,
    profile: {
      gender: PERSON_GENDERS[index],
      relation,
      title,
      org: collection === "科研" ? "知行实验室（模拟）" : `${collection}示范圈`,
      likes: [skill],
      projects: index === 10 || index % 4 === 0 ? ["校园记忆展（模拟）"] : undefined,
      contact:
        index === 10
          ? "demo11@example.invalid"
          : index % 5 === 0
            ? undefined
            : `demo${index + 1}@example.invalid`,
      closeness,
      birthday: `${String((index % 12) + 1).padStart(2, "0")}-${String(((index * 3) % 27) + 1).padStart(2, "0")}`,
      identities:
        index === 10
          ? [
              {
                platform: "大学摄影社（模拟）",
                account: "photo-tang-demo",
                alias: "糖糖",
                validFrom: "2022-09",
                validTo: "2024-06",
                source: demoSource,
              },
              {
                platform: "当前称呼",
                alias: "唐悦",
                validFrom: "2024-07",
                source: demoSource,
              },
            ]
          : undefined,
    },
    rawProfileText: "本条为竞赛合成演示资料，不对应真实个人。",
    descriptors: [],
    thumb: "",
    createdAt: DEMO_AT - index * 36_000,
    updatedAt: index === 10 ? DEMO_AT + 1_000 : undefined,
    source:
      index === 30
        ? { kind: "ai", detail: "合成演示中的低置信度资料，待复核", at: DEMO_AT }
        : demoSource,
  }));
}

function demoCollections(people: PersonRecord[]) {
  const names = [...new Set(SEEDS.map(([, collection]) => collection))];
  const collections: CollectionRecord[] = names.map((name, index) => ({
    id: `${DEMO_PREFIX}collection-${String(index + 1).padStart(2, "0")}`,
    name,
    kind: name === "家人" || name === "亲戚" ? "relationship_circle" : "context",
    createdAt: DEMO_AT,
    updatedAt: DEMO_AT,
  }));
  const collectionByName = new Map(collections.map((collection) => [collection.name, collection]));
  const memberships: CollectionMembershipRecord[] = people.map((person, index) => {
    const collectionName = SEEDS[index][1];
    const collection = collectionByName.get(collectionName);
    if (!collection) throw new Error(`演示集合不存在：${collectionName}`);
    return {
      id: `${collection.id}\u0000${person.id}`,
      collectionId: collection.id,
      personId: person.id,
      source: "manual",
      createdAt: DEMO_AT,
    };
  });
  return { collections, memberships };
}

function demoRelations(people: PersonRecord[]): RelationAssertionRecord[] {
  type RelationSeed = {
    from: number;
    to: number;
    predicate: RelationPredicate;
    label: string;
    note: string;
    qualifiers?: RelationQualifiers;
    validity?: RelationAssertionRecord["validity"];
    pending?: boolean;
  };

  const relation = (
    from: number,
    to: number,
    predicate: RelationPredicate,
    label: string,
    note: string,
    qualifiers?: RelationQualifiers,
  ): RelationSeed => ({ from, to, predicate, label, note, qualifiers });

  const seeds: RelationSeed[] = [
    // 家庭与亲属：使用规范亲属谓词，供亲属投影、称谓和路径功能演示。
    relation(4, 0, "parent_of", "母女", "苏琴是林慧的母亲", {
      parentRole: "mother",
      childRole: "daughter",
      lineage: "blood",
    }),
    relation(4, 7, "sibling_of", "姐弟", "苏琴与陆鸣是姐弟", { lineage: "blood" }),
    relation(7, 6, "spouse_of", "夫妻", "陆鸣与沈芳是夫妻", {
      partnerRole: "husband",
      lineage: "marriage",
    }),
    relation(7, 5, "parent_of", "父子", "陆鸣是顾川的父亲", {
      parentRole: "father",
      childRole: "son",
      lineage: "blood",
    }),
    relation(6, 5, "parent_of", "母子", "沈芳是顾川的母亲", {
      parentRole: "mother",
      childRole: "son",
      lineage: "blood",
    }),
    relation(4, 2, "sibling_of", "姐妹", "苏琴与许兰是姐妹", { lineage: "blood" }),
    relation(2, 8, "parent_of", "母女", "许兰是何静的母亲", {
      parentRole: "mother",
      childRole: "daughter",
      lineage: "blood",
    }),
    relation(0, 5, "cousin_of", "表姐弟", "林慧与顾川是表姐弟", {
      cousinBranch: "maternal_uncle",
      inverseCousinBranch: "paternal_aunt",
      lineage: "blood",
    }),
    relation(0, 8, "cousin_of", "表姐妹", "林慧与何静是表姐妹", {
      cousinBranch: "maternal_aunt",
      inverseCousinBranch: "maternal_aunt",
      lineage: "blood",
    }),
    relation(0, 1, "cousin_of", "表兄妹", "林慧与陈安是表兄妹", {
      cousinBranch: "unspecified",
      inverseCousinBranch: "unspecified",
      lineage: "blood",
    }),
    relation(0, 3, "cousin_of", "堂姐弟", "林慧与赵宇是堂姐弟", {
      cousinBranch: "paternal_uncle",
      inverseCousinBranch: "paternal_uncle",
      lineage: "blood",
    }),
    relation(0, 9, "cousin_of", "堂兄妹", "林慧与方睿是堂兄妹", {
      cousinBranch: "paternal_uncle",
      inverseCousinBranch: "paternal_uncle",
      lineage: "blood",
    }),

    // 大学经历：既有同学、室友，也有共同项目和持续至今的朋友关系。
    {
      ...relation(10, 11, "roommate_of", "前室友", "大二至大四住在同一间宿舍", {
        temporalStatus: "former",
        validFrom: "2021-09",
        validTo: "2023-06",
      }),
      validity: { status: "ended", validFrom: "2021-09", validTo: "2023-06" },
    },
    relation(10, 12, "classmate_of", "大学同学", "同修新闻摄影课程"),
    relation(10, 13, "classmate_of", "大学同学", "同属 2020 级公共选修班"),
    relation(10, 14, "collaborates_with", "志愿活动搭档", "共同组织迎新志愿活动"),
    relation(11, 12, "classmate_of", "大学同学", "同修品牌传播课程"),
    relation(11, 15, "collaborates_with", "课程项目搭档", "共同完成校园导览小程序"),
    relation(12, 16, "colleague_of", "校媒同事", "共同参与校报选题和采编"),
    relation(13, 14, "friend_of", "辩论赛朋友", "在校级辩论赛中相识并保持联系"),
    relation(14, 18, "collaborates_with", "活动组织搭档", "共同负责毕业季活动"),
    relation(15, 17, "classmate_of", "大学同学", "同修软件工程课程"),
    relation(16, 20, "friend_of", "采访搭档", "共同完成校友口述史采访"),
    relation(17, 19, "collaborates_with", "创业赛队友", "共同参加大学生创业赛"),
    relation(18, 20, "classmate_of", "大学同学", "同属社会调查课程小组"),
    relation(19, 21, "knows", "音乐节认识", "在校园音乐节后台相识"),
    relation(10, 21, "classmate_of", "摄影选修课同学", "用于演示两个同名王晨的消歧"),

    // 科研合作网。
    relation(22, 23, "colleague_of", "实验室同门", "同属知行实验室数据组"),
    relation(22, 24, "collaborates_with", "论文合作者", "共同完成关系推荐评测"),
    relation(23, 25, "colleague_of", "课题组同事", "共同维护课题数据与会议安排"),
    relation(24, 26, "collaborates_with", "论文合作者", "负责统计分析与英文修订"),
    relation(25, 31, "reports_to", "项目汇报", "邱然负责向课程讲师章驰汇报项目进度"),
    relation(26, 27, "collaborates_with", "开源项目搭档", "共同维护模型评测工具"),
    relation(27, 28, "collaborates_with", "用户研究搭档", "共同开展原型可用性测试"),
    relation(28, 29, "knows", "学术会议认识", "在交互设计年会上相识"),
    relation(29, 30, "collaborates_with", "创业辅导搭档", "共同组织科研成果路演"),
    relation(30, 31, "knows", "校友导师与助教", "在创业课程中相识"),
    relation(22, 27, "collaborates_with", "算法评测搭档", "共同设计离线评测集"),
    relation(23, 26, "collaborates_with", "数据写作搭档", "共同整理实验数据和论文附录"),

    // 摄影社协作网。
    relation(32, 34, "manages", "社长与器材管理员", "叶青负责摄影社，乔木管理器材"),
    relation(33, 32, "collaborates_with", "后期搭档", "长期合作完成社团活动视频"),
    relation(35, 32, "collaborates_with", "航拍搭档", "共同完成校园航拍项目"),
    relation(36, 32, "friend_of", "模特朋友", "在人像创作中相识并保持联系"),
    relation(37, 32, "collaborates_with", "社团指导搭档", "共同策划摄影社年度展览"),
    relation(38, 33, "collaborates_with", "展览后期搭档", "共同完成展览影像剪辑"),
    relation(39, 35, "collaborates_with", "音乐节拍摄搭档", "共同负责航拍和现场机位"),
    relation(40, 34, "collaborates_with", "灯光器材搭档", "共同维护舞台灯光器材"),
    relation(41, 33, "collaborates_with", "短片搭档", "共同完成社团招新短片"),
    relation(32, 39, "collaborates_with", "现场拍摄搭档", "共同负责音乐节主舞台影像"),
    relation(33, 40, "collaborates_with", "剪辑灯光搭档", "共同完成舞台演出纪录片"),
    relation(34, 38, "collaborates_with", "布展搭档", "共同负责展览器材和布展"),

    // 校友社群协作网。
    relation(42, 43, "collaborates_with", "公益活动搭档", "共同组织校友公益日"),
    relation(42, 44, "collaborates_with", "校友传播搭档", "共同负责校友活动宣传"),
    relation(42, 45, "friend_of", "读书会朋友", "校友读书会固定成员"),
    relation(42, 46, "collaborates_with", "技术沙龙搭档", "共同组织校友技术沙龙"),
    relation(43, 49, "collaborates_with", "志愿活动搭档", "长期参加同一公益影像项目"),
    relation(44, 47, "collaborates_with", "招聘传播搭档", "共同筹办校友招聘会"),
    relation(45, 48, "collaborates_with", "读书会主持搭档", "共同策划读书会访谈"),
    relation(46, 47, "collaborates_with", "招聘会技术搭档", "共同保障线上招聘会"),
    relation(47, 48, "friend_of", "主持人朋友", "在校友论坛主持工作中相识"),
    relation(48, 49, "collaborates_with", "播客摄影搭档", "共同录制校友人物播客"),

    // 跨圈路径：使“这事该拜托谁”能够展示真实的一跳/多跳候选，而非孤岛。
    relation(10, 32, "collaborates_with", "校园记忆展搭档", "唐悦与叶青共同负责主视觉摄影"),
    relation(10, 33, "collaborates_with", "影像制作搭档", "唐悦负责拍摄，程诺负责剪辑"),
    relation(10, 38, "collaborates_with", "展览执行搭档", "共同完成校园记忆展布展"),
    relation(11, 38, "collaborates_with", "展板设计搭档", "周宁与范雨共同设计展板"),
    relation(12, 45, "collaborates_with", "校友采访搭档", "共同完成校友人物专访"),
    relation(13, 1, "knows", "法律讲座认识", "李哲在校友法律讲座中认识陈安"),
    relation(14, 43, "collaborates_with", "公益活动搭档", "共同组织校友公益日"),
    relation(15, 46, "collaborates_with", "技术沙龙搭档", "共同维护活动报名系统"),
    relation(16, 49, "collaborates_with", "纪实摄影搭档", "共同拍摄校友口述史"),
    relation(17, 42, "knows", "创业营认识", "韩松通过创业营认识袁野"),
    relation(18, 25, "collaborates_with", "会务协调搭档", "共同组织校园研究论坛"),
    relation(19, 30, "knows", "创业辅导认识", "谢扬在创业营中认识温言"),
    relation(20, 28, "collaborates_with", "用户访谈搭档", "共同完成社群需求调研"),
    relation(22, 46, "collaborates_with", "技术分享搭档", "共同准备机器学习技术沙龙"),
    relation(23, 15, "collaborates_with", "数据接口搭档", "共同搭建活动数据看板"),
    {
      ...relation(24, 1, "knows", "可能认识", "两人曾出现在同一场合名单中，尚未人工确认"),
      pending: true,
    },
    relation(29, 42, "collaborates_with", "学术活动搭档", "共同组织校友学术论坛"),
    relation(31, 37, "collaborates_with", "视觉课程搭档", "共同开设校园影像工作坊"),
    relation(35, 46, "collaborates_with", "航拍技术搭档", "共同保障校友活动直播"),
  ];

  if (seeds.length !== 80) {
    throw new Error(`合成演示关系应为 80 条，当前为 ${seeds.length} 条`);
  }

  return seeds.map((seed, index) => {
    const at = DEMO_AT - index * 60_000;
    const pending = seed.pending === true;
    return {
      id: `${DEMO_PREFIX}relation-${String(index + 1).padStart(2, "0")}`,
      recordType: "assertion",
      fromId: people[seed.from].id,
      toId: people[seed.to].id,
      predicate: seed.predicate,
      qualifiers: { temporalStatus: "current", ...seed.qualifiers },
      label: seed.label,
      direction: "ontology",
      note: seed.note,
      evidence: {
        mode: pending ? "source_claim" : "manual",
        basis: pending ? `推断依据：${seed.note}` : `合成演示设定：${seed.note}`,
        sourceIds: [],
      },
      validity: seed.validity ?? { status: "active" },
      createdAt: at,
      updatedAt: at,
      confirmationStatus: pending ? "pending" : "confirmed",
      confidence: pending ? 0.62 : 0.96,
      source: pending ? { kind: "ai", detail: "合成低置信度关系", at } : demoSource,
    } satisfies RelationAssertionRecord;
  });
}

function demoEvents(people: PersonRecord[]): LifeEventRecord[] {
  type EventSeed = Omit<LifeEventRecord, "id" | "personIds" | "createdAt" | "source"> & {
    people: number[];
  };
  const seeds: EventSeed[] = [
    {
      date: "2026-08-05",
      title: "校园记忆展第一次策划会",
      kind: "聚会",
      people: [10, 11, 32, 38],
      detail: "确定人物采访、摄影和展板分工。",
    },
    {
      date: "2026-08-07",
      title: "展览场地踩点",
      kind: "帮忙",
      people: [10, 32, 34, 35],
      place: "大学生活动中心",
      detail: "确认机位、灯光、电源和器材动线。",
    },
    {
      date: "2026-08-09",
      title: "校友口述史采访",
      kind: "其它",
      people: [12, 16, 45, 49],
      detail: "完成第一位校友的采访与纪实拍摄。",
    },
    {
      date: "2026-08-11",
      title: "展板视觉评审",
      kind: "聚会",
      people: [11, 38, 44],
      detail: "评审主视觉、字体和照片选择。",
    },
    {
      date: "2026-08-13",
      title: "完成人物肖像试拍",
      kind: "帮忙",
      people: [10, 32, 36],
      detail: "完成三组光线方案并选定正式拍摄风格。",
    },
    {
      date: "2026-08-15",
      title: "活动报名系统联调",
      kind: "帮忙",
      people: [15, 23, 46],
      detail: "联调报名接口、数据看板与现场签到。",
    },
    {
      date: "2026-08-17",
      title: "志愿者排班会",
      kind: "聚会",
      people: [14, 18, 43],
      detail: "确认接待、引导和布展班次。",
    },
    {
      date: "2026-08-19",
      title: "科研成果路演彩排",
      kind: "其它",
      people: [22, 29, 30, 42],
      detail: "试讲推荐算法和隐私边界。",
    },
    {
      date: "2026-08-21",
      title: "音乐节影像复盘",
      kind: "聚会",
      people: [33, 35, 39, 40],
      detail: "复盘航拍、现场机位、灯光与后期交付。",
    },
    {
      date: "2026-08-23",
      title: "读书会人物访谈",
      kind: "其它",
      people: [42, 45, 48],
      detail: "围绕校友职业转型录制一期播客。",
    },
    {
      date: "2026-08-25",
      title: "家庭生日聚餐",
      kind: "聚会",
      people: [0, 2, 4, 7],
      place: "家中",
      detail: "为苏琴提前庆祝生日。",
    },
    {
      date: "2026-08-27",
      title: "最终布展",
      kind: "帮忙",
      people: [10, 11, 32, 33, 34, 38],
      detail: "完成展板、投影、灯光和播放设备安装。",
    },
    {
      date: "2026-07-01",
      precision: "month",
      title: "去年暑期项目回访",
      kind: "通话",
      people: [20, 28],
      detail: "只记得七月，回访参与者对项目的长期感受。",
    },
    {
      date: "2026-05-01",
      precision: "month",
      title: "公益影像项目启动",
      kind: "聚会",
      people: [43, 49],
      detail: "五月启动，具体日期未记录。",
    },
    {
      date: "2025-09-01",
      precision: "month",
      title: "创业营相识",
      kind: "其它",
      people: [19, 30, 42],
      detail: "秋季创业营期间建立联系。",
    },
    {
      date: "2025-06-12",
      title: "毕业季合影",
      kind: "聚会",
      people: [10, 11, 12, 13, 14],
      detail: "在教学楼前拍摄毕业合影。",
    },
    {
      date: "2025-03-18",
      title: "论文数据复核",
      kind: "帮忙",
      people: [22, 23, 24, 26],
      detail: "共同复核数据清洗和统计口径。",
    },
    {
      date: "2025-01-01",
      precision: "year",
      title: "开始筹备校园口述史",
      kind: "其它",
      people: [16, 45, 49],
      detail: "只记得发生在 2025 年。",
    },
    {
      date: "2024-10-03",
      title: "摄影社秋季外拍",
      kind: "聚会",
      people: [32, 33, 34, 35, 36],
      place: "滨江公园",
      detail: "完成社团新人第一次集体外拍。",
    },
    {
      date: "2024-07-15",
      dateEnd: "2024-08-20",
      precision: "range",
      title: "暑期志愿服务",
      kind: "帮忙",
      people: [14, 18, 43],
      detail: "持续一个多月的社区暑期志愿服务。",
    },
    {
      date: "2024-04-21",
      title: "校友技术沙龙",
      kind: "聚会",
      people: [22, 46, 47],
      detail: "分享机器学习项目并认识招聘团队。",
    },
    {
      date: "2023-11-08",
      title: "创业赛决赛",
      kind: "其它",
      people: [17, 19],
      detail: "共同完成路演并获得校级奖项。",
    },
    {
      date: "2023-06-01",
      precision: "month",
      title: "室友搬离宿舍",
      kind: "其它",
      people: [10, 11],
      detail: "毕业前搬离，具体日期未记录。",
    },
    {
      date: "2022-09-01",
      precision: "month",
      title: "加入大学摄影社",
      kind: "其它",
      people: [10, 32],
      detail: "唐悦在招新季认识叶青。",
    },
    {
      date: "2021-09-01",
      precision: "month",
      title: "成为大学室友",
      kind: "其它",
      people: [10, 11],
      detail: "新生报到月开始合住。",
    },
  ];

  return seeds.map(({ people: personIndexes, ...seed }, index) => ({
    ...seed,
    id: `${DEMO_PREFIX}event-${String(index + 1).padStart(2, "0")}`,
    personIds: personIndexes.map((personIndex) => people[personIndex].id),
    createdAt: DEMO_AT - index * 86_400_000,
    updatedAt: DEMO_AT - index * 86_400_000,
    source: demoSource,
  }));
}

function demoReminders(people: PersonRecord[]): ReminderRecord[] {
  const seeds: Array<[string, string, string]> = [
    ["给唐悦确认活动摄影档期", "2026-08-28", people[10].id],
    ["给周宁发送展板尺寸", "2026-08-29", people[11].id],
    ["联系袁野确认校友邀请名单", "2026-08-30", people[42].id],
  ];
  return seeds.map(([title, due, personId], index) => ({
    id: `${DEMO_PREFIX}reminder-${index + 1}`,
    title,
    due,
    personIds: [personId],
    kind: "custom",
    done: false,
    createdAt: DEMO_AT + index,
    source: demoSource,
  }));
}

export async function loadDemoData() {
  const people = demoPeople();
  const relations = demoRelations(people);
  const { collections, memberships } = demoCollections(people);
  const events = demoEvents(people);
  const reminders = demoReminders(people);
  await facesDb.applyArchiveMutationBatch({
    persons: people,
    assertions: relations,
    collections,
    collectionMemberships: memberships,
    lifeEvents: events,
    reminders,
  });
  return { people: people.length, relations: relations.length, events: events.length };
}

export async function clearDemoData() {
  const [people, relations, events, reminders, collections, memberships] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelationAssertions(),
    facesDb.listLifeEvents(),
    facesDb.listReminders(),
    facesDb.listCollections(),
    facesDb.listCollectionMemberships(),
  ]);
  await facesDb.applyArchiveMutationBatch({
    deletePersonIds: people
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
    deleteAssertionIds: relations
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
    deleteLifeEventIds: events
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
    deleteReminderIds: reminders
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
    deleteCollectionIds: collections
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
    deleteCollectionMembershipIds: memberships
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => item.id),
  });
}

export async function getDemoDataStatus() {
  const [people, relations] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelationAssertions(),
  ]);
  return {
    people: people.filter((item) => item.id.startsWith(DEMO_PREFIX)).length,
    relations: relations.filter((item) => item.id.startsWith(DEMO_PREFIX)).length,
  };
}
