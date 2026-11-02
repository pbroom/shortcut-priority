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
- **Use Both** keeps the key unreserved so the page gets it, runs Zen's command itself as soon as the key is pressed, and cancels the copy of the event the page process sends back so the command doesn't run twice.
- The picker is added to `about:keyboard` by a small frame script, because that page runs in Firefox's privileged about: process rather than the browser window.

## License

MIT
