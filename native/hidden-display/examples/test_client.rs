//! A GPU-free Wayland client for the integration test: a solid-colour window that repaints on
//! clicks, keys and resizes, hides its cursor and locks the pointer while the left button is held
//! (as Blender does during a grab), and writes every input it receives to a log, one per line.
//!
//! usage: test_client TITLE LOG_PATH

use std::fs::File;
use std::io::Write;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};

use wayland_client::protocol::{
    wl_buffer, wl_compositor, wl_keyboard, wl_pointer, wl_registry, wl_seat, wl_shm, wl_shm_pool,
    wl_surface,
};
use wayland_client::{Connection, Dispatch, QueueHandle, WEnum, delegate_noop};
use wayland_protocols::wp::pointer_constraints::zv1::client::{
    zwp_locked_pointer_v1 as locked_pointer, zwp_pointer_constraints_v1 as pointer_constraints,
};
use wayland_protocols::wp::relative_pointer::zv1::client::{
    zwp_relative_pointer_manager_v1 as relative_manager,
    zwp_relative_pointer_v1 as relative_pointer,
};
use wayland_protocols::xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base};
use xkbcommon::xkb;

const BTN_LEFT: u32 = 272;
const COLOURS: [u32; 4] = [0xff20_4080, 0xff80_2040, 0xff40_8020, 0xffc0_c0c0];

struct Client {
    log: File,
    compositor: wl_compositor::WlCompositor,
    shm: wl_shm::WlShm,
    surface: wl_surface::WlSurface,
    cursor_surface: wl_surface::WlSurface,
    constraints: pointer_constraints::ZwpPointerConstraintsV1,
    relative: relative_manager::ZwpRelativePointerManagerV1,
    pointer: Option<wl_pointer::WlPointer>,
    locked: Option<locked_pointer::ZwpLockedPointerV1>,
    relative_pointer: Option<relative_pointer::ZwpRelativePointerV1>,
    enter_serial: u32,
    size: (i32, i32),
    colour: usize,
    configured: bool,
    xkb: Option<xkb::State>,
}

impl Client {
    fn log(&mut self, line: String) {
        let _ = writeln!(self.log, "{line}");
        let _ = self.log.flush();
    }

    fn buffer(
        &self,
        width: i32,
        height: i32,
        colour: u32,
        qh: &QueueHandle<Client>,
    ) -> wl_buffer::WlBuffer {
        let stride = width * 4;
        let size = (stride * height) as usize;
        let fd = unsafe {
            OwnedFd::from_raw_fd(libc::memfd_create(
                c"test-client".as_ptr(),
                libc::MFD_CLOEXEC,
            ))
        };
        let mut file = File::from(fd.try_clone().unwrap());
        let pixels: Vec<u8> = colour.to_le_bytes().repeat(size / 4);
        file.write_all(&pixels).unwrap();
        let pool = self.shm.create_pool(fd.as_fd(), size as i32, qh, ());
        let buffer = pool.create_buffer(0, width, height, stride, wl_shm::Format::Xrgb8888, qh, ());
        pool.destroy();
        buffer
    }

    fn draw(&mut self, qh: &QueueHandle<Client>) {
        let (width, height) = self.size;
        let buffer = self.buffer(width, height, COLOURS[self.colour % COLOURS.len()], qh);
        self.surface.attach(Some(&buffer), 0, 0);
        self.surface.damage_buffer(0, 0, width, height);
        self.surface.commit();
        self.log(format!("draw {width}x{height}"));
    }

