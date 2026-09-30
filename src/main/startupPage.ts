interface StartupPageOptions {
  locale: string;
  isMacOS: boolean;
  error?: string;
}

export function startupPageUrl({ locale, isMacOS, error }: StartupPageOptions): string {
  const russian = locale.toLowerCase().startsWith("ru");
  const titlebarHeight = isMacOS ? 32 : 44;
  const failed = typeof error === "string";
  const title = failed
    ? (russian ? "Raoden Loom не удалось запустить" : "Raoden Loom could not start")
    : (russian ? "Raoden Loom запускается" : "Raoden Loom is starting");
  const message = failed
    ? (russian ? "Проверьте подробности ниже и перезапустите приложение." : "Review the details below and restart the application.")
    : (russian ? "Подготавливаем локальные сервисы…" : "Preparing local services…");
  const detail = failed ? `<pre>${escapeHtml(error)}</pre>` : '<span class="spinner" aria-hidden="true"></span>';
  const titleBar = isMacOS
    ? '<header class="macos-titlebar"><strong>Raoden Loom</strong><div class="drag"></div></header>'
    : '<header><strong>Raoden Loom</strong><button type="button" aria-label="Close" onclick="window.close()">×</button></header>';

  const html = `<!doctype html>
<html lang="${russian ? "ru" : "en"}">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Raoden Loom</title>
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body { --titlebar-height: ${titlebarHeight}px; display: grid; grid-template-rows: var(--titlebar-height) 1fr; color: #f7f4ec; background: #292a35; font-family: Inter, system-ui, sans-serif; }
      header { display: flex; align-items: center; justify-content: space-between; padding-left: 15px; border-bottom: 1px solid rgba(255,255,255,.08); -webkit-app-region: drag; }
      header strong { font-size: 13px; letter-spacing: .02em; }
      button { width: 46px; height: 100%; border: 0; color: rgba(255,255,255,.8); background: transparent; cursor: pointer; font-size: 22px; -webkit-app-region: no-drag; }
      button:hover { color: white; background: #d85b61; }
      .macos-titlebar { justify-content: flex-start; gap: 10px; padding-left: 78px; }
      .macos-titlebar .drag { flex: 1; height: 100%; }
      main { display: grid; place-items: center; padding: 32px; background: #aaa7a2; }
      section { width: min(620px, 100%); padding: 28px; border-radius: 18px; color: #2f3038; background: #e4f1cf; box-shadow: 0 18px 48px rgba(30,31,40,.22); }
      h1 { margin: 0 0 9px; font-size: 24px; }
      p { margin: 0; color: #585965; font-size: 14px; line-height: 1.5; }
      pre { max-height: 230px; margin: 20px 0 0; padding: 14px; overflow: auto; border-radius: 10px; color: #f7f4ec; background: #353642; font: 12px/1.45 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
      .spinner { width: 34px; height: 34px; margin-top: 22px; display: block; border: 4px solid rgba(47,48,56,.2); border-top-color: #353642; border-radius: 50%; animation: spin .8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    ${titleBar}
    <main><section><h1>${title}</h1><p>${message}</p>${detail}</section></main>
  </body>
</html>`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]!);
}
