//! Optional host-side audio playlist for Stage packages.
//!
//! Pocket apps stay portable: the guest exchanges small JSON intents and
//! status lines through the existing svc mailbox, while the macOS host owns
//! files, decoding and the audio device. The first backend deliberately uses
//! the OS `afplay` service, so paused widgets have no audio callback and no
//! additional decoder dependency in the generic renderer.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, ensure};
use serde_json::{Value, json};

use crate::device::{MediaSettings, MediaTrack};

const STATUS_INTERVAL_TICKS: u64 = 15;

pub struct MediaService {
    tracks: Vec<MediaTrack>,
    index: usize,
    child: Option<Child>,
    playing: bool,
    position_before_segment: Duration,
    segment_started: Option<Instant>,
    dirty: bool,
    last_status_tick: u64,
    error: Option<String>,
    player_program: PathBuf,
}

impl MediaService {
    pub fn new(settings: MediaSettings) -> Result<Self> {
        Self::new_with_player(settings, PathBuf::from("/usr/bin/afplay"))
    }

    fn new_with_player(settings: MediaSettings, player_program: PathBuf) -> Result<Self> {
        ensure!(
            settings.service == "audio-playlist@1",
            "unsupported media adapter {}",
            settings.service
        );
        ensure!(
            !settings.channel.trim().is_empty(),
            "media service channel is empty"
        );
        ensure!(!settings.tracks.is_empty(), "media playlist is empty");
        for track in &settings.tracks {
            ensure!(
                track.path.is_file(),
                "missing media track {} ({})",
                track.id,
                track.path.display()
            );
        }
        Ok(Self {
            tracks: settings.tracks,
            index: 0,
            child: None,
            playing: false,
            position_before_segment: Duration::ZERO,
            segment_started: None,
            dirty: true,
            last_status_tick: 0,
            error: None,
            player_program,
        })
    }

