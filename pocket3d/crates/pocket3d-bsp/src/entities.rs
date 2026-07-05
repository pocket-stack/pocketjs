//! Entity lump: a text blob of `{ "key" "value" ... }` blocks.

use std::collections::HashMap;

use glam::Vec3;

use crate::raw::q2y;

#[derive(Clone, Debug, Default)]
pub struct Entity {
    pub kv: HashMap<String, String>,
}

impl Entity {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.kv.get(key).map(String::as_str)
    }

    pub fn classname(&self) -> &str {
        self.get("classname").unwrap_or("")
    }

    /// Origin converted to Y-up space.
    pub fn origin(&self) -> Option<Vec3> {
        let raw = self.get("origin")?;
        let mut it = raw.split_ascii_whitespace().map(|s| s.parse::<f32>());
        let x = it.next()?.ok()?;
        let y = it.next()?.ok()?;
        let z = it.next()?.ok()?;
        Some(q2y(Vec3::new(x, y, z)))
    }

    /// Quake yaw in degrees (key "angle", or the second component of
    /// "angles"), converted to a Pocket3D camera yaw in radians.
    pub fn yaw(&self) -> Option<f32> {
        let deg = if let Some(a) = self.get("angle") {
            a.parse::<f32>().ok()?
        } else {
            let angles = self.get("angles")?;
            angles
                .split_ascii_whitespace()
                .nth(1)?
                .parse::<f32>()
                .ok()?
        };
        Some(quake_yaw_to_pocket(deg))
    }

    /// The `*N` brush-model index this entity points at, if any.
    pub fn brush_model(&self) -> Option<usize> {
        let m = self.get("model")?;
        m.strip_prefix('*')?.parse().ok()
    }
}

/// Quake yaw (degrees CCW from +X east, around +Z up) to Pocket3D yaw
/// (radians around +Y, 0 = -Z).
pub fn quake_yaw_to_pocket(deg: f32) -> f32 {
    let rad = deg.to_radians();
    (-rad.cos()).atan2(rad.sin())
}

pub fn parse_entities(text: &str) -> Vec<Entity> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '{' {
            continue;
        }
        let mut ent = Entity::default();
        loop {
            // Scan to a quote, a closing brace, or EOF.
            let mut key = None;
            loop {
                match chars.next() {
                    Some('"') => {
                        let mut s = String::new();
                        for q in chars.by_ref() {
                            if q == '"' {
                                break;
                            }
                            s.push(q);
                        }
                        key = Some(s);
                        break;
                    }
                    Some('}') | None => break,
                    Some(_) => {}
                }
            }
            let Some(key) = key else { break };
            // Value string.
            let mut value = String::new();
            let mut in_value = false;
            for q in chars.by_ref() {
                if q == '"' {
                    if in_value {
                        break;
                    }
                    in_value = true;
                } else if in_value {
                    value.push(q);
                }
            }
            ent.kv.insert(key, value);
        }
        if !ent.kv.is_empty() {
            out.push(ent);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blocks() {
        let src = r#"
{
"classname" "worldspawn"
"wad" "\half-life\cstrike\cs_dust.wad;\half-life\valve\halflife.wad"
}
{
"classname" "info_player_start"
"origin" "160 -96 64"
"angle" "90"
}
"#;
        let ents = parse_entities(src);
        assert_eq!(ents.len(), 2);
        assert_eq!(ents[0].classname(), "worldspawn");
        let spawn = &ents[1];
        // Quake (160, -96, 64) -> Y-up (160, 64, 96).
        assert_eq!(spawn.origin(), Some(Vec3::new(160.0, 64.0, 96.0)));
        // Quake yaw 90 deg = +Y north -> Y-up -Z, which is pocket yaw 0.
        let yaw = spawn.yaw().unwrap();
        assert!(yaw.abs() < 1e-5, "yaw was {yaw}");
    }
}
