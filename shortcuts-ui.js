const CUSTOM_HOTKEYS_KEY = "customViewerHotkeys";

const DEFAULT_CUSTOM_HOTKEYS = {
  viewerPreviousPlace: "Ctrl+Alt+A",
  viewerWhatIs: "Ctrl+Alt+W",
  viewerEtymology: "Ctrl+Alt+E",
  viewerTranslateRu: "Ctrl+Alt+T",
};

function normalizeHotkey(key) {
  if (!key || typeof key !== "string") return "";
  const parts = key
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const flags = { ctrl: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === "ctrl" || p === "control") flags.ctrl = true;
    else if (p === "alt") flags.alt = true;
    else if (p === "shift") flags.shift = true;
    else flags.key = part.length === 1 ? part.toUpperCase() : part;
  }
  if (!flags.key) return "";
  const out = [];
  if (flags.ctrl) out.push("Ctrl");
  if (flags.alt) out.push("Alt");
  if (flags.shift) out.push("Shift");
  out.push(flags.key);
  return out.join("+");
}

function keyFromKeyboardEvent(event) {
  if (!event || typeof event.key !== "string") return "";
  const key = event.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) return "";
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (/^F\d{1,2}$/i.test(key)) return key.toUpperCase();
  return key[0].toUpperCase() + key.slice(1);
}

export function formatHotkeyFromEvent(event) {
  const key = keyFromKeyboardEvent(event);
  if (!key) return "";
  const out = [];
  if (event.ctrlKey) out.push("Ctrl");
  if (event.altKey) out.push("Alt");
  if (event.shiftKey) out.push("Shift");
  out.push(key);
  return out.join("+");
}

export function isHotkeyMatch(event, hotkey) {
  const normalized = normalizeHotkey(hotkey);
  if (!normalized) return false;
  const parts = normalized.split("+");
  const key = parts[parts.length - 1];
  const hasCtrl = parts.includes("Ctrl");
  const hasAlt = parts.includes("Alt");
  const hasShift = parts.includes("Shift");
  const eventKey = keyFromKeyboardEvent(event);
  return (
    !event.metaKey &&
    Boolean(eventKey) &&
    eventKey === key &&
    event.ctrlKey === hasCtrl &&
    event.altKey === hasAlt &&
    event.shiftKey === hasShift
  );
}

export async function getCustomHotkeys() {
  const stored = await chrome.storage.local.get(CUSTOM_HOTKEYS_KEY);
  return {
    viewerPreviousPlace:
      normalizeHotkey(stored[CUSTOM_HOTKEYS_KEY]?.viewerPreviousPlace) ||
      DEFAULT_CUSTOM_HOTKEYS.viewerPreviousPlace,
    viewerWhatIs: normalizeHotkey(stored[CUSTOM_HOTKEYS_KEY]?.viewerWhatIs) || DEFAULT_CUSTOM_HOTKEYS.viewerWhatIs,
    viewerEtymology:
      normalizeHotkey(stored[CUSTOM_HOTKEYS_KEY]?.viewerEtymology) ||
      DEFAULT_CUSTOM_HOTKEYS.viewerEtymology,
    viewerTranslateRu:
      normalizeHotkey(stored[CUSTOM_HOTKEYS_KEY]?.viewerTranslateRu) ||
      DEFAULT_CUSTOM_HOTKEYS.viewerTranslateRu,
  };
}

export async function saveCustomHotkeys(nextHotkeys) {
  await chrome.storage.local.set({
    [CUSTOM_HOTKEYS_KEY]: {
      viewerPreviousPlace:
        normalizeHotkey(nextHotkeys.viewerPreviousPlace) ||
        DEFAULT_CUSTOM_HOTKEYS.viewerPreviousPlace,
      viewerWhatIs: normalizeHotkey(nextHotkeys.viewerWhatIs) || DEFAULT_CUSTOM_HOTKEYS.viewerWhatIs,
      viewerEtymology:
        normalizeHotkey(nextHotkeys.viewerEtymology) ||
        DEFAULT_CUSTOM_HOTKEYS.viewerEtymology,
      viewerTranslateRu:
        normalizeHotkey(nextHotkeys.viewerTranslateRu) ||
        DEFAULT_CUSTOM_HOTKEYS.viewerTranslateRu,
    },
  });
}

function makeEditableHotkeyRow(label, keyName, state, refresh) {
  const row = document.createElement("div");
  row.className = "shortcuts-edit-row";

  const name = document.createElement("strong");
  name.className = "shortcuts-edit-label";
  name.textContent = label;
  row.appendChild(name);

  const controls = document.createElement("div");
  controls.className = "shortcuts-edit-controls";

  const value = document.createElement("input");
  value.type = "text";
  value.readOnly = true;
  value.className = "shortcuts-url-field";
  value.value = state[keyName];

  const setBtn = document.createElement("button");
  setBtn.type = "button";
  setBtn.className = "shortcuts-copy-btn";
  setBtn.textContent = "Set";
  setBtn.addEventListener("click", () => {
    setBtn.textContent = "Press keys...";
    const onKey = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const hotkey = formatHotkeyFromEvent(event);
      if (!hotkey) return;
      window.removeEventListener("keydown", onKey, true);
      state[keyName] = hotkey;
      await saveCustomHotkeys(state);
      setBtn.textContent = "Set";
      refresh();
    };
    window.addEventListener("keydown", onKey, true);
  });

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "shortcuts-copy-btn";
  resetBtn.textContent = "Reset";
  resetBtn.addEventListener("click", async () => {
    state[keyName] = DEFAULT_CUSTOM_HOTKEYS[keyName];
    await saveCustomHotkeys(state);
    refresh();
  });

  controls.appendChild(value);
  controls.appendChild(setBtn);
  controls.appendChild(resetBtn);
  row.appendChild(controls);
  return row;
}