    /// Exact guest → host namespace discriminator used by the selective svc
    /// drain. Invalid JSON and every other namespace remain available to the
    /// adapters that run after media; the Stage's final router then bounds
    /// truly unhandled traffic by draining it with rate-limited diagnostics.
    pub fn is_guest_line(line: &str) -> bool {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("t").and_then(Value::as_str).map(str::to_owned))
            .is_some_and(|kind| kind == "media")
    }

    pub fn hello_line(&self) -> String {
        let tracks: Vec<Value> = self
            .tracks
            .iter()
            .map(|track| {
                json!({
                    "id": track.id,
                    "title": track.title,
                    "artist": track.artist,
                    "durationMs": track.duration_ms,
                })
            })
            .collect();
        let track = self.current();
        json!({
            "t": "media.hello",
            "tracks": tracks,
            "index": self.index,
            "playing": self.playing,
            "positionMs": self.position().as_millis() as u64,
            "durationMs": track.duration_ms,
        })
        .to_string()
    }

    pub fn tick(&mut self, tick: u64) -> Option<String> {
        if let Err(error) = self.advance_if_finished() {
            self.fail(error);
        }
        let periodic =
            self.playing && tick.saturating_sub(self.last_status_tick) >= STATUS_INTERVAL_TICKS;
        if !self.dirty && !periodic {
            return None;
        }
        self.dirty = false;
        self.last_status_tick = tick;
        Some(self.state_line())
    }

    pub fn handle_guest_line(&mut self, line: &str) -> Result<bool> {
        let value: Value = serde_json::from_str(line).context("invalid media svc JSON")?;
        if value["t"].as_str() != Some("media") {
            return Ok(false);
        }
        // Reap a naturally completed afplay before interpreting this turn's
        // command. Otherwise a same-tick toggle/pause observes the stale child
        // and signals a process that has already exited.
        if let Err(error) = self.advance_if_finished() {
            self.fail(error);
        }
        let op = value["op"]
            .as_str()
            .ok_or_else(|| anyhow!("media intent is missing op"))?;
        let result = match op {
            "play" => {
                let index = value["index"].as_u64().map(|index| index as usize);
                self.play(index)
            }
            "toggle" => self.toggle(),
            "pause" => self.pause(),
            "resume" => self.resume(),
            "next" => self.skip(1),
            "previous" => self.skip(-1),
            other => Err(anyhow!("unknown media op {other:?}")),
        };
        if let Err(error) = result {
            self.fail(error);
        }
        Ok(true)
    }

    fn current(&self) -> &MediaTrack {
        &self.tracks[self.index]
    }

    fn state_line(&self) -> String {
        let mut value = json!({
            "t": "media.state",
            "index": self.index,
            "playing": self.playing,
            "positionMs": self.position().as_millis() as u64,
            "durationMs": self.current().duration_ms,
        });
        if let Some(error) = &self.error {
            value["error"] = Value::String(error.clone());
        }
        value.to_string()
    }

    fn position(&self) -> Duration {
        let elapsed = self
            .segment_started
            .map(|started| started.elapsed())
            .unwrap_or(Duration::ZERO);
        (self.position_before_segment + elapsed)
            .min(Duration::from_millis(self.current().duration_ms))
    }

    fn play(&mut self, index: Option<usize>) -> Result<()> {
        let index = index.unwrap_or(self.index);
        ensure!(
            index < self.tracks.len(),
            "media track index {index} is out of range"
        );
        self.stop_child();
        self.index = index;
        self.position_before_segment = Duration::ZERO;
        self.spawn_current()
    }

    fn spawn_current(&mut self) -> Result<()> {
        let path = self.current().path.clone();
        log::info!(
            "pocket-stage media: playing {} — {} ({})",
            self.current().title,
            self.current().artist,
            path.display()
        );
        let child = Command::new(&self.player_program)
            .arg(&path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("starting afplay for {}", path.display()))?;
        self.child = Some(child);
        self.playing = true;
        self.segment_started = Some(Instant::now());
        self.error = None;
        self.dirty = true;
        Ok(())
    }

    fn toggle(&mut self) -> Result<()> {
        if self.child.is_none() {
            self.spawn_current()
        } else if self.playing {
            self.pause()
        } else {
            self.resume()
        }
    }

    fn pause(&mut self) -> Result<()> {
        let Some(child) = &self.child else {
            return Ok(());
        };
        if !self.playing {
            return Ok(());
        }
        signal(child.id(), "STOP")?;
        self.position_before_segment = self.position();
        self.segment_started = None;
        self.playing = false;
        self.dirty = true;
        Ok(())
    }

    fn resume(&mut self) -> Result<()> {
        let Some(child) = &self.child else {
            return self.spawn_current();
        };
        if self.playing {
            return Ok(());
        }
        signal(child.id(), "CONT")?;
        self.segment_started = Some(Instant::now());
        self.playing = true;
        self.error = None;
        self.dirty = true;
        Ok(())
    }

    fn skip(&mut self, direction: isize) -> Result<()> {
        let count = self.tracks.len() as isize;
        let next = (self.index as isize + direction).rem_euclid(count) as usize;
        let should_play = self.playing;
        self.stop_child();
        self.index = next;
        self.position_before_segment = Duration::ZERO;
        self.error = None;
        self.dirty = true;
        if should_play {
            self.spawn_current()?;
        }
        Ok(())
    }

    fn advance_if_finished(&mut self) -> Result<()> {
        let Some(child) = self.child.as_mut() else {
            return Ok(());
        };
        let Some(status) = child.try_wait().context("polling afplay")? else {
            return Ok(());
        };
        self.child = None;
        self.segment_started = None;
        self.position_before_segment = Duration::ZERO;
        if !status.success() {
            self.playing = false;
            return Err(anyhow!("afplay exited with {status}"));
        }
        // A SIGSTOP'd child cannot exit, so a successful exit always means the
        // track truly finished — even when a pause raced the natural end and
        // `playing` is already false. Advance either way; only keep playing
        // (spawn the next track) when the user still expects audio.
        self.index = (self.index + 1) % self.tracks.len();
        if self.playing {
            self.spawn_current()?;
        }
        self.dirty = true;
        Ok(())
    }

    fn stop_child(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.playing = false;
        self.segment_started = None;
    }

    fn fail(&mut self, error: anyhow::Error) {
        log::warn!("pocket-stage media: {error:#}");
        self.stop_child();
        // The guest receives metadata and playback state only — the full
        // error chain (which may name host filesystem paths) stays in the
        // host log above.
        self.error = Some("playback failed".into());
        self.dirty = true;
    }
}

