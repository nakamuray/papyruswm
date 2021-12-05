'use strict';
/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();

const mainloop = imports.mainloop;
const { Clutter, GLib, Gio, Meta, Shell, St } = imports.gi;
const Main = imports.ui.main;
const Ripples = imports.ui.ripples;

const OUT_OF_FOCUS_WINDOW_Y_OFFSET = 0.05;
const WINDOW_SPACE = 16;
const WINDOW_MOVE_DURATION = 250;
const WINDOW_MOVE_MODE = Clutter.AnimationMode.EASE_IN_OUT_QUAD;

var DEBUG = false;
function _debug_log(...args) {
    if (DEBUG) {
        log.apply(null, args);
    }
}

class PapyrusManager {
    constructor(workspace) {
        this._rearranging = false;
        this._window_handler_ids = {};

        this.workspace = workspace;
        this.managed_windows = [];
        workspace.list_windows().forEach((window) => {
            if (this._ignore_window(window)) {
                _debug_log(`ignore window "${window.title}", just watch focus`);
                this._connect_window_once(window, "focus", this.on_ignored_window_focus.bind(this));
            } else {
                this.managed_windows.push(window);
            }
        });
        this.managed_windows.sort((first, second) => {
            // sort windows by x-axis
            // (gnome-shell has some limitation on window position, ordering windows by it's x-axis may failed to 
            // recover original window order while disable -> enable extension.
            // actor doesn't have the limitation, use it)
            return first.get_compositor_private().x - second.get_compositor_private().x;
        });
        this.managed_windows.forEach((window, i) => {
            var priv = window.get_compositor_private();
            var rect = window.get_frame_rect();
            _debug_log(`window "${window.title}", index=${i}, rect.x=${rect.x}, priv.x=${priv.x}`)

            this._connect_window_once(window, "position-changed", this.on_window_position_changed.bind(this));
            this._connect_window_once(window, "size-changed", this.on_window_size_changed.bind(this));
            this._connect_window_once(window, "focus", this.on_window_focus.bind(this));
        });

        this._workspace_handler_ids = [
            this.workspace.connect('window-added', this.on_window_added.bind(this)),
            this.workspace.connect('window-removed', this.on_window_removed.bind(this)),
        ];

        this._overview_handler_id = Main.overview.connect('hidden', this.on_overview_hidden.bind(this));

        if (workspace.active) {
            _idle_add_oneshot(GLib.PRIORITY_DEFAULT, () => {
                this.rearrange_windows(this._last_focused_window(), true, true);
            });
        }
    }

    disable() {
        this.managed_windows.forEach((window) => this._disconnect_window_all(window));
        this.managed_windows.forEach((window, i) => {
            var priv = window.get_compositor_private();
            var rect = window.get_frame_rect();
            _debug_log(`window "${window.title}", index=${i}, rect.x=${rect.x}, priv.x=${priv.x}`)
        });

        // to disconnect from float (ignored) windows, which is not in managed_windows,
        // try to disconnect all windows within this workspace;
        this.workspace.list_windows().forEach(this._disconnect_window_all.bind(this));

        this.managed_windows = [];

        this._workspace_handler_ids.forEach((handler_id) => this.workspace.disconnect(handler_id));
        this._workspace_handler_ids = [];
        this.workspace = null;

        Main.overview.disconnect(this._overview_handler_id);
    }

    _connect_window_once(window, signal, handler) {
        var id = window.get_id();
        if (!this._window_handler_ids[id]) {
            this._window_handler_ids[id] = {};
        }
        if (!this._window_handler_ids[id][signal]) {
            this._window_handler_ids[id][signal] = window.connect(signal, handler);
        }
    }

    _disconnect_window_all(window) {
        var id = window.get_id();
        if (this._window_handler_ids[id]) {
            for (var signal in this._window_handler_ids[id]) {
                var handler_id = this._window_handler_ids[id][signal];
                window.disconnect(handler_id);
            }
            delete this._window_handler_ids[id];
        }
    }

