// Electron 主进程：窗口管理，以及把内核（Agent）的能力通过 IPC 提供给界面
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  Agent, apiKeySource, defaultModel, fetchProviderModels, findModel, getProvider, listModels, listProviders, loadConfig, modelKey,
  PROVIDER_PRESETS, rememberCwd, removeProvider, resolveApiKey, saveConfig, saveProvider, secretStoreName, setSecret, deleteSecret,
  SessionStore, projectDocs, assertSessionFile, sandboxAvailable, STEPHARNESS_DIR,
  type ProviderConfig,
  type AgentEvent, type ApprovalDecision, type ApprovalMode, type ApprovalRequest, type ImageBlock, type ModelInfo, type ThinkingLevel,
} from "../core/index.js";

const isDev = process.argv.includes("--dev");
app.setName("StepHarness");

// 从 Finder 启动的应用拿不到终端里的 PATH，这里从登录 shell 读取一次
function loadShellEnv() {
  if (process.platform === "win32") return;
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", "printf '__STEPHARNESS_PATH__%s__END__' \"$PATH\""], { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/__STEPHARNESS_PATH__(.*)__END__/s);
    if (m?.[1]) process.env.PATH = m[1];
  } catch {}
}
loadShellEnv();

let win: BrowserWindow | null = null;
let agent: Agent | null = null;
let unsubscribe: (() => void) | null = null;
/** 还没有配置任何模型时使用的占位模型：可以打开界面，但发送消息会提示先添加服务 */
const NO_MODEL: ModelInfo = { id: "", name: "未配置模型", api: "anthropic-messages", provider: "", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const pendingApprovals = new Map<string, ApprovalRequest>();
let queue: string[] = [];

const realDir = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const send = (ev: unknown) => win?.webContents.send("stepharness:event", ev);

/** 当前模型：优先沿用正在用的，其次是默认模型，都没有时用占位模型 */
function pickModel(current?: ModelInfo): ModelInfo {
  return (current && current.id && findModel(modelKey(current))) || defaultModel() || NO_MODEL;
}

function attach(next: Agent) {
  if (agent?.running) agent.abort();
  unsubscribe?.();
  pendingApprovals.clear();
  queue = [];
  agent = next;
  unsubscribe = next.on((e: AgentEvent) => {
    if (e.type === "approval_request") pendingApprovals.set(e.request.id, e.request);
    if (e.type === "approval_resolved") pendingApprovals.delete(e.id);
    if (e.type === "queue") queue = e.pending;
    send(e);
  });
  rememberCwd(next.cwd);
  send({ type: "reset", snapshot: snapshot() });
}

function newAgent(cwd: string, sessionFile?: string): Agent {
  const cfg = loadConfig();
  const common = {
    model: pickModel(agent?.model),
    thinking: agent?.thinking ?? cfg.thinking ?? "low",
    approvalMode: agent?.approvalMode ?? cfg.approvalMode ?? "auto-edit",
    getApiKey: (m: ModelInfo) => resolveApiKey(m.provider),
    sandbox: cfg.sandbox ?? true,
    sandboxWritableRoots: cfg.sandboxWritableRoots ?? [],
    autoCompact: cfg.autoCompact ?? true,
  };
  if (sessionFile) {
    const { store, messages, display } = SessionStore.load(sessionFile);
    return new Agent({ ...common, cwd: realDir(store.cwd), session: store, messages, display });
  }
  return new Agent({ ...common, cwd: realDir(cwd) });
}

/** 服务或模型列表变化后：当前模型被删了就换成默认模型，并通知界面 */
function refreshAgentModel() {
  if (!agent) return;
  agent.model = pickModel(agent.model);
  send({ type: "model_changed", model: agent.model, modelKey: agent.model.id ? modelKey(agent.model) : "", providerCount: listProviders().length });
}

function snapshot() {
  const a = agent!;
  const cfg = loadConfig();
  return {
    cwd: a.cwd,
    home: os.homedir(),
    sessionFile: a.session.exists ? a.session.file : null,
    title: a.title,
    messages: a.display,
    running: a.running,
    compacting: a.compacting,
    sandbox: a.sandbox,
    sandboxAvailable: sandboxAvailable(),
    autoCompact: a.autoCompact,
    model: a.model,
    thinking: a.thinking,
    approvalMode: a.approvalMode,
    stats: a.stats(),
    queue,
    approvals: [...pendingApprovals.values()],
    recentCwds: (cfg.recentCwds || []).filter((c) => fs.existsSync(c)),
    docs: projectDocs(a.cwd).map((d) => d.file),
    modelKey: a.model.id ? modelKey(a.model) : "",
    providerCount: listProviders(cfg).length,
  };
}

// ---------- IPC ----------
type Handler = (...args: any[]) => unknown;
const api: Record<string, Handler> = {
  snapshot: () => snapshot(),
  models: () => {
    const names = new Map(listProviders().map((p) => [p.id, p.name]));
    return listModels().map((m) => ({ key: modelKey(m), id: m.id, provider: m.provider, providerName: names.get(m.provider) ?? m.provider, input: m.input, reasoning: m.reasoning }));
  },

  prompt: (text: string, images: ImageBlock[] = []) => agent!.prompt(text, images),
  abort: () => agent!.abort(),
  clearQueue: () => agent!.clearQueue(),
  approve: (id: string, decision: ApprovalDecision) => agent!.respondApproval(id, decision),

  setModel: (key: string) => {
    const m = findModel(key);
    if (!m) throw new Error(`找不到模型 ${key}`);
    agent!.model = m;
    saveConfig({ defaultModel: key });
    return { model: m, modelKey: key };
  },
  setThinking: (level: ThinkingLevel) => { agent!.thinking = level; saveConfig({ thinking: level }); },
  setApprovalMode: (mode: ApprovalMode) => { agent!.approvalMode = mode; saveConfig({ approvalMode: mode }); },
  setTitle: (title: string) => agent!.setTitle(title),
  compact: () => agent!.compactNow(),
  setSandbox: (on: boolean) => { agent!.sandbox = !!on; saveConfig({ sandbox: !!on }); return agent!.sandbox; },
  setAutoCompact: (on: boolean) => { agent!.autoCompact = !!on; saveConfig({ autoCompact: !!on }); },

  newSession: () => { attach(newAgent(agent!.cwd)); },
  listSessions: (cwd?: string) => SessionStore.list(cwd ?? agent!.cwd),
  openSession: (file: string) => { attach(newAgent("", assertSessionFile(file))); },
  deleteSession: (file: string) => {
    SessionStore.remove(file);
    if (agent?.session.file === file) attach(newAgent(agent.cwd));
  },
  openWorkspace: (dir: string) => {
    const d = realDir(dir.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) throw new Error(`目录不存在：${d}`);
    attach(newAgent(d));
  },
  chooseWorkspace: async () => {
    const r = await dialog.showOpenDialog(win!, { title: "选择工作区", defaultPath: agent?.cwd, properties: ["openDirectory", "createDirectory"] });
    if (r.canceled || !r.filePaths[0]) return false;
    attach(newAgent(r.filePaths[0]));
    return true;
  },

  getSettings: () => {
    const c = loadConfig();
    return {
      dataDir: STEPHARNESS_DIR, secretStore: secretStoreName(),
      sandbox: agent!.sandbox, sandboxAvailable: sandboxAvailable(), autoCompact: agent!.autoCompact, writableRoots: c.sandboxWritableRoots ?? [],
    };
  },
  saveSettings: (s: { writableRoots?: string[] }) => {
    if (Array.isArray(s.writableRoots)) {
      const roots = s.writableRoots.map((r) => String(r).trim().replace(/^~(?=$|\/)/, os.homedir())).filter((r) => r && path.isAbsolute(r));
      saveConfig({ sandboxWritableRoots: roots });
      agent!.sandboxWritableRoots = roots;
    }
  },

  // ---- 模型服务与 API Key（Key 只进不出：界面只能看到「是否已配置」和来源） ----
  presets: () => PROVIDER_PRESETS,
  providers: () => listProviders().map((p) => ({ ...p, key: apiKeySource(p.id) })),
  saveProvider: (p: ProviderConfig, opts: { isNew?: boolean; apiKey?: string } = {}) => {
    const saved = saveProvider(p, { isNew: opts.isNew });
    if (opts.apiKey) setSecret(saved.id, opts.apiKey);
    refreshAgentModel();
    return { ...saved, key: apiKeySource(saved.id) };
  },
  removeProvider: (id: string) => { removeProvider(id); refreshAgentModel(); },
  clearProviderKey: (id: string) => { deleteSecret(id); return apiKeySource(id); },
  /** 获取模型列表。可以传入还没保存的服务配置和 Key（添加服务时先试一下） */
  fetchModels: async (p: ProviderConfig, apiKey?: string) => {
    const key = apiKey || (getProvider(p.id) ? resolveApiKey(p.id) : "");
    return fetchProviderModels(p, key);
  },

  // 只在访达中显示，不会打开或执行文件
  revealPath: (p: string) => { if (typeof p === "string" && path.isAbsolute(p)) shell.showItemInFolder(p); },
  openExternal: (url: string) => { if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url); },
};

