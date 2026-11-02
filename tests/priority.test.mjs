import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../shortcut-priority.uc.js', import.meta.url), 'utf8');
const branch = 'zen.shortcut-priority.';

class Events {
  listeners = new Map();
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(callback);
  }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  dispatch(type, event = {}) {
    for (const callback of [...(this.listeners.get(type) || [])]) {
      if (typeof callback === 'function') callback(event);
      else callback.handleEvent(event);
    }
  }
}

class Element extends Events {
  attrs = new Map();
  children = [];
  commands = 0;
  constructor(name, attrs = {}) {
    super();
    this.localName = this.tagName = name;
    for (const [key, value] of Object.entries(attrs)) this.setAttribute(key, value);
  }
  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get parentElement() { return this.parentNode; }
  get nextSibling() {
    return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null;
  }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  removeAttribute(name) { this.attrs.delete(name); }
  hasAttribute(name) { return this.attrs.has(name); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, next) {
    node.remove();
    const index = next ? this.children.indexOf(next) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
    let root = this;
    while (root.parentNode) root = root.parentNode;
    root.onAttached?.(node);
    return node;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  querySelectorAll(selector) {
    const match = selector.match(/^([\w-]+)(?:\[([^\]]+)\])?$/);
    if (!match) return [];
    const found = [];
    for (const child of this.children) {
      if (child.localName === match[1] && (!match[2] || child.hasAttribute(match[2]))) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
  doCommand() {
    this.commands++;
    const command = this.getAttribute('command');
    if (command) {
      let root = this;
      while (root.parentNode) root = root.parentNode;
      root.getElementById(command).doCommand();
      return;
    }
    this.dispatch('command', { target: this });
  }
}

function harness({ keys = [], prefs = {}, delayedStartupFinished = true, platform = 'macosx', tabCount = 4 } = {}) {
  const values = new Map(Object.entries(prefs));
  const prefObservers = new Map();
  const topicObservers = new Map();
  const progressListeners = new Set();
  const mutations = [];
  const document = new Element('document');
  document.documentElement = new Element('window');
  document.body = new Element('body');
  document.append(document.documentElement);
  document.documentElement.append(document.body);
  const keyset = new Element('keyset', { id: 'mainKeyset' });
  document.body.append(keyset);
  for (const key of keys) keyset.append(new Element('key', key));
  const menubar = new Element('menubar', { id: 'main-menubar' });
  const menu = new Element('menu', { id: 'windowMenu' });
  menu.append(new Element('menupopup', { id: 'windowPopup' }));
  menubar.append(menu);
  document.documentElement.append(menubar);
  document.getElementById = id => {
    const find = node => node.id === id ? node : node.children.map(find).find(Boolean);
    return find(document) || null;
  };
  document.createXULElement = name => new Element(name);
  document.createElement = name => new Element(name);
  const window = Object.assign(new Events(), {
    document,
    location: { href: 'chrome://browser/content/browser.xhtml' },
  });
  const services = {
    prefs: {
      getBoolPref: (key, fallback) => values.get(key) ?? fallback,
      getIntPref: (key, fallback) => values.get(key) ?? fallback,
      getStringPref: (key, fallback) => values.get(key) ?? fallback,
      setStringPref(key, value) { setPref(key, value); },
      addObserver(key, observer) {
        if (!prefObservers.has(key)) prefObservers.set(key, new Set());
        prefObservers.get(key).add(observer);
      },
      removeObserver(key, observer) { prefObservers.get(key)?.delete(observer); },
    },
    obs: {
      addObserver(observer, topic) {
        if (!topicObservers.has(topic)) topicObservers.set(topic, new Set());
        topicObservers.get(topic).add(observer);
      },
      removeObserver(observer, topic) { topicObservers.get(topic)?.delete(observer); },
    },
  };
  function setPref(key, value) {
    values.set(key, value);
    for (const [prefix, observers] of prefObservers) {
      if (key.startsWith(prefix)) for (const observer of [...observers]) observer.observe(null, 'nsPref:changed', key);
    }
  }
  const browser = { localName: 'browser', isRemoteBrowser: true };
  const gBrowser = {
    browsers: [],
    addTabsProgressListener: listener => progressListeners.add(listener),
    removeTabsProgressListener: listener => progressListeners.delete(listener),
  };
  const previews = Array.from({ length: tabCount }, (_, index) => ({ _tab: { index } }));
  const showAllButton = {};
  previews.push(showAllButton);
  const ctrlTab = {
    tabCount, previews, showAllButton, index: 0, panelOpen: false, pending: false,
    opens: 0, closes: 0, picks: [],
    get isOpen() { return this.pending || this.panelOpen; },
    get selected() { return previews[this.index]; },
    init() {},
    open() { this.opens++; this.pending = true; this.index = 1; },
    showPanel() { this.pending = false; this.panelOpen = true; },
    advanceFocus(forward) {
      this.index = (this.index + (forward ? 1 : -1) + previews.length) % previews.length;
      if (this.pending) this.showPanel();
    },
    pick() { this.picks.push(this.selected._tab); this.close(); },
    close() { this.closes++; this.pending = this.panelOpen = false; },
  };
  const attachments = [];
  document.onAttached = node => attachments.push({
    name: node.localName, id: node.id,
    keys: node.querySelectorAll('key[id]').map(key => key.id),
    menuKey: node.localName === 'menuitem' ? document.getElementById(node.getAttribute('key')) : null,
  });
  const context = {
    window, document, Services: services, gBrowser, ctrlTab,
    gBrowserInit: { delayedStartupFinished },
    AppConstants: { platform },
    KeyEvent: { DOM_VK_F5: 116 },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.observing = false; mutations.push(this); }
      observe(target, options) { this.observing = true; this.target = target; this.options = options; }
      disconnect() { this.observing = false; }
    },
    performance: { now: () => 100 },
    console, AbortController, setTimeout, clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: 'shortcut-priority.uc.js' });
  const api = window.ZenShortcutPriority;
  function keypress(overrides = {}) {
    const event = {
      isTrusted: true, target: browser, key: 'g', code: 'KeyG', keyCode: 71, charCode: 103,
      metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {}, stopImmediatePropagation() {},
      ...overrides,
    };
    window.dispatch('keypress', event);
    return event;
  }
  return {
    api, window, document, keyset, browser, values, prefObservers, progressListeners, mutations, ctrlTab, attachments,
    setPref, keypress,
    bind(direction, modifiers = 'accel', key = direction === 'forward' ? '`' : '1') {
      const element = document.getElementById('key_zsp_tabSwitcher_' + direction);
      element.setAttribute('modifiers', modifiers);
      element.setAttribute('key', key);
      return element;
    },
    release(overrides = {}) {
      const event = {
        isTrusted: true, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.propagationStopped = true; },
        ...overrides,
      };
      window.dispatch('keyup', event);
      return event;
    },
    key: id => document.getElementById(id),
    start(subject = window) {
      const topic = 'browser-delayed-startup-finished';
      for (const observer of [...(topicObservers.get(topic) || [])]) observer(subject, topic);
    },
  };
}

