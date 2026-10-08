// 预加载脚本：只向页面暴露两个受控的方法，页面本身没有 Node 权限
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("stepharness", {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke("stepharness:call", method, ...args),
  onEvent: (fn: (ev: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, ev: unknown) => fn(ev);
    ipcRenderer.on("stepharness:event", handler);
    return () => ipcRenderer.removeListener("stepharness:event", handler);
  },
  platform: process.platform,
});