    fn show_cursor(&self, pointer: &wl_pointer::WlPointer) {
        pointer.set_cursor(self.enter_serial, Some(&self.cursor_surface), 0, 0);
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let title = args.next().expect("TITLE");
    let log = File::options()
        .append(true)
        .open(args.next().expect("LOG_PATH"))
        .expect("log");
    let connection = Connection::connect_to_env().expect("WAYLAND_DISPLAY");
    let (globals, mut queue) =
        wayland_client::globals::registry_queue_init::<Client>(&connection).unwrap();
    let qh = queue.handle();
    let compositor: wl_compositor::WlCompositor = globals.bind(&qh, 4..=6, ()).unwrap();
    let wm: xdg_wm_base::XdgWmBase = globals.bind(&qh, 1..=1, ()).unwrap();
    let _seat: wl_seat::WlSeat = globals.bind(&qh, 1..=7, ()).unwrap();
    let surface = compositor.create_surface(&qh, ());
    let xdg = wm.get_xdg_surface(&surface, &qh, ());
    let toplevel = xdg.get_toplevel(&qh, ());
    toplevel.set_title(title);
    surface.commit();
    let cursor_surface = compositor.create_surface(&qh, ());
    let mut client = Client {
        log,
        shm: globals.bind(&qh, 1..=1, ()).unwrap(),
        constraints: globals.bind(&qh, 1..=1, ()).unwrap(),
        relative: globals.bind(&qh, 1..=1, ()).unwrap(),
        compositor,
        surface,
        cursor_surface,
        pointer: None,
        locked: None,
        relative_pointer: None,
        enter_serial: 0,
        size: (320, 240),
        colour: 0,
        configured: false,
        xkb: None,
    };
    let cursor = client.buffer(8, 8, 0xffff_ffff, &qh);
    client.cursor_surface.attach(Some(&cursor), 0, 0);
    client.cursor_surface.commit();
    let _ = &client.compositor;
    loop {
        queue.blocking_dispatch(&mut client).unwrap();
    }
}

impl Dispatch<wl_registry::WlRegistry, wayland_client::globals::GlobalListContents> for Client {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &wayland_client::globals::GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Client {
    fn event(
        _: &mut Self,
        wm: &xdg_wm_base::XdgWmBase,
        event: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = event {
            wm.pong(serial);
        }
    }
}

impl Dispatch<xdg_surface::XdgSurface, ()> for Client {
    fn event(
        client: &mut Self,
        xdg: &xdg_surface::XdgSurface,
        event: xdg_surface::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = event {
            xdg.ack_configure(serial);
            client.configured = true;
            client.draw(qh);
        }
    }
}

impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Client {
    fn event(
        client: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        event: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match event {
            xdg_toplevel::Event::Configure { width, height, .. } if width > 0 && height > 0 => {
                if (width, height) != client.size {
                    client.colour += 1;
                }
                client.size = (width, height);
            }
            xdg_toplevel::Event::Close => std::process::exit(0),
            _ => {}
        }
    }
}

impl Dispatch<wl_seat::WlSeat, ()> for Client {
    fn event(
        client: &mut Self,
        seat: &wl_seat::WlSeat,
        event: wl_seat::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(capabilities),
        } = event
        {
            if capabilities.contains(wl_seat::Capability::Pointer) && client.pointer.is_none() {
                let pointer = seat.get_pointer(qh, ());
                client.relative_pointer =
                    Some(client.relative.get_relative_pointer(&pointer, qh, ()));
                client.pointer = Some(pointer);
            }
            if capabilities.contains(wl_seat::Capability::Keyboard) {
                seat.get_keyboard(qh, ());
            }
        }
    }
}

impl Dispatch<wl_pointer::WlPointer, ()> for Client {
    fn event(
        client: &mut Self,
        pointer: &wl_pointer::WlPointer,
        event: wl_pointer::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_pointer::Event::Enter {
                serial,
                surface_x,
                surface_y,
                ..
            } => {
                client.enter_serial = serial;
                client.show_cursor(pointer);
                client.log(format!("enter {} {}", surface_x.round(), surface_y.round()));
            }
            wl_pointer::Event::Motion {
                surface_x,
                surface_y,
                ..
            } => client.log(format!(
                "motion {} {}",
                surface_x.round(),
                surface_y.round()
            )),
            wl_pointer::Event::Button {
                button,
                state: WEnum::Value(state),
                ..
            } => {
                let pressed = state == wl_pointer::ButtonState::Pressed;
                client.log(format!("button {button} {}", u8::from(pressed)));
                if button == BTN_LEFT && pressed {
                    pointer.set_cursor(client.enter_serial, None, 0, 0);
                    client.locked = Some(client.constraints.lock_pointer(
                        &client.surface,
                        pointer,
                        None,
                        pointer_constraints::Lifetime::Oneshot,
                        qh,
                        (),
                    ));
                    client.colour += 1;
                    client.draw(qh);
                } else if button == BTN_LEFT {
                    if let Some(locked) = client.locked.take() {
                        locked.destroy();
                    }
                    client.show_cursor(pointer);
                }
            }
            wl_pointer::Event::Axis {
                axis: WEnum::Value(axis),
                value,
                ..
            } => client.log(format!("axis {axis:?} {}", value.round())),
            _ => {}
        }
    }
}

impl Dispatch<relative_pointer::ZwpRelativePointerV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &relative_pointer::ZwpRelativePointerV1,
        event: relative_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let relative_pointer::Event::RelativeMotion { dx, dy, .. } = event
            && client.locked.is_some()
        {
            client.log(format!("relative {} {}", dx.round(), dy.round()));
        }
    }
}

impl Dispatch<locked_pointer::ZwpLockedPointerV1, ()> for Client {
    fn event(
        client: &mut Self,
        _: &locked_pointer::ZwpLockedPointerV1,
        event: locked_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let locked_pointer::Event::Locked = event {
            client.log("locked".into());
        }
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for Client {
    fn event(
        client: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match event {
            wl_keyboard::Event::Keymap { fd, size, .. } => {
                use std::io::Read;
                let mut text = String::with_capacity(size as usize);
                let _ = File::from(fd).read_to_string(&mut text);
                let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
                let keymap = xkb::Keymap::new_from_string(
                    &context,
                    text.trim_end_matches('\0').to_string(),
                    xkb::KEYMAP_FORMAT_TEXT_V1,
                    xkb::KEYMAP_COMPILE_NO_FLAGS,
                );
                client.xkb = keymap.map(|keymap| xkb::State::new(&keymap));
            }
            wl_keyboard::Event::Modifiers {
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
                ..
            } => {
                if let Some(state) = client.xkb.as_mut() {
                    state.update_mask(mods_depressed, mods_latched, mods_locked, 0, 0, group);
                }
            }
            wl_keyboard::Event::Key {
                key,
                state: WEnum::Value(state),
                ..
            } => {
                let pressed = state == wl_keyboard::KeyState::Pressed;
                let name = client
                    .xkb
                    .as_ref()
                    .map(|xkb| xkb::keysym_get_name(xkb.key_get_one_sym((key + 8).into())))
                    .unwrap_or_default();
                client.log(format!("key {key} {} {name}", u8::from(pressed)));
                if pressed {
                    client.colour += 1;
                    client.draw(qh);
                }
            }
            _ => {}
        }
    }
}

delegate_noop!(Client: ignore wl_compositor::WlCompositor);
delegate_noop!(Client: ignore wl_shm::WlShm);
delegate_noop!(Client: ignore wl_shm_pool::WlShmPool);
delegate_noop!(Client: ignore wl_buffer::WlBuffer);
delegate_noop!(Client: ignore wl_surface::WlSurface);
delegate_noop!(Client: ignore pointer_constraints::ZwpPointerConstraintsV1);
delegate_noop!(Client: ignore relative_manager::ZwpRelativePointerManagerV1);
