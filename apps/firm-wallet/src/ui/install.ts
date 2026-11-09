/**
 * "Install app": the wallet is a web app that installs to the home screen on Android (Chrome's
 * install prompt) and iPhone (Share → Add to Home Screen). Free; no app store needed.
 */
import { useEffect, useState } from "preact/hooks";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPrompt | null = null;
const listeners = new Set<() => void>();

if (typeof window !== "undefined") {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPrompt;
    listeners.forEach((l) => l());
  });
  addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

export const isInstalled = () =>
  typeof window !== "undefined" && (matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);

export const isIos = () => typeof navigator !== "undefined" && /iPhone|iPad|iPod/.test(navigator.userAgent);

/** "prompt" when the browser can install now, "ios" for the Share-menu route, null when nothing to do. */
export function useInstall(): { kind: "prompt" | "ios" | null; install: () => Promise<void> } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  const kind = isInstalled() ? null : deferred ? "prompt" : isIos() ? "ios" : null;
  return {
    kind,
    install: async () => {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice.catch(() => undefined);
      deferred = null;
      listeners.forEach((l) => l());
    },
  };
}
