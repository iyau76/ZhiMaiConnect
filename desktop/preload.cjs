const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zhimaiNative", {
  platform: "windows",
  request(input, callback) {
    const channel = `zhimai-http:${input.id}`;
    const listener = (_event, packet) => {
      callback(packet);
      if (packet.type === "end" || packet.type === "error")
        ipcRenderer.removeListener(channel, listener);
    };
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke("zhimai-http", input).catch(() => {
      ipcRenderer.removeListener(channel, listener);
      callback({ type: "error", message: "原生网络请求未能完成" });
    });
  },
  cancel(id) {
    ipcRenderer.send("zhimai-http-cancel", id);
  },
  saveFile(input) {
    return ipcRenderer.invoke("zhimai-save-file", input);
  },
  printHtml(input) {
    return ipcRenderer.invoke("zhimai-print-html", input);
  },
});
