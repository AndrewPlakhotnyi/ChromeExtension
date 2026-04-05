window.addEventListener(
  "keydown",
  (e) => {
    if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.code !== "KeyS") return;
    const text = window.getSelection().toString().trim();
    if (!text) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage(
      { command: "search-selection-google", text },
      () => void chrome.runtime.lastError
    );
  },
  true
);
