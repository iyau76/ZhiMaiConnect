# 知脉 Connect · 首个 Windows / Android 预览版

把随手记下的人和事整理成人物、关系、事件与提醒。现在可以安装到电脑和手机，免登录使用；页面和资料管理功能随安装包交付。

## 下载与安装

在下方 **Assets** 中选择安装包，无需下载 Source code：

| 设备 | 文件 | 安装说明 |
| --- | --- | --- |
| Windows 10/11 x64 | `ZhiMai-Connect-0.2.0-win-x64-setup.exe` | 双击安装，可选择目录。当前未签名，系统可能提示未知发布者；请核对下载来源和 SHA256。 |
| Android 7.0+ | `ZhiMai-Connect-0.2.0-test.apk` | 下载后由文件管理器打开，按系统提示允许该来源安装。需要 Android System WebView 111 或更新版本；建议使用仍有安全更新的设备。 |
| 校验文件 | `SHA256SUMS.txt` | 包含上述两个安装包的 SHA256。Windows 可运行 `Get-FileHash .\文件名 -Algorithm SHA256` 核对。 |

Android 包使用测试签名，供体验反馈。后续切换正式签名可能需要卸载重装，请先在设置页导出 JSON 完整备份。安装包和本页面均不包含模型密钥。

## 第一次打开

1. 载入合成演示资料，先体验人物卡、关系图、圈层、事件和提醒。
2. 在 **AI 助理 → 模型配置** 填写自己的接口地址、模型名称与 API Key。手机使用 HTTPS 接口；Windows 还可连接本机 Ollama。
3. 在录入页写一段话，让 AI 整理成草稿，确认后入库。联网 AI 请求由安装版直接发送到配置的模型服务。
4. 网页、电脑和手机各自保存资料。换设备时，在设置页导出、导入 JSON 完整备份；没有自动云同步。

## 本版范围与已知问题

- 已验证 Windows 安装启动、离线操作、重启保留资料及 JSON/PDF 保存；Android 模拟器已验证安装、离线操作、重启保留和 JSON 导出。两端模型直连已验证。
- AI 修改人物时，部分模型可能返回不支持的字段名，导致没有生成待批准提案。遇到这一情况，可先在人物详情中手动编辑。
- Android PDF 导出依赖系统打印服务，部分模拟器的打印组件会崩溃；PDF、相机和麦克风仍需真机验收。
- 当前没有登录、多设备同步、自动更新或关闭应用后的定时系统通知。Android 尚无系统“分享至知脉”入口。
- 资料保存在当前设备；AI 等联网功能仍需网络。显式保存的模型密钥使用应用本地设置存储，尚未接入系统凭据保险库。

本次安装包由源码提交 `8327c23a098b36678f87801e801bda8f30dae98d` 构建。反馈时请附设备、系统版本和复现步骤，勿上传个人档案或密钥。

[使用说明](https://github.com/iyau76/ZhiMaiConnect#readme) · [报告问题](https://github.com/iyau76/ZhiMaiConnect/issues)

---

**English:** First public preview for Windows x64 and Android. Download the `.exe` or `.apk` under Assets. Windows is unsigned; Android uses a test signing key. Android requires version 7+ and WebView 111+. Bring your own model endpoint and API key. Records stay on each device; migrate them using JSON backups. No account, automatic sync, or auto-update. Some AI profile edits may fail to produce a proposal; manual editing remains available. Android printing, camera, and microphone need further physical-device testing.
