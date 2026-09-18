/**
 * 演示库注册表：元数据静态（渲染卡片用），剧本数据按需动态加载，
 * 主包体积不随库数量增长。
 *
 * 世界剧场（DLC）插画未到位前使用占位图（demo-scenario-picker 的
 * SCENARIO_ART）；插画放入 src/assets/art/web/ 后替换对应条目即可。
 */

export const LIFE_PACK_IDS = ["campus", "family", "workplace", "small_business"] as const;
export const WORLD_PACK_IDS = ["hongloumeng", "hogwarts", "genshin", "arknights", "santi"] as const;

/** 世界剧场总开关：置 false 可整体隐藏 DLC 分组（数据与加载器保留）。 */
export const WORLD_PACKS_ENABLED = true;

export type LifePackId = (typeof LIFE_PACK_IDS)[number];
export type WorldPackId = (typeof WORLD_PACK_IDS)[number];
export type DemoScenarioId = "all" | LifePackId | WorldPackId;

export interface DemoPackMeta {
  id: Exclude<DemoScenarioId, "all">;
  group: "life" | "world";
  name: string;
  description: string;
  example: string;
}

export const PACK_META: Record<Exclude<DemoScenarioId, "all">, DemoPackMeta> = {
  campus: {
    id: "campus",
    group: "life",
    name: "校园生活",
    description: "同学、社团、展览与两位同名人物",
    example: "看看唐悦如何连接摄影社与校园记忆展",
  },
  family: {
    id: "family",
    group: "life",
    name: "家庭往来",
    description: "家人、亲戚、生日与亲属关系推导",
    example: "从苏琴、林慧和陆鸣看清一张家庭关系网",
  },
  workplace: {
    id: "workplace",
    group: "life",
    name: "职场协作",
    description: "同事、项目、会议与专业能力",
    example: "围绕知行实验室准备会议与项目协作",
  },
  small_business: {
    id: "small_business",
    group: "life",
    name: "小企业协作",
    description: "创业、市场、招聘、技术与内容交付",
    example: "在有限团队之外找到可靠的合作伙伴",
  },
  hongloumeng: {
    id: "hongloumeng",
    group: "world",
    name: "红楼梦",
    description: "贾府宗族、四大家族与称谓推导",
    example: "从贾母看清贾府三代的亲缘网络",
    // universe 等文案随数据文件落地时补充英文翻译。
  },
  hogwarts: {
    id: "hogwarts",
    group: "world",
    name: "魔法学院",
    description: "学院、社团与师生协作网",
    example: "想学一项新咒语，该找谁请教？",
  },
  genshin: {
    id: "genshin",
    group: "world",
    name: "元素大陆",
    description: "七国城邦与跨城协作",
    example: "要在璃月办一场灯会，找谁统筹？",
  },
  arknights: {
    id: "arknights",
    group: "world",
    name: "矿石病都市",
    description: "干员、阵营与跨阵营合作",
    example: "突发聚集感染，该找谁处理？",
  },
  santi: {
    id: "santi",
    group: "world",
    name: "黑暗森林",
    description: "跨越世纪的协作与抉择",
    example: "末日之战前，该找谁了解敌人？",
  },
};

/** UI 渲染顺序：先生活场景，后世界剧场。 */
export const DEMO_SCENARIOS: ReadonlyArray<DemoPackMeta> = WORLD_PACKS_ENABLED
  ? [...LIFE_PACK_IDS, ...WORLD_PACK_IDS].map((id) => PACK_META[id])
  : LIFE_PACK_IDS.map((id) => PACK_META[id]);

export async function loadPack(id: Exclude<DemoScenarioId, "all">) {
  switch (id) {
    case "campus":
      return (await import("./life/campus")).campusPack;
    case "family":
      return (await import("./life/family")).familyPack;
    case "workplace":
      return (await import("./life/workplace")).workplacePack;
    case "small_business":
      return (await import("./life/small-business")).smallBusinessPack;
    case "hongloumeng":
      return (await import("./world/hongloumeng")).hongloumengPack;
    case "hogwarts":
      return (await import("./world/hogwarts")).hogwartsPack;
    case "genshin":
      return (await import("./world/genshin")).genshinPack;
    case "arknights":
      return (await import("./world/arknights")).arknightsPack;
    case "santi":
      return (await import("./world/santi")).santiPack;
    default: {
      const exhaustive: never = id;
      throw new Error(`演示库不存在：${exhaustive}`);
    }
  }
}

export async function loadLifePacks() {
  return Promise.all(LIFE_PACK_IDS.map((id) => loadPack(id)));
}
