function sendSelectionCommand(command, e) {
  const text = window.getSelection().toString().trim();
  if (!text) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  chrome.runtime.sendMessage({ command, text }, () => void chrome.runtime.lastError);
}

window.addEventListener(
  "keydown",
  (e) => {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code === "KeyS") {
      sendSelectionCommand("search-selection-google", e);
    } else if (e.code === "KeyE") {
      sendSelectionCommand("search-selection-etymology", e);
    }
  },
  true
);
