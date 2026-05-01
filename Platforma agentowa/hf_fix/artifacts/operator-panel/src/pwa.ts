import { toast } from "sonner";

type RegisterSW = (options: {
  onNeedRefresh?: () => void;
  onOfflineReady?: () => void;
  onRegisterError?: (error: unknown) => void;
}) => (reloadPage?: boolean) => void | Promise<void>;

/**
 * Registers the service worker produced by vite-plugin-pwa.
 *
 * In CI / builds with PWA disabled, this becomes a safe no-op.
 */
export async function initPWA() {
  let registerSW: RegisterSW;

  try {
    const moduleId = "virtual:pwa-register";
    const mod = (await import(/* @vite-ignore */ moduleId)) as {
      registerSW: RegisterSW;
    };
    registerSW = mod.registerSW;
  } catch {
    // PWA plugin disabled or unavailable in this build
    return;
  }

  const updateSW = registerSW({
    // Called when a new SW version is waiting to activate
    onNeedRefresh() {
      toast("Update available", {
        description: "A new version of HyperFlow Operator is available.",
        duration: Infinity,
        action: {
          label: "Reload",
          onClick: () => updateSW(true),
        },
        cancel: {
          label: "Later",
          onClick: () => {},
        },
      });
    },

    // Called when app is fully cached for offline use
    onOfflineReady() {
      toast.success("HyperFlow is ready to work offline", {
        description: "Core UI and last known agent data are cached.",
        duration: 4000,
      });
    },

    // Called on registration error
    onRegisterError(error: unknown) {
      console.warn("[PWA] Service worker registration failed", error);
    },
  });

  // Network status banner
  window.addEventListener("offline", () => {
    toast.warning("You are offline", {
      description:
        "Showing cached data. Changes will sync when connection returns.",
      duration: Infinity,
      id: "offline-banner",
    });
  });

  window.addEventListener("online", () => {
    toast.dismiss("offline-banner");
    toast.success("Back online", { duration: 2000 });
  });
}