    _get_reverse_managed_window_index_map() {
        var map = new Map();
        this.managed_windows.forEach((window, index) => {
            map.set(window, index);
        });
        return map;
    }

    _get_last_focused_index() {
        var map = this._get_reverse_managed_window_index_map();
        for (var window of global.display.get_tab_list(Meta.TabList.NORMAL_ALL, this.workspace)) {
            if (!window.get_compositor_private()) {
                // maybe the window closing, skip
                continue;
            }
            var index = map.get(window);
            if (index !== undefined) {
                return index;
            }
        }
        return -1;
    }

    _last_focused_window() {
        var index = this._get_last_focused_index();
        if (index == -1) {
            return null;
        } else {
            return this.managed_windows[index];
        }
    }

    _ignore_window(window) {
        if (window.get_window_type() != Meta.WindowType.NORMAL) {
            _debug_log(`not a normal type, ignore`);
            return true;
        }

        if (window.is_on_all_workspaces()) {
            _debug_log(`window is on all workspaces, ignore`);
            return true;
        }

        if (window.get_transient_for()) {
            _debug_log(`have transient_for window "${window.get_transient_for().title}", ignore`);
            return true;
        }

        return false;
    }

    on_window_added(ws, window) {
        _debug_log(`window "${window.title}", type:${window.get_window_type()} added`);
        _debug_log(`actor: ${window.get_compositor_private()}`);

        var index = this.managed_windows.findIndex((w) => w.get_id() == window.get_id());
        if (index != -1) {
            log(`window "${window.title}" already managed (index:${index}), ignore`);
            return;
        }

        var next_step = () => {
                if (this._ignore_window(window)) {
                    _debug_log(`ignore window "${window.title}", just watch focus`);
                    this._connect_window_once(window, "focus", this.on_ignored_window_focus.bind(this));
                    var base_window = this._last_focused_window();
                    this.rearrange_windows(base_window, false, true);
                    return;
                }

                var last_focused_index = this._get_last_focused_index();
                _debug_log(`insert window to ${last_focused_index + 1}`);
                // insert window after currently focused window
                this.managed_windows.splice(last_focused_index + 1, 0, window);

                this._connect_window_once(window, "position-changed", this.on_window_position_changed.bind(this));
                this._connect_window_once(window, "size-changed", this.on_window_size_changed.bind(this));
                this._connect_window_once(window, "focus", this.on_window_focus.bind(this));
                // to run rearrange after show-window animation, use idle_add
                _idle_add_oneshot(GLib.PRIORITY_DEFAULT, () => {
                    this.rearrange_windows(window, true, true);
                });
            };

        if (window.get_compositor_private()) {
            // window has actor (window already displayed)
            // do next step immediately
            next_step();
        } else {
            // window doesn't have actor
            // wait until window displayed
            var handler_id;
            switch (window.get_client_type()) {
                case Meta.WindowClientType.WAYLAND:
                    handler_id = window.connect('shown', () => {
                        _debug_log(`window "${window.title}", type:${window.get_window_type()} shown`);
                        window.disconnect(handler_id);

                        next_step();
                    });
                    break;
                case Meta.WindowClientType.X11:
                    // XXX: because X11 window seems not to emit "shown" signal, watch display's "window-created" instead
                    var display = window.get_display();
                    handler_id = display.connect("window-created", (display, created_window) => {
                        if (created_window.get_id() == window.get_id()) {
                            _debug_log(`window "${window.title}", type:${window.get_window_type()} created`);
                            display.disconnect(handler_id);
                            next_step();
                        }
                    });
                    break;
                default:
                    log(`window "${window.title}" has unknown client type ${window.get_client_type()}`);
            }
        }
    }

    on_window_position_changed(window) {
        _debug_log(`window "${window.title}" position changed`);
        this.rearrange_windows(window, false, false);
    }