/** 只接受来自我们自己窗口、自己页面的调用 */
const RENDERER_FILE = path.join(__dirname, "renderer", "index.html");
function trustedSender(e: IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) return false;
  try {
    // 比较解码后的文件路径，而不是 URL 字符串：路径里有空格、中文时两边的编码方式可能不同
    const u = new URL(e.senderFrame.url);
    return u.protocol === "file:" && path.normalize(fileURLToPath(u)) === path.normalize(RENDERER_FILE);
  } catch {
    return false;
  }
}

ipcMain.handle("stepharness:call", async (e, method: string, ...args: unknown[]) => {
  if (!trustedSender(e)) throw new Error("拒绝来自未知来源的调用");
  if (typeof method !== "string" || !Object.prototype.hasOwnProperty.call(api, method)) throw new Error(`未知方法：${method}`);
  return api[method](...args);
});

// ---------- 窗口 ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    title: "StepHarness",
    backgroundColor: "#0f0f10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadURL(pathToFileURL(RENDERER_FILE).href);
  // 链接用系统浏览器打开；拖入文件时不要跳转页面
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (isDev) win.webContents.openDevTools({ mode: "detach" });
  win.on("closed", () => { win = null; });
}

function buildMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    {
      label: "文件",
      submenu: [
        { label: "新对话", accelerator: "CmdOrCtrl+N", click: () => send({ type: "menu", action: "new" }) },
        { label: "打开工作区…", accelerator: "CmdOrCtrl+O", click: () => send({ type: "menu", action: "open" }) },
        { type: "separator" },
        { label: "设置…", accelerator: "CmdOrCtrl+,", click: () => send({ type: "menu", action: "settings" }) },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // 不需要摄像头、麦克风、定位、通知等任何权限，全部拒绝
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const cfg = loadConfig();
  // argv 里可能包含应用自身的路径（开发模式）和各种启动参数，都要排除
  const appPath = realDir(app.getAppPath());
  const userArgs = process.argv.slice(1).filter((a) => !a.startsWith("-") && realDir(a) !== appPath);
  const argCwd = userArgs.find((a) => fs.existsSync(a) && fs.statSync(a).isDirectory());
  const startCwd = argCwd || (cfg.lastCwd && fs.existsSync(cfg.lastCwd) ? cfg.lastCwd : os.homedir());
  try {
    agent = newAgent(startCwd);
    attach(agent);
  } catch (err) {
    dialog.showErrorBox("StepHarness 启动失败", (err as Error).message);
    app.quit();
    return;
  }
  buildMenu();
  createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on("window-all-closed", () => {
  agent?.abort();
  app.quit();
});
