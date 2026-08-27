import {
  facesDb,
  type LifeEventRecord,
  type PersonRecord,
  type RelationRecord,
  type ReminderRecord,
} from "./face-db";
import type { Provenance } from "./provenance";

const DEMO_PREFIX = "demo-zhimai-";
const DEMO_AT = new Date(2026, 7, 20, 10).getTime();
const demoSource: Provenance = { kind: "manual", detail: "合成演示数据", at: DEMO_AT };

type Seed = [
  name: string,
  circle: string,
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

function demoPeople(): PersonRecord[] {
  return SEEDS.map(([name, circle, relation, title, skill, closeness], index) => ({
    id: `${DEMO_PREFIX}person-${String(index + 1).padStart(2, "0")}`,
    name,
    note: `合成角色：${relation}，可协助${skill}。`,
    profile: {
      relation,
      circle,
      tags: [circle],
      title,
      org: circle === "科研" ? "知行实验室（模拟）" : `${circle}示范圈`,
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

function demoRelations(people: PersonRecord[]): RelationRecord[] {
  const rows: RelationRecord[] = [];
  const add = (from: number, to: number, label: string, index: number) => {
    const at = DEMO_AT - index * 60_000;
    rows.push({
      id: `${DEMO_PREFIX}relation-${String(index + 1).padStart(2, "0")}`,
      fromId: people[from].id,
      toId: people[to].id,
      label,
      mutual: true,
      note: "合成演示关系",
      createdAt: at,
      updatedAt: at,
      confirmationStatus: index === 63 ? "pending" : "confirmed",
      source: index === 63 ? { kind: "ai", detail: "合成低置信度关系", at } : demoSource,
    });
  };
  const groups = new Map<string, number[]>();
  people.forEach((person, index) => {
    const key = person.profile?.circle ?? "其它";
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  for (const members of groups.values()) {
    members.forEach((from, index) => {
      add(from, members[(index + 1) % members.length], "同圈伙伴", rows.length);
    });
  }
  for (let index = 0; index < 30; index += 1) {
    add(
      index,
      (index + 10) % people.length,
      index % 3 === 0 ? "活动搭档" : "共同认识",
      rows.length,
    );
  }
  return rows;
}

function demoEvents(people: PersonRecord[]): LifeEventRecord[] {
  const titles = [
    "讨论校园记忆展分工",
    "完成活动摄影踩点",
    "一起修改招募文案",
    "确认展板与物资清单",
    "线上复盘志愿活动",
  ];
  return people.slice(0, 25).map((person, index) => ({
    id: `${DEMO_PREFIX}event-${String(index + 1).padStart(2, "0")}`,
    date:
      index === 22
        ? "2026-08-13"
        : index < 12
          ? `2026-08-${String(5 + index).padStart(2, "0")}`
          : `2025-${String((index % 12) + 1).padStart(2, "0")}-12`,
    precision: "day",
    title: index === 22 ? "完成展览人物肖像试拍" : titles[index % titles.length],
    detail: "合成演示事件，用于解释推荐与长期未联系提醒。",
    kind: index % 4 === 0 ? "帮忙" : "聚会",
    personIds: [person.id, people[(index + 10) % people.length].id],
    createdAt: DEMO_AT - index * 86_400_000,
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
  }));
}

export async function loadDemoData() {
  const people = demoPeople();
  const relations = demoRelations(people);
  const events = demoEvents(people);
  const reminders = demoReminders(people);
  await Promise.all(people.map((person) => facesDb.putPerson(person)));
  await Promise.all(relations.map((relation) => facesDb.putRelation(relation)));
  await Promise.all(events.map((event) => facesDb.putLifeEvent(event)));
  await Promise.all(reminders.map((reminder) => facesDb.putReminder(reminder)));
  return { people: people.length, relations: relations.length, events: events.length };
}

export async function clearDemoData() {
  const [people, relations, events, reminders] = await Promise.all([
    facesDb.listPersons(),
    facesDb.listRelations(),
    facesDb.listLifeEvents(),
    facesDb.listReminders(),
  ]);
  await Promise.all(
    people
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => facesDb.deletePerson(item.id)),
  );
  await Promise.all(
    relations
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => facesDb.deleteRelation(item.id)),
  );
  await Promise.all(
    events
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => facesDb.deleteLifeEvent(item.id)),
  );
  await Promise.all(
    reminders
      .filter((item) => item.id.startsWith(DEMO_PREFIX))
      .map((item) => facesDb.deleteReminder(item.id)),
  );
}

export async function getDemoDataStatus() {
  const [people, relations] = await Promise.all([facesDb.listPersons(), facesDb.listRelations()]);
  return {
    people: people.filter((item) => item.id.startsWith(DEMO_PREFIX)).length,
    relations: relations.filter((item) => item.id.startsWith(DEMO_PREFIX)).length,
  };
}