    on_window_size_changed(window) {
        _debug_log(`window "${window.title}" size changed`);
        var show = window.has_focus() ? true : false;
        // XXX: may I enable animation there?
        //      (when window resized by mouse drag, I don't want to animate.
        //      but if resized directly by some other method, I want)
        this.rearrange_windows(window, show, false);
    }

    on_window_focus(window) {
        _debug_log(`window "${window.title}" focused`);
        var priv = window.get_compositor_private();
        if (!priv) {
            _debug_log("XXX: compositor_private is null");
            return;
        }

        this.rearrange_windows(window, true, true);

        if (Main.overview.visible) {
            return;
        }

        // if cursor not on the window, move it on it
        var [cursor_x, cursor_y] = cursor.get_pointer();
        var rect = window.get_frame_rect();

        if (cursor_x < rect.x
            || cursor_x > rect.x + rect.width
            || cursor_y < rect.y
            || cursor_y > rect.y + rect.height) {
            var [x, y] = _get_move_point(cursor_x, cursor_y, rect);
            cursor.move(x, y, WINDOW_MOVE_DURATION);
        }
    }

    on_ignored_window_focus(window) {
        _debug_log(`ignored window "${window.title}" focused`);
        if (this.workspace.active && this.managed_windows.length) {
            var base_window = window;
            // ignored window might be a dialog which attached to managed window
            // if so, use the managed one as a rearrenge base
            while (base_window.get_transient_for()) {
                base_window = base_window.get_transient_for();
            }
            if (this.managed_windows.includes(base_window)) {
                // ansestor window is managed
                // use it as a base window and show it
                this.rearrange_windows(base_window, true, true);
            } else {
                // ansestor window is not managed (or, not a dialog window in the first place)
                // use last focused window as a base but no need to show it
                base_window = this._last_focused_window();
                this.rearrange_windows(base_window, false, true);
            }

        }
    }

    rearrange_windows(...args) {
        if (this._rearranging) {
            // don't re-rearrange while rearranging now
            return;
        }
        this._rearranging = true;
        try {
            var ret = this._rearrange_windows.apply(this, args);
        } catch (err) {
            this._rearranging = false;
            throw err;
        }
        this._rearranging = false;
        return ret;
    }
    _rearrange_windows(base_window, show, animate) {
        var base_index = this.managed_windows.indexOf(base_window);
        if (base_index == -1) {
            _debug_log(`base window "${base_window?.title}" is not managed, do nothing`);
            return;
        }

        _debug_log(`overview.visible = ${Main.overview.visible}, workspace.active = ${this.workspace.active}`);
        if (Main.overview.visible) {
            _debug_log(`ovewview is visible, skip`);
            return;
        }

        var window_space = _scaled_window_space();

        if (show) {
            // move window within display area if not
            var rect = base_window.get_frame_rect();
            var [display_width, display_height] = global.display.get_size();
            _debug_log(`focused:x = ${rect.x}, width = ${rect.width}, display.width = ${display_width}`);

            var y = _get_y_offset(base_window);

            if (rect.x < 0) {
                // if window is on the left side of window, move it to upper left
                _debug_log(`move focused window within display area`);
                _move_frame_with_animation(base_window, window_space / 2, y, animate);
            } else if (rect.x + rect.width > display_width) {
                // if window is on the right side of window, move it to upper right
                _debug_log(`move focused window within display area`);
                _move_frame_with_animation(base_window, display_width - rect.width - window_space / 2, y, animate);
            } else {
                // if displayed, move it to upper
                _move_frame_with_animation(base_window, rect.x, y, animate);
            }
        } else {
            var y = _get_y_offset(base_window);
            var rect = base_window.get_frame_rect();
            _move_frame_with_animation(base_window, rect.x, y, animate);
        }
        // move other windows to a position based on the window one

        var base_rect = base_window.get_frame_rect();
        var x = base_rect.x;
        _debug_log(`base:x = ${base_rect.x}`);

        // re-arrange windows left side of base window
        for (var i = base_index - 1; i >= 0; i--) {
            var window = this.managed_windows[i];

            var priv = window.get_compositor_private();
            if (!priv) {
                _debug_log("XXX: compositor_private is null");
            } else if (window.minimized) {
                _debug_log(`left:${i}:${window.title} skip minimized one}`);
            } else {
                var rect = window.get_frame_rect();
                x = x - window_space - rect.width;
                var y = _get_y_offset(window);
                _debug_log(`left:${i}:${window.title} move to x = ${x}`);
                _move_frame_with_animation(window, x, y, animate);
            }
        }
        // re-arrange windows right side of base window
        _debug_log(`base:x = ${base_rect.x}, width = ${base_rect.width}`);
        x = base_rect.x + base_rect.width + window_space;
        for (var i = base_index + 1; i < this.managed_windows.length; i++) {
            var window = this.managed_windows[i];

            var priv = window.get_compositor_private();
            if (!priv) {
                _debug_log("XXX: compositor_private is null");
            } else if (window.minimized) {
                _debug_log(`right:${i}:${window.title} skip minimized one`);
            } else {
                _debug_log(`right:${i}:${window.title} move to x = ${x}`);
                var y = _get_y_offset(window);
                _move_frame_with_animation(window, x, y, animate);

                var rect = window.get_frame_rect();
                x = x + rect.width + window_space;
            }
        }
    }

