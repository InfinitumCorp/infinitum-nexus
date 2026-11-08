import { render } from "preact";
import { MiniApp } from "./Mini.tsx";
import "../ui/styles.css";

render(<MiniApp />, document.getElementById("app")!);
