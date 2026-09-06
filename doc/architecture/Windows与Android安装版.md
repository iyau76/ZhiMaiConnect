# Windows 与 Android 安装版

安装版将页面和离线资料操作随安装包交付。Windows 使用 Electron，Android 使用 Capacitor；二者共用 React 界面、IndexedDB、Agent 运行与 `archive@2`，免登录使用。

## 下载与安装

在 [GitHub Releases](https://github.com/iyau76/ZhiMaiConnect/releases) 下载 Windows EXE 或 Android APK。发布页列出签名状态、已知问题与 SHA256 校验文件。当前为预览版；不需要自行编译，也无需下载 Source code 压缩包。

安装后先载入合成演示资料，或到 AI 助理配置自己的模型接口与密钥。升级或更换设备前，在设置页导出 JSON 完整备份。

## 与网页版的连接方式

| 入口 | 页面来源 | 模型请求 | 数据位置 |
| --- | --- | --- | --- |
| 网页 / PWA | 网站；安装后缓存公开静态资源 | 网站服务端转发到用户配置的模型接口 | 当前浏览器站点的 IndexedDB |
| Windows | 安装包内置资源，`zhimai://app` | Electron 主进程直接访问模型接口 | 当前 Windows 用户的应用数据目录 |
| Android | 安装包内置资源，WebView 中的 `https://localhost` | Android 原生网络直接访问模型接口 | 应用私有存储中的 WebView IndexedDB |

桌面和手机不需要先打开 workers.dev 下载页面。AI、天气和网络查询仍需要设备能访问相应服务；安装包不附带 API Key。各端数据独立，通过设置页的 JSON 完整备份迁移；原始材料收件箱和未提交草稿需要另外保存。

## 代码分工

- `src/components/workspace.tsx`：共享应用界面；网页路由与 `native/main.tsx` 都挂载此组件。
- `src/lib/provider-protocol.ts`：网页与原生端共用模型消息、参数和响应解释，提示词只有一份。
- `src/lib/web-tool-service.ts`：天气、新闻、公开搜索的共用逻辑，由宿主注入网络读取。
- `src/lib/api-session.ts`：网页沿用会话与服务端入口；原生端交给 `native-api.ts`。
- `src/lib/native-runtime.ts`：把原生流式 HTTP 转成标准 `Response`，并提供系统文件保存和 PDF 导出接口。
- `desktop/`：隔离的 Electron 页面与原生网络、保存窗口；渲染页不获得 Node.js 或任意文件系统权限。
- `android/`：Capacitor 工程与 `ZhimaiNativePlugin`；请求分块返回，取消不等待整个回答完成。

原生 HTTP 只改变传输层，不另建工具、预算、恢复或资料提交机制。普通页面切换继续使用同一个应用进程。关闭进程、系统杀后台或断网后，恢复仍按共享检查点规则进行；没有后台常驻推理服务。

## 本地构建

先安装项目依赖：`npm ci`。Windows 构建在 Windows 上执行。

```sh
npm run build:native
npm run desktop:dev
npm run package:windows
```

Windows 输出在 `release/windows/`，包括 NSIS 安装程序和 `win-unpacked/`。安装程序允许选择目录，以当前用户安装。未配置商业代码签名，系统可能显示未知发布者提示；正式公开分发前应配置可信签名和发布校验。

Android 构建需要 JDK 21、Android SDK Platform 36、Build Tools 和已接受的 SDK 许可。在当前终端设置 `JAVA_HOME`、`ANDROID_HOME`；可通过 `GRADLE_USER_HOME` 将缓存放到空间充足的磁盘。然后执行：

```sh
npm run package:android
```

输出在 `release/android/`。当前脚本生成 **debug 签名测试 APK**，用于手机与模拟器验收。正式发布前需设置长期保管的签名密钥；不同签名无法覆盖升级。不要把签名文件或密码提交到仓库。

`dist-native/`、Gradle 缓存、编译结果和 `release/` 均不提交。每次修改页面后重新构建、同步 Capacitor 资源并打包。安装版当前没有自动更新，需安装新包；相同应用 ID 与签名的覆盖安装应保留数据，升级前仍应导出备份。

## 手机验收与边界

- Android 7.0 及以上，并需要 Android System WebView 111 或更新版本；推荐使用仍能接收系统与 WebView 安全更新的手机。旧内核会显示更新说明。
- 雷电可能预装旧 WebView。应在独立测试实例里更新组件，保留原有实例。模拟器通过不能替代相机、麦克风、文件选择器及厂商后台策略的真机测试。
- 文件导入使用系统选择器；备份保存使用系统“创建文档”，无需全盘文件访问权限。PDF 使用系统打印服务，可选择另存为 PDF；此功能依赖设备上的打印组件，仍需真机验收。
- 当前 Android APK 尚未注册系统“分享至知脉”的入口。应用内粘贴、导入文件、录音和离线材料收件箱可用；PWA 的系统分享接收由浏览器提供。
- Android 当前要求 HTTPS 模型服务。Windows 可连接本机 HTTP Ollama；手机内的 localhost 指手机自身，不能作为电脑 Ollama 地址。
- 没有登录、云同步、关闭应用后的定时系统通知。卸载 Android 应用会删除私有数据；Windows 卸载程序配置为保留应用数据，手动清理仍会删除资料。
- 显式保存的模型密钥沿用现有本地设置存储，尚未接入 Windows 凭据库或 Android Keystore。请勿在共享设备上保存个人密钥。

## 验证命令

```sh
npm run check
npm run build
npm run e2e
npm run e2e:pwa
npm run e2e:desktop
```

原生传输测试覆盖分块输出、UTF-8、多部分文件上传、HTTP 错误、取消及与网页版共用模型参数。安装包还需检查实际打开、断网操作、重启保留、模型直连和系统导出。APK 与 EXE 需要单独打包验证，网页测试不能替代它们。

桌面测试默认运行 `dist-native/`。设置 `ZHIMAI_DESKTOP_EXE` 可指向打包后的 EXE；测试使用独立资料目录和合成场景，不读取正常应用资料。`NATIVE_LIVE_TEST=1` 时会使用进程环境中的 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`、`DEEPSEEK_BASE_URL` 执行一次真实连接测试；密钥不写进测试脚本与输出。

参考：[Capacitor Android 环境](https://capacitorjs.com/docs/getting-started/environment-setup)、[Electron 分发](https://www.electronjs.org/docs/latest/tutorial/distribution-overview)、[Electron 隔离与安全](https://www.electronjs.org/docs/latest/tutorial/security)。
