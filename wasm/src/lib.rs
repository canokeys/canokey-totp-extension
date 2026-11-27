use std::alloc::{alloc, dealloc, Layout};

pub use canokey_c::*;

#[no_mangle]
pub extern "C" fn cnk_wasm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return std::ptr::null_mut();
    }
    let Ok(layout) = Layout::from_size_align(size, 8) else {
        return std::ptr::null_mut();
    };
    unsafe { alloc(layout) }
}

#[no_mangle]
pub unsafe extern "C" fn cnk_wasm_free(pointer: *mut u8, size: usize) {
    if pointer.is_null() || size == 0 {
        return;
    }
    if let Ok(layout) = Layout::from_size_align(size, 8) {
        dealloc(pointer, layout);
    }
}

#[no_mangle]
pub unsafe extern "C" fn cnk_wasm_zero(pointer: *mut u8, size: usize) {
    if !pointer.is_null() {
        std::ptr::write_bytes(pointer, 0, size);
    }
}