test('rules override key reservations; disabling and unloading restore exact native attributes', () => {
  const h = harness({ keys: [
    { id: 'reserved', key: 'w', modifiers: 'accel', reserved: 'true' },
    { id: 'unreserved', key: 'g', modifiers: 'accel', reserved: 'false' },
    { id: 'unset', key: 'h', modifiers: 'accel' },
    { id: 'internal', key: 'q', modifiers: 'accel', reserved: 'true', internal: 'true' },
  ] });
  h.api.setRules({ reserved: 'websites', unreserved: 'zen', unset: 'zen', internal: 'websites' });
  assert.equal(h.key('reserved').getAttribute('reserved'), 'false');
  assert.equal(h.key('unreserved').getAttribute('reserved'), 'true');
  assert.equal(h.key('unset').getAttribute('reserved'), 'true');
  assert.equal(h.key('internal').getAttribute('reserved'), 'true');
  h.setPref(branch + 'enabled', false);
  assert.equal(h.key('reserved').getAttribute('reserved'), 'true');
  assert.equal(h.key('unreserved').getAttribute('reserved'), 'false');
  assert.equal(h.key('unset').getAttribute('reserved'), null);
  h.setPref(branch + 'enabled', true);
  h.api.uninit();
  assert.equal(h.key('reserved').getAttribute('reserved'), 'true');
  assert.equal(h.key('unreserved').getAttribute('reserved'), 'false');
  assert.equal(h.key('unset').getAttribute('reserved'), null);
  assert.equal(h.window.ZenShortcutPriority, undefined);
});

