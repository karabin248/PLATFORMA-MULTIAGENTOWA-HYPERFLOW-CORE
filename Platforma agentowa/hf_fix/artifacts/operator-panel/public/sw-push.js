/**
 * Web Push notification handler.
 *
 * This file is registered as the push event listener in the service worker
 * context. vite-plugin-pwa injects it via workbox injectManifest or via
 * the additionalManifestEntries — here we keep it as a standalone companion
 * that can be imported by the generated SW via importScripts if needed.
 *
 * Push payload schema (from api-server NotificationService):
 * {
 *   type: "run.completed" | "run.failed" | "run.cancelled" | "run.started",
 *   runId: string,
 *   agentId: string,
 *   status: string,
 *   durationMs?: number,
 *   error?: string
 * }
 */

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { type: "unknown", runId: "?", agentId: "?" };
  }

  const titles = {
    "run.completed": "✅ Run completed",
    "run.failed": "❌ Run failed",
    "run.cancelled": "⛔ Run cancelled",
    "run.started": "▶️ Run started",
  };

  const title = titles[payload.type] ?? "HyperFlow Operator";

  const body = [
    `Agent: ${payload.agentId}`,
    payload.durationMs ? `Duration: ${(payload.durationMs / 1000).toFixed(1)}s` : null,
    payload.error ? `Error: ${payload.error}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: `run-${payload.runId}`,
    renotify: true,
    data: {
      url: `/runs/${payload.runId}`,
    },
    actions: [
      { action: "view", title: "View run" },
      { action: "dismiss", title: "Dismiss" },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "dismiss") return;

  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // If app is already open, focus it and navigate
        for (const client of windowClients) {
          if ("focus" in client) {
            client.focus();
            client.navigate(url);
            return;
          }
        }
        // Otherwise open a new window
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      }),
  );
});