    on_window_removed(ws, window) {
        var pos = this.managed_windows.indexOf(window);
        _debug_log(`removed window pos: ${pos}`);
        if (pos >= 0) {
            this.managed_windows.splice(pos, 1);
        }
        _debug_log("disconnect handlers");
        this._disconnect_window_all(window);
    }

    on_overview_hidden() {
        _debug_log(`overview hidden, workspace.actie=${this.workspace.active}`);
        if (!this.workspace.active) {
            return;
        }
        var window = global.display.focus_window;
        this.rearrange_windows(window, true, true);
    }

    move_focus_next() {
        var focused_index = this._get_last_focused_index();
        var focused_window = this.managed_windows[focused_index];
        var next_index;
        if (focused_window != global.display.focus_window) {
            next_index = focused_index;
        } else {
            next_index = this._get_next_index(focused_index);
        }
        if (next_index >= 0) {
            var next_window = this.managed_windows[next_index];
            var timestamp = global.display.get_current_time_roundtrip();
            next_window.focus(timestamp);
            next_window.raise();
        }
    }

    move_focus_previous() {
        var focused_index = this._get_last_focused_index();
        var focused_window = this.managed_windows[focused_index];
        var previous_index;
        if (focused_window != global.display.focus_window) {
            previous_index = focused_index;
        } else {
            previous_index = this._get_previous_index(focused_index);
        }
        if (previous_index >= 0) {
            var previous_window = this.managed_windows[previous_index];
            var timestamp = global.display.get_current_time_roundtrip();
            previous_window.focus(timestamp);
            previous_window.raise();
        }
    }

    swap_next() {
        var focused_index = this._get_last_focused_index();
        var focused_window = this.managed_windows[focused_index];
        if (focused_window != global.display.focus_window) {
            // do nothing if actually focused window is not managed
            return;
        }
        var next_index = this._get_next_index(focused_index);
        if (focused_index >=0 && next_index >= 0) {
            var window = this.managed_windows[focused_index];
            _swap(this.managed_windows, focused_index, next_index);
            this.rearrange_windows(window, false, true);
        }
    }

    swap_previous() {
        var focused_index = this._get_last_focused_index();
        var focused_window = this.managed_windows[focused_index];
        if (focused_window != global.display.focus_window) {
            // do nothing if actually focused window is not managed
            return;
        }
        var previous_index = this._get_previous_index(focused_index);
        if (focused_index >= 0 && previous_index >= 0) {
            var window = this.managed_windows[focused_index];
            _swap(this.managed_windows, focused_index, previous_index);
            this.rearrange_windows(window, false, true);
        }
    }

