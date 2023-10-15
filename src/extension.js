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

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import St from 'gi://St';
// import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// Window edge action
const WindowEdgeAction = {
    NONE: 0,                    // No action
    WAIT_GESTURE: 0x01,         // Wait for gesture flag
    MOVE: 0x02,                 // Move flag
    RESIZE: 0x04,               // Resize flag

    GESTURE_LEFT: 0x10,         // Gesture Left
    GESTURE_RIGHT: 0x20,        // Gesture Right
    GESTURE_UP: 0x40,           // Gesture Up
    GESTURE_DOWN: 0x80,         // Gesture Down

    GESTURE_UP_LEFT: 0x100,     // Gesture Up Left
    GESTURE_UP_RIGHT: 0x200,    // Gesture Up Right

    GESTURE_HORIZONTAL: 0x400,  // Non-Window Gestures
    GESTURE_VERTICAL: 0x800,

    RESIZE_LEFT: 0x1000,        // Resize Flags
    RESIZE_RIGHT: 0x2000,
    RESIZE_TOP: 0x4000,
    RESIZE_BOTTOM: 0x8000,

    MOVE_SNAP_TOP: 0x10000,     // Snap Flags
    MOVE_SNAP_LEFT: 0x20000,
    MOVE_SNAP_RIGHT: 0x40000

};

// Window Blacklist Classes
const WindowClassBlacklist = [
    "gjs"
];

// Manager Class
class Manager {

    // Init Extension
    constructor(ext) {
        // Get settings
        this._settings = ext.getSettings();

        // Gestures are hooked by WGS
        this._hooked = false;

        // Create virtual devices
        const seat = Clutter.get_default_backend().get_default_seat();
        this._virtualTouchpad = seat.create_virtual_device(
            Clutter.InputDeviceType.POINTER_DEVICE
        );
        this._virtualKeyboard = seat.create_virtual_device(
            Clutter.InputDeviceType.KEYBOARD_DEVICE
        );

        // Init variables - keep enable() clean
        this._clearVars();

        // Capture Touchpad Event
        this._gestureCallbackID = global.stage.connect(
            'captured-event::touchpad',
            this._touchEvent.bind(this)
        );

        // init 3 or 4 fingers config support
        this._initFingerCountFlip();

        // action widget holder
        this._actionWidgets = {};
    }

    // Cleanup Extension
    destroy() {
        // restore default GNOME 3 fingers gesture
        this._restoreFingerCountFlip();

        // Release Touchpad Event Capture
        global.stage.disconnect(this._gestureCallbackID);

        // Cleanup virtual devices
        this._virtualTouchpad = null;
        this._virtualKeyboard = null;

        // Cleanup all variables
        this._clearVars();
        this._settings = null;
        this._ShaderClass = null;
    }



    // Initialize variables
    _clearVars() {
        // Target window to manage
        this._targetWindow = null;

        // Mouse start position
        this._startPos = {
            x: 0, y: 0
        };

        // Mouse start position
        this._movePos = {
            x: 0, y: 0
        };

        // Monitor Id
        this._monitorId = 0;

        // Monitor Workarea
        this._monitorArea = null;

        // Starting Window Area
        this._startWinArea = null;

        // Edge Action
        this._edgeAction = WindowEdgeAction.NONE;
        this._edgeGestured = false;

        // Pinch
        this._pinch = {
            begin: false,
            fingers: 0,
            progress: 0,

            velocity: null,

            action: 0,
            action_id: 0,
            action_cmp: 0
        };

        // Clear window tile preview
        this._hidePreview();
    }

