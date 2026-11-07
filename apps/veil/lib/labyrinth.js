import { can } from "./workspace.js";
/** Explicit artifact save/load from VEIL's own pages only; the server verifies the CID cookie and plan. */
export async function veilLabyrinth(origin, workspace, command, fetcher = fetch) {
  if (!can(workspace, "signin")) throw new Error("Cumulus ID sign-in required");
  const url = new URL(origin);
  if (url.username || url.password || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) throw new Error("Invalid Cumulus ID origin");
  if (!command || typeof command !== "object" || !["list", "create", "save", "load", "history", "diff", "provision"].includes(command.action)) throw new Error("Invalid Labyrinth action");
  const response = await fetcher(`${url.origin}/api/labyrinth`, { method: "POST", credentials: "include", redirect: "error", cache: "no-store", headers: { "content-type": "application/json", "x-labyrinth": "1" }, body: JSON.stringify({ ...command, product: "veil" }), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Labyrinth access denied (${response.status})`);
  return response.json();
}