test('native default reporting respects explicit reservation and shortcut permission changes', () => {
  const h = harness({ keys: [
    { id: 'reserved', reserved: 'true' }, { id: 'unreserved', reserved: 'false' }, { id: 'unset' },
  ] });
  assert.equal(h.api.modeFor('reserved'), 'zen');
  assert.equal(h.api.modeFor('unreserved'), 'websites');
  assert.equal(h.api.modeFor('unset'), 'websites');
  h.setPref('permissions.default.shortcuts', 2);
  assert.equal(h.api.modeFor('reserved'), 'zen');
  assert.equal(h.api.modeFor('unreserved'), 'websites');
  assert.equal(h.api.modeFor('unset'), 'zen');
  assert.equal(h.api.modeFor('missing'), null);
});

test('per-key rules take priority over the global mode and malformed rules fall back safely', () => {
  const h = harness({ keys: [{ id: 'key', reserved: 'true' }] });
  h.setPref(branch + 'default', 'both');
  assert.equal(h.api.modeFor('key'), 'both');
  assert.equal(h.key('key').getAttribute('reserved'), 'false');
  h.api.setRules({ key: 'zen' });
  assert.equal(h.api.modeFor('key'), 'zen');
  h.setPref(branch + 'rules', '{broken');
  assert.equal(h.api.modeFor('key'), 'both');
  h.setPref(branch + 'default', 'unknown');
  assert.equal(h.api.modeFor('key'), 'zen');
  assert.equal(h.key('key').getAttribute('reserved'), 'true');
});

test('Use Both runs once before content, cancels the returning command, and resets on a new press', () => {
  const h = harness({ keys: [{ id: 'both', key: 'g', modifiers: 'accel' }] });
  h.api.setRules({ both: 'both' });
  const first = h.keypress();
  assert.equal(h.key('both').commands, 1);
  assert.equal(first.defaultPrevented, false, 'content must still receive the first event');
  const reply = h.keypress();
  assert.equal(reply.defaultPrevented, true);
  assert.equal(h.key('both').commands, 1);
  h.window.dispatch('keydown');
  h.keypress();
  assert.equal(h.key('both').commands, 2);
  h.window.dispatch('keydown');
  h.keypress({ defaultPrevented: true });
  h.keypress({ isTrusted: false });
  h.keypress({ target: { localName: 'input' } });
  assert.equal(h.key('both').commands, 2);
});

test('Use Both matches configured modifiers, virtual keys, and a remapped key at event time', () => {
  const h = harness({ keys: [
    { id: 'both', key: 'g', modifiers: 'accel' },
    { id: 'reload', keycode: 'VK_F5', modifiers: 'control,shift' },
  ] });
  h.api.setRules({ both: 'both', reload: 'both' });
  h.keypress({ shiftKey: true });
  h.keypress({ altKey: true });
  assert.equal(h.key('both').commands, 0);
  h.keypress({ key: 'F5', code: 'F5', keyCode: 116, charCode: 0, metaKey: false, ctrlKey: true, shiftKey: true });
  assert.equal(h.key('reload').commands, 1);
  h.window.dispatch('keydown');
  h.key('both').setAttribute('key', 'j');
  h.keypress();
  assert.equal(h.key('both').commands, 0);
  h.keypress({ key: 'j', code: 'KeyJ', keyCode: 74, charCode: 106 });
  assert.equal(h.key('both').commands, 1);
});

test('delayed startup installs only in its own window and unload releases runtime registrations', () => {
  const h = harness({ delayedStartupFinished: false, keys: [{ id: 'key', key: 'g', modifiers: 'accel' }], prefs: { [branch + 'rules']: '{"key":"zen"}' } });
  assert.equal(h.key('key').getAttribute('reserved'), null);
  assert.equal(h.progressListeners.size, 0);
  h.start({});
  assert.equal(h.progressListeners.size, 0);
  h.start();
  assert.equal(h.key('key').getAttribute('reserved'), 'true');
  assert.equal(h.progressListeners.size, 1);
  assert.equal(h.window.listeners.get('keypress').size, 1);
  h.window.dispatch('unload');
  assert.equal(h.progressListeners.size, 0);
  assert.equal(h.window.listeners.get('keypress').size, 0);
  assert.equal(h.window.listeners.get('keydown').size, 0);
  assert.ok([...h.prefObservers.values()].every(observers => observers.size === 0));
  assert.ok(h.mutations.every(observer => !observer.observing));
  assert.equal(h.key('key').getAttribute('reserved'), null);
});


