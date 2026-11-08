import { render } from "preact";
import { MiniApp } from "./Mini.tsx";
import "../ui/styles.css";

render(<MiniApp />, document.getElementById("app")!);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
