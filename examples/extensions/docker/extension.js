let disposables = [];
let counts = new Map();
let failures = new Map();
let active = false;
export async function activate(patchbay) {
  active = true;
  const isCompose = (component) =>
    component?.terminals.some((t) => t.id === "up");
  let panel;
  const render = () =>
    panel?.render(
      `<style>body{font:14px system-ui;color:#eee;background:#20232a;padding:16px}button{padding:8px}</style><h2>Containers</h2><p>${counts.size ? [...counts.values()].reduce((sum, n) => sum + n.count, 0) + " running containers (last successful refresh)" : "Not refreshed"}${failures.size ? " — Docker query failed; previous results are stale" : ""}</p><button onclick="patchbayView.postMessage('refresh')">Refresh</button>`,
    );
  const refresh = async (component) => {
    if (!isCompose(component)) return;
    const result = await patchbay.terminals.run(
      component.id,
      "docker compose ps --status running -q",
    );
    if (!active) return result;
    if (result.exitCode === 0 && !result.running) {
      counts.set(component.id, {
        count: result.output.trim().split("\n").filter(Boolean).length,
        at: Date.now(),
      });
      failures.delete(component.id);
    } else {
      failures.set(
        component.id,
        result.output.trim() || "Docker unavailable or command still running",
      );
    }
    await render();
    return result;
  };
  disposables.push(
    patchbay.views.registerWebviewView("acme.docker.panel", {
      resolve: (view) => {
        panel = view;
        void render();
      },
      onMessage: async (message) => {
        if (message === "refresh") {
          const p = await patchbay.project.get();
          await refresh(
            p?.components.find(
              (c) => c.id === patchbay.selection.component?.id,
            ),
          );
        }
      },
    }),
  );
  disposables.push(
    patchbay.commands.registerCommand("acme.docker.refresh", async () => {
      const project = await patchbay.project.get();
      return refresh(
        project?.components.find(
          (c) => c.id === patchbay.selection.component?.id,
        ),
      );
    }),
  );
  disposables.push(
    patchbay.badges.registerProvider((component) =>
      isCompose(component)
        ? {
            text: failures.has(component.id)
              ? "Docker unavailable/error"
              : counts.has(component.id)
                ? `${counts.get(component.id).count} containers`
                : "Not refreshed",
            tone: failures.has(component.id) ? "warning" : "info",
            tooltip:
              failures.get(component.id) ||
              (counts.has(component.id)
                ? `Last successful refresh: ${new Date(counts.get(component.id).at).toLocaleString()}`
                : "Use Refresh to query Docker."),
          }
        : null,
    ),
  );
  disposables.push(
    patchbay.context.registerProvider((component) =>
      isCompose(component)
        ? failures.has(component.id)
          ? `Docker query failed: ${failures.get(component.id)}. Previous results may be stale.`
          : counts.has(component.id)
            ? `Docker Compose has ${counts.get(component.id).count} running containers; last successful refresh ${new Date(counts.get(component.id).at).toISOString()}.`
            : "Docker Compose has not been refreshed."
        : "",
    ),
  );
  disposables.push(
    patchbay.commands.registerCommand("acme.docker.sandboxProbe", async () => {
      let parentDenied = false;
      let invokeRejected = false;
      let fileEscapeRejected = false;
      let foreignCommandRejected = false;
      try {
        void parent.document.body;
      } catch {
        parentDenied = true;
      }
      try {
        await fetch("ipc://localhost/list_extensions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } catch {
        invokeRejected = true;
      }
      // Forge the postMessage IPC transport with an app Origin and a guessed invoke key.
      // The smoke test then checks the storage write never landed.
      const forged = JSON.stringify({
        cmd: "extension_storage_set",
        callback: 1,
        error: 2,
        payload: { extensionId: "acme.docker", data: { forged: true } },
        options: { headers: { Origin: "tauri://localhost" } },
        __TAURI_INVOKE_KEY__: "guess",
      });
      const transports = [
        window.webkit?.messageHandlers?.ipc,
        window.ipc,
        window.chrome?.webview,
      ].filter((t) => typeof t?.postMessage === "function");
      for (const transport of transports) {
        try {
          transport.postMessage(forged);
        } catch {
          /* a refused transport is also fine */
        }
      }
      try {
        await patchbay.files.read("/etc/passwd");
      } catch {
        fileEscapeRejected = true;
      }
      try {
        await patchbay.commands.registerCommand("foreign.command", () => {})
          .ready;
      } catch {
        foreignCommandRejected = true;
      }
      return {
        fileEscapeRejected,
        foreignCommandRejected,
        parentDenied,
        tauriAbsent: !window.__TAURI_INTERNALS__,
        invokeRejected,
        forgedTransports: transports.length,
      };
    }),
  );
  await Promise.all(disposables.map((d) => d.ready));
}
export function deactivate() {
  active = false;
  for (const disposable of disposables) disposable.dispose();
  disposables = [];
  counts = new Map();
  failures = new Map();
}
