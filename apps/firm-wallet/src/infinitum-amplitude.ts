/**
 * Privacy-first Amplitude Browser SDK bootstrap for Infinitum commercial apps.
 * The public API key may live in client config. Never use the Secret key.
 * Page views + sessions only. No form autocapture, session replay, or IP tracking.
 */
import { init } from "@amplitude/analytics-browser";

const PUBLIC_API_KEY = "756c0bc80c5cb27386bfd7b2b13196c8";

const PRIVACY_OPTIONS = {
  autocapture: {
    attribution: false,
    fileDownloads: false,
    formInteractions: false,
    pageViews: true,
    sessions: true,
    elementInteractions: false,
    frustrationInteractions: false,
    networkTracking: false,
    webVitals: false,
    performanceTracking: false,
    pageUrlEnrichment: false,
  },
  trackingOptions: { ipAddress: false },
  serverZone: "US" as const,
  fetchRemoteConfig: false,
  remoteConfig: { fetchRemoteConfig: false },
  enableDiagnostics: false,
};

export function initInfinitumAmplitude() {
  if (typeof window === "undefined") return;
  if ((window as unknown as { __infinitumAmplitudeStarted?: boolean }).__infinitumAmplitudeStarted) return;
  const envKey = (import.meta as { env?: { VITE_AMPLITUDE_API_KEY?: string } }).env?.VITE_AMPLITUDE_API_KEY;
  const apiKey = envKey || PUBLIC_API_KEY;
  if (!apiKey || apiKey.length < 16) return;
  (window as unknown as { __infinitumAmplitudeStarted?: boolean }).__infinitumAmplitudeStarted = true;
  init(apiKey, PRIVACY_OPTIONS);
}
