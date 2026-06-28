import { render } from "preact";
import { App } from "./ui/App";
import "./styles/tokens.css";
import "./styles/app.css";

const root = document.getElementById("app");
if (root) {
  root.replaceChildren();
  render(<App />, root);
}
