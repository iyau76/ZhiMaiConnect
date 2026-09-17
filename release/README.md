# 知脉 Connect 0.2.0 安装测试

## 安装包

- Windows：[`windows/ZhiMai-Connect-0.2.0-win-x64-setup.exe`](windows/ZhiMai-Connect-0.2.0-win-x64-setup.exe)，约 108 MiB。
- Android：[`android/ZhiMai-Connect-0.2.0-test.apk`](android/ZhiMai-Connect-0.2.0-test.apk)，约 7.5 MiB。

这是本机测试产物，尚未公开发布。Windows 程序未配置发布者签名，APK 使用 debug 测试签名；请只使用自己构建或核对来源的安装包，不关闭系统全局安全防护。

## 怎么开始

Windows 双击安装程序，可以选择安装位置。已实际安装并测试的副本位于：

```text
E:\CodexData\ZhiMaiBuildTools\installed-test\ZhiMaiConnect\ZhiMai Connect.exe
```

Android 将 APK 传到手机后打开安装；如系统询问，为当前文件管理器临时允许安装该文件。要求 Android 7.0+、Android System WebView 111+。APK 不需要电脑常开，也不需要先访问 Cloudflare 网页。

雷电已创建独立实例 **ZhiMai-Test（序号 3）**，装好最终 APK 并载入 10 人合成家庭资料，可直接打开知脉。原有三个实例未改动。该测试实例的 WebView 已单独更新，旧组件备份在 `E:\CodexData\ZhiMaiBuildTools\downloads\ld-webview91.apk`；测试签名组件仅供此模拟器使用，不要传给手机。

进入应用后：

1. 在空库载入演示数据，或导入已有 JSON 完整备份。
2. 在“更多 → AI 助理”配置模型接口、模型名和 API Key；Android 当前使用 HTTPS 接口。测试连接后按需保存配置。包内没有密钥，测试用密钥已清除。
3. 试一次“写一段话 → AI 整理 → 核对批准”，再到人物关系页查看结果。
4. 断网查看资料、关闭重开，最后导出 JSON 完整备份。

浏览器、EXE 和 APK 各自保存资料，不自动同步。通过 JSON 完整备份迁移正式记录，原始材料和未提交草稿另存。手机卸载应用会清除私有数据；新包同签名覆盖安装已验证保留资料。

## 已验证与待确认

两个平台均通过：安装后启动、离线加载、10 人合成资料、关闭重开保留、真实模型连接、JSON 文件保存。Windows PDF 输出通过。

雷电 PDF 操作会触发其系统打印服务 `com.android.printspooler` 的资源异常；Android PDF 需手机实测。相机、麦克风及后台切换也请在手机上确认。当前没有登录、云同步、自动更新、APK 系统分享接收和关闭应用后的定时通知。

详细报告：[`../doc/history/2026-09/Windows与Android首包验证-2026-09-06.md`](../doc/history/2026-09/Windows与Android首包验证-2026-09-06.md)。

## 文件校验

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\release\windows\ZhiMai-Connect-0.2.0-win-x64-setup.exe'
Get-FileHash -Algorithm SHA256 -LiteralPath '.\release\android\ZhiMai-Connect-0.2.0-test.apk'
```

```text
Windows  575A86B2975DA057C6EB009D475881157AB891D371343C2E99D394A1A7AAD4C9
Android  B59CA30755DFF7DAFCE2C671BCD2255131039F849D3AE138D2FFCC28505E5490
```
