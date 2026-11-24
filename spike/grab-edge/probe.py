"""Runs inside a throwaway Blender on the hidden labwc display. Writes GPU/session info
once, then publishes state every 0.1 s (cube, mode, view, windows, running modal
operators). Executes OUT/cmd/*.py drop-in files so the driver can open windows, start
playback etc. Quits when OUT/quit appears (or after 1500 s)."""
import glob
import json
import os
import time
import traceback

import bpy
import gpu

OUT = os.environ["T3_PROBE_OUT"]
STARTED = time.time()
os.makedirs(os.path.join(OUT, "cmd"), exist_ok=True)
# Belt and braces: never let quit.blend / autosave land in the shared /tmp.
bpy.context.preferences.filepaths.temporary_directory = os.environ["TMPDIR"]


def view3d():
    win = bpy.context.window_manager.windows[0]
    area = next((a for a in win.screen.areas if a.type == "VIEW_3D"), None)
    return win, area


def write_json(name, data):
    tmp = os.path.join(OUT, name + ".tmp")
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, os.path.join(OUT, name))


def info():
    win, area = view3d()
    sysinfo = os.path.join(OUT, "sysinfo.txt")
    with bpy.context.temp_override(window=win, area=area):
        bpy.ops.wm.sysinfo(filepath=sysinfo)
    write_json("info.json", {
        "pid": os.getpid(),
        "blender": bpy.app.version_string,
        "gpu_backend": gpu.platform.backend_type_get(),
        "gpu_renderer": gpu.platform.renderer_get(),
        "gpu_vendor": gpu.platform.vendor_get(),
        "window_size": [win.width, win.height],
        "WAYLAND_DISPLAY": os.environ.get("WAYLAND_DISPLAY"),
        "DISPLAY": os.environ.get("DISPLAY"),
    })
    return None


def run_cmds():
    for path in sorted(glob.glob(os.path.join(OUT, "cmd", "*.py"))):
        src = open(path).read()
        os.remove(path)
        win, area = view3d()
        try:
            with bpy.context.temp_override(window=win, area=area):
                exec(compile(src, path, "exec"), {"bpy": bpy, "win": win, "area": area})
            msg = "ok"
        except Exception:
            msg = traceback.format_exc()
        with open(os.path.join(OUT, "cmd.log"), "a") as f:
            f.write(f"{time.time():.3f} {os.path.basename(path)}: {msg}\n")


def state():
    if os.path.exists(os.path.join(OUT, "quit")) or time.time() - STARTED > 1500:
        win, area = view3d()
        with bpy.context.temp_override(window=win, area=area):
            bpy.ops.wm.quit_blender()
        return None
    run_cmds()
    wm = bpy.context.window_manager
    win, area = view3d()
    cube = bpy.data.objects.get("Cube")
    data = {"t": time.time(), "screen": win.screen.name,
            "windows": [[w.width, w.height, w.screen.name] for w in wm.windows],
            "frame": bpy.context.scene.frame_current}
    try:
        data["modal"] = [op.bl_idname for w in wm.windows for op in w.modal_operators]
    except AttributeError:
        data["modal"] = None
    if cube:
        data["mode"] = cube.mode
        data["cube_location"] = [round(v, 4) for v in cube.location]
        data["cube_rotation"] = [round(v, 4) for v in cube.rotation_euler]
        data["cube_scale"] = [round(v, 4) for v in cube.scale]
    if area:
        r3d = area.spaces.active.region_3d
        data["view_rotation"] = [round(v, 4) for v in r3d.view_rotation]
        data["view_distance"] = round(r3d.view_distance, 4)
    views = []
    for w in wm.windows:
        a = next((a for a in w.screen.areas if a.type == "VIEW_3D"), None)
        if not a:
            views.append({"win": [w.width, w.height], "areas": len(w.screen.areas)})
            continue
        sp = a.spaces.active
        r = sp.region_3d
        views.append({"win": [w.width, w.height], "areas": len(w.screen.areas), "screen": w.screen.name,
                      "rot": [round(v, 4) for v in r.view_rotation], "dist": round(r.view_distance, 4),
                      "loc": [round(v, 4) for v in r.view_location], "persp": r.view_perspective,
                      "shading": sp.shading.type, "header": sp.show_region_header})
    data["views"] = views
    write_json("state.json", data)
    return 0.1


bpy.app.timers.register(info, first_interval=1.5)
bpy.app.timers.register(state, first_interval=2.0)