    // Init 3 or 4 finger count switch mode
    _initFingerCountFlip() {
        // Move 3-4 Finger Gesture
        /*
         * Original Hook Logic From (swap-finger-gestures):
         * https://github.com/icedman/swap-finger-gestures-3-4
         * 
         */
        this._swipeMods = [
            Main.overview._swipeTracker._touchpadGesture,
            Main.wm._workspaceAnimation._swipeTracker._touchpadGesture,
            Main.overview._overview._controls
                ._workspacesDisplay._swipeTracker._touchpadGesture,
            Main.overview._overview._controls
                ._appDisplay._swipeTracker._touchpadGesture
        ];
        let me = this;
        this._swipeMods.forEach((g) => {
            g._newHandleEvent = (actor, event) => {
                event._get_touchpad_gesture_finger_count =
                    event.get_touchpad_gesture_finger_count;
                event.get_touchpad_gesture_finger_count = () => {
                    let real_count = event._get_touchpad_gesture_finger_count();
                    if (me._hooked || (real_count == me._gestureNumFinger())) {
                        return 0;
                    }
                    else if (real_count >= 3) {
                        return 3;
                    }
                    return 0;
                };
                if (me._hooked) {
                    return Clutter.EVENT_STOP;
                }
                return g._handleEvent(actor, event);
            };
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._newHandleEvent.bind(g),
                g
            );
        });
    }

    // Restore 3 or 4 finger count switch mode
    _restoreFingerCountFlip() {
        // Restore 3 finger gesture
        this._swipeMods.forEach((g) => {
            global.stage.disconnectObject(g);
            global.stage.connectObject(
                'captured-event::touchpad',
                g._handleEvent.bind(g),
                g
            );
        });
        this._swipeMods = [];
    }


    // Create UI Indicator
    _createUi(ui_class, x, y, w, h, icon, parent) {
        let ui = new St.Widget({ style_class: ui_class });
        ui.set_clip_to_allocation(true);
        ui._icon = null;
        ui._parent = parent ? parent : Main.layoutManager.uiGroup;
        if (icon) {
            ui._icon = new St.Icon({
                icon_name: icon,
                style_class: 'wgs-widget-icon'
            });
            ui.add_child(ui._icon);
        }
        ui.set_position(x, y);
        ui.set_size(w, h);
        ui.set_pivot_point(0.5, 0.5);
        ui.viewShow = (prop, duration) => {
            ui.show();
            prop.mode = Clutter.AnimationMode.EASE_OUT_QUAD;
            prop.duration = duration;
            ui.ease(prop);
        };
        ui.viewHide = (prop) => {
            prop.mode = Clutter.AnimationMode.EASE_OUT_QUAD;
            prop.duration = duration;
            prop.onStopped = () => {
                ui.hide();
            };
            ui.ease(prop);
        };
        ui.aniRelease = (progress) => {
            if (!progress) {
                progress = 1.0;
            }
            if (progress > 0.2) {
                ui.ease({
                    opacity: 0,
                    scale_x: 0,
                    scale_y: 0,
                    duration: Math.round(250 * progress),
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onStopped: () => {
                        ui.release();
                    }
                });
            }
            else {
                ui.release();
            }
        };
        ui.release = () => {
            // Cleanup
            ui.hide();
            ui._parent.remove_child(ui);
            if (ui._icon) {
                ui.remove_child(ui._icon);
                ui._icon.destroy();
                ui._icon = null;
            }
            ui.destroy();
            ui = null;
        };
        ui._parent.add_child(ui);
        return ui;
    }

    // Create Shader Effect
    _createShader(type, actor, name) {
        let fx = new Clutter.ShaderEffect(
            { shader_type: Clutter.ShaderType.FRAGMENT_SHADER }
        );
        let shader = '';
        if (type == 'close') {
            shader =
                'color.g *= 1-(0.3*value); ' +
                'color.b *= 1-(0.34*value); ';
        }
        else {
            shader =
                'color.rgb *= 1.0-value; ';
        }
        fx.set_shader_source(
            'uniform sampler2D tex; ' +
            'uniform float value; ' +
            'void main() { ' +
            'vec4 color=texture2D(tex,cogl_tex_coord_in[0].st);' +
            shader +
            'cogl_color_out = color * cogl_color_in;}'
        );
        fx.set_uniform_value('tex', 0);
        fx.setValue = function (v) {
            fx.set_uniform_value('value', v);
        }
        if (actor) {
            fx._fxname = name;
            actor.fx = fx;
            if (actor.get_effect(name)) {
                actor.remove_effect_by_name(name);
            }
            actor.add_effect_with_name(name, fx);
        }
        fx.release = () => {
            if (actor) {
                actor.remove_effect_by_name(actor.fx._fxname);
                actor.fx = null;
                actor = null;
            }
            fx = null;
        };
        return fx;
    }

    // Velocity functions
    _velocityInit() {
        let vel = {
            data: [],
            prev: 0
        };
        return vel;
    }
    _velocityTrim(vel) {
        const thresholdTime = this._tick() - 150;
        const index = vel.data.findIndex(r => r.time >= thresholdTime);
        vel.data.splice(0, index);
    }
    _velocityAppend(vel, v) {
        this._velocityTrim(vel);
        let vb = Math.abs(v);
        let d = vb - vel.prev;
        vel.prev = vb;
        vel.data.push({ time: this._tick(), delta: d });
    }
    _velocityCalc(vel) {
        this._velocityTrim(vel);
        if (vel.data.length < 2)
            return 0;
        const firstTime = vel.data[0].time;
        const lastTime = vel.data[vel.data.length - 1].time;
        if (firstTime === lastTime)
            return 0;
        const totalDelta = vel.data.slice(1).map(
            a => a.delta).reduce((a, b) => a + b);
        const period = lastTime - firstTime;
        return totalDelta / period;
    }
    _velocityFling(vel, curr, max, maxframe, cb) {
        let n = 0;
        let target = curr;
        let v = vel;
        let me = this;
        let iv = this.setInterval(function () {
            target += v * 2;
            v *= 0.98;
            n++;
            if (target >= max || n >= maxframe) {
                if (target >= max) {
                    target = max;
                }
                cb(1, target);
                me.clearInterval(iv);
            }
            else {
                cb(0, target);
            }
        }, 4);
    }


    _tick() {
        return new Date().getTime();
    }

    _isWindowBlacklist(win) {
        if (win) {
            if (WindowClassBlacklist.indexOf(win.get_wm_class()) == -1) {
                return false;
            }
        }
        return true;
    }

    // Get padding edge size
    _edgeSize() {
        return this._settings.get_int('edge-size');
    }

    // Get top padding edge size
    _topEdgeSize() {
        return this._settings.get_int('top-edge-size');
    }

    // Get gesture threshold
    _gestureThreshold() {
        return this._settings.get_int('gesture-threshold');
    }

    // Get acceleration
    _getAcceleration() {
        return (this._settings.get_int('gesture-acceleration') * 0.1);
    }

    // Get gesture threshold
    _gestureCancelThreshold() {
        return this._settings.get_int('gesture-cancel-threshold');
    }

    // Get horizontal swipe mode
    _getHorizontalSwipeMode() {
        // false. Change workspace, true. Switch Window
        return this._settings.get_boolean("horiz-swap-switch");
    }

    // Is 3 Finger
    _gestureNumFinger() {
        return this._settings.get_boolean("three-finger") ? 3 : 4;
    }

    // Functions Settings
    _getUseActiveWindow() {
        return this._settings.get_boolean("use-active-window");
    }
    _getEnableResize() {
        return this._settings.get_boolean("fn-resize");
    }
    _getEnableMove() {
        return this._settings.get_boolean("fn-move");
    }
    _getEnableMaxSnap() {
        return this._settings.get_boolean("fn-maximized-snap");
    }
    _getEnableMoveSnap() {
        return this._settings.get_boolean("fn-move-snap");
    }
    _getEnableFullscreen() {
        return this._settings.get_boolean("fn-fullscreen");
    }


    _getPinchInScale() {
        return this._settings.get_int('pinch-in-scale');
    }

    _getPinchOutScale() {
        return this._settings.get_int('pinch-out-scale');
    }

    _getPinchEnabled() {
        return this._settings.get_boolean("pinch-enable");
    }

    // Is On Overview
    _isOnOverview() {
        return Main.overview._shown;
    }

    // Check edge flags
    _isEdge(edge) {
        return ((this._edgeAction & edge) == edge);
    }

    // Show Preview
    _showPreview(rx, ry, rw, rh) {
        if (this._targetWindow == null) {
            return;
        }
        global.window_manager.emit("show-tile-preview",
            this._targetWindow, new Meta.Rectangle(
                { x: rx, y: ry, width: rw, height: rh }
            )
            , this._monitorId
        );
    }

    // Get Alt Tabs List
    _getWindowTabList() {
        let wm = global.workspace_manager;
        let workspace = wm.get_active_workspace();
        let windows = global.display.get_tab_list(
            Meta.TabList.NORMAL_ALL, workspace
        );
        return windows.map(w => {
            return w.is_attached_dialog() ? w.get_transient_for() : w;
        }).filter((w, i, a) => !w.skip_taskbar && a.indexOf(w) === i);
    }

    // Hide Preview
    _hidePreview() {
        global.window_manager.emit("hide-tile-preview");
    }

    // Simulate keypress (up -> down)
    _sendKeyPress(combination) {
        combination.forEach(key => this._virtualKeyboard.notify_keyval(
            Clutter.get_current_event_time(), key, Clutter.KeyState.PRESSED)
        );
        combination.reverse().forEach(key =>
            this._virtualKeyboard.notify_keyval(
                Clutter.get_current_event_time(), key, Clutter.KeyState.RELEASED
            ));
    }

    // Move Mouse Pointer
    _movePointer(x, y) {
        if (!this._getUseActiveWindow()) {
            // Move only if not use active window
            this._virtualTouchpad.notify_relative_motion(
                global.get_current_time(), x, y
            );
        }
    }

    // Snap Window
    _setSnapWindow(snapRight) {
        if (this._targetWindow == null) {
            return;
        }
        // TODO: Using non key shortcut for snap left/right
        if (snapRight) {
            this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_Right]);
        }
        else {
            this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_Left]);
        }
    }

    // Move to Workspace
    _moveWindowWorkspace(moveRight) {
        if ((this._targetWindow == null) ||
            !Meta.prefs_get_dynamic_workspaces()) {
            return;
        }
        let wsid = this._targetWindow.get_workspace().index();
        if (wsid == 0 && !moveRight) {
            this._insertWorkspace(0, this._targetWindow);
            return;
        }
        let tw = this._targetWindow.get_workspace()
            .get_neighbor(moveRight ? Meta.MotionDirection.RIGHT :
                Meta.MotionDirection.LEFT);
        this._targetWindow.change_workspace(tw);
        this._targetWindow.activate(global.get_current_time());
    }

    // Insert new workspace
    _insertWorkspace(pos, chkwin) {
        // Main.wm.insertWorkspace(0);
        let wm = global.workspace_manager;
        if (!Meta.prefs_get_dynamic_workspaces()) {
            return -1;
        }
        wm.append_new_workspace(false, global.get_current_time());
        let windows = global.get_window_actors().map(a => a.meta_window);
        windows.forEach(window => {
            if (chkwin && chkwin == window)
                return -1;
            if (window.get_transient_for() != null)
                return -1;
            if (window.is_override_redirect())
                return -1;
            if (window.on_all_workspaces)
                return -1;
            let index = window.get_workspace().index();
            if (index < pos)
                return -1;
            window.change_workspace_by_index(index + 1, true);
        });
        if (chkwin) {
            wm.get_workspace_by_index(pos + 1).activate(
                global.get_current_time()
            );
            chkwin.change_workspace_by_index(pos, true);
            this._targetWindow.activate(global.get_current_time());
        }
        return pos;
    }

    // Have Left Workspace
    _workspaceHavePrev() {
        if (this._targetWindow == null) {
            return false;
        }
        return (this._targetWindow.get_workspace().index() > 0);
    }

    _resetWinPos() {
        if (this._targetWindow == null) {
            return;
        }

        // Reset
        this._targetWindow.move_frame(
            true,
            this._startWinArea.x,
            this._startWinArea.y
        );
    }

    // Activate Target Window
    _activateWindow() {
        if (this._targetWindow == null) {
            return;
        }

        // Activate window if not focused yet
        if (!this._targetWindow.has_focus()) {
            this._targetWindow.activate(
                global.get_current_time()
            );
        }
    }

    setInterval(func, delay, ...args) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            func(...args);
            return GLib.SOURCE_CONTINUE;
        });
    }

    setTimeout(func, delay, ...args) {
        return GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            func(...args);
            return GLib.SOURCE_REMOVE;
        });
    };

    clearInterval(id) {
        GLib.source_remove(id);
    }

    clearTimeout(id) {
        GLib.source_remove(id);
    }

    // On touch gesture started
    _touchStarted() {
        // Stop if it was on overview
        if (this._isOnOverview()) {
            return Clutter.EVENT_STOP;
        }

        // Get current mouse position
        let [pointerX, pointerY, pointerZ] = global.get_pointer();

        // Save start position
        this._startPos.x = pointerX;
        this._startPos.y = pointerY;

        // Reset move position
        this._movePos.x = this._movePos.y = 0;

        // Configs
        let allowResize = this._getEnableResize();
        let allowMove = this._getEnableMove();

        if (this._getUseActiveWindow()) {
            // Get Active Window
            this._targetWindow = global.display.get_focus_window();
            if (!this._targetWindow) {
                return Clutter.EVENT_PROPAGATE;
            }
            allowResize = false;
        }
        else {
            // Get actor in current mouse position
            let currActor = global.stage.get_actor_at_pos(
                Clutter.PickMode.REACTIVE, pointerX, pointerY
            );

            // Find root window for current actor
            let currWindow = currActor.get_parent();
            let i = 0;
            while (!currWindow.get_meta_window) {
                currWindow = currWindow.get_parent();
                // Hack for it to works, some apps only 1 level to root window,
                // some apps is multiple parents to root window.
                // loop until got the root (or max 10 level)
                if (!currWindow || (++i > 10)) {
                    // cannot fetch root window, so ignore it!
                    return Clutter.EVENT_PROPAGATE;
                }
            }

            // Set meta window as target window to manage
            this._targetWindow = currWindow.get_meta_window();
        }

        // Set opener window as target if it was dialog
        if (this._targetWindow.is_attached_dialog()) {
            this._targetWindow = this._targetWindow.get_transient_for();
        }

        // Check blacklist window
        if (this._isWindowBlacklist(this._targetWindow)) {
            this._targetWindow = null;
            return Clutter.EVENT_PROPAGATE;
        }

        // Get monitor area
        this._monitorArea = this._targetWindow.get_work_area_current_monitor();

        // Get monitor id
        this._monitorId = global.display.get_monitor_index_for_rect(
            this._monitorArea
        );

        // Get start frame rectangle
        this._startWinArea = this._targetWindow.get_frame_rect();

        // Window area as local value
        let wLeft = this._startWinArea.x;
        let wTop = this._startWinArea.y;
        let wRight = wLeft + this._startWinArea.width;
        let wBottom = wTop + this._startWinArea.height;
        let wThirdX = wLeft + (this._startWinArea.width / 3);
        let wThirdY = wTop + (this._startWinArea.height / 3);
        let w34X = wLeft + ((this._startWinArea.width / 3) * 2);
        let w34Y = wTop + ((this._startWinArea.height / 3) * 2);

        // Detect window edge
        let edge = this._edgeSize();
        let topEdge = this._topEdgeSize();

        // Default edge: need move event for more actions
        this._edgeAction = WindowEdgeAction.WAIT_GESTURE;
        this._edgeGestured = false;

        // Check allow resize
        if (allowResize && this._targetWindow.allows_resize() &&
            this._targetWindow.allows_move()) {
            // Edge cursor position detection
            if (this._startPos.y >= wBottom - edge) {
                // Cursor on bottom of window
                this._edgeAction =
                    WindowEdgeAction.RESIZE |
                    WindowEdgeAction.RESIZE_BOTTOM;

                // 1/3 from left|right
                if (this._startPos.x <= wThirdX) {
                    this._edgeAction |= WindowEdgeAction.RESIZE_LEFT;
                }
                else if (this._startPos.x >= w34X) {
                    this._edgeAction |= WindowEdgeAction.RESIZE_RIGHT;
                }
            }
            else {
                if (this._startPos.x <= wLeft + edge) {
                    // Cursor on left side of window
                    this._edgeAction =
                        WindowEdgeAction.RESIZE |
                        WindowEdgeAction.RESIZE_LEFT;
                }
                else if (this._startPos.x >= wRight - edge) {
                    // Cursor on right side of window
                    this._edgeAction =
                        WindowEdgeAction.RESIZE |
                        WindowEdgeAction.RESIZE_RIGHT;
                }
                if (this._isEdge(WindowEdgeAction.RESIZE)) {
                    // 1/3 from top|bottom
                    if (this._startPos.y <= wThirdY) {
                        this._edgeAction |= WindowEdgeAction.RESIZE_TOP;
                    }
                    else if (this._startPos.y >= w34Y) {
                        this._edgeAction |= WindowEdgeAction.RESIZE_BOTTOM;
                    }
                }
            }
        }
        if (!this._isEdge(WindowEdgeAction.RESIZE)) {
            if (allowMove && this._startPos.y <= wTop + topEdge) {
                if (this._targetWindow.allows_move() &&
                    !this._targetWindow.get_maximized()) {
                    // Mouse in top side of window
                    this._edgeAction = WindowEdgeAction.MOVE;
                }
            }
        }

        return Clutter.EVENT_STOP;
    }

    // On touch gesture updated no targetWindow
    _touchUpdateNoWindow() {
        if (this._isOnOverview()) {
            return Clutter.EVENT_STOP;
        }
        let threshold = this._gestureThreshold();
        let absX = Math.abs(this._movePos.x);
        let absY = Math.abs(this._movePos.y);

        // Gesture still undefined
        if (this._edgeAction == WindowEdgeAction.NONE) {
            // Move Value
            if (absX >= threshold || absY >= threshold) {
                let gestureValue = 0;
                let isVertical = false;
                if (absX > absY) {
                    // Horizontal Swipe
                    if (this._movePos.x < 0 - threshold) {
                        gestureValue = -1;
                        this._edgeAction = WindowEdgeAction.WAIT_GESTURE |
                            WindowEdgeAction.GESTURE_HORIZONTAL;

                    }
                    else if (this._movePos.x > threshold) {
                        gestureValue = 1;
                        this._edgeAction = WindowEdgeAction.WAIT_GESTURE |
                            WindowEdgeAction.GESTURE_HORIZONTAL;
                    }
                }
                else {
                    // Vertical Swipe
                    if (this._movePos.y < 0 - threshold) {
                        gestureValue = -1;
                        this._edgeAction = WindowEdgeAction.WAIT_GESTURE |
                            WindowEdgeAction.GESTURE_VERTICAL;
                        isVertical = true;
                    }
                    else if (this._movePos.y > threshold) {
                        gestureValue = 1;
                        this._edgeAction = WindowEdgeAction.WAIT_GESTURE |
                            WindowEdgeAction.GESTURE_VERTICAL;
                        isVertical = true;
                    }
                }
                if (gestureValue != 0) {
                    // Reset Move Position
                    this._movePos.x = 0;
                    this._movePos.y = 0;

                    // isVertical
                    let focusWindow = global.display.get_focus_window();
                    if (focusWindow) {
                        let listWin = [];
                        if (isVertical) {
                            // All Windows
                            listWin = global.display.list_all_windows();
                        }
                        else {
                            // Windows in workspace only
                            listWin = focusWindow
                                .get_workspace().list_windows();
                        }
                        let indexAct = listWin.indexOf(focusWindow);
                        if (indexAct > -1) {
                            let nextWin = indexAct + gestureValue;
                            if (nextWin < 0) {
                                nextWin = listWin.length - 1;
                            }
                            else if (nextWin >= listWin.length) {
                                nextWin = 0;
                            }
                            listWin[nextWin].activate(
                                global.get_current_time()
                            );
                        }
                    }
                }
            }
        }
        return Clutter.EVENT_STOP;
    }

    // On touch gesture updated
    _touchUpdate(dx, dy) {
        // Moving coordinat
        this._movePos.x += dx;
        this._movePos.y += dy;

        // Ignore if no target window
        if (this._targetWindow == null) {
            return this._touchUpdateNoWindow();
        }

        // Ignore if no edge action (will not happened btw)
        if (this._edgeAction == WindowEdgeAction.NONE) {
            this._clearVars();
            return Clutter.EVENT_PROPAGATE;
        }

        // Configs
        let allowResize = this._getEnableResize();
        let allowMove = this._getEnableMove();
        let allowMaxSnap = this._getEnableMaxSnap();
        let allowMoveSnap = this._getEnableMoveSnap();

        // Check edge flags
        if (this._isEdge(WindowEdgeAction.MOVE)) {
            if (!allowMove) {
                // Will not happening
                return Clutter.EVENT_STOP;
            }
            this._activateWindow();

            // Move cursor pointer
            this._movePointer(
                dx, dy
            );

            let edge = this._edgeSize();
            let mX = this._monitorArea.x;
            let mY = this._monitorArea.y;
            let mW = this._monitorArea.width;
            let mR = mX + mW;

            // let [pointerX, pointerY, pointerZ] = global.get_pointer();
            let hedge = edge / 2;
            let winX = this._startWinArea.x + this._movePos.x;
            let winY = this._startWinArea.y + this._movePos.y;
            let winR = winX + this._startWinArea.width;

            // Move action
            this._targetWindow.move_frame(
                true,
                winX, winY
            );

            if (allowMoveSnap && winX < mX) {
                this._showPreview(
                    this._monitorArea.x,
                    this._monitorArea.y,
                    this._monitorArea.width / 2,
                    this._monitorArea.height
                );
                this._edgeAction = WindowEdgeAction.MOVE
                    | WindowEdgeAction.MOVE_SNAP_LEFT;
            }
            else if (allowMoveSnap && winR > mR) {
                this._showPreview(
                    this._monitorArea.x + (this._monitorArea.width / 2),
                    this._monitorArea.y,
                    this._monitorArea.width / 2,
                    this._monitorArea.height
                );
                this._edgeAction = WindowEdgeAction.MOVE
                    | WindowEdgeAction.MOVE_SNAP_RIGHT;
            }
            else if (allowMoveSnap && winY < mY) {
                this._showPreview(
                    this._monitorArea.x,
                    this._monitorArea.y,
                    this._monitorArea.width,
                    this._monitorArea.height
                );
                this._edgeAction = WindowEdgeAction.MOVE
                    | WindowEdgeAction.MOVE_SNAP_TOP;
            }
            else {
                this._edgeAction = WindowEdgeAction.MOVE;
                this._hidePreview();
            }
        }
        else if (this._isEdge(WindowEdgeAction.RESIZE)) {
            if (!allowResize) {
                // Will not happening
                return Clutter.EVENT_STOP;
            }

            this._activateWindow();

            // Move cursor pointer
            this._movePointer(
                (this._isEdge(WindowEdgeAction.RESIZE_LEFT) ||
                    this._isEdge(WindowEdgeAction.RESIZE_RIGHT)) ? dx : 0,
                (this._isEdge(WindowEdgeAction.RESIZE_TOP) ||
                    this._isEdge(WindowEdgeAction.RESIZE_BOTTOM)) ? dy : 0
            );

            // Resize actions
            let tX = this._startWinArea.x;
            let tY = this._startWinArea.y;
            let tW = this._startWinArea.width;
            let tH = this._startWinArea.height;

            if (this._isEdge(WindowEdgeAction.RESIZE_BOTTOM)) {
                tH += this._movePos.y;
            }
            else if (this._isEdge(WindowEdgeAction.RESIZE_TOP)) {
                tY += this._movePos.y;
                tH -= this._movePos.y;
            }
            if (this._isEdge(WindowEdgeAction.RESIZE_RIGHT)) {
                tW += this._movePos.x;
            }
            else if (this._isEdge(WindowEdgeAction.RESIZE_LEFT)) {
                tX += this._movePos.x;
                tW -= this._movePos.x;
            }

            let tR = tX + tW;
            let tB = tY + tH;

            let mX = this._monitorArea.x;
            let mY = this._monitorArea.y;
            let mW = this._monitorArea.width;
            let mH = this._monitorArea.height;
            let mR = mX + mW;
            let mB = mY + mH;

            // edge
            if (tX < mX) {
                tX = mX;
                tW = tR - tX;
            }
            if (tY < mY) {
                tY = mY;
                tH = tB - tY;
            }
            if (tR > mR) {
                tW = mR - tX;
            }
            if (tB > mB) {
                tH = mB - tY;
            }


            // Resize Window
            this._targetWindow.move_resize_frame(
                true,
                tX, tY, tW, tH
            );
        }
        else if (this._isEdge(WindowEdgeAction.WAIT_GESTURE)) {
            let threshold = this._gestureThreshold();
            let absX = Math.abs(this._movePos.x);
            let absY = Math.abs(this._movePos.y);

            if (!this._edgeGestured) {
                if (absX >= threshold || absY >= threshold) {
                    if (absX > absY) {
                        if (this._movePos.x < 0 - threshold) {
                            if (!this._getHorizontalSwipeMode()) {
                                this._edgeAction |=
                                    WindowEdgeAction.GESTURE_LEFT;
                                this._edgeGestured = true;
                            }
                            else {
                                this._edgeAction = WindowEdgeAction.NONE;
                                this._targetWindow = null;
                                return this._touchUpdateNoWindow();
                            }
                        }
                        else if (this._movePos.x > threshold) {
                            if (!this._getHorizontalSwipeMode()) {
                                // if (this._workspaceHavePrev()) {
                                this._edgeAction |=
                                    WindowEdgeAction.GESTURE_RIGHT;
                                this._edgeGestured = true;
                                // }
                            }
                            else {
                                this._edgeAction = WindowEdgeAction.NONE;
                                this._targetWindow = null;
                                return this._touchUpdateNoWindow();
                            }
                        }
                    }
                    else {
                        if (this._movePos.y < 0 - threshold) {
                            this._edgeAction |= WindowEdgeAction.GESTURE_UP;
                            this._edgeGestured = true;
                        }
                        else if (this._movePos.y > threshold) {
                            if (this._targetWindow.is_fullscreen() ||
                                this._targetWindow.get_maximized()) {
                                this._edgeAction |=
                                    WindowEdgeAction.GESTURE_DOWN;
                                this._edgeGestured = true;
                            }
                            else {
                                if (allowMove &&
                                    this._targetWindow.allows_move()) {
                                    this._edgeAction = WindowEdgeAction.MOVE;
                                }
                            }
                        }
                    }
                }
                if (this._edgeGestured) {
                    /* Reset move position */
                    this._movePos.x = this._movePos.y = 0;
                }
            }
            else {
                let cancelThreshold = this._gestureCancelThreshold();
                let resetGesture = 0;
                let threshold2x = threshold * 2;
                /* Reset Gesture Detection */
                if (this._isEdge(WindowEdgeAction.GESTURE_LEFT)) {
                    if (this._movePos.x > cancelThreshold) {
                        resetGesture = 1;
                    }
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_RIGHT)) {
                    if (this._movePos.x < 0 - cancelThreshold) {
                        resetGesture = 1;
                    }
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_UP)) {
                    if (this._movePos.y > cancelThreshold) {
                        resetGesture = 1;
                    }
                    else if (!this._targetWindow.is_fullscreen() &&
                        (this._targetWindow.get_maximized()
                            != Meta.MaximizeFlags.BOTH)) {
                        // Tile Left / Right if not maximize / fullscreen
                        if (allowMaxSnap &&
                            this._movePos.x <= 0 - threshold2x) {
                            this._edgeAction |=
                                WindowEdgeAction.GESTURE_UP_LEFT;
                        }
                        else if (allowMaxSnap &&
                            this._movePos.x >= threshold2x) {
                            this._edgeAction |=
                                WindowEdgeAction.GESTURE_UP_RIGHT;
                        }
                        else {
                            this._edgeAction = WindowEdgeAction.GESTURE_UP |
                                WindowEdgeAction.WAIT_GESTURE;
                        }
                        resetGesture = 2;
                    }
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                    if (this._movePos.y < 0 - cancelThreshold) {
                        resetGesture = 1;
                    }
                }
                if (resetGesture == 1) {
                    this._hidePreview();
                    this._edgeAction = WindowEdgeAction.WAIT_GESTURE;
                }
                else if (resetGesture == 2) {
                    /* Reset Y only */
                    this._movePos.y = 0;
                    if (this._movePos.x < 0 - threshold2x) {
                        this._movePos.x = 0 - (threshold2x + 5);
                    }
                    else if (this._movePos.x > threshold2x) {
                        this._movePos.x = threshold2x + 5;
                    }
                }
                else {
                    /* Reset move position */
                    this._movePos.x = this._movePos.y = 0;
                }
            }

            if (this._edgeGestured) {
                this._activateWindow();
                if (this._isEdge(WindowEdgeAction.GESTURE_UP)) {
                    if (allowMaxSnap &&
                        this._isEdge(WindowEdgeAction.GESTURE_UP_LEFT)) {
                        this._showPreview(
                            this._monitorArea.x,
                            this._monitorArea.y,
                            this._monitorArea.width / 2,
                            this._monitorArea.height
                        );
                    }
                    else if (allowMaxSnap &&
                        this._isEdge(WindowEdgeAction.GESTURE_UP_RIGHT)) {
                        this._showPreview(
                            this._monitorArea.x + (this._monitorArea.width / 2),
                            this._monitorArea.y,
                            this._monitorArea.width / 2,
                            this._monitorArea.height
                        );
                    }
                    else {
                        this._showPreview(
                            this._monitorArea.x,
                            this._monitorArea.y,
                            this._monitorArea.width,
                            this._monitorArea.height
                        );
                    }
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_LEFT)) {
                    this._showPreview(
                        this._monitorArea.x
                        + this._monitorArea.width
                        - this._startWinArea.width,
                        this._startWinArea.y,
                        this._startWinArea.width,
                        this._startWinArea.height
                    );
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_RIGHT)) {
                    this._showPreview(
                        this._monitorArea.x,
                        this._startWinArea.y,
                        this._startWinArea.width,
                        this._startWinArea.height
                    );
                }
                else if (this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                    this._showPreview(
                        this._monitorArea.x + (this._monitorArea.width / 4),
                        this._monitorArea.y + (this._monitorArea.height / 4),
                        this._monitorArea.width / 2,
                        this._monitorArea.height / 2
                    );
                }
            }
        }

        return Clutter.EVENT_STOP;
    }

    // On touch gesture ended
    _touchEnd() {
        /* No target window? return directly */
        if (this._targetWindow == null) {
            this._clearVars();
            return Clutter.EVENT_STOP;
        }

        // Configs
        let allowMaxSnap = this._getEnableMaxSnap();
        let allowMoveSnap = this._getEnableMoveSnap();

        /* Check Gestures */
        if (this._isEdge(WindowEdgeAction.WAIT_GESTURE)) {
            if (this._isEdge(WindowEdgeAction.GESTURE_UP)) {
                // Maximize / Fullscreen
                if (this._targetWindow.get_maximized() ==
                    Meta.MaximizeFlags.BOTH) {
                    if (!this._targetWindow.is_fullscreen()) {
                        if (this._getEnableFullscreen()) {
                            this._targetWindow.make_fullscreen();
                        }
                    }
                    else {
                        this._targetWindow.unmake_fullscreen();
                    }
                }
                else if (this._targetWindow.can_maximize()) {
                    if (allowMaxSnap &&
                        this._isEdge(WindowEdgeAction.GESTURE_UP_LEFT)) {
                        this._setSnapWindow(0);
                    }
                    else if (allowMaxSnap &&
                        this._isEdge(WindowEdgeAction.GESTURE_UP_RIGHT)) {
                        this._setSnapWindow(1);
                    }
                    else {
                        this._targetWindow.maximize(Meta.MaximizeFlags.BOTH);
                    }
                }
            }
            else if (this._isEdge(WindowEdgeAction.GESTURE_DOWN)) {
                // Un-Fullscreen & Un-Maximize
                if (this._targetWindow.is_fullscreen()) {
                    this._targetWindow.unmake_fullscreen();
                }
                else if (this._targetWindow.get_maximized()) {
                    this._targetWindow.unmaximize(
                        Meta.MaximizeFlags.BOTH
                    );
                }
            }
            else if (this._isEdge(WindowEdgeAction.GESTURE_LEFT)) {
                // Move to right workspace
                this._moveWindowWorkspace(1);
            }
            else if (this._isEdge(WindowEdgeAction.GESTURE_RIGHT)) {
                // Move to left workspace
                this._moveWindowWorkspace(0);
            }
        }
        else if (allowMoveSnap && this._isEdge(WindowEdgeAction.MOVE)) {
            if (this._isEdge(WindowEdgeAction.MOVE_SNAP_TOP)) {
                if (this._targetWindow.can_maximize()) {
                    this._resetWinPos();
                    this._targetWindow.maximize(Meta.MaximizeFlags.BOTH);
                }
            }
            else if (this._isEdge(WindowEdgeAction.MOVE_SNAP_LEFT)) {
                this._resetWinPos();
                this._setSnapWindow(0);
            }
            else if (this._isEdge(WindowEdgeAction.MOVE_SNAP_RIGHT)) {
                this._resetWinPos();
                this._setSnapWindow(1);
            }
        }
        this._clearVars();

        return Clutter.EVENT_STOP;
    }

    _actionIdGet(type) {
        let cfg_name = "";
        switch (type) {
            case 1: cfg_name = "swipe4-left"; break;
            case 2: cfg_name = "swipe4-right"; break;
            case 3: cfg_name = "swipe3-down"; break;
            case 4: cfg_name = "swipe3-left"; break;
            case 5: cfg_name = "swipe3-right"; break;

            case 6: cfg_name = "pinch3-in"; break;
            case 7: cfg_name = "pinch3-out"; break;
            case 8: cfg_name = "pinch4-in"; break;
            case 9: cfg_name = "pinch4-out"; break;
            default: return 0;
        }
        return this._settings.get_int(cfg_name);
    }

    // Get Current Action Id
    _pinchGetCurrentActionId() {
        if (this._pinch.begin && this._pinch.action != 0) {
            if (this._pinch.action != this._pinch.action_cmp) {
                this._pinch.action_id = this._actionIdGet(
                    (this._pinch.fingers == 3) ?
                        this._pinch.action + 5 :
                        this._pinch.action + 7
                );
                this._pinch.action_cmp = this._pinch.action;
            }
            return this._pinch.action_id;
        }
        return 0;
    }

    // Update Pinch
    _pinchUpdate(pinch_scale) {
        if (this._pinch.begin) {
            let pIn = (this._getPinchInScale() / 100.0);
            let pOut = (this._getPinchOutScale() / 100.0);

            // Get prediction action & current progress position
            if (pinch_scale < 1.0) {
                if (pinch_scale < pIn) {
                    pinch_scale = pIn;
                }
                this._pinch.action = 1;
                this._pinch.progress = (1.0 - pinch_scale) / (1.0 - pIn);
            }
            else if (pinch_scale > 1.0) {
                if (pinch_scale > pOut) {
                    pinch_scale = pOut;
                }
                this._pinch.action = 2;
                this._pinch.progress = (pinch_scale - 1.0) / (pOut - 1.0);
            }
            else {
                this.pinch.action = 0;
                this._pinch.progress = 0;
            }

            if (this._pinch.action_cmp &&
                (this._pinch.action != this._pinch.action_cmp)) {
                // Send Cancel State
                let aid = this._actionIdGet(
                    (this._pinch.fingers == 3) ?
                        this._pinch.action_cmp + 2 :
                        this._pinch.action_cmp + 4
                );
                if (aid) {
                    this._runAction(aid, 1, 0);
                }

                // Reset velocity
                this._pinch.velocity = this._velocityInit();
                this._velocityAppend(this._pinch.velocity, 0);
            }
            this._velocityAppend(this._pinch.velocity, this._pinch.progress);

            let action_id = this._pinchGetCurrentActionId();
            if (action_id) {
                this._runAction(action_id, 0,
                    this._pinch.progress
                );
            }
        }
        return Clutter.EVENT_STOP;
    }

    // End Pinch
    _pinchEnd() {
        let action_id = this._pinchGetCurrentActionId();
        if (action_id) {
            if (this._pinch.progress < 1.0) {
                // Fling Velocity
                let vel = this._velocityCalc(this._pinch.velocity);
                if (vel > 0.001) {
                    let me = this;
                    this._velocityFling(vel,
                        this._pinch.progress,
                        1.0, 30,
                        function (state, prog) {
                            me._runAction(action_id, state, prog);
                        }
                    );
                    this._clearVars();
                    return Clutter.EVENT_STOP;
                }
            }
            this._runAction(action_id, 1, this._pinch.progress);
        }

        this._clearVars();
        return Clutter.EVENT_STOP;
    }

    // Pinch Handler
    _pinchEventHandler(actor, event) {
        if (!this._getPinchEnabled()) {
            return Clutter.EVENT_PROPAGATE;
        }
        let numfingers = event.get_touchpad_gesture_finger_count();
        if (numfingers != 3 && numfingers != 4) {
            return Clutter.EVENT_PROPAGATE;
        }
        const pinch_scale = event.get_gesture_pinch_scale();

        // Process gestures state
        switch (event.get_gesture_phase()) {
            case Clutter.TouchpadGesturePhase.BEGIN:
                // Pinch Variables
                this._pinch.begin = true;
                this._pinch.fingers = numfingers;
                this._pinch.progress = 0;

                // Action Variables
                this._pinch.action = 0;
                this._pinch.action_cmp = 0;
                this._pinch.action_id = 0;

                // Velocity Variables
                this._pinch.velocity = this._velocityInit();
                this._velocityAppend(this._pinch.velocity, 0);
                return Clutter.EVENT_STOP;

            case Clutter.TouchpadGesturePhase.UPDATE:
                return this._pinchUpdate(pinch_scale);

            default:
                return this._pinchEnd();
        }

        return Clutter.EVENT_STOP;
    }

    // Touch Event Handler
    _touchEvent(actor, event) {

        // Only process swipe event
        if (event.type() == Clutter.EventType.TOUCHPAD_PINCH)
            return this._pinchEventHandler(actor, event);

        // Only process swipe event
        if (event.type() != Clutter.EventType.TOUCHPAD_SWIPE)
            return Clutter.EVENT_PROPAGATE;

        // Only process configured finger gesture
        if (event.get_touchpad_gesture_finger_count()
            != this._gestureNumFinger())
            return Clutter.EVENT_PROPAGATE;

        // Process gestures state
        switch (event.get_gesture_phase()) {
            case Clutter.TouchpadGesturePhase.BEGIN:
                // Begin event
                return this._touchStarted();

            case Clutter.TouchpadGesturePhase.UPDATE:
                // Update / move event
                let [dx, dy] = event.get_gesture_motion_delta();
                return this._touchUpdate(
                    dx * this._getAcceleration(),
                    dy * this._getAcceleration()
                );

            default:
                // Cancel / end event
                return this._touchEnd();
        }
        return Clutter.EVENT_STOP;
    }

    // Run Action
    _runAction(id, state, progress) {
        const _LCASE = 32;
        if (id == 1) {
            //
            // MINIMIZE ACTION
            //
            if (this._isOnOverview()) {
                return; // Ignore on overview
            }

            let activeWin = null;
            let ui = this._actionWidgets.minimize;

            // Init indicator
            if (!ui) {
                activeWin = global.display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin && activeWin.can_minimize()) {
                    ui = activeWin.get_compositor_private();
                    this._actionWidgets.minimize = ui;
                    if (ui) {
                        ui.set_pivot_point(0.5, 1);
                    }
                }
                else {
                    this._actionWidgets.minimize = ui = -1;
                }
            }

            // Execute Progress
            if (ui && ui != -1) {
                if (!state) {
                    ui.set_pivot_point(0.5, 1);
                    ui.opacity = 255 - Math.round(100 * progress);
                    ui.scale_x = 1.0 - (0.2 * progress);
                    ui.scale_y = 1.0 - (0.2 * progress);
                }
                else {
                    // Action is executed
                    activeWin = null;
                    if (progress >= 1.0) {
                        activeWin = global.display.get_focus_window();
                        if (activeWin) {
                            if (!activeWin.can_minimize()) {
                                activeWin = null;
                            }
                        }
                    }

                    // Restore
                    ui.ease({
                        duration: Math.round(250 * progress),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        opacity: activeWin ? 0 : 255,
                        scale_x: activeWin ? 0 : 1,
                        scale_y: activeWin ? 0 : 1,
                        onStopped: () => {
                            ui.set_pivot_point(0, 0);
                            if (activeWin) {
                                activeWin.minimize();
                                ui.opacity = 0;
                                ui.ease({
                                    duration: 800,
                                    opacity: 0,
                                    onStopped: () => {
                                        ui.opacity = 255;
                                        ui.scale_x = 1;
                                        ui.scale_y = 1;
                                        ui = null;
                                    }
                                });
                            }
                            else {
                                ui = null;
                            }
                        }
                    });
                    this._actionWidgets.minimize = null;
                }
            } else if (state) {
                this._actionWidgets.minimize = ui = null;
            }
        }
        else if (id == 2) {
            //
            // CLOSE WINDOW ACTION
            //
            if (this._isOnOverview()) {
                return; // Ignore on overview
            }

            let activeWin = null;
            let ui = this._actionWidgets.close;

            // Init indicator
            if (!ui) {
                activeWin = global.display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin) {
                    ui = activeWin.get_compositor_private();
                    this._actionWidgets.close = ui;
                    if (ui) {
                        ui.set_pivot_point(0.5, 0.5);
                        this._createShader('close', ui, 'closeindicator');
                        ui.fx?.setValue(0);
                    }
                }
                else {
                    this._actionWidgets.close = ui = -1;
                }
            }

            // Execute Progress
            if (ui && ui != -1) {
                if (!state) {
                    ui.set_pivot_point(0.5, 0.5);
                    ui.opacity = 255 - Math.round(40 * progress);
                    ui.scale_x = 1.0 - (progress * 0.08);
                    ui.scale_y = 1.0 - (progress * 0.08);
                    ui.fx?.setValue(progress * 0.99);
                }
                else {
                    activeWin = null;

                    // Action is executed
                    if (progress >= 1.0) {
                        activeWin = global.display.get_focus_window();
                    }

                    ui.fx?.release();
                    ui.ease({
                        duration: Math.round(250 * progress),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        opacity: activeWin ? 0 : 255,
                        scale_x: activeWin ? 0 : 1,
                        scale_y: activeWin ? 0 : 1,
                        onStopped: () => {
                            ui.set_pivot_point(0, 0);
                            if (activeWin) {
                                ui.hide();
                                ui.opacity = 0;
                                ui.ease({
                                    duration: 800,
                                    opacity: 0
                                });
                                activeWin.delete(
                                    global.get_current_time()
                                );
                                activeWin = null;
                            }
                            ui = null;
                        }
                    });

                    this._actionWidgets.close = null;
                }
            } else if (state) {
                this._actionWidgets.close = ui = null;
            }
        }
        else if (id == 3) {
            //
            // SHOW DESKTOP
            //
            if (this._isOnOverview()) { // Ignore on overview
                return;
            }

            let ui = this._actionWidgets.show_desktop;

            // Init indicator
            if (!ui) {
                let monitorArea = global.display.list_all_windows();
                if (monitorArea.length > 0) {
                    ui = [];
                    for (var i = 0; i < monitorArea.length; i++) {
                        if (!this._isWindowBlacklist(monitorArea[i])) {
                            let aui = monitorArea[i].get_compositor_private();

                            if (aui) {
                                ui.push(aui);
                                let mrect = monitorArea[i]
                                    .get_work_area_current_monitor();
                                let wrect = monitorArea[i].get_frame_rect();

                                // black magic calc ;)
                                let wl = (mrect.width / 32);
                                aui._t_targetx = (mrect.width - wl) - wrect.x;
                                var nx = (0 - (wrect.width - wl)) - wrect.x;
                                aui.set_pivot_point(1.0, 0.5);
                                if (Math.abs(nx) < Math.abs(aui._t_targetx)) {
                                    aui._t_targetx = nx;
                                    aui.set_pivot_point(1, (i % 5) * 0.25);
                                }
                                else {
                                    aui.set_pivot_point(0, (i % 5) * 0.25);
                                }
                            }
                        }
                    }
                    this._actionWidgets.show_desktop = ui;
                }
                else {
                    this._actionWidgets.show_desktop = ui = -1;
                }
            }

            // Execute Progress
            if (ui && ui != -1) {
                if (!state) {
                    ui.forEach((aui) => {
                        aui.opacity = 255 - Math.round(180 * progress);
                        aui.scale_y =
                            aui.scale_x = 1.0 - (progress * 0.6);
                        aui.translation_x = (
                            (progress * progress) * aui._t_targetx
                        );
                    });
                }
                else {
                    // Action is executed
                    if (progress >= 1.0) {
                        // Show Desktop (Super+D)  Clutter.KEY_D
                        this._sendKeyPress(
                            [Clutter.KEY_Super_L,
                            Clutter.KEY_D + _LCASE]
                        );
                    }

                    ui.forEach((aui) => {
                        aui.ease({
                            duration: Math.round(250 * progress),
                            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                            opacity: 255,
                            translation_x: 0,
                            scale_x: 1,
                            scale_y: 1,
                            onStopped: () => {
                                aui.set_pivot_point(0, 0);
                                delete aui._t_targetx;
                                delete aui._t_targety;
                            }
                        });
                    });

                    this._actionWidgets.show_desktop = ui = null;
                }
            } else if (state) {
                this._actionWidgets.show_desktop = ui = null;
            }

        }
        else if ((id == 4) || (id == 5)) {
            //
            // NEXT & PREVIOUS WINDOW SWITCHING
            //
            if (this._isOnOverview()) {
                return; // Ignore on overview
            }

            let prv = (id == 5);
            let wid = prv ? "switchwin_prev" : "switchwin_next";
            let ui = this._actionWidgets[wid];

            // Init indicator
            if (!ui) {
                ui = -1;
                let wins = null;

                // Cancel cache win timeout
                if (this._actionWidgets.cacheWinTimeout) {
                    this.clearTimeout(this._actionWidgets.cacheWinTimeout);
                    this._actionWidgets.cacheWinTimeout = 0;
                }
                // Get cached window list
                if (this._actionWidgets.cacheWinTabList) {
                    wins = this._actionWidgets.cacheWinTabList;
                }
                if (!wins) {
                    // No last cached
                    wins = this._getWindowTabList();
                }
                if (wins.length > 1) {
                    ui = { from: wins[0] };
                    if (prv) {
                        ui.into = wins[wins.length - 1];
                    }
                    else {
                        ui.into = wins[1];
                    }
                    ui.lstate = 0;
                    ui.from_actor = ui.from.get_compositor_private();
                    ui.into_actor = ui.into.get_compositor_private();
                    ui.from_actor.set_pivot_point(0.5, 1);
                    ui.into_actor.set_pivot_point(0.5, 1);

                    // Reorder for next (below 1s) calls
                    this._actionWidgets.cacheWinTabList = wins;
                }
                this._actionWidgets[wid] = ui;
            }
            if (ui && ui != -1) {
                if (!state) {
                    ui.from_actor.opacity = 255 - Math.round(80 * progress);
                    ui.from_actor.scale_y =
                        ui.from_actor.scale_x = 1.0 - (0.05 * progress);
                    ui.into_actor.scale_y =
                        ui.into_actor.scale_x = 1.0 + (0.05 * progress);
                    if (progress > 0.8) {
                        if (!ui.lstate) {
                            ui.into.raise();
                            ui.lstate = 1;
                        }
                    }
                    else if (ui.lstate) {
                        ui.from.raise();
                        ui.lstate = 0;
                    }
                }
                else {
                    if ((progress > 0.8) || ui.lstate) {
                        ui.into.activate(
                            global.get_current_time()
                        );
                        if (prv) {
                            this._actionWidgets.cacheWinTabList.unshift(
                                this._actionWidgets.cacheWinTabList.pop()
                            );
                        }
                        else {
                            this._actionWidgets.cacheWinTabList.push(
                                this._actionWidgets.cacheWinTabList.shift()
                            );
                        }
                    }
                    ui.nclose = 0;
                    // Ease Restore
                    ui.from_actor.ease({
                        duration: Math.round(200 * progress),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        opacity: 255,
                        scale_x: 1,
                        scale_y: 1,
                        onStopped: () => {
                            ui.from_actor.set_pivot_point(0, 0);
                            ui.from_actor = null;
                            ui.from = null;
                            if (++ui.nclose == 2) {
                                ui = null;
                            }
                        }
                    });
                    ui.into_actor.ease({
                        duration: Math.round(200 * progress),
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        opacity: 255,
                        scale_x: 1,
                        scale_y: 1,
                        onStopped: () => {
                            ui.into_actor.set_pivot_point(0, 0);
                            ui.into_actor = null;
                            ui.into = null;
                            if (++ui.nclose == 2) {
                                ui = null;
                            }
                        }
                    });
                    this._actionWidgets[wid] = null;

                    // Clear cache after timeout
                    this._actionWidgets.cacheWinTimeout = this.setTimeout(
                        function (me) {
                            me._actionWidgets.cacheWinTabList = null;
                            me.clearTimeout(me._actionWidgets.cacheWinTimeout);
                            me._actionWidgets.cacheWinTimeout = 0;
                        }, 1000, this
                    );
                }
            } else if (state) {
                this._actionWidgets[wid] = ui = null;
            }
        }


        else if ((id == 6) || (id == 7)) {
            //
            // NEXT & PREVIOUS WINDOW SWITCHING
            //
            if (this._isOnOverview()) {
                return; // Ignore on overview
            }

            let prv = (id == 6);
            let wid = prv ? "movewin_left" : "movewin_right";
            let ui = this._actionWidgets[wid];
            let activeWin = null;

            // Init indicator
            if (!ui) {
                ui = -1;
                // Cancel cache win timeout
                activeWin = global.display.get_focus_window();
                let inserted = 0;
                if (activeWin) {
                    let wsid = activeWin.get_workspace().index();
                    let tsid = wsid;
                    if (prv) {
                        if (wsid == 0) {
                            let wpl = activeWin.get_workspace().list_windows();
                            inserted = wpl.length;
                            if (inserted > 1) {
                                // Check for blacklisted windows
                                for (var i = 0; i < inserted; i++) {
                                    if (this._isWindowBlacklist(wpl[i])) {
                                        inserted--;
                                    }
                                }
                            }
                            wsid = tsid = 1;
                        }
                        tsid--;
                    }
                    else {
                        tsid++;
                    }
                    // Make sure move left from left-most workspace only
                    // triggered if other window is available in
                    // current workspace
                    if (inserted !== 1) {
                        activeWin.stick();
                        if (inserted) {
                            this._insertWorkspace(0);
                        }
                        ui = {
                            confirmSwipe: () => { },
                            wm: Main.wm._workspaceAnimation,
                            win: activeWin,
                            wid: tsid,
                            sid: wsid,
                            ins: inserted
                        };
                        ui.wm._switchWorkspaceBegin(
                            ui,
                            global.display.get_primary_monitor()
                        );
                    }
                }
                this._actionWidgets[wid] = ui;
            }
            if (ui && ui != -1) {
                if (!state) {
                    ui.wm._switchWorkspaceUpdate(
                        ui,
                        ui.sid + ((prv) ? 0 - progress : progress)
                    )
                }
                else {
                    ui.win.unstick();
                    ui.wm._switchWorkspaceEnd(
                        ui, 350,
                        ui.sid + ((prv) ? 0 - progress : progress)
                    );
                    if (progress > 0.5) {
                        ui.win.change_workspace_by_index(
                            ui.wid, true
                        );
                        global.workspace_manager.get_workspace_by_index(ui.wid)
                            .activate(
                                global.get_current_time()
                            );
                    }
                    else if (ui.ins) {
                        // list_windows
                        if (ui.ins > 1) {
                            ui.win.change_workspace_by_index(
                                ui.sid, true
                            );
                        }
                        else {
                            ui.win.change_workspace_by_index(
                                ui.wid, true
                            );
                        }
                    }
                    ui.win.activate(global.get_current_time());
                    this._actionWidgets[wid] = ui = null;
                }
            } else if (state) {
                this._actionWidgets[wid] = ui = null;
            }
        }




        else if (id >= 8 && id <= 9) {
            //
            // BACK / FORWARD
            //
            if (this._isOnOverview()) {
                return; // Ignore on overview
            }

            const keyList = [
                Clutter.KEY_Back,
                Clutter.KEY_Forward
            ];
            let kid = id - 8;
            let activeWin = null;
            let kidw = kid ? 'btnforward' : 'btnback';
            let ui = this._actionWidgets[kidw];

            // Init indicator
            if (!ui) {
                activeWin = global.display.get_focus_window();
                if (this._isWindowBlacklist(activeWin)) {
                    activeWin = null;
                }
                if (activeWin) {
                    let uipar = activeWin.get_compositor_private();
                    if (uipar) {
                        let wrect = activeWin.get_frame_rect();
                        let uix = ((uipar.get_width() - wrect.width) / 2);
                        let uiy = (uipar.get_height() / 2) - 32;
                        if (kid) {
                            uix += wrect.width - 128;
                        }
                        else {
                            uix += 64;
                        }
                        ui = this._createUi(
                            'wgs-indicator-backforward',
                            uix,
                            uiy,
                            64, 64,
                            kid ? 'pan-end-symbolic.symbolic' :
                                'pan-start-symbolic.symbolic',
                            uipar
                        );
                        if (ui) {
                            ui.translation_x = kid ? -32 : 32;
                            ui.opacity = 0;
                        }
                        else {
                            ui = -1;
                        }
                        this._actionWidgets[kidw] = ui;
                    }
                    else {
                        this._actionWidgets[kidw] = -1;
                    }
                }
                else {
                    this._actionWidgets[kidw] = -1;
                }
            }

            // Execute Progress
            if (ui && ui != -1) {
                if (!state) {
                    if (kid) {
                        ui.translation_x = 32 - (32 * progress);
                    }
                    else {
                        ui.translation_x = (32 * progress) - 32;
                    }
                    ui.opacity = Math.round(255 * progress);
                }
                else {
                    // Action is executed
                    if (progress >= 1.0) {
                        this._sendKeyPress([keyList[kid]]);
                    }
                    ui.release();
                    this._actionWidgets[kidw] = ui = null;
                }
            } else if (state) {
                this._actionWidgets[kidw] = ui = null;
            }
        }
        else if (id >= 10 && id <= 17) {
            //
            // MEDIA & BRIGHTNESS
            //
            const keyList = [
                Clutter.KEY_MonBrightnessUp,
                Clutter.KEY_MonBrightnessDown,
                Clutter.KEY_AudioRaiseVolume,
                Clutter.KEY_AudioLowerVolume,
                Clutter.KEY_AudioMute,
                Clutter.KEY_AudioPlay,
                Clutter.KEY_AudioNext,
                Clutter.KEY_AudioPrev
            ];
            let wid = 'keys_' + id;
            let cid = 'keysn_' + id;
            let keyId = keyList[id - 10];
            let isRepeat = (id < 14);
            let kidw = 'keyaction_' + id;
            let ui = this._actionWidgets[kidw];

            if (isRepeat) {
                if (!state && (progress >= 1)) {
                    if (!this._actionWidgets[wid]) {
                        let me = this;
                        this._actionWidgets[cid] = 0;
                        this._sendKeyPress([keyId]);
                        this._actionWidgets[wid] = this.setInterval(
                            function () {
                                if (me._actionWidgets[cid] >= 5) {
                                    me._sendKeyPress([keyId]);
                                }
                                else {
                                    me._actionWidgets[cid]++;
                                }
                            },
                            100
                        );
                    }
                }
                if (state) {
                    if (this._actionWidgets[wid]) {
                        this.clearInterval(this._actionWidgets[wid]);
                    }
                    this._actionWidgets[wid] = 0;
                    this._actionWidgets[cid] = 0;
                }
            }
            else {
                if (!ui) {
                    const iconlist = [
                        'audio-volume-muted-symbolic',
                        'media-playback-start-symbolic',
                        'media-skip-forward-symbolic',
                        'media-skip-backward-symbolic'
                    ];
                    let display = global.get_display();
                    let mrect = display.get_monitor_geometry(
                        display.get_primary_monitor()
                    );
                    ui = this._createUi(
                        'wgs-indicator-keys',
                        mrect.x + (mrect.width / 2) - 64,
                        mrect.y + (mrect.height / 2) - 64,
                        128, 128,
                        iconlist[id - 14],
                        null
                    );
                    ui.opacity = 0;
                    ui.scale_x = ui.scale_y = 0;
                    this._actionWidgets[kidw] = ui;
                }

                // Execute Progress
                if (ui && ui != -1) {
                    if (!state) {
                        ui.scale_x = ui.scale_y = progress;
                        ui.opacity = Math.round(255 * progress);
                    }
                    else {
                        // Action is executed
                        if (progress >= 1.0) {
                            this._sendKeyPress([keyId]);
                        }
                        ui.aniRelease(progress);
                        this._actionWidgets[kidw] = ui = null;
                    }
                }
                else if (state) {
                    this._actionWidgets[kidw] = ui = null;
                }
            }

        }




        //
        // TODO: Change Below Actions
        //
        else if (id == 18) {
            if (this._isOnOverview()) {
                // Ignore on overview
                return;
            }
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // ALT+TAB
            this._sendKeyPress([Clutter.KEY_Alt_L, Clutter.KEY_Tab]);
        }
        else if (id == 19) {
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // Overview (Super)
            this._sendKeyPress([Clutter.KEY_Super_L]);
        }
        else if (id == 20) {
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // Show Apps (Super+A)
            this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_A + _LCASE]);
        }
        else if (id == 21) {
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // Quick Settings (Super+S)
            Main.wm._toggleQuickSettings();
            // this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_S + _LCASE]);
        }
        else if (id == 22) {
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // Notification (Super+V)
            Main.wm._toggleCalendar();
            // this._sendKeyPress([Clutter.KEY_Super_L, Clutter.KEY_V + _LCASE]);
        }
        else if (id == 23) {
            if (!state || progress < 1.0) {
                // Ignore if non end
                return;
            }
            // Run (Alt+F2)
            this._sendKeyPress([Clutter.KEY_Alt_L, Clutter.KEY_F2]);
        }

        //
        // End Of Actions
        //

        /*
        let stk=Main.wm._workspaceAnimation._swipeTracker;
        stk.emit('begin',global.display.get_primary_monitor());
        stk.emit('update',0.5);
        stk.emit('end',100,1.0);

        Main.wm._workspaceAnimation._swipeTracker.orientation=Clutter.Orientation.HORIZONTAL;
        Main.wm._workspaceAnimation._swipeTracker.emit('begin',global.display.get_primary_monitor());
        Main.wm._workspaceAnimation._swipeTracker.emit('update',-0.5);
        Main.wm._workspaceAnimation._swipeTracker.emit('end',100,-1.0);

        Main.wm._workspaceAnimation._swipeTracker.orientation=Clutter.Orientation.HORIZONTAL;
        Main.wm._workspaceAnimation._swipeTracker.emit('begin',global.display.get_primary_monitor());
        Main.wm._workspaceAnimation._swipeTracker.emit('update',0.5);
        Main.wm._workspaceAnimation._swipeTracker.emit('end',100,1.0);

        */
    }
}

// Export Extension
export default class WindowGesturesExtension extends Extension {
    // Enable Extension
    enable() {
        this.manager = new Manager(this);
    }

    // Disable Extension
    disable() {
        this.manager.destroy();
        this.manager = null;
    }
}