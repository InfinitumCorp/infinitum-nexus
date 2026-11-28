import { render } from "preact";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";
import "./i18n/start.ts";

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