    _get_next_index(index) {
        if (index < 0) {
            return -1;
        }
        for (var i = index + 1; i < this.managed_windows.length; i++) {
            var window = this.managed_windows[i];
            if (!window.minimized) {
                return i;
            }
        }
        return -1;
    }

    _get_previous_index(index) {
        if (index < 0) {
            return -1;
        }
        if (index >= this.managed_windows.length) {
            return -1;
        }
        for (var i = index - 1; i >= 0; i--) {
            var window = this.managed_windows[i];
            if (!window.minimized) {
                return i;
            }
        }
        return -1;
    }
}

function _swap(array, i, j) {
    [array[i], array[j]] = [array[j], array[i]];
}

function _idle_add_oneshot(priority, handler) {
    return GLib.idle_add(priority, () => {
        try {
            handler();
        } catch (err) {
            logError(err, 'something wrong');
        }
        return GLib.SOURCE_REMOVE;
    });
}

function _get_scale_factor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

function _scaled_window_space() {
    var scale = _get_scale_factor();
    return WINDOW_SPACE * scale;
}

function _move_frame_with_animation(window, x, y, animate) {
    var panel_height = window.is_fullscreen() ? 0 : Main.panel.height;

    // gnome-shell (or mutter?) don't allow to move window above panel
    if (y < panel_height) {
        y = panel_height;
    }

    var actor = window.get_compositor_private();

    var rect = window.get_frame_rect();
    var brect = window.get_buffer_rect();

    var x_offset = rect.x - brect.x;
    var y_offset = rect.y - brect.y;

    if (animate) {
        actor.ease({x: x - x_offset, y: y - y_offset, duration: WINDOW_MOVE_DURATION, mode: WINDOW_MOVE_MODE});
    } else {
        actor.set_position(x - x_offset, y - y_offset);
    }
    window.move_frame(true, x, y);
}

function _get_y_offset(window) {
    var [_width, display_height] = global.display.get_size();
    var panel_height = window.is_fullscreen() ? 0 : Main.panel.height;
    var space = (window.is_fullscreen() || window.maximized_vertically) ? 0 : _scaled_window_space() / 2;

    var has_focus = window.has_focus();
    if (!has_focus) {
        window.foreach_transient((win) => {
            // XXX: should I also check win is not a NORMAL type?
            if (win.has_focus()) {
                // if window attached to it (like dialog) has focus, treat it has focus
                has_focus = true;
            }
        });
    }
    var y_offset = has_focus ? 0 : OUT_OF_FOCUS_WINDOW_Y_OFFSET;
    var y = Math.floor(display_height * y_offset) + panel_height + space;
    _debug_log(`display.height = ${display_height}, y_offset = ${y_offset}, panel.height = ${panel_height}, panel.visible = ${Main.panel.visible}, space = ${space}, y = ${y}`);

    return y;
}

function _get_move_point(cursor_x, cursor_y, window_rect) {
    const split_num = 3;
    var points = [];
    for (var i = 1; i < split_num; i++) {
        for (var j = 1; j < split_num; j++) {
            var x = window_rect.x + Math.floor(window_rect.width * i / split_num);
            var y = window_rect.y + Math.floor(window_rect.height * j / split_num);
            var d = Math.abs(Math.sqrt((cursor_x - x) ** 2 + (cursor_y - y) ** 2));
            points.push([d, x, y]);
        }
    }
    points.sort((a, b) => a[0] - b[0]);
    _debug_log(`points: ${points}`);
    var [_, x, y] = points.shift();
    return [x, y];
}

class Spotlight {
    constructor() {
        this.target_types = new Set([
            Meta.WindowType.NORMAL,
            Meta.WindowType.DIALOG,
            Meta.WindowType.MODAL_DIALOG,
        ]);
        this._window = null;
        this._window_handler_ids = [];
        this._actor_handler_ids = [];
        this._display_hander_id = global.display.connect('notify::focus-window', () => this.focus(global.display.focus_window));
        this._bin = new St.Bin({style_class: 'papyrus-spotlight'});
    }

