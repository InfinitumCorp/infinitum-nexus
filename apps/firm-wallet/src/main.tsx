import { initInfinitumAmplitude } from "./infinitum-amplitude";
import { render } from "preact";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";

render(<App />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

initInfinitumAmplitude();
