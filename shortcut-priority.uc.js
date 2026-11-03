// ==UserScript==
// @name           Shortcut Priority
// @description    Arc-style per-shortcut conflict setting: Prefer Websites, Use Both, or Prefer Zen.
// @include        main
// @version        0.4.0
// ==/UserScript==

(() => {
  "use strict";

  if (window.location.href !== "chrome://browser/content/browser.xhtml") {
    return;
  }
  if (window.ZenShortcutPriority) {
    return;
  }

  const PREF_BRANCH = "zen.shortcut-priority.";
  const PREF_ENABLED = PREF_BRANCH + "enabled";
  const PREF_RULES = PREF_BRANCH + "rules";
  const PREF_DEFAULT = PREF_BRANCH + "default";

  // Modes, as stored in the rules pref.
  const WEBSITES = "websites";
  const BOTH = "both";
  const ZEN = "zen";
  const MODES = [WEBSITES, BOTH, ZEN];

  // Remembers each key's own `reserved` attribute so we can put it back.
  const ORIG_ATTR = "zsp-orig-reserved";
  const NO_ATTR = "\u0000none";
  const NATIVE_PRIORITY_ATTR = "data-native-shortcut-priority";

  const MSG = "ZenShortcutPriority:";
  const isMac = AppConstants.platform == "macosx";

  function getBool(pref, fallback) {
    return Services.prefs.getBoolPref(pref, fallback);
  }

  function getRules() {
    try {
      const rules = JSON.parse(Services.prefs.getStringPref(PREF_RULES, "{}"));
      return rules && typeof rules == "object" ? rules : {};
    } catch (e) {
      return {};
    }
  }

  function setRules(rules) {
    Services.prefs.setStringPref(PREF_RULES, JSON.stringify(rules));
  }

  function getDefaultMode() {
    // "default" (or anything unknown) keeps each key's built-in behavior.
    const mode = Services.prefs.getStringPref(PREF_DEFAULT, "default");
    return MODES.includes(mode) ? mode : "";
  }

  function originalReserved(keyEl) {
    const saved = keyEl.getAttribute(ORIG_ATTR);
    if (saved !== null) {
      return saved == NO_ATTR ? null : saved;
    }
    return keyEl.getAttribute("reserved");
  }

  // What the browser does with a key when we leave it alone.
  function builtInMode(keyEl) {
    if (originalReserved(keyEl) == "true") {
      return ZEN;
    }
    // Unset keys follow permissions.default.shortcuts (2 = block pages).
    if (
      originalReserved(keyEl) != "false" &&
      Services.prefs.getIntPref("permissions.default.shortcuts", 0) == 2
    ) {
      return ZEN;
    }
    return WEBSITES;
  }

  // The mode a key should have: its own rule, else the global default, else
  // whatever the browser ships with.
  function modeFor(keyEl, rules = getRules()) {
    if (!getBool(PREF_ENABLED, true)) {
      return null;
    }
    const rule = rules[keyEl.id];
    if (MODES.includes(rule)) {
      return rule;
    }
    return getDefaultMode() || null;
  }

  function effectiveMode(keyEl, rules) {
    return modeFor(keyEl, rules) || builtInMode(keyEl);
  }

  // ---------------------------------------------------------------------------
  // Applying rules to <key> elements.
  //
  // Gecko decides who wins in KeyEventHandler: a key with reserved="true" never
  // reaches the page's own listeners, and one with reserved="false" lets the
  // page cancel it with preventDefault(). Gecko only reads key elements when
  // their keyset is bound, so a changed keyset is removed and re-added, the
  // same way Firefox's CustomKeys applies new shortcuts.
  // ---------------------------------------------------------------------------

  let applying = false;

  function wantedReserved(keyEl, rules) {
    const mode = modeFor(keyEl, rules);
    if (mode == ZEN) {
      return "true";
    }
    if (mode == WEBSITES || mode == BOTH) {
      return "false";
    }
    return originalReserved(keyEl);
  }

  function applyToKey(keyEl, rules, keysets) {
    if (!keyEl.id || keyEl.getAttribute("internal") == "true") {
      return;
    }
    // The native Zen backport reads this opt-in before macOS window cycling.
    // Keep it limited to our switcher actions; stock Zen ignores the attribute.
    if (keyEl.parentElement === switcherKeyset) {
      if (isMac && getBool(PREF_ENABLED, true) &&
          effectiveMode(keyEl, rules) == ZEN) {
        keyEl.setAttribute(NATIVE_PRIORITY_ATTR, "true");
      } else {
        keyEl.removeAttribute(NATIVE_PRIORITY_ATTR);
      }
    }
    const wanted = wantedReserved(keyEl, rules);
    const current = keyEl.getAttribute("reserved");
    if (wanted == current) {
      return;
    }
    if (!keyEl.hasAttribute(ORIG_ATTR)) {
      keyEl.setAttribute(ORIG_ATTR, current ?? NO_ATTR);
    }
    if (wanted === null) {
      keyEl.removeAttribute("reserved");
    } else {
      keyEl.setAttribute("reserved", wanted);
    }
    if (wanted === originalReserved(keyEl)) {
      keyEl.removeAttribute(ORIG_ATTR);
    }
    if (keyEl.parentElement?.localName == "keyset") {
      keysets.add(keyEl.parentElement);
    }
  }

  function refreshKeysets(keysets) {
    if (!keysets.size) {
      return;
    }
    applying = true;
    try {
      for (const keyset of keysets) {
        const parent = keyset.parentNode;
        const next = keyset.nextSibling;
        keyset.remove();
        parent.insertBefore(keyset, next);
      }
    } finally {
      // MutationObserver callbacks run as microtasks, after this returns.
      Promise.resolve().then(() => (applying = false));
    }
  }

  function applyAll() {
    const rules = getRules();
    const keysets = new Set();
    for (const keyEl of document.querySelectorAll("key[id]")) {
      applyToKey(keyEl, rules, keysets);
    }
    refreshKeysets(keysets);
    refreshNativeSwitcherBridge();
  }

  // Keysets can arrive late (DevTools adds one during delayed startup).
  const keysetObserver = new MutationObserver(mutations => {
    if (applying) {
      return;
    }
    const rules = getRules();
    const keysets = new Set();
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.localName != "keyset") {
          continue;
        }
        for (const keyEl of node.querySelectorAll("key[id]")) {
          applyToKey(keyEl, rules, keysets);
        }
      }
    }
    refreshKeysets(keysets);
    refreshBothKeys();
    refreshNativeSwitcherBridge();
  });

  // ---------------------------------------------------------------------------
  // "Use Both".
  //
  // A page gets a non-reserved shortcut first, and the browser only acts on it
  // once the page process sends the event back un-cancelled. For "Use Both" we
  // run the browser's command as soon as the key press happens, let the page
  // have the event as usual, and cancel the copy that comes back so the
  // command doesn't run twice.
  // ---------------------------------------------------------------------------

  const VK_CODES = new Map();
  function keyCodeFor(vk) {
    if (!VK_CODES.has(vk)) {
      VK_CODES.set(vk, KeyEvent["DOM_" + vk] ?? -1);
    }
    return VK_CODES.get(vk);
  }

  function parseModifiers(keyEl) {
    const mods = { alt: false, ctrl: false, meta: false, shift: false, any: false };
    for (let name of (keyEl.getAttribute("modifiers") || "").split(/[\s,]+/)) {
      switch (name.toLowerCase()) {
        case "accel":
          mods[isMac ? "meta" : "ctrl"] = true;
          break;
        case "control":
          mods.ctrl = true;
          break;
        case "meta":
        case "os":
          mods.meta = true;
          break;
        case "alt":
          mods.alt = true;
          break;
        case "shift":
          mods.shift = true;
          break;
        case "any":
          mods.any = true;
          break;
      }
    }
    return mods;
  }

  function keyMatches(keyEl, event) {
    const key = keyEl.getAttribute("key");
    const keycode = keyEl.getAttribute("keycode");
    if (!key && !keycode) {
      return false;
    }
    const mods = parseModifiers(keyEl);
    if (
      event.altKey != mods.alt ||
      event.ctrlKey != mods.ctrl ||
      event.metaKey != mods.meta
    ) {
      return false;
    }
    if (keycode) {
      if (event.shiftKey != mods.shift) {
        return false;
      }
      return event.keyCode == keyCodeFor(keycode.toUpperCase());
    }
    const want = key.toUpperCase();
    const candidates = [event.key?.toUpperCase()];
    if (event.charCode) {
      candidates.push(String.fromCharCode(event.charCode).toUpperCase());
    }
    // Ctrl+letter on non-Latin layouts still reports the Latin keyCode.
    if (event.keyCode >= 48 && event.keyCode <= 90) {
      candidates.push(String.fromCharCode(event.keyCode));
    }
    if (!candidates.includes(want)) {
      return false;
    }
    // Shift must match for letters; for punctuation it's often needed just
    // to type the character, so Gecko ignores it there too.
    if (mods.shift || /^[A-Z0-9]$/.test(want)) {
      return event.shiftKey == mods.shift;
    }
    return true;
  }

  // Ids of keys set to "Use Both", refreshed whenever the rules change. The
  // elements are looked up on each press, since keysets can be replaced.
  let bothKeys = [];
  function refreshBothKeys() {
    const rules = getRules();
    bothKeys = [...document.querySelectorAll("key[id]")]
      .filter(
        keyEl =>
          keyEl.getAttribute("internal") != "true" &&
          modeFor(keyEl, rules) == BOTH
      )
      .map(keyEl => keyEl.id);
  }

  function findBothKey(event) {
    for (const id of bothKeys) {
      const keyEl = document.getElementById(id);
      if (
        keyEl?.localName == "key" &&
        keyEl.getAttribute("disabled") != "true" &&
        keyMatches(keyEl, event)
      ) {
        return keyEl;
      }
    }
    return null;
  }

  // The press we ran a command for, so its returning copy can be cancelled.
  let pendingReply = null;

  function signature(event) {
    return [
      event.key,
      event.code,
      event.keyCode,
      event.altKey,
      event.ctrlKey,
      event.metaKey,
      event.shiftKey,
    ].join("|");
  }

  function onKeyPress(event) {
    if (!event.isTrusted || !bothKeys.length) {
      return;
    }
    const target = event.target;
    if (target?.localName != "browser" || !target.isRemoteBrowser) {
      return; // Focus is in the browser UI; Gecko handles it normally.
    }
    const sig = signature(event);
    if (
      pendingReply &&
      pendingReply.sig == sig &&
      pendingReply.browser == target &&
      performance.now() - pendingReply.time < 2000
    ) {
      // The page has handled the press and sent it back. We already ran the
      // command, so stop Gecko from running it again.
      pendingReply = null;
      event.preventDefault();
      return;
    }
    if (event.defaultPrevented) {
      return;
    }
    const keyEl = findBothKey(event);
    if (!keyEl) {
      return;
    }
    pendingReply = { sig, browser: target, time: performance.now() };
    try {
      keyEl.doCommand();
    } catch (e) {
      console.error("Shortcut Priority: could not run", keyEl.id, e);
    }
  }

  function onKeyDown() {
    // A new press. If the last one never came back (the page cancelled its
    // keydown, so no keypress went to the page), forget it.
    pendingReply = null;
  }

  // ---------------------------------------------------------------------------
  // Native tab-switcher actions. Menu entries let Firefox list these in
  // about:keyboard, where bindings and the priority picker remain editable.
  // ---------------------------------------------------------------------------

  let switcherKeyset;
  let switcherCommands;
  let switcherMenus = [];
  let switcherPopup;
  let cyclingModifiers = null;
  let nativeSwitcherModule = null;
  let nativeSwitcherError = "";

  function nativeSwitcherEligible() {
    const key = document.getElementById("key_zsp_tabSwitcher_forward");
    if (disposed || !isMac ||
        Services.appinfo?.platformVersion?.split(".")[0] !== "159" ||
        !getBool(PREF_ENABLED, true) || !switcherKeyset?.parentNode ||
        key?.parentElement !== switcherKeyset ||
        key.getAttribute("disabled") == "true" ||
        key.getAttribute("key") !== "`" || key.getAttribute("keycode") ||
        effectiveMode(key) !== ZEN) return false;
    const mods = parseModifiers(key);
    return mods.meta && !mods.ctrl && !mods.alt && !mods.shift;
  }

  function refreshNativeSwitcherBridge() {
    const enabled = nativeSwitcherEligible();
    if (!enabled && !nativeSwitcherModule) return;
    try {
      nativeSwitcherModule ||= ChromeUtils.importESModule(
        "chrome://sine/content/shortcut-priority/macos-shortcuts.sys.mjs"
      );
      nativeSwitcherModule.setWindow(window, enabled);
      nativeSwitcherError = "";
    } catch (error) {
      // Missing or unsupported native libraries leave the ordinary mod usable.
      nativeSwitcherError = String(error);
    }
  }
  // Cocoa caches menu equivalents; refresh the reference after a remap.
  const switcherKeyObserver = new MutationObserver(() => {
    for (const item of switcherMenus) {
      const id = item.getAttribute("key");
      item.removeAttribute("key");
      item.setAttribute("key", id);
    }
    refreshNativeSwitcherBridge();
  });

  function advanceTab(forward) {
    ctrlTab.advanceFocus(forward);
    if (ctrlTab.selected === ctrlTab.showAllButton) {
      ctrlTab.advanceFocus(forward);
    }
  }

  function cycleTabs(forward) {
    const key = document.getElementById(
      "key_zsp_tabSwitcher_" + (forward ? "forward" : "backward")
    );
    if (!key) return;
    ctrlTab.init();
    if (ctrlTab.tabCount < 2) return;
    cyclingModifiers = parseModifiers(key);
    if (ctrlTab.isOpen) {
      advanceTab(forward);
    } else {
      ctrlTab.open();
      if (!forward) {
        // Preserve open()'s delay so a quick release commits before popup focus
        // changes. advanceFocus() would force the panel open immediately.
        ctrlTab._selectedIndex = ctrlTab.tabPreviewCount - 1;
        gBrowser.warmupTab(ctrlTab.selected._tab);
      }
    }
    if (!cyclingModifiers.meta && !cyclingModifiers.ctrl &&
        !cyclingModifiers.alt && !cyclingModifiers.shift) {
      cyclingModifiers = null;
      ctrlTab.pick();
    }
  }

  function onSwitcherKeyUp(event) {
    const mods = cyclingModifiers;
    if (!event.isTrusted || !mods) return;
    if ((mods.meta && !event.metaKey) || (mods.ctrl && !event.ctrlKey) ||
        (mods.alt && !event.altKey) || (mods.shift && !event.shiftKey)) {
      cyclingModifiers = null;
      if (ctrlTab.isOpen) {
        event.preventDefault();
        event.stopPropagation();
        ctrlTab.pick();
      }
    }
  }

  function refreshNativeSwitcherMenu() {
    if (isMac) {
      // Rebuild the cache without opening a menu or firing popup handlers.
      window.windowUtils?.forceUpdateNativeMenuAt?.("");
    }
  }

  function installTabSwitcher() {
    switcherCommands = document.createXULElement("commandset");
    switcherKeyset = document.createXULElement("keyset");
    // Gecko warns against dynamically changing macOS's managed Window menu.
    switcherPopup = document.getElementById("menu_viewPopup");
    for (const direction of ["forward", "backward"]) {
      const id = "zsp_tabSwitcher_" + direction;
      const command = document.createXULElement("command");
      command.id = "cmd_" + id;
      command.addEventListener("command", () => cycleTabs(direction === "forward"));
      switcherCommands.append(command);
      const key = document.createXULElement("key");
      key.id = "key_" + id;
      key.setAttribute("command", command.id);
      key.setAttribute("reserved", "true");
      switcherKeyset.append(key);
    }
    document.body.append(switcherCommands, switcherKeyset);
    // Add menu items after their keys exist so Cocoa can resolve equivalents.
    for (const direction of ["forward", "backward"]) {
      const item = document.createXULElement("menuitem");
      item.id = "menu_zsp_tabSwitcher_" + direction;
      item.setAttribute("label", "Tab Switcher (" + direction + ")");
      item.setAttribute("accesskey", direction == "forward" ? "w" : "b");
      item.setAttribute("key", "key_zsp_tabSwitcher_" + direction);
      item.setAttribute("command", "cmd_zsp_tabSwitcher_" + direction);
      switcherPopup.append(item);
      switcherMenus.push(item);
    }
    switcherKeyObserver.observe(switcherKeyset, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["key", "keycode", "modifiers", "disabled"],
    });
    window.addEventListener("keyup", onSwitcherKeyUp, {
      capture: true, mozSystemGroup: true,
    });
    // Cocoa otherwise leaves dynamically inserted rows lazy until menu opening.
    refreshNativeSwitcherMenu();
  }

  function removeTabSwitcher(refreshNative = true) {
    if (nativeSwitcherModule) {
      try {
        nativeSwitcherModule.setWindow(window, false);
        nativeSwitcherError = "";
      } catch (error) {
        nativeSwitcherError = String(error);
      }
    }
    switcherKeyObserver.disconnect();
    if (cyclingModifiers && ctrlTab.isOpen) ctrlTab.close();
    cyclingModifiers = null;
    window.removeEventListener("keyup", onSwitcherKeyUp, {
      capture: true, mozSystemGroup: true,
    });
    for (const key of switcherKeyset?.children || []) {
      key.removeAttribute(NATIVE_PRIORITY_ATTR);
    }
    for (const item of switcherMenus) item.remove();
    switcherMenus = [];
    switcherKeyset?.remove();
    switcherCommands?.remove();
    if (refreshNative) refreshNativeSwitcherMenu();
    switcherPopup = null;
  }

  // ---------------------------------------------------------------------------
  // The picker in about:keyboard.
  //
  // about:keyboard runs in the privileged about: process, so a small frame
  // script adds the picker to each row and talks to this window over the
  // message manager.
  // ---------------------------------------------------------------------------

  const FRAME_SCRIPT = `
(() => {
  const MSG = ${JSON.stringify(MSG)};
  const LABELS = {
    websites: "Prefer Websites",
    both: "Use Both",
    zen: "Prefer Zen",
  };
  const HINTS = {
    websites: "When shortcuts conflict, the website wins.",
    both: "The website and Zen both get the shortcut.",
    zen: "When shortcuts conflict, Zen wins.",
  };
  const CSS = \`
.key-actions:has(.zsp-picker) {
  /* Make room for the picker next to Firefox's input and buttons. */
  flex-basis: calc(var(--input-width) * 10 + var(--button-size-icon) * 2 + var(--space-xsmall) * 3 + 10.5em);
}
@media (max-width: 600px) {
  .key-actions:has(.zsp-picker) {
    flex-basis: 100%;
  }
}
.key-actions .zsp-picker {
  appearance: none;
  flex: none;
  width: 10.5em;
  min-height: 28px;
  margin: 0;
  padding: 2px 26px 2px 10px;
  border: 1px solid var(--border-color-interactive, color-mix(in srgb, currentColor 25%, transparent));
  border-radius: var(--border-radius-small, 6px);
  background-color: var(--button-background-color, transparent);
  background-image: url("chrome://global/skin/icons/arrow-down-12.svg");
  background-position: right 8px center;
  background-repeat: no-repeat;
  -moz-context-properties: fill;
  fill: currentColor;
  color: inherit;
  font: inherit;
  font-size: 0.9em;
  cursor: pointer;
}
.key-actions .zsp-picker:hover {
  background-color: var(--button-background-color-hover, color-mix(in srgb, currentColor 8%, transparent));
}
.key-actions .zsp-picker:focus-visible {
  outline: var(--focus-outline, 2px solid AccentColor);
  outline-offset: var(--focus-outline-offset, 2px);
}
.key-actions .zsp-picker:not(.zsp-custom) {
  opacity: 0.7;
}
.key-actions .zsp-picker.zsp-custom {
  border-color: var(--color-accent-primary, AccentColor);
}
.key.internal .zsp-picker,
.key.editing .zsp-picker {
  display: none;
}
\`;

  let state = null;
  // False once the mod is turned off, so later page loads stay untouched.
  let active = true;
  const sheetsLoaded = new WeakSet();
  let observer = null;

  function isKeyboardPage() {
    return content.document?.documentURI?.startsWith("about:keyboard");
  }

  function decorate(row) {
    if (!state || row.querySelector(":scope .zsp-picker")) {
      return;
    }
    const id = row.dataset.id;
    const info = state.keys[id];
    const actions = row.querySelector(".key-actions");
    if (!info || !actions) {
      return;
    }
    const doc = content.document;
    const select = doc.createElement("select");
    select.className = "zsp-picker";
    for (const mode of ["websites", "both", "zen"]) {
      const option = doc.createElement("option");
      option.value = mode;
      option.textContent = LABELS[mode];
      select.append(option);
    }
    select.setAttribute(
      "aria-label",
      "When this shortcut conflicts with a website: " + (row.dataset.label || id)
    );
    update(select, info);
    select.addEventListener("change", () => {
      sendAsyncMessage(MSG + "SetMode", { id, mode: select.value });
    });
    // Keep clicks on the picker from reaching the page's row handler.
    select.addEventListener("click", e => e.stopPropagation());
    actions.prepend(select);
  }

  function update(select, info) {
    select.value = info.mode;
    select.classList.toggle("zsp-custom", info.custom);
    select.title = HINTS[info.mode] + (info.custom ? "" : " (default)");
  }

  function decorateAll() {
    if (!state || !isKeyboardPage()) {
      return;
    }
    for (const row of content.document.querySelectorAll("#table .key")) {
      decorate(row);
    }
  }

  function attach() {
    if (!active || !isKeyboardPage()) {
      return false;
    }
    const doc = content.document;
    if (!sheetsLoaded.has(doc)) {
      sheetsLoaded.add(doc);
      content.windowUtils.loadSheetUsingURIString(
        "data:text/css;charset=utf-8," + encodeURIComponent(CSS),
        content.windowUtils.AUTHOR_SHEET
      );
    }
    observer?.disconnect();
    observer = new content.MutationObserver(decorateAll);
    const table = doc.getElementById("table");
    if (table) {
      observer.observe(table, { childList: true, subtree: true });
    }
    return true;
  }

  function setup() {
    if (attach()) {
      sendAsyncMessage(MSG + "GetState");
    }
  }

  addMessageListener(MSG + "State", ({ data }) => {
    state = data;
    if (!active) {
      // Turned back on: watch the table again.
      active = true;
      attach();
    }
    if (!isKeyboardPage()) {
      return;
    }
    for (const select of content.document.querySelectorAll(".zsp-picker")) {
      const id = select.closest(".key")?.dataset.id;
      if (state.keys[id]) {
        update(select, state.keys[id]);
      }
    }
    decorateAll();
  });

  addMessageListener(MSG + "Remove", () => {
    active = false;
    state = null;
    observer?.disconnect();
    if (content.document) {
      for (const select of content.document.querySelectorAll(".zsp-picker")) {
        select.remove();
      }
    }
  });

  addEventListener("DOMContentLoaded", setup);
  setup();
})();
`;
  const FRAME_SCRIPT_URL =
    "data:application/javascript;charset=utf-8," +
    encodeURIComponent(FRAME_SCRIPT);

  // Message managers we've loaded the frame script into.
  const injected = new Set();

  function stateFor() {
    const rules = getRules();
    const keys = {};
    for (const keyEl of document.querySelectorAll("key[id]")) {
      keys[keyEl.id] = {
        mode: effectiveMode(keyEl, rules),
        custom: MODES.includes(rules[keyEl.id]),
      };
    }
    return { keys };
  }

  function sendState(browser) {
    try {
      browser.messageManager?.sendAsyncMessage(MSG + "State", stateFor());
    } catch (e) {}
  }

  function keyboardBrowsers() {
    return gBrowser.browsers.filter(b =>
      b.currentURI?.spec.startsWith("about:keyboard")
    );
  }

  function maybeInject(browser) {
    if (!getBool(PREF_ENABLED, true)) {
      return;
    }
    if (!browser?.currentURI?.spec.startsWith("about:keyboard")) {
      return;
    }
    const mm = browser.messageManager;
    if (!mm || injected.has(mm)) {
      sendState(browser);
      return;
    }
    injected.add(mm);
    mm.addMessageListener(MSG + "GetState", receiveMessage);
    mm.addMessageListener(MSG + "SetMode", receiveMessage);
    mm.loadFrameScript(FRAME_SCRIPT_URL, false);
  }

  function receiveMessage(message) {
    if (!getBool(PREF_ENABLED, true)) {
      return;
    }
    const browser = message.target;
    if (message.name == MSG + "GetState") {
      sendState(browser);
    } else if (message.name == MSG + "SetMode") {
      const { id, mode } = message.data;
      const keyEl = document.getElementById(id);
      if (!keyEl || keyEl.localName != "key" || !MODES.includes(mode)) {
        return;
      }
      const rules = getRules();
      delete rules[id];
      // Picking what the key would do anyway clears the rule.
      if (mode != effectiveMode(keyEl, rules)) {
        rules[id] = mode;
      }
      setRules(rules);
    }
  }

  const progressListener = {
    onLocationChange(browser, webProgress, request, location) {
      if (webProgress?.isTopLevel && location?.spec.startsWith("about:keyboard")) {
        maybeInject(browser);
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Lifecycle.
  // ---------------------------------------------------------------------------

  function onPrefChange() {
    applyAll();
    refreshBothKeys();
    if (getBool(PREF_ENABLED, true)) {
      for (const browser of keyboardBrowsers()) {
        maybeInject(browser);
        sendState(browser);
      }
    } else {
      for (const browser of keyboardBrowsers()) {
        browser.messageManager?.sendAsyncMessage(MSG + "Remove");
      }
    }
  }

  const prefObserver = { observe: onPrefChange };

  function restoreAll() {
    const keysets = new Set();
    for (const keyEl of document.querySelectorAll(`key[${ORIG_ATTR}]`)) {
      const orig = originalReserved(keyEl);
      keyEl.removeAttribute(ORIG_ATTR);
      if (orig === null) {
        keyEl.removeAttribute("reserved");
      } else {
        keyEl.setAttribute("reserved", orig);
      }
      if (keyEl.parentElement?.localName == "keyset") {
        keysets.add(keyEl.parentElement);
      }
    }
    refreshKeysets(keysets);
  }

  let initialized = false;
  let disposed = false;
  let startupObserver = null;

  function init() {
    if (disposed) return;
    initialized = true;
    installTabSwitcher();
    applyAll();
    refreshBothKeys();
    for (const node of [document, document.body]) {
      keysetObserver.observe(node, { childList: true });
    }
    // System group, capturing: we see each press before Gecko's own key
    // handling does, and after the page has had its turn on the way back.
    window.addEventListener("keydown", onKeyDown, {
      capture: true,
      mozSystemGroup: true,
    });
    window.addEventListener("keypress", onKeyPress, {
      capture: true,
      mozSystemGroup: true,
    });
    gBrowser.addTabsProgressListener(progressListener);
    Services.prefs.addObserver(PREF_BRANCH, prefObserver);
    // Changes which mode counts as a key's default.
    Services.prefs.addObserver("permissions.default.shortcuts", prefObserver);
    for (const browser of keyboardBrowsers()) {
      maybeInject(browser);
    }
  }

  function uninit(event) {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("unload", uninit);
    if (startupObserver) {
      Services.obs.removeObserver(startupObserver, "browser-delayed-startup-finished");
      startupObserver = null;
    }
    if (!initialized) {
      delete window.ZenShortcutPriority;
      return;
    }
    removeTabSwitcher(event?.type !== "unload");
    keysetObserver.disconnect();
    window.removeEventListener("keydown", onKeyDown, {
      capture: true,
      mozSystemGroup: true,
    });
    window.removeEventListener("keypress", onKeyPress, {
      capture: true,
      mozSystemGroup: true,
    });
    gBrowser.removeTabsProgressListener(progressListener);
    Services.prefs.removeObserver(PREF_BRANCH, prefObserver);
    Services.prefs.removeObserver("permissions.default.shortcuts", prefObserver);
    for (const browser of keyboardBrowsers()) {
      browser.messageManager?.sendAsyncMessage(MSG + "Remove");
    }
    for (const mm of injected) {
      mm.removeMessageListener(MSG + "GetState", receiveMessage);
      mm.removeMessageListener(MSG + "SetMode", receiveMessage);
    }
    injected.clear();
    restoreAll();
    delete window.ZenShortcutPriority;
  }

  window.ZenShortcutPriority = {
    applyAll,
    cycleTabs,
    uninit,
    getRules,
    setRules,
    nativeStatus: () => ({
      eligible: nativeSwitcherEligible(),
      error: nativeSwitcherError,
      ...nativeSwitcherModule?.status(window),
    }),
    modeFor: id => {
      const keyEl = document.getElementById(id);
      return keyEl ? effectiveMode(keyEl) : null;
    },
  };

  if (gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    startupObserver = (subject, topic) => {
      if (subject == window) {
        Services.obs.removeObserver(startupObserver, topic);
        startupObserver = null;
        init();
      }
    };
    Services.obs.addObserver(startupObserver, "browser-delayed-startup-finished");
  }
  window.addEventListener("unload", uninit, { once: true });
  if (typeof window.addUnloadListener === "function") window.addUnloadListener(uninit);
})();
