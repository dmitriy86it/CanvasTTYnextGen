import { extname, isAbsolute } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import type {
  AppSettings,
  BrowserCommand,
  CanvasNavigationPointerBindingInput,
  CreateSessionRequest,
  PluginBrowserOpenResponse,
  PluginCanvasRequest,
  ProviderId,
  SessionBounds
} from "../../shared/contracts";
import { IPC } from "../../shared/contracts";
import { isCanvasNavigationMouseButton } from "../../shared/canvasNavigation";
import { observeWindowState, readWindowState } from "../windowState";
import type { SettingsStore } from "../services/SettingsStore";
import type { TerminalManager } from "../services/TerminalManager";
import type { LimitsService } from "../services/LimitsService";
import type { PluginManager } from "../services/PluginManager";
import type { PluginMediaService } from "../services/PluginMediaService";
import type { PluginSecretsService } from "../services/PluginSecretsService";
import type { BrowserService } from "../services/BrowserService";
import { normalizePluginBrowserUrl } from "../services/browser/PluginBrowserOpenPolicy";
import { PluginBrowserOpenBroker } from "./PluginBrowserOpenBroker";
import type { GithubAuthService } from "../services/GithubAuthService";
import type { HermesHudService } from "../services/HermesHudService";
import { normalizeExternalUrl } from "../../shared/externalUrl";
import { assertMainRenderer } from "./mainRenderer";
import { registerOrchestrationIpc } from "./orchestrationIpc";
import type { RunManager } from "../services/orchestration/manager";
import type { WorkspaceStore } from "../services/WorkspaceStore";
import type { CameraState } from "../../shared/contracts";

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

interface Dependencies {
  // a hermetic smoke of the development build: notifications go to stdout, never to the machine's Notification Center
  notesToLog?: boolean;
  settings: SettingsStore;
  terminals: TerminalManager;
  limits: LimitsService;
  plugins: PluginManager;
  pluginMedia: PluginMediaService;
  pluginSecrets: PluginSecretsService;
  browser: BrowserService;
  githubAuth: GithubAuthService;
  hermesHud: HermesHudService;
  orchestration: RunManager;
  workspaces: WorkspaceStore;
  getMainWindow(): BrowserWindow | null;
  applyBrowserSettings(settings: AppSettings): Promise<void> | void;
  setCanvasNavigationShortcutCapture(active: boolean): void;
  setCanvasNavigationPointerBinding(input: CanvasNavigationPointerBindingInput): void;
  openPluginWindow(pluginId: string, contributionId: string): Promise<void>;
  closePluginWindows(pluginId: string): void;
  requestPluginLauncher(provider: ProviderId): void;
  requestPluginCanvas(request: PluginCanvasRequest): void;
  broadcastPluginStorageChange(pluginId: string, key: string, value: unknown): void;
}

