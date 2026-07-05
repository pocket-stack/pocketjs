use glam::Vec3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SoundHandle(pub u32);

pub trait AudioBackend {
    fn play_2d(&mut self, sound: SoundHandle, volume: f32);
    fn play_3d(&mut self, sound: SoundHandle, pos: Vec3, volume: f32);
    fn set_listener(&mut self, pos: Vec3, forward: Vec3, up: Vec3);
}

#[derive(Default)]
pub struct NullAudio {
    pub events: Vec<String>,
}

impl AudioBackend for NullAudio {
    fn play_2d(&mut self, sound: SoundHandle, volume: f32) {
        self.events.push(format!("play_2d:{}:{volume:.2}", sound.0));
    }

    fn play_3d(&mut self, sound: SoundHandle, pos: Vec3, volume: f32) {
        self.events.push(format!(
            "play_3d:{}:{:.1},{:.1},{:.1}:{volume:.2}",
            sound.0, pos.x, pos.y, pos.z
        ));
    }

    fn set_listener(&mut self, pos: Vec3, forward: Vec3, up: Vec3) {
        self.events.push(format!(
            "listener:{:.1},{:.1},{:.1}:{:.2},{:.2},{:.2}:{:.2},{:.2},{:.2}",
            pos.x, pos.y, pos.z, forward.x, forward.y, forward.z, up.x, up.y, up.z
        ));
    }
}
