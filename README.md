# PapyrusWM

PapyrusWM is a scrollable window management extension for gnome-shell.
It is inspired by [PaperWM](https://github.com/paperwm/PaperWM).

## Install

Clone the repository to `$HOME/.local/share/gnome-shell/extensions/papyruswm@u7fa9.org`,
restart gnome-shell and enable it using Extensions app.

## Keyboard Shortcuts

| Key                                    | Description                                      |
| --------                               | --------                                         |
| <kbd>&lt;Super&gt;.</kbd>              | Move focus to the next window                    |
| <kbd>&lt;Super&gt;,</kbd>              | Move focus to the previous window                |
| <kbd>&lt;Super&gt;&lt;Ctrl&gt;.</kbd>  | Swap the focused window with the next window     |
| <kbd>&lt;Super&gt;&lt;Ctrl&gt;,</kbd>  | Swap the focused window with the previous window |
| <kbd>&lt;Super&gt;T</kbd>              | Toggle window floating                           |
| <kbd>&lt;Super&gt;R</kbd>              | Resize window horizontally                       |
| <kbd>&lt;Super&gt;&lt;Shift&gt;R</kbd> | Resize window vertically                         |

## Settings

PapyrusWM doesn't have preference dialog.
Instead, use `gsettings` command like below.

```console
$ gsettings --schemadir ~/.local/share/gnome-shell/extensions/papyruswm@u7fa9.org/schemas list-keys org.gnome.shell.extensions.papyruswm
papyrus-cycle-resize-window
papyrus-swap-next
papyrus-swap-previous
papyrus-cycle-resize-window-vertically
papyrus-move-focus-next
papyrus-move-focus-previous
papyrus-toggle-float
```

## TODO

* multi-monitor
* touchpad gesture
* stack windows vertically