export function registerIpc({
  settings,
  terminals,
  limits,
  plugins,
  pluginMedia,
  pluginSecrets,
  browser,
  githubAuth,
  hermesHud,
  orchestration,
  workspaces,
  getMainWindow,
  applyBrowserSettings,
  setCanvasNavigationShortcutCapture,
  setCanvasNavigationPointerBinding,
  openPluginWindow,
  closePluginWindows,
  requestPluginLauncher,
  requestPluginCanvas,
  broadcastPluginStorageChange,
  notesToLog = false
}: Dependencies): void {
  // Every channel is available only to the main renderer unless it authenticates its own sender.
  const handleMain = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown
  ): void => ipcMain.handle(channel, (event, ...args) => {
    assertMainRenderer(event, getMainWindow);
    return listener(event, ...args);
  });
  const onMain = (
    channel: string,
    listener: (event: IpcMainEvent, ...args: any[]) => void
  ): void => {
    ipcMain.on(channel, (event, ...args) => {
      assertMainRenderer(event, getMainWindow);
      listener(event, ...args);
    });
  };
  registerOrchestrationIpc(handleMain, orchestration);
  const pluginBrowserOpenBroker = new PluginBrowserOpenBroker(getMainWindow);
  const requestPluginBrowserOpen = async (pluginId: string, value: unknown): Promise<void> => {
    plugins.assertPermission(pluginId, "browser:open");
    await pluginBrowserOpenBroker.request(pluginId, normalizePluginBrowserUrl(value));
  };

  handleMain(IPC.clipboardRead, () => clipboard.readText());
  onMain(IPC.clipboardWrite, (_event, text: string) => {
    if (typeof text === "string" && text.length > 0) clipboard.writeText(text);
  });
  ipcMain.handle(IPC.externalOpenUrl, (event, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return shell.openExternal(normalizeExternalUrl(value));
  });

  ipcMain.handle(IPC.appVersion, (event) => {
    assertMainRenderer(event, getMainWindow);
    return app.getVersion();
  });
  handleMain(IPC.settingsGet, () => settings.get());
  handleMain(IPC.settingsUpdate, async (_event, patch: Partial<AppSettings>) => {
    const next = await settings.update(patch);
    await applyBrowserSettings(next);
    return next;
  });
  ipcMain.on(IPC.canvasNavigationShortcutCapture, (event, active: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof active !== "boolean") return;
    setCanvasNavigationShortcutCapture(active);
  });
  ipcMain.on(IPC.canvasNavigationPointerBinding, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!isCanvasNavigationPointerBindingInput(input)) return;
    setCanvasNavigationPointerBinding(input);
  });
  ipcMain.on(IPC.canvasNavigationOwnerWheel, (event, input: unknown) => {
    assertMainRenderer(event, getMainWindow);
    browser.beginRendererWheelSequence(input);
    event.returnValue = true;
  });
  ipcMain.on(IPC.canvasNavigationPointerGesture, (event, active: boolean) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof active !== "boolean") return;
    browser.setRendererCanvasGestureActive(active);
  });

  handleMain(IPC.dialogPickDirectory, async (event, defaultPath?: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Choose a project folder",
      defaultPath: typeof defaultPath === "string" ? defaultPath : settings.get().lastDirectory,
      properties: ["openDirectory", "createDirectory"]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handleMain(IPC.dialogPickMedia, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Choose Home media",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    return { path, dataUrl: await readMedia(path) };
  });

  handleMain(IPC.mediaRead, async (_event, path: string) => {
    if (typeof path !== "string" || settings.get().mediaPath !== path) return null;
    try {
      return await readMedia(path);
    } catch (error) {
      console.warn("CanvasTTY media could not be read.", error);
      return null;
    }
  });

  handleMain(IPC.limitsGet, () => limits.get());

  ipcMain.handle(IPC.pluginsList, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.list();
  });
  ipcMain.handle(IPC.pluginsSearch, (event, query: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof query !== "string") throw new Error("Search query is required.");
    return plugins.searchGithubPlugins(query);
  });
  ipcMain.handle(IPC.pluginsShowcase, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.listShowcasePlugins();
  });
  ipcMain.handle(IPC.pluginsIcon, async (event, sourceUrls: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error("GitHub URLs are required.");
    }
    const icons = await plugins.fetchPluginIcons(sourceUrls);
    return Object.fromEntries(icons);
  });
  ipcMain.handle(IPC.pluginsManifests, async (event, sourceUrls: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (!Array.isArray(sourceUrls) || sourceUrls.some((url) => typeof url !== "string")) {
      throw new Error("GitHub URLs are required.");
    }
    const manifests = await plugins.previewManifests(sourceUrls);
    return Object.fromEntries(manifests);
  });
  ipcMain.handle(IPC.pluginsCheckUpdates, (event) => {
    assertMainRenderer(event, getMainWindow);
    return plugins.checkForUpdates();
  });
  ipcMain.handle(IPC.pluginsUpdate, async (event, pluginId: string) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string") throw new Error("Plugin identifier is required.");
    closePluginWindows(pluginId);
    return plugins.updatePlugin(pluginId);
  });
  handleMain(IPC.pluginsPreviewInstall, (_event, sourceUrl: string) => {
    if (typeof sourceUrl !== "string") throw new Error("GitHub URL is required.");
    return plugins.previewInstall(sourceUrl);
  });
  handleMain(IPC.pluginsInstall, (_event, token: string, selectedModules?: string[]) => {
    if (typeof token !== "string") throw new Error("Plugin preview token is invalid.");
    if (selectedModules !== undefined && (
      !Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")
    )) throw new Error("Plugin module selection is invalid.");
    return plugins.install(token, selectedModules);
  });
  handleMain(IPC.pluginsSetModules, async (_event, pluginId: string, selectedModules: string[]) => {
    if (!Array.isArray(selectedModules) || selectedModules.some((item) => typeof item !== "string")) {
      throw new Error("Plugin module selection is invalid.");
    }
    closePluginWindows(pluginId);
    return plugins.setModules(pluginId, selectedModules);
  });
  handleMain(IPC.pluginsSetEnabled, async (_event, pluginId: string, enabled: boolean) => {
    if (typeof enabled !== "boolean") throw new Error("Plugin enabled state is invalid.");
    try {
      return await plugins.setEnabled(pluginId, enabled);
    } finally {
      if (!enabled) closePluginWindows(pluginId);
    }
  });
  ipcMain.handle(IPC.pluginsSetHookEnabled, async (
    event,
    pluginId: string,
    hookId: string,
    enabled: boolean
  ) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof pluginId !== "string" || typeof hookId !== "string" || typeof enabled !== "boolean") {
      throw new Error("Plugin hook state is invalid.");
    }
    return plugins.setHookEnabled(pluginId, hookId, enabled);
  });
  handleMain(IPC.pluginsUninstall, async (_event, pluginId: string) => {
    closePluginWindows(pluginId);
    await pluginSecrets.revokeAll(pluginId);
    await pluginMedia.revokeAll(pluginId);
    await plugins.uninstall(pluginId);
  });
  handleMain(IPC.pluginsOpenCanvas, (
    _event,
    pluginId: string,
    contributionId: string,
    sourceCanvasInstanceId?: string
  ) => {
    const target = plugins.contribution(pluginId, contributionId);
    if (target.kind !== "canvas-app") throw new Error("Plugin contribution is not a canvas app.");
    requestPluginCanvas({
      pluginId,
      contributionId,
      ...(typeof sourceCanvasInstanceId === "string" && sourceCanvasInstanceId.length <= 80
        ? { sourceCanvasInstanceId }
        : {})
    });
  });
  handleMain(IPC.pluginsOpenWindow, (_event, pluginId: string, contributionId: string) => (
    openPluginWindow(pluginId, contributionId)
  ));
  handleMain(IPC.pluginsOpenExternal, async (_event, pluginId: string, value: string) => {
    plugins.assertPermission(pluginId, "external:open");
    const url = normalizeExternalUrl(value);
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC.pluginsOpenBrowser, async (event, pluginId: string, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    await requestPluginBrowserOpen(pluginId, value);
  });
  handleMain(IPC.pluginsStorageGet, (_event, pluginId: string, key: string) => (
    plugins.storageGet(pluginId, key)
  ));
  handleMain(IPC.pluginsStorageSet, async (_event, pluginId: string, key: string, value: unknown) => {
    await plugins.storageSet(pluginId, key, value);
    broadcastPluginStorageChange(pluginId, key, value);
  });
  handleMain(IPC.pluginsSecretsGet, (_event, pluginId: string, key: string) => (
    pluginSecrets.get(pluginId, key)
  ));
  handleMain(IPC.pluginsSecretsSet, (_event, pluginId: string, key: string, value: string) => (
    pluginSecrets.set(pluginId, key, value)
  ));
  handleMain(IPC.pluginsSecretsDelete, (_event, pluginId: string, key: string) => (
    pluginSecrets.delete(pluginId, key)
  ));
  handleMain(IPC.pluginsMediaPickLibrary, (event, pluginId: string) => (
    pickPluginMediaLibrary(event, pluginId, plugins, pluginMedia)
  ));
  handleMain(IPC.pluginsMediaListLibraries, (_event, pluginId: string) => (
    pluginMedia.listLibraries(pluginId)
  ));
  handleMain(IPC.pluginsMediaScanLibrary, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.scanLibrary(pluginId, libraryId)
  ));
  handleMain(IPC.pluginsMediaRevokeLibrary, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.revokeLibrary(pluginId, libraryId)
  ));
  handleMain(IPC.pluginsPlaylistsList, (_event, pluginId: string, libraryId: string) => (
    pluginMedia.listPlaylists(pluginId, libraryId)
  ));
  handleMain(IPC.pluginsPlaylistsRead, (_event, pluginId: string, libraryId: string, playlistId: string) => (
    pluginMedia.readPlaylist(pluginId, libraryId, playlistId)
  ));
  handleMain(IPC.pluginsPlaylistsWrite, (
    _event,
    pluginId: string,
    libraryId: string,
    name: string,
    content: string
  ) => pluginMedia.writePlaylist(
    pluginId,
    stringValue(libraryId, "libraryId"),
    stringValue(name, "name"),
    playlistContent(content)
  ));
  handleMain(IPC.pluginsHermesHudStatus, (_event, pluginId: string) => {
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.status();
  });
  handleMain(IPC.pluginsHermesHudOpen, (_event, pluginId: string) => {
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.open();
  });
  handleMain(IPC.pluginsHermesHudClose, (_event, pluginId: string) => {
    plugins.assertPermission(pluginId, "hermes:hud");
    return hermesHud.close();
  });
  ipcMain.handle(IPC.pluginsHostInvoke, async (
    event,
    pluginId: string,
    contributionId: string,
    method: string,
    params: unknown
  ) => {
    const senderUrl = event.senderFrame?.url;
    if (!senderUrl) throw new Error("Plugin window sender is unavailable.");
    const contribution = assertPluginWindowSender(senderUrl, plugins, pluginId, contributionId);
    const values = params && typeof params === "object" && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    if (method === "host.getContext") {
      const plugin = plugins.list().find((candidate) => candidate.manifest.id === pluginId)!;
      return {
        apiVersion: 1,
        plugin: {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          version: plugin.manifest.version,
          permissions: plugin.manifest.permissions,
          modules: plugin.selectedModules
        },
        contribution: { id: contribution.id, kind: contribution.kind, title: contribution.title },
        appearance: { locale: settings.get().locale, palette: settings.get().palette }
      };
    }
    if (method === "storage.get") return plugins.storageGet(pluginId, stringValue(values.key, "key"));
    if (method === "storage.set") {
      const key = stringValue(values.key, "key");
      await plugins.storageSet(pluginId, key, values.value);
      broadcastPluginStorageChange(pluginId, key, values.value);
      return null;
    }
    if (method === "secrets.get") return pluginSecrets.get(pluginId, stringValue(values.key, "key"));
    if (method === "secrets.set") {
      await pluginSecrets.set(
        pluginId,
        stringValue(values.key, "key"),
        secretValue(values.value)
      );
      return null;
    }
    if (method === "secrets.delete") {
      await pluginSecrets.delete(pluginId, stringValue(values.key, "key"));
      return null;
    }
    if (method === "sessions.list") {
      plugins.assertPermission(pluginId, "sessions:read");
      return terminals.list().map((session) => ({
        id: session.id,
        provider: session.provider,
        title: session.title,
        status: session.status,
        startedAt: session.startedAt,
        exitCode: session.exitCode
      }));
    }
    if (method === "limits.get") {
      plugins.assertPermission(pluginId, "limits:read");
      return { state: "ready", snapshot: await limits.get() };
    }
    if (method === "hermesHud.getState") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.status();
    }
    if (method === "hermesHud.open") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.open();
    }
    if (method === "hermesHud.close") {
      plugins.assertPermission(pluginId, "hermes:hud");
      return hermesHud.close();
    }
    if (method === "launcher.open") {
      plugins.assertPermission(pluginId, "launcher:open");
      const provider = providerValue(values.provider);
      requestPluginLauncher(provider);
      return null;
    }
    if (method === "external.open") {
      plugins.assertPermission(pluginId, "external:open");
      await shell.openExternal(normalizeExternalUrl(values.url));
      return null;
    }
    if (method === "browser.open") {
      await requestPluginBrowserOpen(pluginId, values.url);
      return null;
    }
    if (method === "media.pickLibrary") {
      return pickPluginMediaLibrary(event, pluginId, plugins, pluginMedia);
    }
    if (method === "media.listLibraries") return pluginMedia.listLibraries(pluginId);
    if (method === "media.scanLibrary") {
      return pluginMedia.scanLibrary(pluginId, stringValue(values.libraryId, "libraryId"));
    }
    if (method === "media.revokeLibrary") {
      await pluginMedia.revokeLibrary(pluginId, stringValue(values.libraryId, "libraryId"));
      return null;
    }
    if (method === "playlists.list") {
      return pluginMedia.listPlaylists(pluginId, stringValue(values.libraryId, "libraryId"));
    }
    if (method === "playlists.read") {
      return pluginMedia.readPlaylist(
        pluginId,
        stringValue(values.libraryId, "libraryId"),
        stringValue(values.playlistId, "playlistId")
      );
    }
    if (method === "playlists.write") {
      return pluginMedia.writePlaylist(
        pluginId,
        stringValue(values.libraryId, "libraryId"),
        stringValue(values.name, "name"),
        playlistContent(values.content)
      );
    }
    if (method === "window.open") {
      const targetId = stringValue(values.contributionId, "contributionId");
      const target = plugins.contribution(pluginId, targetId);
      if (target.kind !== "window") throw new Error("Plugin requested an unknown window contribution.");
      await openPluginWindow(pluginId, targetId);
      return null;
    }
    if (method === "canvas.open") {
      const targetId = stringValue(values.contributionId, "contributionId");
      const target = plugins.contribution(pluginId, targetId);
      if (target.kind !== "canvas-app") throw new Error("Plugin requested an unknown canvas contribution.");
      requestPluginCanvas({ pluginId, contributionId: targetId });
      return null;
    }
    throw new Error(`Unsupported plugin method: ${String(method).slice(0, 80)}.`);
  });

  ipcMain.handle(IPC.pluginsBrowserOpenResponded, (event, response: unknown) => {
    assertMainRenderer(event, getMainWindow);
    return pluginBrowserOpenBroker.complete(pluginBrowserOpenResponse(response));
  });

  ipcMain.handle(IPC.browserGetState, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.getState();
  });
  ipcMain.handle(IPC.browserOpen, (event, url?: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.open(url);
  });
  ipcMain.handle(IPC.browserClose, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.close();
  });
  ipcMain.handle(IPC.browserCloseAllTabs, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.closeAllTabs();
  });
  ipcMain.handle(IPC.browserNewTab, (event, url?: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.newTab(url);
  });
  ipcMain.handle(IPC.browserSelectTab, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.selectTab(id);
  });
  ipcMain.handle(IPC.browserCloseTab, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.closeTab(id);
  });
  ipcMain.handle(IPC.browserNavigate, (event, id: string, value: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.navigate(id, value);
  });
  ipcMain.handle(IPC.browserBack, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.back(id);
  });
  ipcMain.handle(IPC.browserForward, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.forward(id);
  });
  ipcMain.handle(IPC.browserReload, (event, id: string) => {
    assertMainRenderer(event, getMainWindow);
    return browser.reload(id);
  });
  ipcMain.handle(IPC.browserExecute, (event, command: BrowserCommand) => {
    assertMainRenderer(event, getMainWindow);
    return browser.executeHuman(command);
  });
  ipcMain.handle(IPC.browserGetActivity, (event, sinceSequence?: number) => {
    assertMainRenderer(event, getMainWindow);
    return browser.getActivity(sinceSequence);
  });
  ipcMain.handle(IPC.browserClearData, (event) => {
    assertMainRenderer(event, getMainWindow);
    return browser.clearData();
  });
  ipcMain.on(IPC.browserFocus, (event) => {
    assertMainRenderer(event, getMainWindow);
    browser.focus();
  });
  ipcMain.on(IPC.browserSetInputFocused, (event, focused: unknown) => {
    assertMainRenderer(event, getMainWindow);
    browser.setInputFocused(focused === true);
    event.returnValue = true;
  });
  ipcMain.on(IPC.browserSetViewport, (event, bounds) => {
    assertMainRenderer(event, getMainWindow);
    browser.setViewport(bounds);
  });
  ipcMain.on(IPC.browserPageWheelDecision, (event, input: unknown) => {
    event.returnValue = browser.decidePageWheel(event.sender, input);
  });
  ipcMain.on(IPC.browserPageWheel, (event, input: unknown) => {
    browser.handlePageWheel(event.sender, input);
  });

  ipcMain.handle(IPC.githubAuthStatus, (event) => {
    assertMainRenderer(event, getMainWindow);
    return githubAuth.status();
  });
  ipcMain.handle(IPC.githubAuthStart, async (event) => {
    assertMainRenderer(event, getMainWindow);
    const flow = await githubAuth.startDeviceFlow();
    // The trusted renderer chooses the built-in or system browser after it
    // receives this validated device-flow payload.
    return {
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      interval: flow.interval,
      expiresAt: flow.expiresAt
    };
  });
  ipcMain.handle(IPC.githubAuthSignOut, (event) => {
    assertMainRenderer(event, getMainWindow);
    return githubAuth.signOut();
  });
  ipcMain.handle(IPC.githubAuthOpenUrl, (event, value: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof value !== "string") throw new Error("URL is required.");
    return shell.openExternal(safeGithubUrl(value));
  });

  handleMain(IPC.terminalList, () => terminals.list());
  ipcMain.handle(IPC.terminalReadBuffer, (event, id: unknown) => {
    assertMainRenderer(event, getMainWindow);
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    return terminals.readBuffer(id);
  });
  handleMain(IPC.terminalCreate, (_event, request: CreateSessionRequest) => terminals.create(request));
  handleMain(IPC.terminalRestart, (_event, id: string) => terminals.restart(id));
  onMain(IPC.terminalInput, (_event, id: string, data: string) => terminals.input(id, data));
  onMain(IPC.terminalResize, (_event, id: string, cols: number, rows: number) => {
    terminals.resize(id, cols, rows);
  });
  onMain(IPC.terminalBounds, (_event, id: string, bounds: SessionBounds) => terminals.setBounds(id, bounds));
  handleMain(IPC.terminalRename, (_event, id: string, title: string) => terminals.rename(id, title));
  handleMain(IPC.terminalDispose, (_event, id: string) => terminals.dispose(id));
  handleMain(IPC.terminalStop, (_event, id: string) => {
    if (typeof id !== "string") throw new Error("Terminal session ID is required.");
    return terminals.stop(id);
  });
  handleMain(IPC.terminalSetWorkspace, (_event, id: unknown, workspaceId: unknown) => {
    if (typeof id !== "string" || typeof workspaceId !== "string") throw new Error("Invalid terminal workspace request.");
    return terminals.setWorkspace(id, workspaceId);
  });

  // Project workspaces (workspaces-spec.md §4): every rule is the store's; arguments are checked here first.
  const wsId = (v: unknown): string => {
    if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error("Invalid workspace id.");
    return v;
  };
  const wsRoot = (v: unknown): string | null => {
    if (v === null) return null;
    if (typeof v !== "string" || !isAbsolute(v) || v.length > 4_096 || v.includes("\0")) throw new Error("Invalid workspace folder.");
    return v;
  };
  handleMain(IPC.workspacesGet, () => workspaces.get());
  handleMain(IPC.workspacesCreate, (_event, input: unknown) => {
    const o = input as { title?: unknown; root?: unknown; activate?: unknown } | null;
    if (!o || typeof o !== "object" || typeof o.title !== "string" || o.title.length > 200) throw new Error("Invalid workspace request.");
    if (o.activate !== undefined && typeof o.activate !== "boolean") throw new Error("Invalid workspace request.");
    return workspaces.create({ title: o.title, root: wsRoot(o.root ?? null), ...(o.activate === false ? { activate: false } : {}) });
  });
  handleMain(IPC.workspacesUpdate, (_event, id: unknown, patch: unknown) => {
    const o = patch as { title?: unknown; root?: unknown } | null;
    if (!o || typeof o !== "object" || (o.title !== undefined && (typeof o.title !== "string" || o.title.length > 200))) throw new Error("Invalid workspace request.");
    return workspaces.update(wsId(id), { ...(o.title !== undefined ? { title: o.title as string } : {}), ...(o.root !== undefined ? { root: wsRoot(o.root) } : {}) });
  });
  handleMain(IPC.workspacesActivate, (_event, id: unknown) => workspaces.activate(wsId(id)));
  handleMain(IPC.workspacesSetCamera, (_event, id: unknown, camera: unknown) => workspaces.setCamera(wsId(id), camera as CameraState));
  handleMain(IPC.workspacesClose, (_event, id: unknown) => workspaces.close(wsId(id)));
  handleMain(IPC.workspacesReopen, (_event, id: unknown) => workspaces.reopen(wsId(id)));
  handleMain(IPC.workspacesRemove, (_event, id: unknown) => workspaces.remove(wsId(id)));

  const publishWindowState = (window: BrowserWindow): void => {
    if (!window.isDestroyed()) window.webContents.send(IPC.windowState, readWindowState(window));
  };

  const mainWindow = getMainWindow();
  if (mainWindow) observeWindowState(mainWindow, () => publishWindowState(mainWindow));

  // Orchestration notifications (UX audit PR 3). The renderer decides what to tell (notify.ts); here the system shows
  // it, and a click brings the window forward and tells the renderer which run to open.
  const shownNotes = new Set<Notification>(); // held until closed: a collected notification loses its click
  handleMain(IPC.notifyShow, (_event, note: unknown) => {
    const n = note as { runId?: unknown; title?: unknown; body?: unknown } | null;
    if (!n || typeof n.runId !== "string" || !/^[\w-]{1,80}$/.test(n.runId) || typeof n.title !== "string" || typeof n.body !== "string") throw new Error("Invalid notification.");
    if (notesToLog) { console.log(`[smoke] notify ${JSON.stringify({ runId: n.runId, title: n.title, body: n.body })}`); return { shown: true }; }
    if (!Notification.isSupported()) { console.log(`[notify] unsupported ${n.runId}`); return { shown: false }; }
    const runId = n.runId;
    console.log(`[notify] requested ${runId}`);
    const shown = new Notification({ title: n.title.slice(0, 120), body: n.body.slice(0, 240), silent: false });
    const done = (): void => { shownNotes.delete(shown); };
    shown.on("click", () => {
      done();
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      app.focus({ steal: true });
      window.webContents.send(IPC.notifyClick, runId);
    });
    shown.on("close", done);
    // what macOS did with it goes to the log (no text of the notification): the packaged check reads it
    shown.on("show", () => console.log(`[notify] shown ${runId}`));
    shown.on("failed", (_e, error) => {
      console.log(`[notify] failed ${runId}: ${String(error).slice(0, 200)}`);
      done();
      const window = getMainWindow();
      if (window && !window.isDestroyed()) window.webContents.send(IPC.notifyFailed, runId);
    });
    shownNotes.add(shown);
    shown.show();
    return { shown: true };
  });
  onMain(IPC.notifyBadge, (_event, count: unknown) => {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count >= 10_000) return;
    if (notesToLog) console.log(`[smoke] notify badge ${count}`);
    else app.setBadgeCount(count);
  });
  onMain(IPC.notifyBounce, () => { if (notesToLog) console.log("[smoke] notify bounce"); else app.dock?.bounce("informational"); });

  onMain(IPC.windowMinimize, (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  handleMain(IPC.windowToggleMaximize, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return readWindowState(null);
    window.isMaximized() ? window.unmaximize() : window.maximize();
    return readWindowState(window);
  });
  onMain(IPC.windowClose, (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  handleMain(IPC.windowGetState, (event) => readWindowState(BrowserWindow.fromWebContents(event.sender)));
}

function isCanvasNavigationPointerBindingInput(
  value: unknown
): value is CanvasNavigationPointerBindingInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.button === "string"
    && isCanvasNavigationMouseButton(input.button)
    && typeof input.pressed === "boolean"
    && typeof input.altKey === "boolean"
    && typeof input.ctrlKey === "boolean"
    && typeof input.metaKey === "boolean"
    && typeof input.shiftKey === "boolean";
}

function safeGithubUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("GitHub URL is invalid.");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password) {
    throw new Error("Only HTTPS github.com URLs may be opened here.");
  }
  return url.toString();
}

