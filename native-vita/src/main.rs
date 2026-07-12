#[cfg(not(feature = "capture"))]
use pocketjs_vita::input;
use pocketjs_vita::{graphics, vita_log, Runtime};

static APP_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/game.js"));
static APP_PAK: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/app.pak"));

#[cfg(feature = "capture")]
static CAPTURE_INPUT: &str = env!("POCKETJS_CAPTURE_INPUT");
#[cfg(feature = "capture")]
static CAPTURE_FRAMES: &str = env!("POCKETJS_CAPTURE_FRAMES");
#[cfg(feature = "capture")]
static CAPTURE_DIR: &str = env!("POCKETJS_CAPTURE_DIR");

#[no_mangle]
#[used]
pub static sceUserMainThreadStackSize: u32 = 2 * 1024 * 1024;

#[cfg(feature = "capture")]
fn scripted_buttons(frame: u32) -> i32 {
    let mut buttons = 0;
    let mut latest = None;
    for item in CAPTURE_INPUT.split(',') {
        let Some((at, mask)) = item.split_once(':') else {
            continue;
        };
        let Some(at) = at.parse::<u32>().ok().filter(|at| *at <= frame) else {
            continue;
        };
        if latest.is_none_or(|previous| at >= previous) {
            latest = Some(at);
            buttons = if let Some(hex) = mask.strip_prefix("0x") {
                i32::from_str_radix(hex, 16).unwrap_or(0)
            } else {
                mask.parse::<i32>().unwrap_or(0)
            };
        }
    }
    buttons
}

#[cfg(feature = "capture")]
fn capture_frames() -> Vec<u32> {
    CAPTURE_FRAMES
        .split(',')
        .filter_map(|value| value.parse::<u32>().ok())
        .collect()
}

fn fail(message: &str) -> ! {
    vita_log(format_args!("[PocketJS Vita] {message}"));
    #[cfg(feature = "capture")]
    {
        let _ = std::fs::create_dir_all(CAPTURE_DIR);
        let _ = std::fs::write(format!("{CAPTURE_DIR}/error.txt"), message);
    }
    loop {
        std::thread::yield_now();
    }
}

fn main() {
    unsafe {
        let mut runtime = Runtime::new(APP_PAK).unwrap_or_else(|error| fail(&error));
        runtime.eval(APP_JS).unwrap_or_else(|error| fail(&error));

        #[cfg(feature = "capture")]
        let wanted = capture_frames();
        #[cfg(feature = "capture")]
        let last_capture = wanted.iter().copied().max().unwrap_or(0);

        let mut frame = 0u32;
        loop {
            #[cfg(feature = "capture")]
            let (buttons, analog, touches) = (
                scripted_buttons(frame),
                pocketjs_core::spec::ANALOG_CENTER as i32,
                pocketjs_vita::input::TouchSnapshot::EMPTY,
            );
            #[cfg(not(feature = "capture"))]
            let (buttons, analog, touches) = {
                let pad = input::read();
                (pad.buttons as i32, pad.left_analog(), input::read_touches())
            };

            runtime
                .frame_with_input(buttons, analog, &touches)
                .unwrap_or_else(|error| fail(&error));
            runtime.tick();
            runtime.render();

            graphics::present();

            #[cfg(feature = "capture")]
            if wanted.contains(&frame) {
                let path = format!("{CAPTURE_DIR}/f{frame:04}.rgba");
                runtime
                    .capture_golden(&path)
                    .unwrap_or_else(|error| fail(&error.to_string()));
            }

            #[cfg(feature = "capture")]
            if frame >= last_capture {
                let _ = std::fs::create_dir_all(CAPTURE_DIR);
                let _ = std::fs::write(format!("{CAPTURE_DIR}/done"), b"ok\n");
                // Vita3K 0.2.1/macOS can fault while tearing down GXM from
                // sceKernelExitProcess. The E2E host owns process lifetime:
                // leave the completed guest parked after publishing `done`,
                // then let the driver terminate the emulator cleanly.
                loop {
                    std::thread::yield_now();
                }
            }

            frame = frame.wrapping_add(1);
        }
    }
}
