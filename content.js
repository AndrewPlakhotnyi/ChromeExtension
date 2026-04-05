function sendSelectionCommand(commandName, keyboardEvent) {
  const selectedText = window.getSelection().toString().trim();
  if (!selectedText) return;
  keyboardEvent.preventDefault();
  keyboardEvent.stopImmediatePropagation();
  chrome.runtime.sendMessage(
    { command: commandName, text: selectedText },
    () => void chrome.runtime.lastError
  );
}

window.addEventListener(
  "keydown",
  (keyboardEvent) => {
    if (
      !keyboardEvent.altKey ||
      keyboardEvent.shiftKey ||
      keyboardEvent.ctrlKey ||
      keyboardEvent.metaKey
    ) {
      return;
    }
    if (keyboardEvent.code === "KeyS") {
      sendSelectionCommand("search-selection-google", keyboardEvent);
    } else if (keyboardEvent.code === "KeyW") {
      sendSelectionCommand("search-selection-what-is", keyboardEvent);
    } else if (keyboardEvent.code === "KeyE") {
      sendSelectionCommand("search-selection-etymology", keyboardEvent);
    }
  },
  true
);