function pluginBrowserOpenResponse(value: unknown): PluginBrowserOpenResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Plugin browser.open response is invalid.");
  }
  const response = value as Record<string, unknown>;
  if (typeof response.requestId !== "string" || !/^plugin-browser-[a-z0-9]+$/.test(response.requestId)) {
    throw new Error("Plugin browser.open response ID is invalid.");
  }
  if (typeof response.ok !== "boolean") throw new Error("Plugin browser.open response is invalid.");
  if (response.error !== undefined && (typeof response.error !== "string" || response.error.length > 240)) {
    throw new Error("Plugin browser.open response error is invalid.");
  }
  return response.error === undefined
    ? { requestId: response.requestId, ok: response.ok }
    : { requestId: response.requestId, ok: response.ok, error: response.error };
}

function assertPluginWindowSender(
  senderUrl: string,
  plugins: PluginManager,
  pluginId: string,
  contributionId: string
) {
  const contribution = plugins.contribution(pluginId, contributionId);
  if (contribution.kind !== "window") throw new Error("Plugin host request is not from a window contribution.");
  const actual = new URL(senderUrl);
  const expected = new URL(plugins.entryUrl(pluginId, contributionId));
  if (
    actual.protocol !== expected.protocol
    || actual.hostname !== expected.hostname
    || actual.pathname !== expected.pathname
  ) throw new Error("Plugin window identity does not match its loaded entry.");
  return contribution;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error(`Plugin ${label} parameter is invalid.`);
  }
  return value;
}