    focus(window) {
        if (this._window == window) {
            return;
        }

        if (!this.target_types.has(window?.get_window_type())) {
            return;
        }

        this._unmanage();

        this._window = window;

        if (!this._window) {
            return;
        }

        this._window_handler_ids = [
            this._window.connect('size-changed', this._fit.bind(this)),
            this._window.connect('unmanaging', this._unmanage.bind(this)),
        ];

        var actor = this._window.get_compositor_private();
        actor.insert_child_below(this._bin, null);
        this._actor_handler_ids = [
            actor.connect('notify::first-child', this._down.bind(this)),
        ],

        this._bin.set_opacity(0);
        this._bin.show();
        this._fit();
        this._bin.ease({opacity: 255, duration: WINDOW_MOVE_DURATION});
    }

    _down() {
        // touch actor index right after signal emission might break other one's behavior,
        // do the thing on idle time
        _idle_add_oneshot(GLib.PRIORITY_DEFAULT, () => {
            var parent = this._bin.get_parent();
            if (parent && parent.first_child != this._bin) {
                // keep spotlight below
                parent.set_child_below_sibling(this._bin, null);
            }
        });
    }

    _unmanage() {
        this.off();

        if (this._window) {
            this._window_handler_ids.forEach((handler_id) => {
                this._window.disconnect(handler_id);
            });
            this._window_handler_ids = [];

            var actor = this._window.get_compositor_private();
            if (actor) {
                this._actor_handler_ids.forEach((handler_id) => {
                    actor.disconnect(handler_id);
                });
            }
            this._actor_handler_ids = [];

            this._window = null;

            var parent = this._bin.get_parent();
            if (parent) {
                parent.remove_child(this._bin);
            }
        }
    }

    _fit() {
        var scale = _get_scale_factor();

        var border_width = WINDOW_SPACE / 2;
        var rect = this._window.get_frame_rect();
        var brect = this._window.get_buffer_rect();

        var x_offset = (rect.x - brect.x) / scale;
        var y_offset = (rect.y - brect.y) / scale;

        var width = rect.width / scale;
        var height = rect.height / scale;

        this._bin.set_position(x_offset - border_width, y_offset - border_width);
        this._bin.set_size(width + border_width * 2, height + border_width * 2);
    }

    on() {
        this._bin.show();
    }

    off() {
        this._bin.hide();
    }

    destroy() {
        global.display.disconnect(this._display_hander_id);
        this._unmanage();
        this._bin.destroy();
        this._bin = null;
    }
}

class Cursor {
    constructor() {
        var FPS = 30;

        this._millisec_per_frame = Math.floor(1000 / FPS);
        this._motion_points = [];

        var seat = Clutter.get_default_backend().get_default_seat();
        this._cursor = seat.create_virtual_device(Clutter.InputDeviceType.CURSOR_DEVICE);

        this._timeout_handler_id = null;

        this._ripples = new Ripples.Ripples(0.5, 0.5, 'ripple-pointer-location');
        this._ripples.addTo(Main.uiGroup);

    }
    get_pointer() {
        var [x, y, _] = global.get_pointer();
        return [x, y];
    }
    move(x, y, duration) {
        duration = duration || 0;

        var frame_in_duration = Math.floor(duration / this._millisec_per_frame);
        if (!St.Settings.get().enable_animations || frame_in_duration == 0) {
            this._cursor.notify_absolute_motion(global.get_current_time(), x, y);
            return;
        }

        var [current_x, current_y] = this.get_pointer();
        for (var i = 1; i < frame_in_duration; i++) {
            this._motion_points.push([
                Math.floor(current_x + i * (x - current_x) / frame_in_duration),
                Math.floor(current_y + i * (y - current_y) / frame_in_duration),
            ]);
        }
        this._motion_points.push([x, y]);
        this._start_move();
    }
    _start_move() {
        if (this._timeout_handler_id !== null) {
            return;
        }
        this._timeout_handler_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._millisec_per_frame, this.on_timeout.bind(this));
    }
    on_timeout() {
        if (this._motion_points.length == 0) {
            this._timeout_handler_id = null;
            return false;
        }
        var [x, y] = this._motion_points.shift();
        this._cursor.notify_absolute_motion(global.get_current_time(), x, y);
        if (this._motion_points.length == 0) {
            this._ripples.playAnimation(x, y);
        }
        return true;
    }
    destroy() {
        // XXX: Can I stop timeout handler directly?
        this._motion_points = [];

        this._ripples.destroy();
        this._ripples = null;
    }
}

