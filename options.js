import { mountShortcutsUi } from "./shortcuts-ui.js";

const root = document.getElementById("shortcutsRoot");
await mountShortcutsUi(root);

document.getElementById("optionsRefreshBtn").addEventListener("click", async () => {
  await mountShortcutsUi(root);
});
