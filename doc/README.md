# 知脉 Connect 文档索引

`doc/` 只保存能够随公开代码仓库分发的产品资料。目录按用途划分：

- [`product/中期反思.md`](product/中期反思.md)：当前产品哲学与架构判据。
- [`product/分阶段升级计划-2026-09-02.md`](product/分阶段升级计划-2026-09-02.md)：从 Agent 完成与恢复、个人关系工作台到移动端、账号同步和平台生态的阶段路线与验收门槛。
- [`architecture/机器归档格式-v2.md`](architecture/机器归档格式-v2.md)：当前机器归档契约。
- [`quality/ACCEPTANCE_LOG.md`](quality/ACCEPTANCE_LOG.md)：持续验收记录。
- [`quality/阶段0可复现基线-2026-09-04.md`](quality/阶段0可复现基线-2026-09-04.md)：三套合成归档、五条主流程、版本锚点与发布门槛。
- [`quality/Agent-harness结构审计-2026-09-02.md`](quality/Agent-harness结构审计-2026-09-02.md)：预算表象背后的执行契约、上下文与恢复机制审计。
- [`quality/亲属关系推理-红楼梦测试样例.md`](quality/亲属关系推理-红楼梦测试样例.md)：可重复使用的关系推理回归样例。
- [`research/文献调研-关系网与推荐.md`](research/文献调研-关系网与推荐.md)：关系图与引荐算法的研究依据；原始检索摘录位于 `research/literature/`。
- [`research/peerworks/参赛项目横向调研与知脉改进启示-2026-09-02.md`](research/peerworks/参赛项目横向调研与知脉改进启示-2026-09-02.md)：八个公开参赛仓库（七套产品）的产品形态、移动与平台入口、README 展示、Agent harness、证据索引及双轨改进路线。
- [`history/`](history/)：已经完成或被后续实现取代的计划、审计、问题基线与实施报告，只用于追溯。

`background/` 保存参赛信息、原始材料、本机审计和交付过程文件，已由 `.gitignore` 整体排除。`videos/` 同样只保留在本地，不进入应用代码仓库。

新增文档时，现行契约进入对应主题目录；完成的阶段性记录进入 `history/<年月>/`；含个人信息、参赛身份、原始聊天、未公开素材或本机路径的资料进入 `background/`。
