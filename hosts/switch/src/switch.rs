use alloc::string::String;

use pocketjs_core::Ui;

pub fn multi() -> bool {
    false
}

pub fn find(_output: &str) -> Option<usize> {
    None
}

pub unsafe fn request_launch(_index: usize) {}

pub unsafe fn table_json() -> String {
    String::from("{\"apps\":[]}")
}

pub unsafe fn shot_handle() -> i32 {
    -1
}

pub unsafe fn upload_shot(_ui: &mut Ui) {}
