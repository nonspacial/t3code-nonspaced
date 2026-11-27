//! Just enough libgbm to allocate DMABuf capture targets on the compositor's render node.

use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::rc::Rc;

#[repr(C)]
struct RawDevice(u8);
#[repr(C)]
struct RawBo(u8);

#[link(name = "gbm")]
unsafe extern "C" {
    fn gbm_create_device(fd: i32) -> *mut RawDevice;
    fn gbm_device_destroy(device: *mut RawDevice);
    fn gbm_bo_create_with_modifiers2(
        device: *mut RawDevice,
        width: u32,
        height: u32,
        format: u32,
        modifiers: *const u64,
        count: u32,
        flags: u32,
    ) -> *mut RawBo;
    fn gbm_bo_get_fd(bo: *mut RawBo) -> i32;
    fn gbm_bo_get_stride_for_plane(bo: *mut RawBo, plane: i32) -> u32;
    fn gbm_bo_get_offset(bo: *mut RawBo, plane: i32) -> u32;
    fn gbm_bo_get_modifier(bo: *mut RawBo) -> u64;
    fn gbm_bo_get_plane_count(bo: *mut RawBo) -> i32;
    fn gbm_bo_destroy(bo: *mut RawBo);
}

const GBM_BO_USE_RENDERING: u32 = 1 << 2;

/// Buffers share ownership of the device: destroying a GBM device before its buffers crashes
/// NVIDIA's allocator when they are freed.
pub struct Device(Rc<DeviceHandle>);

struct DeviceHandle {
    raw: *mut RawDevice,
    _node: File,
}

impl Device {
    /// Opens the render node whose device number the capture session advertised.
    pub fn open(dev: u64) -> Option<Device> {
        let node = std::fs::read_dir("/dev/dri")
            .ok()?
            .flatten()
            .find(|entry| {
                entry.file_name().to_string_lossy().starts_with("renderD")
                    && entry
                        .metadata()
                        .is_ok_and(|metadata| metadata.rdev() == dev)
            })?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(node.path())
            .ok()?;
        let raw = unsafe { gbm_create_device(file.as_raw_fd()) };
        (!raw.is_null()).then(|| Device(Rc::new(DeviceHandle { raw, _node: file })))
    }

    /// Allocates a single-plane buffer with one of the offered modifiers.
    pub fn allocate(
        &self,
        width: u32,
        height: u32,
        format: u32,
        modifiers: &[u64],
    ) -> Option<(Bo, Plane)> {
        if modifiers.is_empty() {
            return None;
        }
        let raw = unsafe {
            gbm_bo_create_with_modifiers2(
                self.0.raw,
                width,
                height,
                format,
                modifiers.as_ptr(),
                modifiers.len() as u32,
                GBM_BO_USE_RENDERING,
            )
        };
        if raw.is_null() {
            return None;
        }
        let bo = Bo {
            raw,
            _device: self.0.clone(),
        };
        if unsafe { gbm_bo_get_plane_count(raw) } != 1 {
            return None;
        }
        let fd = unsafe { gbm_bo_get_fd(raw) };
        if fd < 0 {
            return None;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd) };
        let size = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) };
        let plane = Plane {
            fd,
            size: size.max(0) as usize,
            stride: unsafe { gbm_bo_get_stride_for_plane(raw, 0) },
            offset: unsafe { gbm_bo_get_offset(raw, 0) },
            modifier: unsafe { gbm_bo_get_modifier(raw) },
        };
        Some((bo, plane))
    }
}

impl Drop for DeviceHandle {
    fn drop(&mut self) {
        unsafe { gbm_device_destroy(self.raw) };
    }
}

pub struct Plane {
    pub fd: OwnedFd,
    pub size: usize,
    pub stride: u32,
    pub offset: u32,
    pub modifier: u64,
}

pub struct Bo {
    raw: *mut RawBo,
    _device: Rc<DeviceHandle>,
}

impl Drop for Bo {
    fn drop(&mut self) {
        unsafe { gbm_bo_destroy(self.raw) };
    }
}
