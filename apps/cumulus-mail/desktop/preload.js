// The only thing the web app can reach in the desktop shell: start signing in through the browser.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cumulusDesktop", {
  platform: process.platform,
  signInWithBrowser: () => ipcRenderer.invoke("cumulus:signin-browser"),
});
