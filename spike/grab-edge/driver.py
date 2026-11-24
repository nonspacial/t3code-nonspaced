"""Spike #17 driver: starts labwc headless + Blender, starts the one-connection helper, runs
checks 1-9 and writes out/results.json + shots/. Only PIDs spawned here are ever signalled.
Usage: driver.py [phase ...]   (default: all phases)"""
import json
import os
import subprocess
import sys
import threading
import time

from PIL import Image, ImageChops

D = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(D, "out")
SHOTS = os.path.join(D, "shots")
RUN = os.path.join(D, "run")
HELPER = os.path.join(D, "helper/target/release/spike")
PHASES = sys.argv[1:] or ["setup", "keys", "grab", "cursor", "damage", "encode", "windows", "resize"]
results = {}
KEY = {"r": 19, "s": 31, "esc": 1, "tab": 15, "g": 34, "x": 45, "z": 44, "2": 3, "enter": 28, "ctrl": 29, "f12": 88,
       "kp1": 79, "kp3": 81, "kp7": 71, "home": 102, "shift": 42}
BTN_LEFT, BTN_MIDDLE = 272, 274

env_base = {k: v for k, v in os.environ.items() if k not in ("WAYLAND_DISPLAY", "DISPLAY", "WAYLAND_SOCKET")}
env_base["XDG_RUNTIME_DIR"] = RUN

# ---------------- processes ----------------
subprocess.run(["rm", "-rf", OUT])
os.makedirs(OUT)
os.makedirs(SHOTS, exist_ok=True)
labwc_log = open(os.path.join(OUT, "labwc.log"), "w")
labwc = subprocess.Popen([os.path.join(D, "start-labwc.sh")], env=dict(env_base, OUT=OUT), stdout=labwc_log, stderr=subprocess.STDOUT)
print(f"labwc pid={labwc.pid}", flush=True)
for _ in range(120):
    if os.path.exists(os.path.join(OUT, "info.json")):
        break
    if labwc.poll() is not None:
        sys.exit("labwc exited early")
    time.sleep(0.25)
info = json.load(open(os.path.join(OUT, "info.json")))
print("blender", info, flush=True)
WL = {**env_base, "WAYLAND_DISPLAY": info["WAYLAND_DISPLAY"]}

hel_env = dict(WL, GST_GL_WINDOW=os.environ.get("SPIKE_GL_WINDOW", "surfaceless"), GST_GL_PLATFORM="egl",
               GST_DEBUG="glupload:5,nvh264enc:3,GST_CAPS:1", GST_DEBUG_FILE=os.path.join(OUT, "gst-debug.log"))
if os.environ.get("SPIKE_WLDEBUG"):
    hel_env["WAYLAND_DEBUG"] = "1"
helper = subprocess.Popen([HELPER], env=hel_env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.path.join(OUT, "helper.stderr"), "w"), text=True, bufsize=1)
print(f"helper pid={helper.pid}", flush=True)
events = []
ev_lock = threading.Lock()
hlog = open(os.path.join(OUT, "helper.jsonl"), "w")


def reader():
    for line in helper.stdout:
        hlog.write(line)
        hlog.flush()
        try:
            e = json.loads(line)
        except ValueError:
            continue
        e["_rx"] = time.time()
        with ev_lock:
            events.append(e)


threading.Thread(target=reader, daemon=True).start()


def send(*cmds):
    for c in cmds:
        helper.stdin.write(c + "\n")
    helper.stdin.flush()


def mark():
    with ev_lock:
        return len(events)