var cursor = null;

class Extension {
    constructor() {
        this._enabled = false;
        this._managers = new Map();
        this._workspaceManager_handlers = [];
        this._resize_state = {id: null, index: 0};
        this._vertical_resize_state = {id: null, index: 0};
        this._spotlight = null;
    }

    enable() {
        if (this._enabled) {
            log('papyrus already enabled');
            return;
        }

        log(`enabling ${Me.metadata.name}`);
        this.settings = ExtensionUtils.getSettings();

        for (var i = 0; i < global.workspaceManager.get_n_workspaces(); i += 1) {
            var workspace = global.workspaceManager.get_workspace_by_index(i);
            var papyrus = new PapyrusManager(workspace);
            this._managers.set(workspace, papyrus)
        }
        this._workspaceManager_handlers = [
            global.workspaceManager.connect('workspace-added', (wm, i) => {
                _debug_log(`workspace index:${i} added`);
                var workspace = global.workspaceManager.get_workspace_by_index(i);
                if (this._managers.has(workspace)) {
                    log(`XXX: why workspace has papyrus already?`);
                    return;
                }
                var papyrus = new PapyrusManager(workspace);
                this._managers.set(workspace, papyrus)
            }),
            global.workspaceManager.connect('workspace-removed', (wm, i) => {
                // XXX: because there is no way to know which workspace was removed,
                //      iterate all papyrus manager and check if workspace is still in the WorkspaceManager
                var alived_workspaces = new Set();
                for (var i = 0; i < global.workspaceManager.get_n_workspaces(); i += 1) {
                    var workspace = global.workspaceManager.get_workspace_by_index(i);
                    alived_workspaces.add(workspace);
                }
                this._managers.forEach((papyrus, workspace) => {
                    if (!alived_workspaces.has(workspace)) {
                        _debug_log(`workspace:${workspace} not alived, disable papyrus`);
                        this._managers.delete(workspace);
                        papyrus.disable();
                    }
                });
            }),
        ];

        Main.wm.addKeybinding(
            'papyrus-move-focus-next',
            this.settings,
            Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_move_focus_next.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-move-focus-previous',
            this.settings,
            Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_move_focus_previous.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-swap-next',
            this.settings,
            Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_swap_next.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-swap-previous',
            this.settings,
            Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_swap_previous.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-toggle-float',
            this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT|Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_toggle_float.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-cycle-resize-window',
            this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT|Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_cycle_resize_window.bind(this)
        );
        Main.wm.addKeybinding(
            'papyrus-cycle-resize-window-vertically',
            this.settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT|Meta.KeyBindingFlags.PER_WINDOW,
            Shell.ActionMode.NORMAL,
            this.on_cycle_resize_window_vertically.bind(this)
        );

        this._spotlight = new Spotlight();
        if (global.display.focus_window) {
            this._spotlight.focus(global.display.focus_window);
        }

        cursor = new Cursor();

        this._enabled = true;
    }

    disable() {
        log(`disabling ${Me.metadata.name}`);

        this._managers.forEach((papyrus, workspace) => {
            papyrus.disable();
        });
        this._managers.clear();

        this._workspaceManager_handlers.forEach((handler_id) => global.workspaceManager.disconnect(handler_id));
        this._workspaceManager_handlers = [];

        Main.wm.removeKeybinding('papyrus-move-focus-next');
        Main.wm.removeKeybinding('papyrus-move-focus-previous');
        Main.wm.removeKeybinding('papyrus-swap-next');
        Main.wm.removeKeybinding('papyrus-swap-previous');
        Main.wm.removeKeybinding('papyrus-toggle-float');
        Main.wm.removeKeybinding('papyrus-cycle-resize-window');
        Main.wm.removeKeybinding('papyrus-cycle-resize-window-vertically');

        this._spotlight.destroy();
        this._spotlight = null;

        cursor.destroy();
        cursor = null;

        this._enabled = false;
    }

