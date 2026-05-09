# ddc-input-select

Switch the active input on a Dell U5226KW from a Hyprland waybar (or any
keybind), with friendly names instead of `DP-1` / `HDMI-2`.

A small bash wrapper around [`ddcutil`](https://www.ddcutil.com/) that uses
[`walker`](https://github.com/abenz1267/walker) as a dmenu-style picker.

Inspired by [coralnode/delldispctl](https://github.com/coralnode/delldispctl),
which targets traditional desktops via a GTK system-tray icon. This project
covers the same use case for Hyprland/waybar.

## Requirements

- A Dell U5226KW (or another DDC/CI monitor — you may need to adjust the input
  codes in `config/inputs.example.json`).
- `ddcutil` — talks to the monitor over DDC/CI. Your user must be able to read
  and write `/dev/i2c-*`; on most distros that means joining the `i2c` group
  and loading the `i2c-dev` kernel module.
- `walker` — the picker UI. Any dmenu-compatible launcher (`wofi --dmenu`,
  `fuzzel --dmenu`, etc.) will work with a one-line edit to `bin/ddc-input-select`.
- `jq` — JSON parsing.
- `notify-send` (e.g. `mako`, `dunst`) — optional; used for success/error feedback.

## Install

```sh
make install
```

This installs `ddc-input-select` to `~/.local/bin/`, copies the example config
to `~/.config/ddc-input-select/inputs.json`, and prints the waybar snippet you
need to add. Uninstall with `make uninstall` (config is left in place).

## Configure

Edit `~/.config/ddc-input-select/inputs.json` to rename inputs. Set
`"hidden": true` on any entry you want to omit from the picker.

```json
{
  "inputs": [
    { "code": "0x19", "name": "Thunderbolt" },
    { "code": "0x0F", "name": "DisplayPort 1" },
    { "code": "0x13", "name": "Home Laptop" },
    { "code": "0x11", "name": "Work Laptop" },
    { "code": "0x12", "name": "HDMI 2", "hidden": true }
  ]
}
```

The default codes for the U5226KW are:

| Code   | Default label  |
| ------ | -------------- |
| `0x19` | Thunderbolt    |
| `0x0F` | DisplayPort 1  |
| `0x13` | DisplayPort 2  |
| `0x11` | HDMI 1         |
| `0x12` | HDMI 2         |

## Waybar integration

Add to `~/.config/waybar/config.jsonc`:

```jsonc
"custom/monitor-input": {
  "format": "󰍹",
  "tooltip": "Switch monitor input",
  "on-click": "ddc-input-select"
}
```

Then add `"custom/monitor-input"` to your `modules-right` (or wherever you
want it).

For consistent spacing with the rest of the bar, give the module the same
margin treatment as your other custom icons in `~/.config/waybar/style.css`:

```css
#cpu,
#battery,
#pulseaudio,
#custom-monitor-input {
  min-width: 12px;
  margin-right: 16px;
}
```

Reload waybar to pick up the changes:

```sh
pkill -SIGUSR2 waybar
```

## CLI

```
ddc-input-select            # open picker, switch on selection
ddc-input-select --current  # print "<code>\t<name>" for the active input
ddc-input-select --list     # print all (non-hidden) configured inputs
ddc-input-select --help
```

You can also bind it directly in `~/.config/hypr/bindings.conf`:

```
bind = SUPER, M, exec, ddc-input-select
```

## Notes

- DDC/CI does not expose "which inputs have a live signal" on this monitor, so
  the picker shows everything in your config rather than only-connected
  sources.
- The friendly-name mapping is in JSON specifically so it's easy to parse from
  bash via `jq`. If you'd rather hand-edit a different format, the parsing
  lives in three small `jq` invocations in `bin/ddc-input-select`.
