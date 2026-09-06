const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell } = require("electron");
const { join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { writeFile } = require("node:fs/promises");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "zhimai",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
// Stable application identity keeps IndexedDB and settings across installs.
app.setName("ZhiMaiConnect");
const requests = new Map();
function trusted(url) {
  const parsed = new URL(url);
  return parsed.protocol === "zhimai:" && parsed.host === "app";
}
function requireApp(event) {
  if (!event.senderFrame || !trusted(event.senderFrame.url)) throw new Error("App frame required");
}
function openExternal(url) {
  if (["https:", "http:"].includes(new URL(url).protocol)) void shell.openExternal(url);
}

app.whenReady().then(() => {
  const webRoot = app.isPackaged
    ? join(process.resourcesPath, "web")
    : resolve(__dirname, "../dist-native");
  protocol.handle("zhimai", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "app") return new Response("Not found", { status: 404 });
    const relative =
      url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).slice(1);
    const file = resolve(webRoot, relative);
    if (!file.startsWith(webRoot + sep)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  ipcMain.handle("zhimai-http", async (event, input) => {
    requireApp(event);
    const url = new URL(input.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      throw new Error("HTTP or HTTPS required");
    const key = `${event.sender.id}:${input.id}`;
    const controller = new AbortController();
    requests.set(key, controller);
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    const send = (packet) => {
      if (!event.sender.isDestroyed()) event.sender.send(`zhimai-http:${input.id}`, packet);
    };
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: input.headers,
        body: input.bodyBase64 ? Buffer.from(input.bodyBase64, "base64") : undefined,
        signal: controller.signal,
        redirect: "manual",
      });
      send({
        type: "headers",
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
      if (response.body)
        for await (const chunk of response.body) {
          timer.refresh();
          send({ type: "chunk", data: Buffer.from(chunk).toString("base64") });
        }
      send({ type: "end" });
    } catch (error) {
      send({
        type: "error",
        message: controller.signal.aborted
          ? "网络请求已取消或超时"
          : `网络请求失败（${error.cause?.code || error.name}）`,
      });
    } finally {
      clearTimeout(timer);
      requests.delete(key);
    }
  });
  ipcMain.on("zhimai-http-cancel", (event, id) => {
    requireApp(event);
    requests.get(`${event.sender.id}:${id}`)?.abort();
  });
  ipcMain.handle("zhimai-save-file", async (event, input) => {
    requireApp(event);
    const selection = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "保存知脉资料",
      defaultPath: input.name,
    });
    if (selection.canceled) return { cancelled: true };
    await writeFile(selection.filePath, Buffer.from(input.data, "base64"));
    return { name: input.name };
  });
  ipcMain.handle("zhimai-print-html", async (event, input) => {
    requireApp(event);
    const selection = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: "导出 PDF",
      defaultPath: `${input.name}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (selection.canceled) return { cancelled: true };
    const printWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    try {
      await printWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(input.html));
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        pageSize: "A4",
      });
      await writeFile(selection.filePath, pdf);
      return { name: input.name };
    } finally {
      printWindow.destroy();
    }
  });
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 390,
    minHeight: 650,
    backgroundColor: "#0b1220",
    title: "知脉 Connect",
    autoHideMenuBar: true,
    icon: join(webRoot, "icons/zhimai-384.png"),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!trusted(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => {
    callback(trusted(contents.getURL()) && ["media", "fullscreen"].includes(permission));
  });
  window.webContents.on("destroyed", () => {
    for (const controller of requests.values()) controller.abort();
  });
  void window.loadURL("zhimai://app/");
});
app.on("window-all-closed", () => app.quit());
