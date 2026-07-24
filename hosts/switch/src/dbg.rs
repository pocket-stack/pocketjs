use alloc::string::String;

pub fn active() -> bool {
    false
}

pub fn poll() -> Option<String> {
    None
}

pub fn send(_bytes: &[u8]) {}

pub fn shot() -> bool {
    false
}
