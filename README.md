# 知脉 Connect

知脉 Connect 是一个本地优先、证据可追溯的人际关系记忆与行动助手。它帮助用户从文字、文档、图片或语音材料中整理人物与关系，在用户确认后写入本地资料库，并通过关系图、日历、提醒和 AI 助理辅助回忆与行动。

当前仓库是竞赛原型／个人版 MVP，适合本地开发、内部演示和继续迭代，尚不应在没有额外鉴权与安全加固的情况下作为公开的多用户服务部署。

## 主要能力

- 自然语言、TXT、PDF、DOCX 和图片材料录入
- 多轮录入智能体可检索已有档案并把人物/事件更新放入待确认草稿
- 人物档案、关系记录和二维关系图；支持概览/一跳/两跳/全部视图、关系证据筛选和单边常显/自动/常隐
- 生日、节日、自定义提醒，以及公历/农历同格显示、可原位编辑的模糊日期日历
- “问一问”可调用本机档案与联网工具；人物修改必须先展示差异并由用户批准
- “这事该拜托谁”区分开放求助与目标人物引荐；目标模式只返回本地确定性算法找到的真实路径
- 本地 IndexedDB 数据存储
- Lovable AI、自定义 OpenAI 兼容接口与本地 Ollama 三种模型接入方式
- Markdown、DOCX 等数据导出能力
- 中英文、主题和基础无障碍设置

## 技术栈

- React 19、TypeScript、Tailwind CSS 4、Radix UI
- TanStack Start、TanStack Router、Vite 8
- Nitro Cloudflare Module 构建目标、Wrangler 本地预览
- IndexedDB 本地数据层
- Vitest 单元测试基线、ESLint 和 Prettier 质量检查

## 环境要求

- Node.js `>=22.12.0`
- npm `>=10.9.0`

本项目统一使用 npm。`package-lock.json` 是依赖解析的唯一基线，安装依赖时优先使用 `npm ci`。仓库中的 `bun.lock` 与 `bunfig.toml` 是 Lovable 生成流程遗留文件，不作为本地安装或 CI 的依据；不要同时用 Bun 更新依赖。

## 本地开发

```powershell
git clone <repository-url>
cd camera-connect-personal
npm ci
Copy-Item .env.example .env.local
npm run dev
```

macOS 或 Linux 可将复制环境文件的命令替换为：

```sh
cp .env.example .env.local
```

开发服务器的实际访问地址会显示在终端中。

## 环境变量与模型配置

`.env.example` 仅包含变量名和用途，不包含真实密钥。服务端当前使用的可选变量如下：

| 变量                     | 用途                                                             | 是否必需 |
| ------------------------ | ---------------------------------------------------------------- | -------- |
| `LOVABLE_API_KEY`        | 调用 Lovable AI 的图像理解与语音转写接口                         | 否       |
| `AI_PROXY_ALLOWED_HOSTS` | 允许服务端代理访问的额外 AI 主机名，以英文逗号分隔且必须精确匹配 | 否       |
| `ZHIMAI_RATE_LIMIT_SALT` | 将 Cloudflare 边缘客户端标识做不可逆伪名化的服务端盐             | 否       |

将真实密钥放在未提交的 `.env.local` 中：

```dotenv
LOVABLE_API_KEY=your-server-side-key
AI_PROXY_ALLOWED_HOSTS=api.example.com
```

`AI_PROXY_ALLOWED_HOSTS` 只填写主机名，不填写协议、端口或路径；不支持通配符或子域名自动扩展。应用仍会拒绝 IP 字面量、本地域名和非 HTTPS 地址。

不要使用 `VITE_` 前缀保存密钥；带该前缀的变量会进入浏览器构建产物。

没有配置 `LOVABLE_API_KEY` 时，应用主体和所有本地数据功能仍可使用，Lovable AI 请求会受限。此时可以在应用的模型设置中选择：

- 本机运行的 Ollama；浏览器需要能访问配置的 Ollama 地址。
- 用户自行提供的 OpenAI 兼容接口、模型和 API Key。