def wait_ev(pred, since=0, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        with ev_lock:
            for e in events[since:]:
                if pred(e):
                    return e
        time.sleep(0.005)
    return None


def evs(since, name):
    with ev_lock:
        return [e for e in events[since:] if e.get("ev") == name]


def state():
    try:
        return json.load(open(os.path.join(OUT, "state.json")))
    except (OSError, ValueError):
        return {}


def wait_state(pred, timeout=4.0, after=0.0):
    end = time.time() + timeout
    while time.time() < end:
        s = state()
        if s.get("t", 0) > after and pred(s):
            return s
        time.sleep(0.02)
    return None


def stats(label):
    m = mark()
    send(f"cap stats {label}")
    return wait_ev(lambda e: e.get("ev") == "stats", m)


n_cmd = [0]


def blender(src, wait=0.5):
    n_cmd[0] += 1
    p = os.path.join(OUT, "cmd", f"{n_cmd[0]:03d}.py")
    with open(p + ".tmp", "w") as f:
        f.write(src)
    os.replace(p + ".tmp", p)
    time.sleep(wait)


def tap(k, hold=0.03):
    send(f"key {KEY[k]} 1")
    time.sleep(hold)
    send(f"key {KEY[k]} 0")


def grim(name):
    p = os.path.join(SHOTS, name)
    r = subprocess.run(["grim", p], env=WL, capture_output=True, text=True)
    return p if r.returncode == 0 else r.stderr


def ppm_to_png(ppm, name):
    p = os.path.join(SHOTS, name)
    Image.open(ppm).save(p)
    return p


def record(check, **kw):
    results.setdefault(check, {}).update(kw)
    print(f"[{check}] " + json.dumps(kw)[:600], flush=True)


def W():
    return state().get("windows", [[1920, 1080]])[0][0]


def H():
    return state().get("windows", [[1920, 1080]])[0][1]


# ---------------- phases ----------------
def phase_setup():
    g = wait_ev(lambda e: e.get("ev") == "globals", 0, 5)
    want = ["zwp_pointer_constraints_v1", "zwp_relative_pointer_manager_v1", "zwlr_virtual_pointer_manager_v1",
            "zwp_virtual_keyboard_manager_v1", "ext_image_copy_capture_manager_v1", "zwlr_screencopy_manager_v1"]
    names = {s.split(" ")[0]: s for s in g["list"]}
    record("1_setup", blender=info, globals_present={w: names.get(w) for w in want}, all_present=all(w in names for w in want))
    sysinfo = open(os.path.join(OUT, "sysinfo.txt")).read()
    record("1_setup", windowing=[l.strip() for l in sysinfo.splitlines() if "windowing" in l.lower()][:1])
    ready = wait_ev(lambda e: e.get("ev") == "ready", 0, 5)
    record("2_one_connection", helper_ready=ready)
    # Keymap first: wlroots rejects key events before a keymap.
    m = mark()
    send(f"keymap {D}/gb.xkb")
    record("9_keyboard", keymap=wait_ev(lambda e: e.get("ev") == "keymap_sent", m, 3))
    # 1920x1080 via wlr-output-management (headless starts at 1280x720).
    m = mark()
    t = time.time()
    send("resize 1920 1080")
    res = wait_ev(lambda e: e.get("ev") == "om_result", m, 5)
    mode = wait_ev(lambda e: e.get("ev") == "output_mode", m, 5)
    s = wait_state(lambda s: s["windows"][0][:2] == [1920, 1080], 6, t)
    record("8_resize", initial_resize={"om": res and res["result"], "output_mode": mode and [mode["w"], mode["h"]],
                                       "blender_window": s and s["windows"][0], "blender_follow_s": s and round(s["t"] - t, 2)})
    time.sleep(1.0)
    send(f"abs {int(1920 * 0.4)} {int(1080 * 0.5)}")
    time.sleep(0.2)
    tap("esc")  # close the splash
    time.sleep(0.8)
    record("1_setup", screenshot=grim("01-setup-1080p.png"))


def phase_keys():
    send(f"abs {int(W() * 0.4)} {int(H() * 0.5)}")
    time.sleep(0.2)
    t = time.time()
    tap("tab")
    s1 = wait_state(lambda s: s.get("mode") == "EDIT", 3, t)
    t2 = time.time()
    tap("tab")
    s2 = wait_state(lambda s: s.get("mode") == "OBJECT", 3, t2)
    # G X 2 Enter -> cube x == 2, then Ctrl+Z -> x back to 0.
    for k in ("g", "x", "2", "enter"):
        tap(k)
        time.sleep(0.12)
    s3 = wait_state(lambda s: abs(s["cube_location"][0] - 2.0) < 1e-3, 3)
    t4 = time.time()
    send(f"key {KEY['ctrl']} 1")
    time.sleep(0.03)
    tap("z")
    send(f"key {KEY['ctrl']} 0")
    s4 = wait_state(lambda s: abs(s["cube_location"][0]) < 1e-3, 3, t4)
    record("9_keyboard", tab_edit=bool(s1), tab_edit_latency_s=s1 and round(s1["t"] - t, 3), tab_object=bool(s2),
           typed_move_x2=bool(s3), ctrl_z_undo=bool(s4), ctrl_z_latency_s=s4 and round(s4["t"] - t4, 3))


def drive(kind, n=300, step=8.0, dt=0.008, mmb=False, key="g"):
    """Start a G grab (or MMB orbit) at the viewport centre, then push the pointer `n*step`
    px to the right with relative or absolute motion. Returns the state trace."""
    w, h = W(), H()
    x0, y0 = int(w * 0.4), int(h * 0.5)
    send(f"abs {x0} {y0}")
    time.sleep(0.3)
    if mmb:
        send(f"btn {BTN_MIDDLE} 1")
    else:
        tap(key)
    time.sleep(0.25)
    trace = []
    t0 = time.time()
    edge_t = None
    for i in range(n):
        if kind == "rel":
            send(f"motion {step} 0")
        else:
            x = min(x0 + step * (i + 1), w - 1)
            send(f"abs {int(x)} {y0}")
        if edge_t is None and x0 + step * (i + 1) >= w:
            edge_t = time.time()
        if i % 6 == 0:
            s = state()
            trace.append((round(time.time() - t0, 3), s.get("cube_location"), s.get("view_rotation"), s.get("modal"), s.get("cube_rotation"), s.get("cube_scale")))
        time.sleep(dt)
    time.sleep(0.3)
    s = state()
    trace.append((round(time.time() - t0, 3), s.get("cube_location"), s.get("view_rotation"), s.get("modal"), s.get("cube_rotation"), s.get("cube_scale")))
    if mmb:
        send(f"btn {BTN_MIDDLE} 0")
    else:
        tap("esc")
    time.sleep(0.4)
    return trace, (edge_t - t0) if edge_t else None


def summarize(trace, edge_s, idx):
    """How far the watched value moved before vs after the pointer passed the screen edge."""
    def val(e):
        v = e[idx]
        return v[0] if idx == 1 else v
    pre = [e for e in trace if edge_s and e[0] <= edge_s]
    post = [e for e in trace if edge_s and e[0] > edge_s]
    changes_after_edge = sum(1 for a, b in zip(post, post[1:]) if val(a) != val(b))
    return {"edge_after_s": edge_s and round(edge_s, 2), "value_at_edge": pre and val(pre[-1]),
            "value_end": val(trace[-1]), "changes_after_edge": changes_after_edge, "samples_after_edge": len(post),
            "modal_seen": sorted({m for e in trace for m in (e[3] or [])})}


def phase_rs():
    """R and S past the edge with relative motion (vertical-ish so R keeps turning)."""
    tr, edge = drive("rel", key="r")
    record("3_grabs", R_relative=summarize(tr, edge, 4))
    json.dump(tr, open(os.path.join(OUT, "trace-R-rel.json"), "w"))
    tr, edge = drive("rel", key="s", n=300, step=8.0)
    record("3_grabs", S_relative=summarize(tr, edge, 5))
    json.dump(tr, open(os.path.join(OUT, "trace-S-rel.json"), "w"))


def phase_grab():
    tr, edge = drive("rel")
    record("3_grabs", G_relative=summarize(tr, edge, 1))
    json.dump(tr, open(os.path.join(OUT, "trace-G-rel.json"), "w"))
    tr, edge = drive("abs")
    record("3_grabs", G_absolute=summarize(tr, edge, 1))
    json.dump(tr, open(os.path.join(OUT, "trace-G-abs.json"), "w"))
    tr, edge = drive("rel", mmb=True)
    record("3_grabs", orbit_relative=summarize(tr, edge, 2))
    json.dump(tr, open(os.path.join(OUT, "trace-orbit-rel.json"), "w"))
    tr, edge = drive("abs", mmb=True)
    record("3_grabs", orbit_absolute=summarize(tr, edge, 2))
    json.dump(tr, open(os.path.join(OUT, "trace-orbit-abs.json"), "w"))
    blender("bpy.ops.view3d.view_axis(type='FRONT')\nbpy.ops.view3d.view_persportho()\nbpy.ops.view3d.view_persportho()\n")
    # Input -> pixels latency: during a G grab, one relative nudge, time to the next captured frame.
    send("cap start shm 0")
    time.sleep(1.0)
    send(f"abs {int(W() * 0.4)} {int(H() * 0.5)}")
    time.sleep(0.3)
    tap("g")
    time.sleep(0.5)
    lats = []
    for i in range(30):
        time.sleep(0.25)  # let damage settle so the next frame is ours
        m = mark()
        t = time.time()
        send(f"motion {6 if i % 2 == 0 else -6} 0")
        e = wait_ev(lambda e: e.get("ev") == "stats" or (e.get("ev") is None), m, 0)  # no-op
        # frames have no per-frame event; poll stats frame counter instead
        before = None
        end = t + 1.0
        while time.time() < end:
            s = stats("lat")
            if before is None:
                before = s["frames"]
            elif s["frames"] > before:
                lats.append(round((time.time() - t) * 1000, 1))
                break
    tap("esc")
    send("cap stop")
    lats.sort()
    record("3_grabs", motion_to_captured_frame_ms={"n": len(lats), "median_upper_bound": lats[len(lats) // 2] if lats else None, "min": lats[0] if lats else None})


def crop_diff(a, b, cx, cy, r=40):
    A = Image.open(a).crop((cx - r, cy - r, cx + r, cy + r))
    B = Image.open(b).crop((cx - r, cy - r, cx + r, cy + r))
    bbox = ImageChops.difference(A.convert("RGB"), B.convert("RGB")).getbbox()
    return bbox


def save_frame(name, cursors):
    m = mark()
    send(f"cap start shm {cursors}")
    wait_ev(lambda e: e.get("ev") == "session_done", m, 3)
    time.sleep(0.3)
    p = os.path.join(OUT, name + ".ppm")
    m = mark()
    send(f"cap save {p}")
    send("motion 0 0")  # zero-length motion = a little damage on some setups; harmless
    blender("win.screen.areas[0].tag_redraw()\n[a.tag_redraw() for a in win.screen.areas]\n", wait=0.1)
    ok = wait_ev(lambda e: e.get("ev") == "saved", m, 3)
    send("cap stop")
    time.sleep(0.2)
    return p if ok else None


def sc_shot(name, overlay):
    p = os.path.join(OUT, name + ".ppm")
    m = mark()
    send(f"sc shot {overlay} {p}")
    e = wait_ev(lambda e: e.get("ev") in ("sc_ready", "sc_failed"), m, 3)
    return p if e and e.get("ev") == "sc_ready" else None


def phase_cursor():
    w, h = W(), H()
    cx, cy = int(w * 0.4), int(h * 0.5)
    send(f"abs {cx - 200} {cy}")
    time.sleep(0.3)
    m0 = mark()
    send("curs")
    time.sleep(1.0)
    send(f"abs {cx} {cy}")
    time.sleep(0.5)
    hover = {"with": save_frame("hover-ext-cursor1", 1), "without": save_frame("hover-ext-cursor0", 0),
             "sc_with": sc_shot("hover-sc-overlay1", 1), "sc_without": sc_shot("hover-sc-overlay0", 0)}
    m_g = mark()
    t_g = time.time()
    tap("g")
    time.sleep(0.6)
    send("motion 40 0")
    time.sleep(0.4)
    s = state()
    grab = {"with": save_frame("grab-ext-cursor1", 1), "without": save_frame("grab-ext-cursor0", 0),
            "sc_with": sc_shot("grab-sc-overlay1", 1), "sc_without": sc_shot("grab-sc-overlay0", 0)}
    m_e = mark()
    t_e = time.time()
    tap("esc")
    time.sleep(0.8)
    cur_events = [{k: e[k] for k in e if k != "_rx"} for e in events[m0:] if e.get("ev") in ("cursor", "cursor_frame", "buffer_size", "session_done", "frame_failed", "session_stopped") and e.get("kind", "Cursor") == "Cursor"]
    json.dump(cur_events, open(os.path.join(OUT, "cursor-events.json"), "w"), indent=0)
    def diff(d):
        if not (d["with"] and d["without"]):
            return "missing"
        return {"ext_paint_cursors_diff_bbox": crop_diff(d["with"], d["without"], cx + (40 if d is grab else 0), cy),
                "sc_overlay_diff_bbox": d["sc_with"] and d["sc_without"] and crop_diff(d["sc_with"], d["sc_without"], cx + (40 if d is grab else 0), cy)}
    after_g = [e for e in cur_events if e.get("t", 0) >= t_g and e.get("t", 0) < t_e]
    after_esc = [e for e in cur_events if e.get("t", 0) >= t_e]
    record("4_cursor_hidden", modal_during_grab=s.get("modal"), hover=diff(hover), grab=diff(grab),
           cursor_session_events_total=len(cur_events), cursor_events_after_G=after_g[:12], cursor_events_after_esc=after_esc[:12],
           t_G=round(t_g, 4), t_esc=round(t_e, 4))
    for k, p in list(hover.items()) + list(grab.items()):
        pass
    for name in ("hover-ext-cursor1", "hover-ext-cursor0", "grab-ext-cursor1", "grab-ext-cursor0"):
        p = os.path.join(OUT, name + ".ppm")
        if os.path.exists(p):
            Image.open(p).crop((cx - 160, cy - 120, cx + 200, cy + 120)).save(os.path.join(SHOTS, f"04-{name}-crop.png"))


def phase_cursor2():
    """Cursor session alone (no other capture), timeline of enter/leave vs Blender grabs."""
    w, h = W(), H()
    cx, cy = int(w * 0.4), int(h * 0.5)
    send(f"abs {cx} {cy}")
    time.sleep(0.5)
    m0 = mark()
    send("curs")
    time.sleep(1.5)
    acts = []
    def act(name, fn, wait):
        acts.append((name, time.time()))
        fn()
        time.sleep(wait)
    act("hover-move", lambda: send(f"abs {cx + 30} {cy}"), 1.0)
    act("G", lambda: tap("g"), 1.0)
    act("rel-motion", lambda: send("motion 40 0"), 1.0)
    act("Esc", lambda: tap("esc"), 1.5)
    act("MMB-down", lambda: send(f"btn {BTN_MIDDLE} 1"), 1.0)
    act("rel-motion", lambda: [send("motion 10 0") for _ in range(8)], 1.0)
    act("MMB-up", lambda: send(f"btn {BTN_MIDDLE} 0"), 1.5)
    act("hover-move", lambda: send(f"abs {cx} {cy + 20}"), 1.0)
    act("R", lambda: send("key 19 1") or send("key 19 0"), 1.0)
    act("rel-motion", lambda: send("motion 30 30"), 1.0)
    act("Enter", lambda: tap("enter"), 1.5)
    act("start-ext-paint-cursors-session", lambda: send("cap start shm 1"), 1.5)
    act("cap-stop", lambda: send("cap stop"), 1.0)
    act("hover-move", lambda: send(f"abs {cx + 50} {cy}"), 1.0)
    evl = [e for e in events[m0:] if e.get("ev") in ("cursor", "cursor_frame") and e.get("what") != "hotspot"]
    tl = sorted([(round(t - acts[0][1], 3), "ACT " + n) for n, t in acts] +
                [(round(e["t"] - acts[0][1], 3), "  " + e.get("what", "frame") + (f" {e.get('x')},{e.get('y')}" if "x" in e else "") + (f" opaque_px={e['opaque_px']}" if "opaque_px" in e else "")) for e in evl])
    json.dump(tl, open(os.path.join(OUT, "cursor-timeline.json"), "w"), indent=0)
    record("4_cursor_hidden", isolated_timeline=tl)


def phase_cursor3():
    """Realistic helper: main output capture WITHOUT paint_cursors running, plus the cursor session."""
    w, h = W(), H()
    cx, cy = int(w * 0.4), int(h * 0.5)
    send(f"abs {cx} {cy}")
    time.sleep(0.5)
    m0 = mark()
    send("cap start shm 0")
    time.sleep(1.0)
    send("curs")
    time.sleep(1.0)
    acts = []
    def act(name, fn, wait):
        acts.append((name, time.time()))
        fn()
        time.sleep(wait)
    p_hover = os.path.join(OUT, "c3-hover.ppm")
    act("hover-move", lambda: send(f"abs {cx + 30} {cy}"), 0.6)
    act("save-frame", lambda: send(f"cap save {p_hover}") or send("motion 1 0"), 0.6)
    act("G", lambda: tap("g"), 1.0)
    p_grab = os.path.join(OUT, "c3-grab.ppm")
    act("rel-motion", lambda: send("motion 40 0"), 0.5)
    act("save-frame", lambda: send(f"cap save {p_grab}") or send("motion 1 0"), 0.6)
    act("Esc", lambda: tap("esc"), 1.0)
    act("MMB-down", lambda: send(f"btn {BTN_MIDDLE} 1"), 0.8)
    act("MMB-up", lambda: send(f"btn {BTN_MIDDLE} 0"), 1.0)
    act("hover-move", lambda: send(f"abs {cx} {cy + 20}"), 1.0)
    evl = [e for e in events[m0:] if (e.get("ev") in ("cursor", "cursor_frame") and e.get("what") != "hotspot") or e.get("ev") == "saved"]
    tl = sorted([(round(t - acts[0][1], 3), "ACT " + n) for n, t in acts] +
                [(round(e.get("t", e["_rx"]) - acts[0][1], 3), "  " + e.get("what", e["ev"]) + (f" {e.get('x')},{e.get('y')}" if "x" in e else "") + (f" opaque_px={e['opaque_px']}" if "opaque_px" in e else "")) for e in evl])
    send("cap stop")
    for n, p in (("hover", p_hover), ("grab", p_grab)):
        if os.path.exists(p):
            Image.open(p).crop((cx - 160, cy - 120, cx + 200, cy + 120)).save(os.path.join(SHOTS, f"04-c3-{n}-paintcursors0-crop.png"))
    record("4_cursor_hidden", with_main_capture_no_cursor_timeline=tl)


ANIM_ON = """
import bpy
sc = bpy.context.scene
sc.render.fps = 120
cube = bpy.data.objects['Cube']
cube.rotation_euler = (0, 0, 0)
cube.keyframe_insert('rotation_euler', frame=1)
cube.rotation_euler = (0, 0, 6.2832)
cube.keyframe_insert('rotation_euler', frame=240)
sc.frame_end = 240
bpy.ops.screen.animation_play()
"""
ANIM_OFF = "bpy.ops.screen.animation_cancel(restore_frame=False)\n"


def phase_damage():
    send("cap start shm 0")
    time.sleep(1.5)
    send("cap reset")
    time.sleep(10)
    idle = stats("idle-10s")
    blender(ANIM_ON, wait=1.0)
    send("cap reset")
    time.sleep(10)
    anim = stats("anim-10s")
    send("cap stop")
    record("5_damage", ext_idle_10s={k: idle[k] for k in ("frames", "fps", "cpu_pct", "damage_mpx")},
           ext_animating_10s={k: anim[k] for k in ("frames", "fps", "cpu_pct", "present_to_ready_ms_med", "damage_mpx")},
           blender_frame=state().get("frame"))
    # wlr-screencopy fallback: copy_with_damage loop while animating, then idle.
    m = mark()
    send("sc loop 0")
    time.sleep(5)
    send("sc count")
    c1 = wait_ev(lambda e: e.get("ev") == "sc_count", m, 2)
    blender(ANIM_OFF, wait=1.5)
    m = mark()
    send("sc count")
    c2 = wait_ev(lambda e: e.get("ev") == "sc_count", m, 2)
    time.sleep(5)
    m = mark()
    send("sc count")
    c3 = wait_ev(lambda e: e.get("ev") == "sc_count", m, 2)
    send("sc stop")
    time.sleep(0.5)
    shot = sc_shot("sc-fallback", 0)
    record("5_damage", wlr_screencopy_animating_5s_frames=c1 and c1["frames"], wlr_screencopy_idle_5s_frames=(c3 and c2) and c3["frames"] - c2["frames"],
           wlr_screencopy_still=shot and ppm_to_png(shot, "05-wlr-screencopy-fallback.png"))


def gpu_sample():
    r = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,utilization.encoder", "--format=csv,noheader,nounits"], capture_output=True, text=True)
    return r.stdout.strip()


def encode_run(mode, enc, label):
    m = mark()
    send(f"cap start {mode} 0 {enc}")
    started = wait_ev(lambda e: e.get("ev") in ("enc_started", "gst_error"), m, 8)
    time.sleep(2.0)
    send("cap reset")
    samples = []
    for _ in range(5):
        time.sleep(2.0)
        samples.append(gpu_sample())
    s = stats(label)
    errs = [e for e in evs(m, "gst_error")] + [e for e in evs(m, "gst_warning")]
    send("cap stop")
    time.sleep(1.0)
    return {"started": started and started.get("ev"), "fps": s["fps"], "enc_fps": s["enc_fps"], "cpu_pct_helper": s["cpu_pct"],
            "ready_to_encoded_ms_med": s["ready_to_encoded_ms_med"], "ready_to_encoded_ms_p95": s["ready_to_encoded_ms_p95"],
            "present_to_ready_ms_med": s["present_to_ready_ms_med"], "kbps": s["enc_kbps"], "size": [s["w"], s["h"]],
            "gpu_util_gpu_enc_pct": samples, "gst_errors": [e.get("msg") for e in errs][:3]}


def phase_encode_dma():
    blender(ANIM_ON, wait=1.0)
    record("6_nvenc", **{"dmabuf_variant_" + os.environ.get("SPIKE_VARIANT", "x"): encode_run("dmabuf", "nv", "nv-dmabuf-variant")})
    blender(ANIM_OFF, wait=0.5)


def phase_encode():
    blender(ANIM_ON, wait=1.0)
    r_shm = encode_run("shm", "nv", "nv-shm")
    record("6_nvenc", shm_nvh264enc=r_shm)
    r_dma = encode_run("dmabuf", "nv", "nv-dmabuf")
    record("6_nvenc", dmabuf_glupload_nvh264enc=r_dma)
    r_x264 = encode_run("shm", "x264", "x264-shm")
    record("6_nvenc", shm_x264enc=r_x264)
    blender(ANIM_OFF, wait=0.5)
    log = open(os.path.join(OUT, "gst-debug.log"), errors="replace").read() if os.path.exists(os.path.join(OUT, "gst-debug.log")) else ""
    hits = [l for l in log.splitlines() if "dmabuf" in l.lower() and ("import" in l.lower() or "method" in l.lower() or "upload" in l.lower())]
    record("6_nvenc", glupload_dmabuf_log=hits[:6])


def phase_windows():
    send(f"abs {int(W() * 0.4)} {int(H() * 0.5)}")
    time.sleep(0.2)
    blender("bpy.ops.screen.userpref_show()\n", wait=1.5)
    s1 = state()
    p1 = grim("07-preferences-floating.png")
    send(f"abs {int(W() * 0.3)} {int(H() * 0.6)}")
    time.sleep(0.2)
    blender("bpy.context.scene.render.engine = 'BLENDER_WORKBENCH'\n", wait=0.3)
    # Real F12 through the virtual keyboard, pointer over the main window's viewport.
    send("btn 272 1")
    send("btn 272 0")
    time.sleep(0.3)
    tap("f12")
    s2 = wait_state(lambda s: len(s["windows"]) >= 3, 8)
    time.sleep(2.0)
    p2 = grim("07-render-and-prefs-floating.png")
    blender("for w in list(bpy.context.window_manager.windows)[1:]:\n    with bpy.context.temp_override(window=w):\n        bpy.ops.wm.window_close()\n", wait=1.5)
    s3 = state()
    p3 = grim("07-after-close.png")
    record("7_windows", windows_after_prefs=s1.get("windows"), windows_after_f12=s2 and s2.get("windows"), windows_after_close=s3.get("windows"),
           shots=[p1, p2, p3])


def phase_resize():
    m0 = mark()
    send("cap start dmabuf 0 nv")
    wait_ev(lambda e: e.get("ev") == "enc_started", m0, 8)
    blender(ANIM_ON, wait=1.0)
    out = []
    for w, h in ((1280, 720), (1600, 900), (1920, 1080)):
        m = mark()
        t = time.time()
        send(f"resize {w} {h}")
        res = wait_ev(lambda e: e.get("ev") == "om_result", m, 5)
        bs = wait_ev(lambda e: e.get("ev") == "buffer_size" and e.get("kind") == "Main", m, 5)
        s = wait_state(lambda s: s["windows"][0][:2] == [w, h], 6, t)
        time.sleep(1.0)
        before = stats("pre")["frames"]
        time.sleep(1.0)
        st = stats(f"after-{w}x{h}")
        caps = [e["caps"] for e in evs(m, "enc_caps")]
        shot = grim(f"08-resize-{w}x{h}.png")
        out.append({"size": [w, h], "om": res and res["result"], "new_buffer_size": bs and [bs["w"], bs["h"]],
                    "buffer_size_after_s": bs and round(bs["t"] - t, 3), "blender_window": s and s["windows"][0],
                    "blender_follow_s": s and round(s["t"] - t, 2), "frames_still_flowing": st["frames"] > before,
                    "encoder_recaps": caps, "failed_frames": st["failed"],
                    "shot": shot, "pushed_vs_encoded": [st.get("pushed"), st.get("encoded")]})
    blender(ANIM_OFF, wait=0.3)
    send("cap stop")
    errs = [e.get("msg") for e in evs(m0, "gst_error")]
    record("8_resize", runtime_resizes=out, helper_restarted=False, helper_pid=helper.pid, gst_errors=errs[:3])


def V(i=0):
    v = state().get("views", [])
    return v[i] if len(v) > i else {}


def pie(direction, x0, y0, r=160):
    """Tap Z, move toward a pie item with absolute motion, click it."""
    send(f"abs {x0} {y0}")
    time.sleep(0.2)
    tap("z")
    time.sleep(0.5)
    dx, dy = {"W": (-r, 0), "E": (r, 0), "S": (0, r), "N": (0, -r)}[direction]
    send(f"abs {x0 + dx} {y0 + dy}")
    time.sleep(0.3)
    send(f"btn {BTN_LEFT} 1")
    time.sleep(0.05)
    send(f"btn {BTN_LEFT} 0")
    time.sleep(0.4)


def viewer_keys(idx, x0, y0, tag):
    """Viewer-only interactions on the window whose VIEW_3D is views[idx], pointer at (x0, y0)."""
    r = {}
    send(f"abs {x0} {y0}")
    time.sleep(0.3)
    # Z pie: open, screenshot, pick Wireframe (West), then Solid (East).
    tap("z")
    time.sleep(0.6)
    r["pie_shot"] = grim(f"09-{tag}-z-pie-open.png")
    tap("esc")
    time.sleep(0.3)
    pie("W", x0, y0)
    r["pie_west"] = V(idx).get("shading")
    pie("E", x0, y0)
    r["pie_east"] = V(idx).get("shading")
    pie("S", x0, y0)
    r["pie_south"] = V(idx).get("shading")
    pie("E", x0, y0)
    send(f"abs {x0} {y0}")
    time.sleep(0.2)
    for k, name in (("kp7", "top"), ("kp1", "front"), ("kp3", "right")):
        tap(k)
        time.sleep(0.5)
        r[f"numpad_{name}"] = V(idx).get("rot")
    d0 = V(idx).get("dist")
    m = mark()
    for _ in range(4):
        send("wheel 1")
        time.sleep(0.08)
    time.sleep(0.4)
    r["wheel_zoom_dist"] = [d0, V(idx).get("dist")]
    loc0 = V(idx).get("loc")
    send(f"key {KEY['shift']} 1")
    send(f"btn {BTN_MIDDLE} 1")
    for _ in range(20):
        send("motion 6 3")
        time.sleep(0.01)
    send(f"btn {BTN_MIDDLE} 0")
    send(f"key {KEY['shift']} 0")
    time.sleep(0.4)
    r["shift_mmb_pan_loc"] = [loc0, V(idx).get("loc")]
    before = (V(idx).get("dist"), V(idx).get("loc"))
    tap("home")
    time.sleep(0.8)
    r["home_view_all"] = [before, (V(idx).get("dist"), V(idx).get("loc"))]
    send(f"abs {x0 + 5} {y0}")
    time.sleep(0.3)
    rot0 = V(idx).get("rot")
    send(f"btn {BTN_MIDDLE} 1")
    for _ in range(150):
        send("motion 12 0")
        time.sleep(0.004)
    send(f"btn {BTN_MIDDLE} 0")
    time.sleep(0.4)
    r["mmb_orbit_1800px_rot"] = [rot0, V(idx).get("rot")]
    # Right-click context menu: compare screenshots before/after.
    send(f"abs {x0} {y0}")
    time.sleep(0.3)
    a = grim(f"09-{tag}-before-rmb.png")
    send("btn 273 1")
    time.sleep(0.05)
    send("btn 273 0")
    time.sleep(0.6)
    b = grim(f"09-{tag}-rmb-menu.png")
    bbox = ImageChops.difference(Image.open(a).convert("RGB"), Image.open(b).convert("RGB")).getbbox()
    r["rmb_menu_diff_bbox"] = bbox
    tap("esc")
    time.sleep(0.3)
    return r


def phase_viewkeys():
    w, h = W(), H()
    r = viewer_keys(0, int(w * 0.4), int(h * 0.5), "main")
    ok = (r["pie_west"] == "WIREFRAME" and r["pie_east"] == "SOLID" and r["numpad_top"] == [1.0, 0.0, 0.0, 0.0]
          and r["numpad_front"][0] == 0.7071 and r["numpad_right"] == [0.5, 0.5, 0.5, 0.5] and r["rmb_menu_diff_bbox"] is not None)
    record("9_viewer_input", **r, all_ok=ok)


VIEWER_NEW = """
import bpy, json, os
wm = bpy.context.window_manager
bpy.ops.wm.window_new()
vw = wm.windows[-1]
info = {"areas_after_window_new": [a.type for a in vw.screen.areas], "screen": vw.screen.name}
area = max(vw.screen.areas, key=lambda a: a.width * a.height)
area.type = 'VIEW_3D'
sp = area.spaces.active
# A full, real viewport: header, tool header, toolbar and sidebar all visible.
sp.show_region_header = True
sp.show_region_tool_header = True
sp.show_region_toolbar = True
sp.show_region_ui = True
info["areas_final"] = [a.type for a in vw.screen.areas]
info["same_screen_as_main"] = vw.screen == wm.windows[0].screen
open(os.path.join(os.environ["T3_PROBE_OUT"], "viewer.json"), "w").write(json.dumps(info))
"""

VIEWER_FULLSCREEN = """
import bpy
vw = bpy.context.window_manager.windows[-1]
with bpy.context.temp_override(window=vw, screen=vw.screen):
    bpy.ops.wm.window_fullscreen_toggle()
"""

MAIN_SCREENSHOT = """
import bpy, os
main = bpy.context.window_manager.windows[0]
area = next(a for a in main.screen.areas if a.type == 'VIEW_3D')
with bpy.context.temp_override(window=main, screen=main.screen, area=area):
    bpy.ops.screen.screenshot(filepath=os.path.join(os.environ["T3_PROBE_OUT"], "main-blender-screenshot.png"))
"""


def phase_viewer():
    blender(VIEWER_NEW, wait=2.0)
    vinfo = json.load(open(os.path.join(OUT, "viewer.json"))) if os.path.exists(os.path.join(OUT, "viewer.json")) else None
    s = state()
    record("10_viewer_window", viewer_setup=vinfo, windows=s.get("windows"), views=s.get("views"), cmd_log=open(os.path.join(OUT, "cmd.log")).read()[-800:])
    p_float = grim("10-viewer-floating-output.png")
    m = mark()
    send("toplevels")
    tl = wait_ev(lambda e: e.get("ev") == "toplevels", m, 3)
    # (a) ext-image-copy-capture foreign-toplevel source on the newest toplevel.
    m = mark()
    send("cap start shm 0 none tl:-1")
    sd = wait_ev(lambda e: e.get("ev") == "session_done", m, 4)
    time.sleep(0.5)
    p = os.path.join(OUT, "viewer-toplevel.ppm")
    mm = mark()
    send(f"cap save {p}")
    blender("[a.tag_redraw() for w in bpy.context.window_manager.windows for a in w.screen.areas]\n", wait=0.2)
    saved = wait_ev(lambda e: e.get("ev") == "saved", mm, 4)
    # Occluded: raise the main window over the viewer, animate, count toplevel frames.
    send("cap reset")
    send(f"abs 20 {H() // 2}")
    send(f"btn {BTN_LEFT} 1")
    send(f"btn {BTN_LEFT} 0")
    time.sleep(0.5)
    p_occl = grim("10-main-raised-over-viewer.png")
    blender(ANIM_ON, wait=0.2)
    send("cap reset")
    time.sleep(3)
    occl = stats("toplevel-occluded")
    p2 = os.path.join(OUT, "viewer-toplevel-occluded.ppm")
    mm = mark()
    send(f"cap save {p2}")
    saved2 = wait_ev(lambda e: e.get("ev") == "saved", mm, 4)
    blender(ANIM_OFF, wait=0.3)
    send("cap stop")
    record("10_viewer_window", toplevels=tl and tl["list"], toplevel_session=sd and {"w": sd["w"], "h": sd["h"]},
           toplevel_capture=saved and ppm_to_png(p, "10-viewer-toplevel-capture.png"),
           occluded_frames_3s=occl and occl["frames"], occluded_capture=saved2 and ppm_to_png(p2, "10-viewer-toplevel-capture-while-occluded.png"),
           shots=[p_float, p_occl])
    # (b) fullscreen the viewer: output capture then shows only it.
    blender(VIEWER_FULLSCREEN, wait=1.5)
    s = state()
    p_fs = grim("10-viewer-fullscreen-output.png")
    record("10_viewer_window", fullscreen_windows=s.get("windows"))
    # Isolation: viewer-only interactions (pointer over fullscreen viewer) must not touch main.
    main0 = V(0)
    view0 = V(len(s["views"]) - 1)
    r = viewer_keys(len(s["views"]) - 1, int(W() * 0.5), int(H() * 0.5), "viewer")
    pie("W", int(W() * 0.5), int(H() * 0.5))  # leave the viewer in wireframe
    main1 = V(0)
    view1 = V(len(s["views"]) - 1)
    unchanged = all(main0.get(k) == main1.get(k) for k in ("rot", "dist", "loc", "shading"))
    blender(MAIN_SCREENSHOT, wait=1.5)
    shot = os.path.join(OUT, "main-blender-screenshot.png")
    if os.path.exists(shot):
        Image.open(shot).save(os.path.join(SHOTS, "10-main-window-blender-screenshot.png"))
    p_after = grim("10-viewer-fullscreen-after-interaction.png")
    record("10_viewer_window", viewer_interactions=r, main_before=main0, main_after=main1, main_unchanged=unchanged,
           viewer_before=view0, viewer_after=view1, main_blender_screenshot=os.path.exists(shot), shots2=[p_fs, p_after],
           cmd_log_tail=open(os.path.join(OUT, "cmd.log")).read()[-600:])


def phase_rz():
    mode = os.environ.get("SPIKE_RZ_MODE", "shm")
    restart = os.environ.get("SPIKE_RZ_RESTART") == "1"
    send(f"cap start {mode} 0")
    blender(ANIM_ON, wait=1.5)
    rows = []
    for w, h in ((1280, 720), (1600, 900), (1920, 1080)):
        m = mark()
        send(f"resize {w} {h}")
        if restart:
            wait_ev(lambda e: e.get("ev") == "output_mode", m, 3)
            send("cap stop")
            send(f"cap start {mode} 0")
        time.sleep(1.0)
        a = stats("a")
        time.sleep(1.0)
        b = stats("b")
        rows.append({"size": [w, h], "fps": round((b["frames"] - a["frames"]) / 1.0, 1) if (a and b) else None,
                     "buf": b and [b["w"], b["h"]], "lost": bool(evs(m, "connection_lost"))})
    blender(ANIM_OFF, wait=0.3)
    record("8_resize", **{f"rz_{mode}_restart{int(restart)}": rows})


def phase_shm720():
    m = mark()
    send("cap start shm 0")
    blender(ANIM_ON, wait=1.5)
    a = stats("a")
    time.sleep(1.0)
    b = stats("b")
    blender(ANIM_OFF, wait=0.3)
    record("8_resize", shm_at_startup_size={"size": b and [b["w"], b["h"]], "fps": a and b and b["frames"] - a["frames"], "lost": [e.get("err") for e in evs(m, "connection_lost")]})


def phase_viewer2():
    """Check 10, ordered so the viewer is on top while we drive it."""
    blender(VIEWER_NEW, wait=2.0)
    vinfo = json.load(open(os.path.join(OUT, "viewer.json")))
    s = state()
    m = mark()
    send("toplevels")
    tl = wait_ev(lambda e: e.get("ev") == "toplevels", m, 3)
    p_float = grim("10-viewer-floating-output.png")
    record("10_viewer_window", viewer_setup=vinfo, windows=s.get("windows"), toplevels=tl and tl["list"], shot_floating=p_float)
    blender(VIEWER_FULLSCREEN, wait=1.5)
    s = state()
    vi = len(s["views"]) - 1
    p_fs = grim("10-viewer-fullscreen-output.png")
    m = mark()
    send("cap start shm 0 none tl:-1")
    time.sleep(0.8)
    main0, view0 = V(0), V(vi)
    r = viewer_keys(vi, int(W() * 0.5), int(H() * 0.5), "viewer")
    pie("W", int(W() * 0.5), int(H() * 0.5))  # leave the viewer in wireframe
    time.sleep(0.5)
    main1, view1 = V(0), V(vi)
    unchanged = {k: main0.get(k) == main1.get(k) for k in ("rot", "dist", "loc", "shading")}
    changed = {k: view0.get(k) != view1.get(k) for k in ("rot", "dist", "loc", "shading")}
    p_tl = os.path.join(OUT, "viewer-toplevel.ppm")
    mm = mark()
    send(f"cap save {p_tl}")
    send("motion 1 0")
    saved = wait_ev(lambda e: e.get("ev") == "saved", mm, 4)
    blender(MAIN_SCREENSHOT, wait=1.5)
    shot = os.path.join(OUT, "main-blender-screenshot.png")
    if os.path.exists(shot):
        Image.open(shot).save(os.path.join(SHOTS, "10-main-window-blender-screenshot.png"))
    p_after = grim("10-viewer-fullscreen-after-interaction.png")
    alloc = [e for e in evs(m, "alloc")]
    record("10_viewer_window", fullscreen_windows=s.get("windows"), viewer_interactions=r, main_before=main0, main_after=main1,
           main_unchanged=unchanged, viewer_before=view0, viewer_after=view1, viewer_changed=changed,
           toplevel_capture_size=alloc and [alloc[0]["w"], alloc[0]["h"]], toplevel_capture=saved and ppm_to_png(p_tl, "10-viewer-toplevel-capture.png"),
           main_blender_screenshot=os.path.exists(shot), shots=[p_fs, p_after])
    # Occluded: un-fullscreen, raise main over the viewer, animate, count toplevel frames.
    blender(VIEWER_FULLSCREEN, wait=1.0)
    send(f"abs 20 {H() // 2}")
    time.sleep(0.2)
    send(f"btn {BTN_LEFT} 1")
    send(f"btn {BTN_LEFT} 0")
    time.sleep(0.5)
    p_occl = grim("10-main-raised-over-viewer.png")
    blender(ANIM_ON, wait=0.5)
    send("cap reset")
    time.sleep(3)
    occl = stats("toplevel-occluded")
    p2 = os.path.join(OUT, "viewer-toplevel-occluded.ppm")
    mm = mark()
    send(f"cap save {p2}")
    saved2 = wait_ev(lambda e: e.get("ev") == "saved", mm, 4)
    blender(ANIM_OFF, wait=0.3)
    send("cap stop")
    record("10_viewer_window", occluded_frames_3s=occl and occl["frames"], occluded_capture=saved2 and ppm_to_png(p2, "10-viewer-toplevel-capture-while-occluded.png"), shot_occluded=p_occl)


def phase_orbitafter():
    x0, y0 = int(W() * 0.4), int(H() * 0.5)
    def orbit(tag):
        send(f"abs {x0 + 5} {y0}")
        time.sleep(0.3)
        r0 = V(0).get("rot")
        send(f"btn {BTN_MIDDLE} 1")
        time.sleep(0.15)
        mod = state().get("modal")
        for _ in range(60):
            send("motion 12 0")
            time.sleep(0.006)
        send(f"btn {BTN_MIDDLE} 0")
        time.sleep(0.4)
        return {"step": tag, "orbited": r0 != V(0).get("rot"), "modal": mod, "rot": V(0).get("rot")}
    rows = [orbit("fresh")]
    send(f"abs {x0} {y0}"); time.sleep(0.2)
    tap("kp3"); time.sleep(0.6)
    rows.append(orbit("after numpad 3"))
    tap("kp1"); time.sleep(0.6)
    rows.append(orbit("after numpad 1"))
    tap("home"); time.sleep(0.8)
    rows.append(orbit("after Home"))
    send(f"key {KEY['shift']} 1"); send(f"btn {BTN_MIDDLE} 1")
    for _ in range(20):
        send("motion 6 3"); time.sleep(0.01)
    send(f"btn {BTN_MIDDLE} 0"); send(f"key {KEY['shift']} 0"); time.sleep(0.4)
    rows.append(orbit("after shift+MMB pan"))
    record("3_grabs", orbit_after_view_keys=rows)


try:
    for ph in PHASES:
        print(f"== {ph}", flush=True)
        try:
            globals()[f"phase_{ph}"]()
        except Exception as ex:  # keep going; record the failure
            import traceback
            record(f"error_{ph}", error=traceback.format_exc()[-1500:])
finally:
    json.dump(results, open(os.path.join(OUT, "results.json"), "w"), indent=1, default=str)
    try:
        send("quit")
    except Exception:
        pass
    open(os.path.join(OUT, "quit"), "w").close()
    for p in (helper, labwc):
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            print(f"terminating pid {p.pid}", flush=True)
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
    print("helper rc", helper.returncode, "labwc rc", labwc.returncode, flush=True)
