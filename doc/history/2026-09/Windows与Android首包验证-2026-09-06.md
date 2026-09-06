# Windows 与 Android 首包验证

日期：2026-09-06。首包在 `feature/stage4-local-pwa-20260905` 完成实现、打包与本机验证。随后经用户批准，源码随 `d8e801f` 合并推送至 `main`，网页/PWA 同步部署；安装包仍在本机，未公开分发。发布追记见 [PWA 验证报告](PWA首版实现与验证-2026-09-06.md#合并与生产部署追记)。

## 交付文件

| 平台 | 文件（相对项目根目录） | 大小 | 发布状态 |
| --- | --- | --- | --- |
| Windows x64 | `release/windows/ZhiMai-Connect-0.2.0-win-x64-setup.exe` | 113,203,511 字节，约 108 MiB | NSIS 当前用户安装；未配置发布者签名 |
| Android | `release/android/ZhiMai-Connect-0.2.0-test.apk` | 7,825,926 字节，约 7.5 MiB | debug 签名测试包，尚未使用长期发布签名 |

SHA-256：

```text
Windows  575A86B2975DA057C6EB009D475881157AB891D371343C2E99D394A1A7AAD4C9
Android  B59CA30755DFF7DAFCE2C671BCD2255131039F849D3AE138D2FFCC28505E5490
```

安装包保存在被 Git 忽略的 `release/`，没有上传公共下载站。该目录下的 `README.md` 记录本机安装与手机测试步骤。

## 实现范围

Windows 使用 Electron，Android 使用 Capacitor。安装包内置 React 页面，直接复用既有 IndexedDB、Agent 运行、工具、预算、批准、撤销与恢复机制。原生网络连接用户配置的模型端点，不依赖 Cloudflare 页面加载或请求中转。

网页版与安装版共用 `provider-protocol.ts` 中的模型参数、消息构造和响应解析，联网工具也共用同一业务实现。宿主只承担流式网络、取消、系统文件保存及 PDF 输出。安装包不包含开发机的环境变量或 API Key。

本轮还修复了草稿状态显示的一处错误：刷新后内容与已保存内容相同时，去重分支没有恢复“已保存”状态。现已在相同内容的分支同步恢复状态，并重新跑过完整 E2E。

## 自动化结果

| 验证 | 结果 |
| --- | --- |
| `npm run check` | TypeScript、ESLint、Prettier 通过；89 个文件、754 项单测通过 |
| `npm run build` | 通过；PWA 指纹 `ffbdcd9f702c673d`，17 个公开静态资源 |
| `npm run e2e` | 43 项通过，6 项按条件跳过：5 项 PWA 专项另跑，1 项云端冒烟未部署不运行 |
| `npm run e2e:pwa` | 5 项通过 |
| 原生页面构建 | `dist-native/` 构建通过 |
| Windows 安装包 | 构建通过，实际 NSIS 安装退出码 0，安装后启动通过 |
| Android APK | Gradle debug 构建通过，雷电实际安装与覆盖安装通过 |

新增原生测试覆盖分块输出、UTF-8、多部分文件上传、HTTP 错误、取消、浏览器回退路径及模型参数复用。

## 安装后实测

仅使用合成“家庭往来”场景。真实模型测试使用开发机环境中的凭据，通过应用“测试连接”按钮发起；完成后清除测试配置中的密钥。它验证原生网络到真实模型的连接，不等同于完整 Agent 整理流程真机验收。

| 操作 | Windows | Android / 雷电 |
| --- | --- | --- |
| 打开打包后的应用 | 通过；开发壳、解包 EXE、安装后 EXE 分别验证 | 通过；Android 9，WebView 138 |
| 载入 10 人合成场景 | 通过 | 通过 |
| 断网后重载页面并查看资料 | 通过 | 通过 |
| 进程关闭后重新打开，保留 10 人资料 | 通过 | 通过 |
| 覆盖安装最终 APK 后保留资料 | 不适用 | 通过；未卸载或清除应用数据 |
| UI 中真实模型连接测试 | 通过；Electron 原生网络 | 通过；Android 原生网络 |
| JSON 文件保存 | 通过；指定测试路径，核对落盘文件 | 通过；真实系统保存窗口操作并核对导出内容 |
| PDF | 通过；文件以 `%PDF` 开头 | 未通过；模拟器系统打印服务崩溃，待真机确认 |

Android 导出文件经设备存储拉回核对：`schema=zhimai-connect/archive@2`，10 个人物、12 条事实关系、2 个圈层、10 条成员关系、1 条事件。

### 雷电环境发现

新建独立 `ZhiMai-Test` 实例，原有三个实例未修改。预装 WebView 91 无法承载当前页面，更新该测试实例至 WebView 138 后页面正常。旧版组件保留备份，测试用组件不随 APK 分发，不要求手机使用模拟器组件。

PDF 导出触发系统打印后，崩溃日志明确记录进程为 `com.android.printspooler`，原因是其 `drawable/ic_expand_more` 资源加载失败，底层异常为 `<bitmap> requires a valid 'src' attribute`。该证据指向模拟器打印组件；没有据此宣称 Android PDF 已可用。应用重新打开和资料保留检查通过。

### 留存证据

以下均在已忽略的 `test-results/native-verification/`：

- `desktop-tested.png`：安装版桌面截图；
- `android-home.png`、`android-tested.png`：最终 APK 覆盖安装、重启后的手机界面；
- `android-backup.json`：从 Android 系统保存窗口实际导出的合成完整备份；
- `sample-backup.json`、`sample-print.pdf`：Windows 原生文件保存与 PDF 验证输出。

## 下一轮手机测试

1. 安装测试 APK，首次打开空库，检查软键盘、安全区、手势返回和人物关系图触摸操作。
2. 配置可访问的 HTTPS 模型接口；执行自然语言录入、批准、问答与修改，检查实际 Agent 闭环。
3. 导入一份合成 JSON 完整备份，再导出并在电脑恢复；检查系统文件选择器与权限提示。
4. 实测拍照、录音、转写与 PDF。模拟器不替代这些设备功能的真机验收。
5. 正在编辑或模型运行时切到其他应用，再返回；检查草稿保留及中断任务恢复。

当前没有登录、云同步、自动更新、Android 系统分享接收或退出应用后的定时系统通知。APK 卸载会删除应用私有资料；显式保存的模型密钥尚未使用系统凭据库或 Keystore。正式分发前需确定长期签名与更新方案。
