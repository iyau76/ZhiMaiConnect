# 知脉 Connect 0.3.6 安装测试

## 安装包

- Windows：[`windows/ZhiMai-Connect-0.3.6-win-x64-setup.exe`](windows/ZhiMai-Connect-0.3.6-win-x64-setup.exe)，108.71 MB。
- Android：[`android/ZhiMai-Connect-0.3.6-test.apk`](android/ZhiMai-Connect-0.3.6-test.apk)，6.92 MB。

这是本机测试产物。Windows 程序未配置发布者签名，APK 使用 debug 测试签名；请只使用自己构建或核对过来源的安装包，也不要为了装它关掉系统全局安全防护。

Android 的 versionCode 是 9，可以直接覆盖 0.3.5（8）及更早的测试包。覆盖安装前先在设置页导出 JSON 完整备份。

## 怎么开始

Windows 双击安装程序，安装位置可以自己选。

Android 把 APK 传到手机后打开安装；系统询问时，为当前文件管理器临时允许安装该文件。要求 Android 7.0+、Android System WebView 111+。装好之后不需要电脑常开，也不需要先访问网页版。

进入应用以后：

1. 在空库载入演示资料，或者导入已有的 JSON 完整备份。
2. 在「AI 助理 → 模型配置」里填接口地址、模型名和 API Key，测试连接后按需保存。包内没有密钥。Windows 也可以连本机 Ollama。
3. 试一次「写一段话 → AI 整理 → 逐条核对批准」，再到人物关系页看结果。
4. 断网翻一翻资料、关掉再打开，最后导出一次 JSON 完整备份。

浏览器、EXE 和 APK 各自保存资料，不自动同步。换设备用 JSON 完整备份迁移；还没整理的材料不随备份导出，原始文件和草稿要自己另存。手机卸载应用会清掉私有数据。

## 本版校验状态

已经核对过的：

| 项目 | 结果 |
| --- | --- |
| Windows 安装包版本 | 文件版本 0.3.6，产品版本 0.3.6 |
| Android 包版本 | aapt 读出 versionName 0.3.6、versionCode 9 |
| 构建来源 | `main` 的 `3e43a91`（含 PR #10 恢复的减法改动） |
| 包体大小 | exe 113,986,035 字节；apk 7,251,543 字节 |
| 网页版 | 已部署，Worker 版本 `5cd93971-82ff-44f4-ad2c-309813278f27`，PWA 指纹 `0a984ba4b1d987b3` |

已经通过：`npm run check`（113 个测试文件、1025 条用例）、`npm run build`、`npm run e2e`（84 条里 78 条通过，6 条要连公开部署或装成 PWA 才跑，0 失败）。

这一版**没有**重新做 Windows 安装启动和 Android 真机验收。拍照、录音、PDF 导出、系统分享这几项，仍然沿用 2026-09-06 那轮的结论，见下方文档链接。模拟器里的独立测试实例（雷电 ZhiMai-Test，序号 3）装的是 0.2.x 时期的包，要重新验收请先覆盖安装本版。

## 文件校验

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath '.\release\windows\ZhiMai-Connect-0.3.6-win-x64-setup.exe'
Get-FileHash -Algorithm SHA256 -LiteralPath '.\release\android\ZhiMai-Connect-0.3.6-test.apk'
```

```text
Windows  D29E1D695EA2AAD234FF91BB85377ACDB19F9C02C59567BD3B8100FC9A50C8F2
Android  416F7FF87B318C411BE850415E3F0B1D4070B7A429FA3422F82E202477F4A127
```

## 相关文档

- 安装版构建与测试范围：`doc/architecture/Windows与Android安装版.md`
- 上一轮真机与模拟器验收：`doc/history/2026-09/Windows与Android首包验证-2026-09-06.md`
- 网页版与 PWA 验证：`doc/history/2026-09/PWA首版实现与验证-2026-09-06.md`
- 发布页文案（GitHub Release 正文）：`release/PUBLIC_RELEASE.md`
- 校验值：`release/SHA256SUMS.txt`
