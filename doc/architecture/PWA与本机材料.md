# PWA 与本机材料

知脉可以作为免登录应用安装到手机或电脑。人物、关系与事件仍使用原有 IndexedDB 和 `archive@2`；安装不会创建账号、云端人物库或设备同步通道。

## 三类存储

| 内容 | 位置 | 生命周期 |
| --- | --- | --- |
| 应用页面、脚本、样式、图标 | Cache Storage，`zhimai-shell-<版本>` | 安装时下载整套资源；旧窗口全部关闭后启用新版本并清理旧资源 |
| 已批准档案与运行记录 | 原有 IndexedDB | 沿用现有资料维护、批准、撤销与归档规则 |
| 待整理文件、分享文本、离线录音 | IndexedDB，`zhimai-local-captures` / `inbox` | 收到后保留，成功放入录入框后移除；也可手动删除 |

编辑中的录入框沿用 `zhimai.intake.draft.v1`，取消 24 小时自动过期。分享收件箱的 ID 与追加后的文字一起保存，再移除收件箱条目；若在中间关闭页面，重开后不会重复追加。未变化的旧窗口不会在关闭时重写草稿。多个窗口同时修改同一份录入框不提供协同合并，应在一个窗口继续编辑。

文件内容是原始材料，不直接成为人物事实。系统分享、离线选文件与离线录音共用收件箱，之后进入已有文件读取与草稿确认流程。图片和扫描 PDF 可能需要模型识别，音频需要转写；联网本身不会触发上传。

收件箱数据库为独立的输入暂存区，版本 1；不修改正式资料库 schema。旧录入草稿字段保持可读，新增 `importedCaptureIds` 作为交接收据。原有 `archive@2` 的排除范围不扩大：未提交草稿和这些原始文件不包含在完整备份中。

## 缓存与更新

`scripts/build-pwa.mjs` 在 Vite 构建后生成带内容指纹的 `sw.js`，复制用于网页与 worker 的同一份材料存储逻辑。Service Worker 只缓存明确列出的公开静态文件与 `/` 页面，所有 `/api/*`、模型请求、认证响应、分享请求正文均不进入 HTTP 缓存。

安装阶段检查 HTML 引用与当前资源清单一致，再下载整套文件；下载失败不激活不完整版本。页面从当前版本缓存启动。更新不调用 `skipWaiting`，已有窗口继续使用当前版本，避免中断编辑与 Agent。关闭所有知脉窗口后重新打开，浏览器启用等待中的版本。

检查更新不会清除人物库、录入框、模型设置或材料收件箱。回滚应用代码也应保留 Service Worker 更新路径；单纯删掉服务器的 `sw.js` 不能移除已安装的 worker。

## 安装与访问

- 使用 HTTPS，或在开发电脑通过 localhost / 127.0.0.1 预览生产构建。
- 开发模式 `npm run dev` 不注册 worker，避免离线缓存干扰热更新。
- `npm run build` 后执行 `npm run preview`，在设置页查看“离线资源已就绪”。
- Android Chrome 与桌面 Chrome/Edge 可通过浏览器菜单安装；满足条件时设置页显示安装按钮。
- iPhone 使用浏览器分享菜单中的“添加到主屏幕”；系统文件分享目标等能力需要分别做实机验证。
- 首次安装需要网站可访问。PWA 缓存不能解决 workers.dev 在特定网络中的首次访问问题。
- IP、域名、端口、浏览器配置文件或设备发生变化，通常意味着不同的本地存储。换站点前先导出完整备份。

## 验证

```sh
npm run check
npm run build
npm run e2e
npm run e2e:pwa
```

PWA 专项测试启动真实 Worker 生产预览，检查清除浏览器 HTTP 缓存后的离线导航、录入恢复、离线入库、系统分享 POST、收件箱交接、手机导航与缓存边界。测试结果不能替代 Android/iOS 的实际系统安装、分享面板、麦克风、相机与后台行为验收。

## 当前边界

AI 运行仍由前台浏览器驱动。操作系统可能冻结或终止后台页面；重新打开后使用已有断点恢复机制。当前不提供关掉应用后的准点系统通知，也没有云同步。浏览器仍可能回收站点数据；持久存储申请是否授予由浏览器决定，不能替代备份。

参考：[Service Worker 生命周期](https://web.dev/learn/pwa/service-workers)、[应用更新](https://web.dev/learn/pwa/update)、[系统分享目标](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/share_target)、[安装方式](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)。