Ollama 如遇浏览器跨域限制，请按 Ollama 官方方式设置允许来源；例如仅在可信的本机开发环境中配置 `OLLAMA_ORIGINS`，不要无条件向公网开放服务。

## 检查与测试

```powershell
# TypeScript 静态检查
npm run typecheck

# ESLint（警告也会导致失败）
npm run lint

# 检查或自动统一格式
npm run format:check
npm run format

# 测试监听模式或单次运行
npm test
npm run test:run

# 提交前完整检查：类型、Lint、格式、单元测试
npm run check

# Playwright 端到端测试
npm run e2e
```

## 生产构建与本地预览

```powershell
npm run build
npm run preview
```

构建产物位于 `.output/`。由于生产目标是 Cloudflare Module Worker，`npm run preview` 会通过项目内安装的 Wrangler 启动 `.output/server`，默认监听 `http://127.0.0.1:4173`。它不是普通的 Vite 静态站点，因此不要用 `vite preview` 或直接执行 Worker 入口代替。

每次修改代码后应重新运行 `npm run build`，再启动预览。首次运行 Wrangler 时可能会在本机创建 `.wrangler/`，该目录已被 Git 忽略。

## Cloudflare 部署

确认 Cloudflare 账号、项目名称、环境变量和公开访问策略后，再执行：

```powershell
npm run build
npx wrangler secret put ZHIMAI_RATE_LIMIT_SALT --config .output/server/wrangler.json
npx wrangler deploy --config .output/server/wrangler.json
```

`LOVABLE_API_KEY` 等生产密钥应通过 Cloudflare Secret 管理，不要写入仓库或 `wrangler.json`。`npm run build` 会在生成的 Worker 配置中注入三组 Cloudflare Rate Limiting bindings；请始终部署这份构建产物，不要绕过构建脚本直接发布旧 `.output`。

## 数据与隐私边界

- 人物、关系、提醒等结构化数据默认保存在当前浏览器的 IndexedDB 中；清理站点数据可能导致资料丢失。
- 关系的“常隐”只控制画面；是否允许用于引荐由独立策略控制。目标引荐路径在浏览器本地计算，AI 只能解释锁定后的候选、顺序和路径。
- 选择云端模型时，用户提交的文字、图片或音频会按功能需要发送给相应模型服务商，不等于“所有数据始终只在本机”。
- 页面在调用 AI 路由前会建立短期同源会话令牌；服务端同时校验 SameSite HttpOnly cookie。Cloudflare 生产环境使用 `CF-Connecting-IP` 的加盐哈希和路由形成稳定的边缘共享限流桶，因此反复刷新公开状态接口、轮换会话 UUID 或伪造 `X-Forwarded-For` 都不能绕过主桶；非 Workers/绑定临时不可用时使用有界内存限流回退。
- 选择本地 Ollama 时，模型请求通常留在用户配置的本地服务，但仍需由用户确认该地址与运行环境可信。
- 不应在演示、日志、截图或提交记录中放入真实联系人隐私、API Key 或原始敏感材料。
- 本项目不接入、抓取或宣称可以读取个人微信、QQ、小红书账号数据，也不会自动对外发送消息。

正式使用真实资料前，应先补齐全量备份／恢复、敏感操作确认、密钥安全存储和数据删除能力。

## 项目结构

```text
src/
  components/       业务面板与通用 UI
  lib/              IndexedDB、AI 接入、日期与导入导出逻辑
  routes/           TanStack 页面与服务端 API 路由
  server.ts         SSR 服务入口与错误处理
public/             静态资源
doc/                产品背景、调研材料与升级计划
.lovable/           Lovable 项目配置和原始产品计划
```

详细升级顺序与验收项见 `doc/UPGRADE_TODO.md`。

## Lovable 协作

项目连接到 [Lovable](https://lovable.dev/projects/b8121f02-5be1-4897-b32f-27c518794295)。推送到已连接分支的提交会同步回 Lovable。不要对已经推送的历史执行强制推送、rebase、amend 或 squash，以免丢失 Lovable 侧的项目历史。