test('switcher commands, keys, and native menu references are complete when attached', () => {
  const h = harness();
  const installed = h.attachments.find(item => item.name === 'keyset' && item.keys.includes('key_zsp_tabSwitcher_forward'));
  assert.deepEqual(installed.keys, ['key_zsp_tabSwitcher_forward', 'key_zsp_tabSwitcher_backward']);
  for (const direction of ['forward', 'backward']) {
    const key = h.key('key_zsp_tabSwitcher_' + direction);
    const menu = h.key('menu_zsp_tabSwitcher_' + direction);
    const command = h.key('cmd_zsp_tabSwitcher_' + direction);
    assert.ok(command);
    assert.equal(key.getAttribute('command'), command.id);
    assert.equal(menu.getAttribute('command'), command.id);
    assert.equal(menu.getAttribute('key'), key.id);
    assert.equal(key.getAttribute('key'), null, 'binding starts unset until the user assigns it');
    assert.equal(key.getAttribute('modifiers'), null);
    assert.equal(h.attachments.find(item => item.id === menu.id).menuKey, key);
  }
  const observer = h.mutations.find(item => item.target === h.key('key_zsp_tabSwitcher_forward').parentNode);
  assert.equal(observer.options.subtree, true);
  assert.deepEqual(Array.from(observer.options.attributeFilter), ['key', 'keycode', 'modifiers']);
  const menu = h.key('menu_zsp_tabSwitcher_forward');
  const changes = [];
  const originalSet = menu.setAttribute.bind(menu);
  const originalRemove = menu.removeAttribute.bind(menu);
  menu.setAttribute = (name, value) => { changes.push(['set', name, value]); originalSet(name, value); };
  menu.removeAttribute = name => { changes.push(['remove', name]); originalRemove(name); };
  h.bind('forward', 'control,alt', 'j');
  observer.callback([{ target: h.key('key_zsp_tabSwitcher_forward'), attributeName: 'key' }]);
  assert.deepEqual(changes, [['remove', 'key'], ['set', 'key', 'key_zsp_tabSwitcher_forward']]);
});

test('native switcher goes forward, reverses within the open panel, and commits only on modifier release', () => {
  const h = harness();
  const forward = h.bind('forward');
  h.bind('backward');
  forward.doCommand();
  assert.equal(h.ctrlTab.selected._tab.index, 1);
  assert.equal(h.ctrlTab.pending, true);
  assert.deepEqual(h.ctrlTab.picks, []);
  h.api.cycleTabs(true);
  assert.equal(h.ctrlTab.selected._tab.index, 2);
  assert.equal(h.ctrlTab.panelOpen, true);
  h.api.cycleTabs(false);
  assert.equal(h.ctrlTab.selected._tab.index, 1);
  h.release({ metaKey: true });
  assert.deepEqual(h.ctrlTab.picks, []);
  h.release({ isTrusted: false });
  assert.deepEqual(h.ctrlTab.picks, []);
  const release = h.release();
  assert.equal(release.defaultPrevented, true);
  assert.equal(release.propagationStopped, true);
  assert.deepEqual(h.ctrlTab.picks.map(tab => tab.index), [1]);
  assert.equal(h.ctrlTab.isOpen, false);
});

test('backward starts at the last tab and cycling skips Show All Tabs in either direction', () => {
  const h = harness();
  h.bind('forward');
  h.bind('backward');
  h.key('menu_zsp_tabSwitcher_backward').doCommand();
  assert.equal(h.ctrlTab.selected._tab.index, 3);
  h.api.cycleTabs(true);
  assert.equal(h.ctrlTab.selected._tab.index, 0);
  h.api.cycleTabs(false);
  assert.equal(h.ctrlTab.selected._tab.index, 3);
  h.release();
  assert.deepEqual(h.ctrlTab.picks.map(tab => tab.index), [3]);
});

test('a quick modifier release picks before popup display, with one and two tab cases', () => {
  const quick = harness();
  quick.bind('forward');
  quick.api.cycleTabs(true);
  assert.equal(quick.ctrlTab.pending, true);
  quick.release();
  assert.deepEqual(quick.ctrlTab.picks.map(tab => tab.index), [1]);
  assert.equal(quick.ctrlTab.panelOpen, false);
  const single = harness({ tabCount: 1 });
  single.bind('forward');
  single.api.cycleTabs(true);
  single.release();
  assert.equal(single.ctrlTab.opens, 0);
  assert.deepEqual(single.ctrlTab.picks, []);
  for (const forward of [true, false]) {
    const two = harness({ tabCount: 2 });
    two.bind(forward ? 'forward' : 'backward');
    two.api.cycleTabs(forward);
    assert.equal(two.ctrlTab.isOpen, true);
    assert.equal(two.ctrlTab.selected._tab.index, 1);
    two.release();
    assert.deepEqual(two.ctrlTab.picks.map(tab => tab.index), [1]);
  }
});

