let lastOpen = { key: "", t: 0 };
function dedupeTab(key, createUrl) {
  const now = Date.now();
  if (lastOpen.key === key && now - lastOpen.t < 500) return;
  lastOpen = { key, t: now };
  chrome.tabs.create({ url: createUrl() });
}

function openSearch(text) {
  dedupeTab("s:" + text, () => `https://www.google.com/search?q=${encodeURIComponent(text)}`);
}

function openTranslateRu(text) {
  dedupeTab("t:" + text, () => `https://translate.google.com/?sl=auto&tl=ru&text=${encodeURIComponent(text)}`);
}

async function readSelectedText(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection().toString(),
    });
    return (result || "").trim();
  } catch {
    return "";
  }
}

async function runCommand(command) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const u = tab.url || "";
  if (
    u.startsWith("chrome://") ||
    u.startsWith("chrome-extension://") ||
    u.startsWith("edge://") ||
    u.startsWith("about:")
  ) {
    return;
  }

  const text = await readSelectedText(tab.id);
  if (!text) return;
  if (command === "search-selection-google") openSearch(text);
  else if (command === "translate-selection-ru") openTranslateRu(text);
}

chrome.commands.onCommand.addListener((command) => {
  runCommand(command);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.command !== "search-selection-google" || typeof msg.text !== "string") return;
  const text = msg.text.trim();
  if (text) openSearch(text);
});

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "search-selection-google",
      title: "Search selection in Google",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "translate-selection-ru",
      title: "Translate selection to Russian",
      contexts: ["selection"],
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureContextMenus);

chrome.contextMenus.onClicked.addListener((info) => {
  const text = info.selectionText?.trim();
  if (!text) return;
  if (info.menuItemId === "search-selection-google") openSearch(text);
  else if (info.menuItemId === "translate-selection-ru") openTranslateRu(text);
});
