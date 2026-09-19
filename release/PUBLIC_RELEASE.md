# 知脉 Connect 0.3.6 · Windows / Android 预览版

把随手记下的人和事整理成人物、关系、事件与提醒。可以装到电脑和手机上，免登录使用；资料默认只保存在你自己的设备里。

## 下载与安装

在下方 **Assets** 中选择安装包，无需下载 Source code：

| 设备 | 文件 | 安装说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `ZhiMai-Connect-0.3.6-win-x64-setup.exe` | 双击安装，可选择目录。当前未签名，系统可能提示未知发布者；请核对下载来源和 SHA256。 |
| Android 7.0+ | `ZhiMai-Connect-0.3.6-test.apk` | 下载后由文件管理器打开，按系统提示允许该来源安装。需要 Android System WebView 111 或更新版本；建议使用仍有安全更新的设备。 |
| 校验文件 | `SHA256SUMS.txt` | 包含上述两个安装包的 SHA256。Windows 可运行 `Get-FileHash .\文件名 -Algorithm SHA256` 核对。 |

Android 包使用测试签名，versionCode 9，可以覆盖安装 0.3.5 及更早的测试包；覆盖安装前建议先在设置页导出 JSON 完整备份。切换正式签名可能需要卸载重装。安装包和本页面均不包含模型密钥。

## 本次更新

这一版把 0.3.4 里那批「做减法」的改动重新做回来了（0.3.5 的包里漏掉了它们），同时保留 0.3.5 新增的功能。

界面上的减法：

- 录入页、关系网、设置页和今天页的长段说明收进问号，需要时再展开。
- 人物卡上直接标出「AI 推断，未找到原文依据」的值，哪一条没有原文支撑，一眼能看到。
- 「离线演示草稿」「前往安全录入」和设置页的安装卡片不再占位置，安装说明集中到「关于与更新」。
- 说明浮层会避让屏幕边缘，窄屏不再越界，Esc 或点击外部都能关掉。

功能修复：

- 圈层成员口径修正：手动新建的圈层归入关系圈层，保留原有颜色，已入库的成员也算在内，下拉里能看到本次刚建的圈层。
- 核对页新增「圈层变更」，和人物、关系、事件、提醒放在同一处对照。
- 本机待整理材料在同一时刻记录多条时，顺序保持稳定。
- 「检查新版本」不再依赖写死的版本号，发新版本不需要回来改代码。

保留自 0.3.5 的新功能：关系图按家族树布局、计划的运行记录可以重放、AI 推断出的关系会自动展开并给出核验入口、完整关系测试集。

## 第一次打开

1. 载入合成演示资料，先体验人物卡、关系图、圈层、事件和提醒。
2. 在 **AI 助理 → 模型配置** 里填写接口地址、模型名称与 API Key。手机使用 HTTPS 接口；Windows 还可以连接本机的 Ollama。
3. 在录入页写一段话，让 AI 整理成草稿，逐条确认后再入库。联网请求由安装版直接发给你配置的模型服务。
4. 网页、电脑和手机各自保存资料，没有自动云同步。换设备时在设置页导出、导入 JSON 完整备份；还没整理的材料不随备份导出，请先整理完或另存原文件。

## 本版范围与已知问题

- 当前没有登录、多设备同步、安装包自动更新，也没有关闭应用后的定时系统通知。
- 资料保存在当前设备。清理浏览器站点数据或卸载 Android 应用会删除本地档案，请定期导出 JSON 完整备份，并把备份当敏感文件保管。
- 网页版部署在 `workers.dev` 域名下，部分网络直连不稳定；Windows 与 Android 安装版不受影响，直接访问你配置的模型接口。
- Windows 安装程序未配置发布者签名，APK 使用测试签名。
- 空白页面关闭时会把本机草稿一并清掉，另一个标签页刚写好的草稿可能被抹掉；同期只在一个窗口里录入更安全。
- Android 的 PDF 导出、相机和麦克风仍需真机验收；模拟器的测试范围见仓库里的安装版说明。
- APK 暂未提供系统「分享至知脉」入口；PWA 版能不能接收系统分享，取决于浏览器支持。

安装包由 `main` 的 `3e43a91` 构建（含 PR #10 恢复的减法改动）。网页版已同步部署：Worker 版本 `5cd93971-82ff-44f4-ad2c-309813278f27`，PWA 指纹 `0a984ba4b1d987b3`。反馈时请附设备、系统版本和复现步骤，不要上传个人档案或密钥。

[使用说明](https://github.com/iyau76/ZhiMaiConnect#readme) · [报告问题](https://github.com/iyau76/ZhiMaiConnect/issues)

---

**English:** Preview build for Windows x64 and Android (versionCode 9, overwrite-installable over earlier test builds). Download the `.exe` or `.apk` under Assets and check it against `SHA256SUMS.txt`. This release brings back the interface trimming that 0.3.5 missed: long explanations move behind "?" buttons, ungrounded AI-inferred values are marked on the person card, and the demo-draft button, the review-summary fold, and the install card are gone. It also fixes how manually created circles are classified, keeps a circle's colour, counts members already in the archive, lists newly created circles in the picker, and adds a circle-change summary to the review page. New in 0.3.5 and kept here: family-tree graph layout, planning run replay, an auto-expanded review entry for AI-inferred relations. Bring your own model endpoint and API key. Records stay on each device and migrate through JSON backups; unsubmitted material is not included in a backup. No account, no automatic sync, no auto-update, and no scheduled system notification while the app is closed. The web build is served from a `workers.dev` domain, which some networks cannot reach directly; the desktop and Android builds are unaffected.
