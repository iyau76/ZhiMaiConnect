# 知脉 Connect 验收记录

> 每次完整检查后追加一行；只记录不含联系人、提示词、密钥或其它 PII 的结果。

| 日期时间 | 提交/工作树 | typecheck | lint | format | unit | build | preview | audit | 浏览器 E2E | 剩余风险 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-26 | 基线 `6fd7028` | 通过 | 945 格式错误、25 警告 | 失败 | 无测试 | 通过 | Windows 500 | 1 high (`xlsx`) | 未执行 | API 安全、隐私文案、主流程完整度 |
| 2026-08-26 | Track A 第一批工作树 | 通过 | 通过（0 warning） | 待全仓格式化 | 107 passed、1 todo（随后已修） | 通过 | Wrangler 首页 200 | 0 vulnerabilities | 待执行 | 录入/图谱并行升级中，E2E 与多宽度人工验收未完成 |
| 2026-08-26 18:44 +08:00 | Track A 最新工作树 | 通过 | 通过（0 warning） | 通过 | 149/149 | 通过；仅余 508 KB 路由分包提示 | Wrangler：首页/状态 200、非法 JSON 400、缺密钥 503、匿名 AI 401；会话 Cookie 与 `no-store` 正常 | 0 vulnerabilities | Chrome 13/13；Edge 13/13 | 录屏/部署/信息表/邮件待队长完成；低风险批量确认与模型防编造仍未闭环；全量加密备份和旧模块拆分属 Track B |
| 2026-08-26 21:02 +08:00 | Track A 录入证据门禁与材料收尾工作树 | 通过 | 通过（0 warning） | 通过 | 172/172 | 通过；非阻断提示为 534 KB `routes` 分包，以及上游配置的 `vite-tsconfig-paths` / `inlineDynamicImports` 兼容提示 | Wrangler：首页/状态 200、非法 JSON 400、缺密钥 503、匿名 AI 401；会话 Cookie、令牌形状与 `no-store` 正常 | 0 vulnerabilities | Chrome 17/17；Edge 17/17；人工字段重排/改名定向流程 Chrome、Edge 各 3/3 | 录屏、真实部署、产品信息表基础信息、统一命名和邮件仍需队长/外部环境；证据绑定当前为保守句级启发式，持久化证据区间、跨段指代与实体级归属验证属 Track B |
| 2026-08-29 00:08 +08:00 | 重构验收 `36942b0`（工作树干净） | 通过 | 通过（0 warning） | 通过 | 518/518（56 个测试文件） | 通过；Cloudflare Workers 产物与 rate-limit bindings 正常生成 | 未执行 | 未执行 | Chrome 26/26（1.4 分钟） | 日志默认仍只存结构（savePrivatePayload=false，三档未做）；历史轮次图片不重发与 8 轮静默遗忘未验证；Edge/audit/preview 未跑；真实 DeepSeek 全矩阵与云部署待执行 |
| 2026-09-02 00:40 +08:00 | 后初评发布工作树 | 通过 | 通过（0 warning） | 通过 | 546/546（58 个测试文件） | 通过；Cloudflare Workers 产物与三组 rate-limit bindings 正常生成 | 由 Playwright WebServer 验证 | 0 vulnerabilities | Chrome 32/32（2.0 分钟） | `routes` 产物约 937 KB，仍需在后续性能迭代中拆包；本轮部署后再核对线上静态资源指纹 |

## 固定验收命令

```powershell
npm run check
npm run build
npm run preview
npm audit --audit-level=high
npx playwright test
$env:PLAYWRIGHT_CHANNEL='msedge'; npx playwright test
```

预览启动后另开终端：

```powershell
Invoke-WebRequest http://127.0.0.1:4173/ -UseBasicParsing
```

## 真实浏览器自动化矩阵

以下每一行都实际执行：载入/清除离线草稿、载入 50 人/80 关系合成数据、关系图聚焦、固定摄影问题 Top 3、日历写入、模型连接 Mock，并检查整页无横向溢出。

| 宽度 | 浏览器 | 录入草稿 | 人物/关系 | 提醒/推荐 | 日历写入 | 模型测试 | 无横溢出 | 结果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 390px | 系统 Chrome | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |
| 768px | 系统 Chrome | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |
| 1440px | 系统 Chrome | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |
| 390px | 系统 Edge | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |
| 768px | 系统 Edge | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |
| 1440px | 系统 Edge | 通过 | 通过 | 唐悦/秦月/叶青 | 通过 | 通过 | 通过 | 通过 |

附加自动化覆盖：模型 500、文件解析明确失败后完整草稿不变、刷新/切页草稿保留、24 小时过期清除、带非本批次 sentinel 的最近录入撤销、全部顶层条目待确认阻断、受限事件批量接受、人工编辑后重新待确认、人物改名对 Fact/关系/事件/提醒/汇报对象的引用传播、已有档案改名落库、补充整理保留人工字段来源、关系—证据—人物 ID 闭环、UI 人工/AI 来源标签、人物句级跨主体/否定/字段绑定反例、祝福资料不足提示、中英文 `<html lang>`/标题/关键 ARIA、50 人/80 关系点击交互。所有 E2E 自动 Mock `/api/status`、`/api/vision`、`/api/transcribe`，对未知 `/api/*` fail-closed，并阻断外部网络。