    on_move_focus_next() {
        _debug_log("papyrus-move-focus-next");
        var workspace = global.workspaceManager.get_active_workspace();
        var papyrus = this._managers.get(workspace);
        papyrus.move_focus_next();
    }

    on_move_focus_previous() {
        _debug_log("papyrus-move-focus-previous");
        var workspace = global.workspaceManager.get_active_workspace();
        var papyrus = this._managers.get(workspace);
        papyrus.move_focus_previous();
    }

    on_swap_next() {
        _debug_log("papyrus-swap-next");
        var workspace = global.workspaceManager.get_active_workspace();
        var papyrus = this._managers.get(workspace);
        papyrus.swap_next();
    }

    on_swap_previous() {
        _debug_log("papyrus-swap-previous");
        var workspace = global.workspaceManager.get_active_workspace();
        var papyrus = this._managers.get(workspace);
        papyrus.swap_previous();
    }

    on_toggle_float() {
        _debug_log("papyrus-toggle-float");
        var window = global.display.focus_window;
        if (!window) {
            return;
        }
        if (window.is_on_all_workspaces()) {
            window.unstick();
            window.unmake_above();
        } else {
            window.stick();
            window.make_above();

            var rect = window.get_frame_rect();
            _move_frame_with_animation(window, rect.x, rect.y + 150, true);
        }
    }

    on_cycle_resize_window() {
        _debug_log("papyrus-cycle-resize-window");
        var window = global.display.focus_window;
        if (!window) {
            return;
        }
        const resize_window_ratios = [0.35, 0.5, 0.65];
        var [display_width, _height] = global.display.get_size();
        var rect = window.get_frame_rect();

        var window_id = window.get_id();
        var index = 0;

        if (this._resize_state.id == window_id) {
            index = (this._resize_state.index + 1) % resize_window_ratios.length;
        } else {
            resize_window_ratios.forEach((r, i) => {
                var width = Math.floor((display_width - _scaled_window_space() * 2) * r);
                if (width > rect.width) {
                    index = i;
                }
            });
        }

        var ratio = resize_window_ratios[index];
        var width = Math.floor((display_width - _scaled_window_space() * 2) * ratio);
        window.move_resize_frame(true, rect.x, rect.y, width, rect.height);

        this._resize_state.id = window_id;
        this._resize_state.index = index;
    }

    on_cycle_resize_window_vertically() {
        _debug_log("papyrus-cycle-resize-window-vertically");
        var window = global.display.focus_window;
        if (!window) {
            return;
        }

        var panel_height = Main.panel.height;

        const resize_window_ratios = [0.35, 0.5, 0.65, 0.9];
        var [_width, display_height] = global.display.get_size();
        var rect = window.get_frame_rect();

        var window_id = window.get_id();
        var index = 0;

        if (this._vertical_resize_state.id == window_id) {
            index = (this._vertical_resize_state.index + 1) % resize_window_ratios.length;
        } else {
            resize_window_ratios.forEach((r, i) => {
                var height = Math.floor((display_height - _scaled_window_space() - panel_height) * r);
                if (height > rect.height) {
                    index = i;
                }
            });
        }

        var ratio = resize_window_ratios[index];
        var height = Math.floor((display_height - _scaled_window_space() - panel_height) * ratio);
        window.move_resize_frame(true, rect.x, rect.y, rect.width, height);

        this._vertical_resize_state.id = window_id;
        this._vertical_resize_state.index = index;
    }
}


/* exported init */

function init() {
    log(`initializing ${Me.metadata.name}`);
    return new Extension();
}
