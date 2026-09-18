# 演示库（DemoPack）架构

2026-09-18 起生效。演示数据从 `src/lib/demo-data.ts` 单文件拆为「接口 + 装配器 + 注册表 + 每库一个剧本文件」的结构，目的是让生活场景与世界剧场（DLC）用同一套机制维护，并为将来的整合包与角色扮演玩法留好扩展点。

## 目录

```
src/lib/demo-packs/
  types.ts        # DemoPack 及 seed 接口（唯一权威定义）
  assemble.ts     # 装配器：pack → 可写入 IndexedDB 的记录
  registry.ts     # 元数据 + 动态加载 + 世界剧场总开关
  contract.ts     # 契约测试工厂（describeDemoPackContract）
  life/           # 四个生活场景 + 跨包桥
  world/          # 世界剧场剧本（每个 DLC 一个文件）
```

`src/lib/demo-data.ts` 保留为门面：`loadDemoData / clearDemoData / getDemoDataStatus / buildDemoData` 的对外签名不变，UI 与既有测试无感。

## 一个库要提供什么

一份 `DemoPack` 包含 collections（圈层）、people、relations、events、reminders 五组 seed，包内用局部稳定 key（如 `tangyue`）互相引用。装配器统一负责：

- id 展开：`demo-zhimai-<packId>-<key>`；清除与统计仍按 `demo-zhimai-` 前缀工作；
- 时间冻结：全部时间戳锚定 `DEMO_AT`（assemble.ts），CI 与演示机字节级一致；
- 语义：predicate + qualifiers 为准，label 只做展示；pending 关系展开为低置信待确认（0.62），ended 关系带 validity；
- 引用校验：关系/事件/提醒/圈层引用了包外 key 时直接抛错。

跨包桥（`life/bridges.ts`）用 `<packId>/<key>` 复合键，只在载入完整生活库（`all`）时合并；单独载入某个场景时不可见。世界剧场各库自包含，永不并入 `all`。

## 契约测试

任何新库必须过 `describeDemoPackContract`（contract.ts），它检查：人数区间与 key 唯一、全部引用可解析、以 egoKey（缺省第一人）为锚的连通性（直径 ≤4）、八项演示特性覆盖（待确认关系、已结束关系、身份史或同名、联系方式有无、生日覆盖、时间精度、提醒），以及亲属 qualifiers 与人物 gender 的一致性。包级专项断言写在各库 test 文件的 `extra` 回调里。

## 加一个新库的步骤

1. 在 `types.ts` 不变的前提下新建 `world/<id>.ts`（导出 `<id>Pack`）与 `world/<id>.test.ts`（调契约工厂），设计说明放 `doc/research/demo-packs/<id>.md`；
2. `registry.ts`：PACK_META 补条目（中文名/描述/示例句），`loadPack` 接入动态 import；
3. `demo-scenario-picker.tsx`：SCENARIO_ICON / SCENARIO_ART 补条目，插画放 `src/assets/art/web/<id>.webp`（原稿规范见 `src/assets/art/README.md`）；
4. `i18n.ts`：补名称/描述/示例句英文；
5. 数据与插画齐备后，把 `WORLD_PACKS_ENABLED` 对应启用（当前为全局开关，库多后可改为每库开关）。

## 预留的扩展点

- `universe`：一句话世界观，供角色扮演玩法读取；
- `egoKey`：主角键。当前装配器不读它（世界剧场按「无我」模式运行）；启用后可把主角登记为 `entityRole: "ego"`，让引荐路径以主角为原点。启用前需验证 connection-paths 与 meeting-brief 对 ego 的特殊处理；
- 整合包（把多个库混装）可在 registry 层做组合加载，不动装配器。

## 已知限制

- 完整生活库总数锚定 51 人（文案「载入完整 50 人演示库」与多条 e2e 依赖），调整人数需同步 `demo-data.test.ts`、`face-db.indexeddb.test.ts`、`tests/fixtures/archive-fixtures.ts` 的钉死计数与 e2e 文案；
- 世界剧场在插画与数据都落地前不进入 UI（`WORLD_PACKS_ENABLED = false`）。
