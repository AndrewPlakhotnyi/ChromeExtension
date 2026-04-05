let lastTabOpenDedupe = { dedupeKey: "", timestampMillis: 0 };
function openTabUnlessDuplicate(dedupeKey, createUrl) {
  const now = Date.now();
  if (
    lastTabOpenDedupe.dedupeKey === dedupeKey &&
    now - lastTabOpenDedupe.timestampMillis < 500
  ) {
    return;
  }
  lastTabOpenDedupe = { dedupeKey, timestampMillis: now };
  chrome.tabs.create({ url: createUrl() });
}

function openGoogleSearchForSelection(selectedText) {
  openTabUnlessDuplicate(
    "google-search:" + selectedText,
    () =>
      `https://www.google.com/search?q=${encodeURIComponent(selectedText)}`
  );
}

function openGoogleTranslateRuForSelection(selectedText) {
  openTabUnlessDuplicate(
    "translate-ru:" + selectedText,
    () =>
      `https://translate.google.com/?sl=auto&tl=ru&text=${encodeURIComponent(selectedText)}`
  );
}

function openGoogleEtymologySearchForSelection(selectedText) {
  const googleQuery = `${selectedText} etymology`;
  openTabUnlessDuplicate(
    "etymology:" + selectedText,
    () =>
      `https://www.google.com/search?q=${encodeURIComponent(googleQuery)}`
  );
}

async function readSelectedTextFromTab(tabId) {
  try {
    const [{ result: injectedResult }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.getSelection().toString(),
    });
    return (injectedResult || "").trim();
  } catch {
    return "";
  }
}

async function runCommand(commandName) {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!activeTab?.id) return;
  const tabUrl = activeTab.url || "";
  if (
    tabUrl.startsWith("chrome://") ||
    tabUrl.startsWith("chrome-extension://") ||
    tabUrl.startsWith("edge://") ||
    tabUrl.startsWith("about:")
  ) {
    return;
  }

  const selectedText = await readSelectedTextFromTab(activeTab.id);
  if (!selectedText) return;
  if (commandName === "search-selection-google") {
    openGoogleSearchForSelection(selectedText);
  } else if (commandName === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText);
  } else if (commandName === "translate-selection-ru") {
    openGoogleTranslateRuForSelection(selectedText);
  }
}

chrome.commands.onCommand.addListener((commandName) => {
  runCommand(commandName);
});

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message?.text !== "string") return;
  const selectedText = message.text.trim();
  if (!selectedText) return;
  if (message.command === "search-selection-google") {
    openGoogleSearchForSelection(selectedText);
  } else if (message.command === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText);
  }
});

function ensureContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "search-selection-google",
      title: "Search selection in Google",
      contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: "search-selection-etymology",
      title: "Search etymology in Google",
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

chrome.contextMenus.onClicked.addListener((contextMenuClickInfo) => {
  const selectedText = contextMenuClickInfo.selectionText?.trim();
  if (!selectedText) return;
  if (contextMenuClickInfo.menuItemId === "search-selection-google") {
    openGoogleSearchForSelection(selectedText);
  } else if (contextMenuClickInfo.menuItemId === "search-selection-etymology") {
    openGoogleEtymologySearchForSelection(selectedText);
  } else if (contextMenuClickInfo.menuItemId === "translate-selection-ru") {
    openGoogleTranslateRuForSelection(selectedText);
  }
});
