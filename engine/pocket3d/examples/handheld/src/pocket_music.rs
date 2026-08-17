//! Pocket Music's bounded bridge to the per-user macOS daemon.
//!
//! The PocketJS guest sees only its declared svc channel. The stage owns the
//! Unix socket, validates both directions, and reconnects without blocking the
//! fixed-rate guest turn when the daemon is restarted.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;

use anyhow::{Result, anyhow, ensure};
use serde_json::{Value, json};

use crate::device::CompanionSettings;

const RECONNECT_TICKS: u64 = 30;
const MAX_LINE_BYTES: usize = 64 * 1024;

pub struct PocketMusicService {
    socket_path: PathBuf,
    stream: Option<UnixStream>,
    read_buffer: Vec<u8>,
    writes: VecDeque<Vec<u8>>,
    last_connect_tick: Option<u64>,
    connection_announced: bool,
}

impl PocketMusicService {
    pub fn new(settings: CompanionSettings) -> Result<Self> {
        ensure!(
            settings.service == "pocket-music@1",
            "unsupported Pocket Music companion {}",
            settings.service
        );
        Ok(Self {
            socket_path: socket_path(),
            stream: None,
            read_buffer: Vec::new(),
            writes: VecDeque::new(),
            last_connect_tick: None,
            connection_announced: false,
        })
    }

    pub fn is_guest_line(line: &str) -> bool {
        serde_json::from_str::<Value>(line)
            .ok()
            .and_then(|value| value.get("t").and_then(Value::as_str).map(str::to_owned))
            .is_some_and(|kind| kind == "pocket-music.command")
    }

    pub fn disconnected_line(&self) -> String {
        json!({
            "t": "pocket-music.state",
            "daemonConnected": false,
            "deviceConnected": false,
            "playerRunning": false,
            "playing": false,
            "positionMs": 0,
            "volume": 0,
            "sequence": 0,
        })
        .to_string()
    }

    pub fn handle_guest_line(&mut self, line: &str) -> Result<bool> {
        let value: Value = serde_json::from_str(line)?;
        if value["t"].as_str() != Some("pocket-music.command") {
            return Ok(false);
        }
        let op = value["op"]
            .as_str()
            .ok_or_else(|| anyhow!("Pocket Music command is missing op"))?;
        ensure!(
            matches!(
                op,
                "toggle" | "next" | "previous" | "stop" | "mute" | "volume-up" | "volume-down"
            ),
            "unsupported Pocket Music command {op:?}"
        );
        ensure!(
            value.as_object().is_some_and(|object| object.len() == 2),
            "Pocket Music command contains unsupported fields"
        );
        let mut wire = line.as_bytes().to_vec();
        wire.push(b'\n');
        ensure!(
            wire.len() <= MAX_LINE_BYTES,
            "Pocket Music command is too large"
        );
        self.writes.push_back(wire);
        Ok(true)
    }

    /// Advance the nonblocking connection and return validated daemon lines.
    pub fn tick(&mut self, tick: u64) -> Vec<String> {
        let mut messages = Vec::new();
        if self.stream.is_none()
            && self
                .last_connect_tick
                .is_none_or(|last| tick.saturating_sub(last) >= RECONNECT_TICKS)
        {
            self.last_connect_tick = Some(tick);
            match UnixStream::connect(&self.socket_path) {
                Ok(stream) => {
                    if let Err(error) = stream.set_nonblocking(true) {
                        log::warn!("Pocket Music socket cannot become nonblocking: {error}");
                    } else {
                        self.stream = Some(stream);
                        self.read_buffer.clear();
                        self.connection_announced = true;
                        messages.push(
                            json!({
                                "t": "pocket-music.connection",
                                "daemonConnected": true,
                            })
                            .to_string(),
                        );
                    }
                }
                Err(error)
                    if error.kind() == ErrorKind::NotFound
                        || error.kind() == ErrorKind::ConnectionRefused => {}
                Err(error) => log::warn!(
                    "Pocket Music daemon connection {} failed: {error}",
                    self.socket_path.display()
                ),
            }
        }

        if self.stream.is_some() {
            if let Err(error) = self.flush_writes() {
                log::warn!("Pocket Music daemon write failed: {error}");
                self.disconnect(&mut messages);
                return messages;
            }
            if let Err(error) = self.read_lines(&mut messages) {
                log::warn!("Pocket Music daemon read failed: {error}");
                self.disconnect(&mut messages);
            }
        }
        messages
    }

