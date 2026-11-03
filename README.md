# Shortcut Priority

Arc's per-shortcut conflict setting, for Zen. Every shortcut in Zen's Keyboard Shortcuts settings gets a picker that decides what happens when a website also uses that key:

| Option | What happens |
| --- | --- |
| Prefer Websites | The website gets the key first. If it handles it, Zen does nothing. |
| Use Both | The website gets the key, and Zen runs its shortcut too. |
| Prefer Zen | Zen runs its shortcut, and the website never sees the key. |

![Keyboard Shortcuts with the conflict picker](screenshots/keyboard-shortcuts.png)

Pickers you've changed are outlined. Ones you haven't show what the shortcut does out of the box: most are Prefer Websites, while a few (new tab, new window, close tab, quit and similar) are Prefer Zen. Picking the out-of-the-box option clears your setting.

Built and tested against Zen 1.24b.

## Install

1. In Zen, open Settings → Sine Mods.
2. Install from `https://github.com/pbroom/shortcut-priority`.
3. This mod runs a script, so non-store installs need `sine.allow-unsafe-js` set to `true` in `about:config`.

Then open Settings → Keyboard Shortcuts (`about:keyboard`). Turning the mod off puts every shortcut back the way Zen ships it, without a restart.

## Tab switcher

The mod adds **Tab Switcher (forward)** and **Tab Switcher (backward)** to the View section of `about:keyboard`. Assign the keys there and choose their priority using the same picker as every other shortcut. They start unassigned, so installing the mod does not replace your existing bindings.

For an Arc-style setup on macOS:

1. Clear **Go to Tab 1** if you want to reuse Command+1.
2. Assign **Tab Switcher (forward)** to Command+backtick and **Tab Switcher (backward)** to Command+1.
3. Hold Command while pressing either key to cycle through the native recent-tab previews. Release Command to select. Ctrl+Tab continues to work.

macOS normally reserves Command+backtick for **Move focus to next window**. The optional compiled bridge below lets **Prefer Zen** override that combination on stock Zen 1.24b. The mod leaves global macOS shortcuts unchanged. **Prefer Websites**, **Use Both**, remapping the forward action, and disabling the mod withdraw the override. Other combinations work without the bridge. The companion Zen/Gecko source backport remains another route.

The native override applies to saved bindings. macOS may still intercept Command+backtick while recording a new, empty binding; this backport does not change the recorder. Existing saved bindings are preserved.

The switcher uses Zen's existing preview list and pending-tab rules. It skips the Show All Tabs button while cycling, and creates no separate tab history or preview UI. Disable the Sine mod to remove its actions and menu items; Zen retains your custom bindings for re-enabling it.

### Optional macOS bridge

This is a local installation for macOS and Gecko 159 (Zen 1.24b). Sine's normal installer does not install the compiled library. With Xcode Command Line Tools installed:

1. Run `./native/build.sh` in this checkout. It builds and ad-hoc signs a universal arm64/x86_64 library.
2. Quit Zen normally.
3. Copy `macos-shortcuts.sys.mjs` and `native/build/libshortcut-priority.dylib` beside the installed `shortcut-priority.uc.js` in your profile's `chrome/sine-mods/shortcut-priority/` directory. Update that script from this checkout too.
4. Start Zen and select **Prefer Zen** for the saved Command+backtick forward binding.

The bridge uses the existing Sine loader. It does not replace, edit, or re-sign the Zen application. JavaScript only calls outbound C functions; native callbacks stay in compiled Objective-C. Removing the two optional files and restarting removes the bridge. Restart after replacing its library, because the loaded library stays pinned until process exit.

The bridge refuses unsupported Gecko versions. After a browser upgrade, ordinary shortcut priority remains available, but the native override needs verification against that version.

## Options

In the mod's settings in Sine Mods, or under `zen.shortcut-priority.*` in `about:config`.

| Pref | Default | What it does |
| --- | --- | --- |
| `zen.shortcut-priority.enabled` | `true` | Turns the mod on or off |
| `zen.shortcut-priority.default` | `default` | What shortcuts you haven't set use: `default` (Zen's own behavior), `websites`, `both` or `zen` |
| `zen.shortcut-priority.rules` | `{}` | Your per-shortcut choices, as JSON (`{"key_id": "zen"}`). The picker writes this. |

## How it works

Zen 1.24 moved its shortcuts to Firefox's `about:keyboard`, where each shortcut is a `<key>` element. Gecko already has the switch Arc's setting needs: a key marked `reserved="true"` never reaches the page's own key listeners, and one marked `reserved="false"` lets the page cancel it with `preventDefault()`.

- **Prefer Zen** sets `reserved="true"`. **Prefer Websites** sets `reserved="false"`. Gecko only reads key elements when their keyset is attached, so the script re-attaches changed keysets, the same way Firefox applies edited shortcuts.
- On macOS, the switcher keys also carry `data-native-shortcut-priority="true"` while enabled and using **Prefer Zen**. The companion native patch checks that opt-in on a reserved chrome key before AppKit's default shortcut handling. Stock Zen ignores the attribute. Other shortcut actions are not opted in.
- The optional stock-Zen bridge registers only browser windows whose forward switcher is enabled, bound to Command+backtick, and set to Prefer Zen. It invokes that action through Gecko's normal native menu target before AppKit handles window cycling. Other keys, windows, sheets, and modal dialogs keep their normal handling. Unloading unregisters the window and restores the native methods when no registered windows remain.
- The actions use View because macOS manages the Window menu. After inserting/removing the rows, the mod refreshes Gecko's native menu cache without opening menus or firing popup handlers. Closing a window skips that refresh.
- Initial backward traversal chooses the last visible native preview while preserving the popup delay. A quick modifier release can then select it before popup focus changes.
- **Use Both** keeps the key unreserved so the page gets it, runs Zen's command itself as soon as the key is pressed, and cancels the copy of the event the page process sends back so the command doesn't run twice.
- The picker is added to `about:keyboard` by a small frame script, because that page runs in Firefox's privileged about: process rather than the browser window.

## Verification

Run `npm test` (Node 22 or later). The tests exercise priority rules, event forwarding, native switcher actions, modifier release, and unload cleanup with a browser harness. They do not prove macOS shortcut delivery; verify configured keys in a running Zen as well.

On macOS, run `./native/test.sh` for the compiled hook fixtures. These test native filtering, menu dispatch, restoration, and other interposers; they do not replace real keyboard checks in Zen.

## License

MIT
