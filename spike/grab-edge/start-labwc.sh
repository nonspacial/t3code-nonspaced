#!/usr/bin/env bash
# Starts labwc on the wlroots headless backend with Blender as its only client.
# Private XDG_RUNTIME_DIR, so the socket can never be the user's desktop session.
# Execs labwc, so the caller's captured PID *is* labwc.
set -u
D="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$D/out}"
mkdir -p "$OUT" "$D/blender-user" "$D/tmp"
mkdir -p -m 700 "$D/run"
unset WAYLAND_DISPLAY DISPLAY WAYLAND_SOCKET
export XDG_RUNTIME_DIR="$D/run"
export T3_PROBE_OUT="$OUT"
export BLENDER_USER_RESOURCES="$D/blender-user"
export TMPDIR="$D/tmp"
export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1
export WLR_RENDER_DRM_DEVICE=/dev/dri/renderD128
# labwc drops TMPDIR from its children, so pass the isolation env on the command itself.
exec labwc -C "$D/labwc" -S "env TMPDIR=$D/tmp BLENDER_USER_RESOURCES=$D/blender-user T3_PROBE_OUT=$OUT blender --factory-startup --gpu-backend ${BLENDER_GPU:-vulkan} --window-maximized --python $D/probe.py" 