/**
 * Renders command shortcuts and editable viewer shortcuts.
 */
export async function mountShortcutsUi(root) {
  root.textContent = "";
  let commands;
  try {
    if (typeof chrome === "undefined" || !chrome.commands?.getAll) {
      throw new Error("chrome.commands is not available in this context.");
    }
    commands = await chrome.commands.getAll();
  } catch (error) {
    const p = document.createElement("p");
    p.className = "shortcuts-intro";
    p.textContent = `Could not read shortcuts: ${String(error?.message || error)}`;
    root.appendChild(p);
    return;
  }

  const customHotkeys = await getCustomHotkeys();
  const rerenderCustom = async () => {
    const latest = await getCustomHotkeys();
    customHotkeys.viewerPreviousPlace = latest.viewerPreviousPlace;
    customHotkeys.viewerWhatIs = latest.viewerWhatIs;
    customHotkeys.viewerEtymology = latest.viewerEtymology;
    customHotkeys.viewerTranslateRu = latest.viewerTranslateRu;
    const newPreviousPlaceRow = makeEditableHotkeyRow(
      "Viewer: Go to previous place",
      "viewerPreviousPlace",
      customHotkeys,
      rerenderCustom
    );
    previousPlaceRow.replaceWith(newPreviousPlaceRow);
    previousPlaceRow = newPreviousPlaceRow;
    const newWhatRow = makeEditableHotkeyRow(
      "Viewer: What is selected text",
      "viewerWhatIs",
      customHotkeys,
      rerenderCustom
    );
    whatRow.replaceWith(newWhatRow);
    whatRow = newWhatRow;
    const newEtymologyRow = makeEditableHotkeyRow(
      "Viewer: Etymology of selected text",
      "viewerEtymology",
      customHotkeys,
      rerenderCustom
    );
    etymologyRow.replaceWith(newEtymologyRow);
    etymologyRow = newEtymologyRow;
    const newTranslateRow =
      makeEditableHotkeyRow("Viewer: Translate selected text to Russian", "viewerTranslateRu", customHotkeys, rerenderCustom)
    ;
    translateRow.replaceWith(newTranslateRow);
    translateRow = newTranslateRow;
  };

  const customTitle = document.createElement("h3");
  customTitle.className = "shortcuts-subheading";
  customTitle.textContent = "PDF viewer hotkeys (editable here)";
  root.appendChild(customTitle);

  const customNote = document.createElement("p");
  customNote.className = "shortcuts-note";
  customNote.textContent =
    "These hotkeys are for the extension PDF viewer only and are saved by this extension. They are separate from chrome://extensions/shortcuts.";
  root.appendChild(customNote);

  let previousPlaceRow = makeEditableHotkeyRow(
    "Viewer: Go to previous place",
    "viewerPreviousPlace",
    customHotkeys,
    rerenderCustom
  );
  let whatRow = makeEditableHotkeyRow(
    "Viewer: What is selected text",
    "viewerWhatIs",
    customHotkeys,
    rerenderCustom
  );
  let etymologyRow = makeEditableHotkeyRow(
    "Viewer: Etymology of selected text",
    "viewerEtymology",
    customHotkeys,
    rerenderCustom
  );
  let translateRow = makeEditableHotkeyRow(
    "Viewer: Translate selected text to Russian",
    "viewerTranslateRu",
    customHotkeys,
    rerenderCustom
  );
  root.appendChild(previousPlaceRow);
  root.appendChild(whatRow);
  root.appendChild(etymologyRow);
  root.appendChild(translateRow);

  const intro = document.createElement("p");
  intro.className = "shortcuts-intro";
  intro.style.marginTop = "18px";
  intro.textContent =
    "Shortcuts listed below are Chrome command shortcuts. Chrome exposes them as read-only from extension code.";
  root.appendChild(intro);

  const table = document.createElement("table");
  table.className = "shortcuts-table";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const h1 = document.createElement("th");
  h1.textContent = "Command";
  const h2 = document.createElement("th");
  h2.textContent = "Current shortcut";
  hr.appendChild(h1);
  hr.appendChild(h2);
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  for (const cmd of commands) {
    if (!cmd.name || cmd.name === "_execute_action") continue;
    const tr = document.createElement("tr");
    const tdDesc = document.createElement("td");
    tdDesc.textContent = cmd.description || cmd.name;
    const tdKey = document.createElement("td");
    tdKey.className = "shortcuts-current-key";
    tdKey.textContent = cmd.shortcut?.trim() ? cmd.shortcut : "(not set)";
    tr.appendChild(tdDesc);
    tr.appendChild(tdKey);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  root.appendChild(table);
}
