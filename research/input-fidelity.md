# How can mouse and keyboard input reach a hosted Blender at full fidelity?

Research for issue #3 (map: #1). Feeds #11 (how input is captured and who has control) and #17 (spike: grabs past the window edge).
Checked on 2026-11-23 against Blender v5.3.0, cage v0.3.1, sway 1.11, wlroots 0.19.0, wayvnc v0.10.2, Chromium `main`, Electron 44 (T3 desktop pins `electron@44.10.1`), and MDN browser-compat-data `main`. Sibling research for #2 (`research/headless-compositor.md`) reached the same compositor conclusion independently.

## Answer

**Full fidelity needs three things, and the earlier test had none of them in place:**

1. **A compositor with `pointer-constraints` as well as `relative-pointer`.** Blender refuses every cursor grab when either is missing. cage has no `pointer-constraints`, so in cage Blender never grabbed at all. That, not VNC, is the main reason G/R/S stopped at the window edge. labwc and sway both have the protocol (see #2).
2. **T3's own input channel, not RFB/VNC.** VNC pointer events are absolute only. T3 should send input straight to `wlr-virtual-pointer` and `virtual-keyboard` on the hidden display, using relative `motion` while Blender holds a pointer lock and `motion_absolute` the rest of the time. In sway (and labwc), absolute motion during a lock is turned into a *wrong* delta, so the relative path is required, not optional.
3. **Pointer Lock on the client while Blender is grabbing.** Web and Electron both support it, and the client forwards `movementX/Y`. Do **not** request `unadjustedMovement`: Blender itself uses the *accelerated* delta, so the client OS's normal acceleration is the local-equivalent feel. It is also unsupported in Chrome on Linux.

**Keyboard:** forward physical keys (`KeyboardEvent.code`, mapped to evdev codes) and give the hidden display's virtual keyboard an xkb keymap that matches the user's layout. Blender picks shortcuts by the layout's unmodified keysym, so a QWERTY keymap gives an AZERTY user the wrong shortcuts. Drop browser auto-repeat; Wayland clients repeat keys themselves.

**Reserved keys:**
- **Electron:** everything except the OS's own shortcuts can reach the pane. T3's application menu currently claims Ctrl+Z/Shift+Z/X/C/V/A/R/0/=/-/W/, and F11. The pane must call `webContents.setIgnoreMenuShortcuts(true)` while it has focus; T3 already does this for previews.
- **Web, normal tab:** Ctrl+W/T/N, Ctrl+Shift+W/T/N, Ctrl+Tab and Ctrl+Shift+Tab never reach the page. None of these is a core Blender default except Ctrl+Tab (pie menu for mode switching). Keyboard Lock (Chromium only, fullscreen only) lifts this.
- **Installed PWA (app window):** Chromium reserves no keys.

**Esc is the sharp edge.** In Chrome *and* Electron 44, Esc while the pointer is locked is consumed by the browser to release the lock. It never reaches the page, and it starts a 1.25 s re-lock cooldown. Esc is also Blender's "cancel grab". Mitigation: when the lock is lost without T3 asking, send Blender an Esc. The user's intent and the browser's action then line up.

**Mouse buttons and scroll:** middle mouse works if the pane cancels `pointerdown` for button 1 (Linux paste, Windows autoscroll). Blender turns mouse-wheel input into whole notches even locally, so "high-resolution" wheel gives no extra fidelity; send whole steps with `axis_source=wheel`. Trackpad scroll is different: Blender treats `axis_source=finger` as trackpad pan/orbit, and the browser cannot reliably tell a wheel from a trackpad.

**What breaks without mitigation:**
- cage (no grabs).
- Absolute motion during a lock (runaway deltas).
- Esc consumed by the browser.
- Ctrl+Tab and similar keys in a web tab.
- Electron menu accelerators stealing Ctrl+Z and others.
- A layout mismatch.
- Doubled key repeat.
- Keys or buttons stuck after focus loss.
- Trackpad vs wheel ambiguity.
- Pinch-zoom.
- IME text input.

## How Blender grabs on Wayland

- **Both protocols or nothing.** `GHOST_SystemWayland::window_cursor_grab_set` begins with `if (!display_->wp.relative_pointer_manager || !display_->wp.pointer_constraints) return false;` ([GHOST_SystemWayland.cc@v5.3.0 L11438](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L11438)). `GHOST_Window::setCursorGrab` then returns failure, and the grab mode is never recorded ([GHOST_Window.cc@v5.3.0 L172-L202](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_Window.cc#L172-L202)). The operator carries on with the plain absolute cursor, which stops at the window edge.
- **Wrap and hide grabs use a locked pointer plus relative motion.** For `GHOST_kGrabWrap` (G/R/S, view orbit) and `GHOST_kGrabHide` (dragging number fields), Blender creates a `zwp_relative_pointer_v1` and a persistent `zwp_locked_pointer_v1`. It moves its own software cursor and hands the compositor `set_cursor_position_hint` on release ([L11600-L11619](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L11600-L11619), [L11468](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L11468), [L10679](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L10679)). The code comment explains that Blender deliberately does not use `wp_pointer_warp_v1` ([L9918-L9937](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L9918-L9937)).
- **It uses the accelerated delta.** `relative_pointer_handle_relative_motion` adds `dx`/`dy` and ignores `dx_unaccel`/`dy_unaccel` ([L4068-L4097](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L4068-L4097)). Locally, then, the user feels the OS's pointer acceleration during a grab. Forwarding the browser's normal (accelerated) `movementX/Y` reproduces that. Asking for raw input would make remote grabs feel different from local ones.
- **Protocol guarantee.** While a pointer is locked, "the corresponding seat will not emit any wl_pointer.motion events, but relative motion events will still be emitted" ([pointer-constraints-unstable-v1.xml L138-L139](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/unstable/pointer-constraints/pointer-constraints-unstable-v1.xml)). Relative motion is not clipped by output edges ([relative-pointer-unstable-v1.xml](https://gitlab.freedesktop.org/wayland/wayland-protocols/-/blob/main/unstable/relative-pointer/relative-pointer-unstable-v1.xml)).

## How compositors turn virtual-pointer input into relative motion

- **Virtual pointer requests.** `wlr-virtual-pointer-unstable-v1` has `motion` (relative dx/dy), `motion_absolute` (x/y over an extent), `button`, `axis`, `axis_source`, `axis_stop`, `axis_discrete` and `frame` ([protocol XML](https://gitlab.freedesktop.org/wlroots/wlr-protocols/-/blob/master/unstable/wlr-virtual-pointer-unstable-v1.xml)).
- **wlroots.** `motion` becomes a normal `wlr_pointer` motion event with `delta = unaccel = dx` (sub-pixel `wl_fixed`), so the compositor adds no acceleration of its own. `axis_discrete` is stored as `discrete × 120`, so only whole notches can be sent ([wlr_virtual_pointer_v1.c@0.19.0 L23-L60, L163-L185](https://gitlab.freedesktop.org/wlroots/wlroots/-/blob/0.19.0/types/wlr_virtual_pointer_v1.c)).
- **sway.** `pointer_motion` always sends `relative_motion` first, then applies the active constraint, and the constraint applies to virtual pointers too. Absolute events are turned into `dx = lx - cursor.x` ([sway/input/cursor.c@1.11 L296-L355](https://github.com/swaywm/sway/blob/1.11/sway/input/cursor.c#L296-L355)). While locked, `cursor.x` is frozen. Absolute positions 101, 102, 103 against a lock at 100 therefore produce deltas of 1, 2 and 3, a runaway. **Absolute input cannot drive a locked grab correctly.** The #2 research reports the same structure in labwc's `cursor.c`.
- **cage v0.3.1.** It forwards relative and absolute motion as relative events ([seat.c@v0.3.1 L621-L675](https://github.com/cage-kiosk/cage/blob/v0.3.1/seat.c#L621-L675)). It creates the virtual pointer, virtual keyboard and relative-pointer managers but no pointer-constraints manager ([cage.c@v0.3.1 L531-L553](https://github.com/cage-kiosk/cage/blob/v0.3.1/cage.c#L531-L553)). `master` (f551ca2) still has none. Upstream: issue [#288](https://github.com/cage-kiosk/cage/issues/288) ("missing zwp_pointer_constraints_v1"); unmerged PRs [#300](https://github.com/cage-kiosk/cage/pull/300) and [#527](https://github.com/cage-kiosk/cage/pull/527).
- **wayvnc v0.10.2.**
  - Pointer: only `motion_absolute`, buttons (left, middle, right, back, forward) and `axis_discrete` ([src/pointer.c](https://github.com/any1/wayvnc/blob/v0.10.2/src/pointer.c)).
  - Keyboard: VNC keysyms are reverse-looked-up in a configured xkb keymap. QEMU raw key codes are also accepted ([src/keyboard.c](https://github.com/any1/wayvnc/blob/v0.10.2/src/keyboard.c), [src/main.c `on_key_code_event`](https://github.com/any1/wayvnc/blob/v0.10.2/src/main.c)).
  - Conclusion: fine for viewing, not enough for grabs.

## Client side: Pointer Lock

- **What it gives.** A locked element receives all mouse events. The system cursor is hidden, `clientX/Y` stay constant, and `movementX/Y` carry the deltas ([Pointer Lock 2.0](https://w3c.github.io/pointerlock/)). `requestPointerLock()` returns a Promise in Chrome 92+ and Safari 18.4+ ([MDN BCD api/Element.json](https://github.com/mdn/browser-compat-data/blob/main/api/Element.json)).
- **`unadjustedMovement`.**
  - Support: Chrome 88+ "on macOS Catalina 10.15.1+, Windows, and ChromeOS. Not yet supported on Linux"; Firefox 152; Safari 18.4 (same BCD file).
  - If requested where unsupported, the promise rejects with `NotSupportedError` (spec, step 5).
  - Not needed here (see the Blender section above).
- **Activation rules (Chromium; Electron uses the same controller).**
  - A lock needs transient user activation, *unless the page released the previous lock itself*.
  - After a user Esc, any request within 1250 ms fails with `kUserEscapeCooldown` ([pointer_lock_controller.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/exclusive_access/pointer_lock_controller.cc), `RequestToLockPointer`, `kEffectiveUserEscapeDuration`; spec step 3 has the same "previously released" exception).
  - Practical consequence: the first lock should come straight from a user action. A keydown such as G counts, and Chromium's activation window is several seconds, enough for a server round trip. If T3 always ends locks with `exitPointerLock()`, later locks need no gesture at all.
- **Esc.** `ExclusiveAccessManager::HandleUserKeyEvent` passes Esc to the pointer-lock controller. That controller unlocks the pointer and returns *handled*, so the key is consumed before the page sees it. The exception is an active Keyboard Lock that requires press-and-hold ([exclusive_access_manager.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/exclusive_access/exclusive_access_manager.cc)).
- **Esc in Electron.** Electron 44 runs the same manager *before* it emits `before-input-event` ([electron_api_web_contents.cc@v44.0.0 `PreHandleKeyboardEvent`](https://github.com/electron/electron/blob/v44.0.0/shell/browser/api/electron_api_web_contents.cc)). The desktop app cannot intercept that Esc either.
- **Electron permission.** Electron approves all permission requests by default ([security.md](https://github.com/electron/electron/blob/main/docs/tutorial/security.md)). T3's main-window session sets no handler. The preview session allowlists `pointerLock` ([apps/desktop/src/preview/BrowserSession.ts](https://github.com/nonspacial/t3code-nonspaced/blob/a9bec41729/apps/desktop/src/preview/BrowserSession.ts)). If the main session gets a handler later, it must allow `pointerLock`, and `keyboardLock` if used ([session.md](https://github.com/electron/electron/blob/main/docs/api/session.md)).

### When should the client lock?

Only while Blender holds a lock. The rest of the time, absolute input with the local cursor feels better: no lock prompt, and no cursor that lags by a network round trip. That means the environment must know when Blender has a lock, and no off-the-shelf compositor reports this to a third process. Options, best first:

1. **Ask the compositor.** A small patch or helper that reports pointer-constraint activation and deactivation, e.g. a line on a pipe from labwc's or sway's `active_constraint` handling. This is exact, but it is a compositor change.
2. **Infer from Blender's cursor.** Blender hides its hardware cursor exactly when it locks: `use_visible` is false for wrap and hide grabs ([L11468](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L11468)). A cursor-capture session (e.g. `ext-image-copy-capture` cursor capture, see #2/#4) might expose that. *Unverified*: the spike must check whether a hidden cursor is observable.
3. **Relative mode all the time while the pane is captured**, like Moonlight or VM consoles. Protocol-complete and simple, but the cursor is drawn remotely, so it lags, and the user must click to capture and press Esc to release.

## Keyboard

- **Physical keys plus a matching keymap.**
  - The virtual keyboard must upload an xkb keymap before sending evdev key codes ([virtual-keyboard-unstable-v1.xml](https://github.com/swaywm/wlroots/blob/master/protocol/virtual-keyboard-unstable-v1.xml)).
  - Blender maps keys through the active layout's keysym *without modifiers*, plus fallbacks for keypads and non-Latin layouts ([`xkb_state_key_get_one_sym_without_modifiers` L6745-L6798](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L6745-L6798)). Shortcuts are therefore layout-dependent, just as they are locally.
  - Send `KeyboardEvent.code` → evdev. Chromium's own table is [dom_code_data.inc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/events/keycodes/dom/dom_code_data.inc); the code values are defined in [UI Events KeyboardEvent code](https://w3c.github.io/uievents-code/).
  - Choose the keymap per user. A setting works everywhere. `navigator.keyboard.getLayoutMap()` (Chrome 69+, not Firefox or Safari, per [BCD api/Keyboard.json](https://github.com/mdn/browser-compat-data/blob/main/api/Keyboard.json)) can suggest a default.
  - Dead keys then work through Blender's own xkb compose ([L6800+](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L6800)).
- **Repeat.** Wayland clients repeat keys themselves from `wl_keyboard.repeat_info`, and Blender runs its own repeat timer ([L7074-L7095](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L7074-L7095), [wayland.xml](https://gitlab.freedesktop.org/wayland/wayland/-/blob/main/protocol/wayland.xml)). Drop keydowns with `event.repeat === true`; forward only real presses and releases.
- **Stuck keys.** When the pane loses focus (window blur, tab hidden, control handed to someone else), release every key and button T3 has pressed. Otherwise the keyup that went elsewhere leaves Ctrl or a mouse button held in Blender.
- **Browser-reserved keys.**
  - Chromium's `IsReservedCommandOrKey` reserves no keys in app windows (installed PWA). In fullscreen it reserves only exit and fullscreen-toggle. Otherwise it reserves close tab, close window, new incognito window, new tab, new window, restore tab, next tab and previous tab ([browser_command_controller.cc main](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/ui/browser_command_controller.cc); list at [57f212f](https://chromium.googlesource.com/chromium/src/+/57f212f/chrome/browser/ui/browser_command_controller.cc)).
  - F-keys, Tab, Alt and most Ctrl combinations reach the page and can be `preventDefault()`ed.
  - OS shortcuts (Super, Alt+Tab, workspace switching) reach no page.
- **Keyboard Lock.**
  - Chrome/Edge 68+ only, not Firefox or Safari (BCD).
  - Only takes effect during JavaScript-initiated fullscreen, and cannot be used together with pointer lock outside fullscreen ([Keyboard Lock spec §3.2, §4.2, §5](https://wicg.github.io/keyboard-lock/)).
  - When active, Esc is delivered to the page and a 2 s hold exits.
  - On a Wayland desktop, Chromium implements it with `keyboard-shortcuts-inhibit`, which locks *all* keys; locking only Esc skips the protocol ([wayland_keyboard.cc `CreateKeyboardHook`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/ozone/platform/wayland/host/wayland_keyboard.cc)).
  - A "fullscreen Blender pane" mode could therefore offer full keyboard capture in Chromium and Electron.
- **Electron.** Menu accelerators run before the page. T3's menu ([DesktopApplicationMenu.ts](https://github.com/nonspacial/t3code-nonspaced/blob/a9bec41729/apps/desktop/src/window/DesktopApplicationMenu.ts)) binds:
  - CmdOrCtrl+, and +W
  - the undo/redo/cut/copy/paste/selectAll roles
  - Ctrl+Shift+V
  - Ctrl+R and Ctrl+Shift+R
  - Ctrl+Shift+I
  - Ctrl+0, Ctrl+= and Ctrl+-
  - the `togglefullscreen` role (F11)

  Many of these are Blender shortcuts (Ctrl+R loop cut, Ctrl+Z undo, Ctrl+A apply). `webContents.setIgnoreMenuShortcuts(true)` while the pane has focus ([web-contents.md](https://github.com/electron/electron/blob/main/docs/api/web-contents.md)) fixes this. The pattern already exists in `apps/desktop/src/preview/Manager.ts` and `window/DesktopWindow.ts`.

## Mouse buttons and scroll

- **Middle and side buttons.**
  - Map `button` 0/1/2/3/4 to `BTN_LEFT`/`MIDDLE`/`RIGHT`/`SIDE`/`EXTRA`; Blender reads all five ([L294-L300, L794-L818](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L794-L818)).
  - Cancel `pointerdown` for button 1 to stop Linux paste and Windows autoscroll, `auxclick` to stop new-tab, and `contextmenu` for the right button ([MDN auxclick](https://developer.mozilla.org/en-US/docs/Web/API/Element/auxclick_event)).
  - Pointer Events fire `pointerdown` only for the *first* button. Later buttons arrive as `pointermove` with a changed `buttons` mask, so diff `buttons` on every event ([Pointer Events, chorded buttons](https://w3c.github.io/pointerevents/#chorded-button-interactions)).
  - Back/forward buttons may also navigate; cancel them the same way.
- **Wheel.**
  - Blender throws away smooth values for `axis_source=wheel` "as this causes mouse wheel scroll to orbit the view". It accumulates `value120` into whole notches ([L5124-L5143](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L5124-L5143)).
  - So the client accumulates `deltaY` into notches and sends `axis_source(wheel)` + `axis` + `axis_discrete(n)` + `frame`. The virtual pointer can only send whole notches anyway.
- **Trackpad.**
  - `axis_source=finger` becomes `GHOST_kTrackpadEventScroll`, which orbits or pans in the viewport, as on a local laptop ([L5145-L5226](https://github.com/blender/blender/blob/v5.3.0/intern/ghost/intern/GHOST_SystemWayland.cc#L5145-L5226)).
  - Browsers don't say which device a wheel event came from; a heuristic (pixel deltas that aren't multiples of the notch size) or a user toggle is needed.
  - Pinch arrives in browsers as Ctrl+wheel. That collides with Blender's real Ctrl+wheel, and the virtual pointer has no gesture events. Leave it out of v1.
- **Mobile and pen:** out of scope here (touch has no pointer lock). See #11.

## Open questions for the spike (#17)

The spike must verify, on labwc headless (sway as fallback) with Blender 5.3:

1. G/R/S, middle-mouse orbit and number-field drags continue indefinitely when the client is pointer-locked and T3 sends virtual-pointer `motion`.
2. The cursor ends up where Blender's position hint says when the lock is released.
3. Sending absolute motion during a lock really produces runaway deltas (confirming the code reading).
4. A working lock-state signal (option 1 or 2 above), and the round trip from G keydown to `requestPointerLock` resolving, within Chromium's activation window.
5. Scaling `movementX/Y` from pane CSS pixels to hidden-display logical pixels feels 1:1, including with a scaled output (Blender notes relative motion is not divided by output scale, #129230).
6. Esc during a grab: the lock is released and T3 forwards an Esc that cancels the transform. Check Chrome's "press Esc" bubble and Electron's behaviour, and that the 1.25 s cooldown doesn't block the next G.
7. Ctrl+Z, Ctrl+R, Tab, F2/F3/F9 and Alt combinations reach Blender in Electron with `setIgnoreMenuShortcuts`. Note which keys are lost in a Chrome tab (Ctrl+Tab).
8. Keymap: a non-QWERTY layout (e.g. AZERTY or German) gives the same shortcuts as local Blender, and dead keys type correctly.
9. Wheel notches give one zoom step each. A trackpad sent as `finger` orbits.
10. No stuck keys or buttons after Alt+Tab away mid-drag.