function playlistContent(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Plugin playlist content is invalid or exceeds 4 MB.");
  }
  return value;
}

function secretValue(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new Error("Plugin secret value is invalid or exceeds 16 KB.");
  }
  return value;
}

async function pickPluginMediaLibrary(
  event: IpcMainInvokeEvent,
  pluginId: string,
  plugins: PluginManager,
  pluginMedia: PluginMediaService
) {
  plugins.assertPermission(pluginId, "media:library");
  const owner = BrowserWindow.fromWebContents(event.sender);
  const options: OpenDialogOptions = {
    title: "Choose a music library",
    properties: ["openDirectory"]
  };
  const result = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  const selected = result.filePaths[0];
  return result.canceled || !selected ? null : pluginMedia.addLibrary(pluginId, selected);
}

function providerValue(value: unknown): ProviderId {
  if (value === "terminal" || value === "codex" || value === "claude" || value === "qwen" || value === "kimi" || value === "opencode" || value === "hermes" || value === "grok" || value === "omp" || value === "pi") return value;
  throw new Error("Plugin requested an unknown launcher provider.");
}

async function readMedia(path: string): Promise<string> {
  const mime = MEDIA_MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error("Unsupported media type.");

  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > MAX_MEDIA_BYTES) {
    throw new Error("Media must be a file smaller than 25 MB.");
  }

  const content = await readFile(path);
  return `data:${mime};base64,${content.toString("base64")}`;
}
