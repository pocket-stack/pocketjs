use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScriptConfigError {
    #[error("TOML parse error: {0}")]
    Toml(#[from] toml::de::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeaponConfig {
    pub id: String,
    pub display_name: String,
    pub damage: f32,
    pub fire_interval_ms: u32,
    pub magazine_size: u32,
    pub reload_ms: u32,
    pub range: f32,
    pub spread_degrees: f32,
    pub headshot_multiplier: f32,
}

impl Default for WeaponConfig {
    fn default() -> Self {
        Self {
            id: "os_rifle".to_string(),
            display_name: "OS Rifle".to_string(),
            damage: 35.0,
            fire_interval_ms: 120,
            magazine_size: 30,
            reload_ms: 1800,
            range: 4096.0,
            spread_degrees: 0.5,
            headshot_multiplier: 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundConfig {
    pub pre_round_ms: u32,
    pub intermission_ms: u32,
    pub player_health: i32,
    pub bot_health: i32,
}

impl Default for RoundConfig {
    fn default() -> Self {
        Self {
            pre_round_ms: 1000,
            intermission_ms: 3000,
            player_health: 100,
            bot_health: 100,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub speed: f32,
    pub capsule_radius: f32,
    pub capsule_height: f32,
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            speed: 120.0,
            capsule_radius: 16.0,
            capsule_height: 72.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OpenStrikeConfig {
    #[serde(default)]
    pub weapon: WeaponConfig,
    #[serde(default)]
    pub round: RoundConfig,
    #[serde(default)]
    pub bot: BotConfig,
}

pub fn parse_config(toml_text: &str) -> Result<OpenStrikeConfig, ScriptConfigError> {
    Ok(toml::from_str(toml_text)?)
}