test('switcher commit follows edited modifiers, and unmodified bindings pick immediately', () => {
  const h = harness();
  h.bind('forward', 'control,alt', 'j');
  h.api.cycleTabs(true);
  h.release({ ctrlKey: true, altKey: true });
  assert.deepEqual(h.ctrlTab.picks, []);
  h.release({ ctrlKey: true, altKey: false });
  assert.deepEqual(h.ctrlTab.picks.map(tab => tab.index), [1]);
  h.bind('forward', '', 'j');
  h.api.cycleTabs(true);
  assert.deepEqual(h.ctrlTab.picks.map(tab => tab.index), [1, 1]);
  assert.equal(h.ctrlTab.isOpen, false);
});

test('switcher unload cancels without selecting and removes only its own commands, keys, menus, and handlers', () => {
  const h = harness({ keys: [{ id: 'native', key: 'n', modifiers: 'accel' }] });
  h.bind('forward');
  h.api.cycleTabs(true);
  h.api.uninit();
  assert.deepEqual(h.ctrlTab.picks, []);
  assert.equal(h.ctrlTab.closes, 1);
  assert.equal(h.ctrlTab.isOpen, false);
  assert.ok(h.key('native'));
  assert.ok(h.key('windowPopup'));
  for (const direction of ['forward', 'backward']) {
    assert.equal(h.key('key_zsp_tabSwitcher_' + direction), null);
    assert.equal(h.key('cmd_zsp_tabSwitcher_' + direction), null);
    assert.equal(h.key('menu_zsp_tabSwitcher_' + direction), null);
  }
  assert.equal(h.window.listeners.get('keyup').size, 0);
  assert.ok(h.mutations.every(observer => !observer.observing));
});

test('switcher participates in per-shortcut priority and Use Both dispatches its command only once', () => {
  const h = harness();
  const forward = h.bind('forward', 'accel', 'g');
  h.api.setRules({ [forward.id]: 'both' });
  assert.equal(h.api.modeFor(forward.id), 'both');
  assert.equal(forward.getAttribute('reserved'), 'false');
  const first = h.keypress();
  assert.equal(first.defaultPrevented, false);
  assert.equal(h.ctrlTab.opens, 1);
  assert.equal(h.ctrlTab.selected._tab.index, 1);
  assert.equal(h.keypress().defaultPrevented, true);
  assert.equal(h.ctrlTab.selected._tab.index, 1);
  h.window.dispatch('keydown');
  h.keypress();
  assert.equal(h.ctrlTab.selected._tab.index, 2);
  h.release();
  assert.deepEqual(h.ctrlTab.picks.map(tab => tab.index), [2]);
  h.api.setRules({ [forward.id]: 'zen' });
  assert.equal(forward.getAttribute('reserved'), 'true');
});

test('native priority follows the macOS switcher mode and stops when disabled', () => {
  const attr = 'data-native-shortcut-priority';
  const h = harness({ keys: [{ id: 'other', reserved: 'true' }] });
  const forward = h.bind('forward');
  const backward = h.bind('backward');
  assert.equal(forward.getAttribute(attr), 'true');
  assert.equal(backward.getAttribute(attr), 'true');
  assert.equal(h.key('other').getAttribute(attr), null);
  for (const mode of ['websites', 'both']) {
    h.api.setRules({ [forward.id]: mode });
    assert.equal(forward.getAttribute(attr), null);
    assert.equal(backward.getAttribute(attr), 'true');
  }
  h.api.setRules({ [forward.id]: 'zen' });
  assert.equal(forward.getAttribute(attr), 'true');
  h.setPref(branch + 'enabled', false);
  assert.equal(forward.getAttribute(attr), null);
  assert.equal(backward.getAttribute(attr), null);
  h.setPref(branch + 'enabled', true);
  assert.equal(forward.getAttribute(attr), 'true');
  assert.equal(backward.getAttribute(attr), 'true');
});

test('native priority stays absent on other platforms and honors the global mode', () => {
  const attr = 'data-native-shortcut-priority';
  const linux = harness({ platform: 'linux' });
  assert.equal(linux.bind('forward').getAttribute(attr), null);
  const h = harness({ prefs: { [branch + 'default']: 'websites' } });
  const forward = h.bind('forward');
  assert.equal(forward.getAttribute(attr), null);
  h.api.setRules({ [forward.id]: 'zen' });
  assert.equal(forward.getAttribute(attr), 'true');
  h.api.setRules({});
  assert.equal(forward.getAttribute(attr), null);
});