    fn flush_writes(&mut self) -> std::io::Result<()> {
        let Some(stream) = self.stream.as_mut() else {
            return Ok(());
        };
        while let Some(front) = self.writes.front_mut() {
            match stream.write(front) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        ErrorKind::WriteZero,
                        "daemon socket closed",
                    ));
                }
                Ok(written) => {
                    front.drain(..written);
                    if front.is_empty() {
                        self.writes.pop_front();
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn read_lines(&mut self, messages: &mut Vec<String>) -> std::io::Result<()> {
        let Some(stream) = self.stream.as_mut() else {
            return Ok(());
        };
        let mut chunk = [0_u8; 4096];
        loop {
            match stream.read(&mut chunk) {
                Ok(0) => {
                    return Err(std::io::Error::new(
                        ErrorKind::UnexpectedEof,
                        "daemon socket closed",
                    ));
                }
                Ok(read) => {
                    self.read_buffer.extend_from_slice(&chunk[..read]);
                    if self.read_buffer.len() > MAX_LINE_BYTES {
                        return Err(std::io::Error::new(
                            ErrorKind::InvalidData,
                            "daemon line is too large",
                        ));
                    }
                    while let Some(newline) =
                        self.read_buffer.iter().position(|byte| *byte == b'\n')
                    {
                        let line = self.read_buffer.drain(..=newline).collect::<Vec<_>>();
                        let line = std::str::from_utf8(&line[..line.len() - 1])
                            .map_err(|error| std::io::Error::new(ErrorKind::InvalidData, error))?;
                        if valid_daemon_line(line) {
                            messages.push(line.to_owned());
                        } else {
                            log::warn!("Pocket Music daemon sent an invalid message");
                        }
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn disconnect(&mut self, messages: &mut Vec<String>) {
        self.stream = None;
        self.read_buffer.clear();
        if self.connection_announced {
            self.connection_announced = false;
            messages.push(self.disconnected_line());
        }
    }
}

fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("POCKET_MUSIC_SOCKET") {
        return PathBuf::from(path);
    }
    let base = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("Library/Application Support/Pocket Music/pocket-music.sock")
}

fn valid_daemon_line(line: &str) -> bool {
    if line.len() > MAX_LINE_BYTES {
        return false;
    }
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|value| value.get("t").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|kind| {
            matches!(
                kind.as_str(),
                "pocket-music.state" | "pocket-music.input" | "pocket-music.connection"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service() -> PocketMusicService {
        PocketMusicService::new(CompanionSettings {
            service: "pocket-music@1".into(),
            channel: "pocket-music".into(),
        })
        .unwrap()
    }

    #[test]
    fn command_filter_is_exact_and_bounded() {
        let mut service = service();
        assert!(PocketMusicService::is_guest_line(
            r#"{"t":"pocket-music.command","op":"toggle"}"#
        ));
        assert!(!PocketMusicService::is_guest_line(
            r#"{"t":"pocket-music.state"}"#
        ));
        assert!(
            service
                .handle_guest_line(r#"{"t":"pocket-music.command","op":"next"}"#)
                .unwrap()
        );
        assert_eq!(
            service.writes.pop_front().unwrap(),
            b"{\"t\":\"pocket-music.command\",\"op\":\"next\"}\n"
        );
        assert!(
            service
                .handle_guest_line(r#"{"t":"pocket-music.command","op":"volume","delta":99}"#)
                .is_err()
        );
    }

    #[test]
    fn daemon_namespace_is_not_an_open_json_pipe() {
        assert!(valid_daemon_line(
            r#"{"t":"pocket-music.state","volume":50}"#
        ));
        assert!(!valid_daemon_line(r#"{"t":"media.state"}"#));
        assert!(!valid_daemon_line("not json"));
    }
}