impl Drop for MediaService {
    fn drop(&mut self) {
        self.stop_child();
    }
}

fn signal(pid: u32, name: &str) -> Result<()> {
    let status = Command::new("/bin/kill")
        .arg(format!("-{name}"))
        .arg(pid.to_string())
        .status()
        .with_context(|| format!("sending SIG{name} to afplay"))?;
    ensure!(status.success(), "SIG{name} failed for afplay pid {pid}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(track_count: usize) -> MediaSettings {
        MediaSettings {
            service: "audio-playlist@1".into(),
            channel: "test-media".into(),
            tracks: (0..track_count)
                .map(|index| MediaTrack {
                    id: format!("test-{index}"),
                    title: format!("Test {index}"),
                    artist: "Pocket".into(),
                    path: std::env::current_exe().unwrap(),
                    duration_ms: 1000,
                })
                .collect(),
        }
    }

    fn service_with_finished_child() -> MediaService {
        // `yes` accepts the appended media path and stays alive until the
        // service pauses/kills it; unlike a shell wrapper it cannot orphan a
        // helper process during Drop.
        let mut media =
            MediaService::new_with_player(settings(2), PathBuf::from("/usr/bin/yes")).unwrap();
        let mut finished = Command::new("/usr/bin/true")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(finished.wait().unwrap().success());
        media.child = Some(finished);
        media.playing = true;
        media.segment_started = Some(Instant::now());
        media
    }

    #[test]
    fn ignores_non_media_service_lines() {
        let mut media = MediaService::new(settings(1)).unwrap();
        assert!(!media.handle_guest_line(r#"{"t":"other"}"#).unwrap());
    }

    #[test]
    fn media_namespace_filter_is_exact_and_requires_valid_json() {
        assert!(MediaService::is_guest_line(r#"{"t":"media","op":"pause"}"#));
        assert!(!MediaService::is_guest_line(r#"{"t":"media.state"}"#));
        assert!(!MediaService::is_guest_line(r#"{"t":"other"}"#));
        assert!(!MediaService::is_guest_line("not json"));
    }

    #[test]
    fn same_tick_pause_reaps_natural_finish_before_signalling() {
        let mut media = service_with_finished_child();
        assert!(
            media
                .handle_guest_line(r#"{"t":"media","op":"pause"}"#)
                .unwrap()
        );
        assert_eq!(media.index, 1, "natural completion advances first");
        assert!(!media.playing, "pause applies to the newly started track");
        assert!(media.child.is_some());
        assert!(media.error.is_none());
    }

    #[test]
    fn natural_finish_that_raced_a_pause_still_advances() {
        // A pause can land on the zombie of a track that just ended: the STOP
        // succeeds, `playing` flips false, and only then does the reap run. A
        // stopped child can never exit on its own, so a successful exit must
        // advance the playlist (paused, at the next track) instead of pinning
        // the UI to "paused at 0:00" of a track that actually completed.
        let mut media = service_with_finished_child();
        media.playing = false;
        let _ = media.tick(0);
        assert_eq!(media.index, 1, "the finished track still advances");
        assert!(!media.playing, "the user's pause intent is preserved");
        assert!(media.child.is_none(), "nothing new is spawned while paused");
        assert!(media.error.is_none());
    }

    #[test]
    fn same_tick_toggle_reaps_natural_finish_before_signalling() {
        let mut media = service_with_finished_child();
        assert!(
            media
                .handle_guest_line(r#"{"t":"media","op":"toggle"}"#)
                .unwrap()
        );
        assert_eq!(media.index, 1, "natural completion advances first");
        assert!(!media.playing, "toggle pauses the newly started track");
        assert!(media.child.is_some());
        assert!(media.error.is_none());
    }
}
