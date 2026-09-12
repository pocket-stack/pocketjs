//! Device-side admission of a package's `ResolvedBuildPlan` against the host's
//! target contract.
//!
//! A native shell bakes its contract at build time — target id, host ABI, the
//! surfaces it presents and the capability list of its target registry entry
//! (tools/target-contract.ts renders it as C). Before a `.pocket` replaces the
//! running guest, the plan section is read structurally against that contract;
//! nothing in it is evaluated. Only canonical JSON matches: an escaped string,
//! a non-integer number or a duplicate key never equals a contract value, so a
//! crafted plan cannot pass by spelling a value differently from the desktop
//! resolver (framework/src/manifest/resolve.ts).

use alloc::vec::Vec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanError {
    /// Not one JSON object, malformed, or nested beyond the reader's limit.
    Syntax,
    Target,
    HostAbi,
    Viewport,
    Presentation,
    Surfaces,
    HostExtension,
    Features,
}

/// One presented surface, as the shell laid it out at build time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SurfaceContract<'a> {
    pub logical: [u32; 2],
    pub physical: [u32; 2],
    pub raster_density: u32,
    pub presentation: &'a str,
}

#[derive(Debug, Clone, Copy)]
pub struct TargetContract<'a> {
    pub target: &'a str,
    pub host_abi: u32,
    pub primary: SurfaceContract<'a>,
    /// Present only for hosts that drive a second surface (display.auxiliary).
    pub auxiliary: Option<SurfaceContract<'a>>,
    /// Capability ids the target registry lists for this host.
    pub capabilities: &'a [&'a str],
    /// Whether a plan may carry a `hostExtension` payload.
    pub host_extension: bool,
}

const MAX_DEPTH: u32 = 32;

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Reader { bytes, at: 0 }
    }

    fn skip_ws(&mut self) {
        while let Some(&c) = self.bytes.get(self.at) {
            if c == b' ' || c == b'\t' || c == b'\n' || c == b'\r' {
                self.at += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn expect(&mut self, c: u8) -> Result<(), PlanError> {
        if self.peek() == Some(c) {
            self.at += 1;
            Ok(())
        } else {
            Err(PlanError::Syntax)
        }
    }

    /// Consumes one complete value and returns its raw bytes.
    fn value(&mut self, depth: u32) -> Result<&'a [u8], PlanError> {
        self.skip_ws();
        let start = self.at;
        match self.peek() {
            Some(b'{') => self.object(depth)?,
            Some(b'[') => self.array(depth)?,
            Some(b'"') => {
                self.string()?;
            }
            Some(b't') => self.literal(b"true")?,
            Some(b'f') => self.literal(b"false")?,
            Some(b'n') => self.literal(b"null")?,
            Some(c) if c == b'-' || c.is_ascii_digit() => self.number()?,
            _ => return Err(PlanError::Syntax),
        }
        Ok(&self.bytes[start..self.at])
    }

    fn object(&mut self, depth: u32) -> Result<(), PlanError> {
        if depth >= MAX_DEPTH {
            return Err(PlanError::Syntax);
        }
        self.expect(b'{')?;
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(());
        }
        loop {
            self.skip_ws();
            self.string()?;
            self.skip_ws();
            self.expect(b':')?;
            self.value(depth + 1)?;
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(());
                }
                _ => return Err(PlanError::Syntax),
            }
        }
    }

    fn array(&mut self, depth: u32) -> Result<(), PlanError> {
        if depth >= MAX_DEPTH {
            return Err(PlanError::Syntax);
        }
        self.expect(b'[')?;
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(());
        }
        loop {
            self.value(depth + 1)?;
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(());
                }
                _ => return Err(PlanError::Syntax),
            }
        }
    }

    /// Consumes one string and returns the raw bytes between its quotes.
    fn string(&mut self) -> Result<&'a [u8], PlanError> {
        self.expect(b'"')?;
        let start = self.at;
        loop {
            match self.peek() {
                None => return Err(PlanError::Syntax),
                Some(b'"') => {
                    let raw = &self.bytes[start..self.at];
                    self.at += 1;
                    return Ok(raw);
                }
                Some(b'\\') => {
                    self.at += 1;
                    match self.peek() {
                        Some(b'u') => {
                            self.at += 1;
                            for _ in 0..4 {
                                match self.peek() {
                                    Some(c) if c.is_ascii_hexdigit() => self.at += 1,
                                    _ => return Err(PlanError::Syntax),
                                }
                            }
                        }
                        Some(c) if b"\"\\/bfnrt".contains(&c) => self.at += 1,
                        _ => return Err(PlanError::Syntax),
                    }
                }
                Some(c) if c < 0x20 => return Err(PlanError::Syntax),
                Some(_) => self.at += 1,
            }
        }
    }

    fn number(&mut self) -> Result<(), PlanError> {
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let digits = self.digits();
        if digits == 0 {
            return Err(PlanError::Syntax);
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(PlanError::Syntax);
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(PlanError::Syntax);
            }
        }
        Ok(())
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.at += 1;
        }
        self.at - start
    }

    fn literal(&mut self, word: &[u8]) -> Result<(), PlanError> {
        if self.bytes[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(())
        } else {
            Err(PlanError::Syntax)
        }
    }
}

/// Visits every member of one JSON object. A duplicate key is a syntax error:
/// the desktop resolver never writes one, and two spellings of one field must
/// not let a plan carry two answers.
fn members<'a>(
    object: &'a [u8],
    mut visit: impl FnMut(&'a [u8], &'a [u8]) -> Result<(), PlanError>,
) -> Result<(), PlanError> {
    let mut reader = Reader::new(object);
    reader.skip_ws();
    reader.expect(b'{')?;
    reader.skip_ws();
    if reader.peek() == Some(b'}') {
        return Ok(());
    }
    let mut seen: Vec<&'a [u8]> = Vec::new();
    loop {
        reader.skip_ws();
        let key = reader.string()?;
        if seen.contains(&key) {
            return Err(PlanError::Syntax);
        }
        seen.push(key);
        reader.skip_ws();
        reader.expect(b':')?;
        let value = reader.value(1)?;
        visit(key, value)?;
        reader.skip_ws();
        match reader.peek() {
            Some(b',') => reader.at += 1,
            Some(b'}') => return Ok(()),
            _ => return Err(PlanError::Syntax),
        }
    }
}

fn member<'a>(object: &'a [u8], key: &str) -> Result<Option<&'a [u8]>, PlanError> {
    let mut found = None;
    members(object, |name, value| {
        if name == key.as_bytes() {
            found = Some(value);
        }
        Ok(())
    })?;
    Ok(found)
}

/// The bytes of an unescaped string value; an escaped one never matches.
fn as_str(raw: Option<&[u8]>) -> Option<&[u8]> {
    let raw = raw?;
    if raw.len() < 2 || raw[0] != b'"' || raw[raw.len() - 1] != b'"' {
        return None;
    }
    let inner = &raw[1..raw.len() - 1];
    if inner.contains(&b'\\') {
        return None;
    }
    Some(inner)
}

/// A canonical unsigned integer: digits only, no leading zero, fits u32.
fn as_u32(raw: Option<&[u8]>) -> Option<u32> {
    let raw = raw?;
    if raw.is_empty() || raw.len() > 10 || !raw.iter().all(u8::is_ascii_digit) {
        return None;
    }
    if raw.len() > 1 && raw[0] == b'0' {
        return None;
    }
    let mut value: u32 = 0;
    for &digit in raw {
        value = value.checked_mul(10)?.checked_add(u32::from(digit - b'0'))?;
    }
    Some(value)
}

fn as_bool(raw: &[u8]) -> Option<bool> {
    match raw {
        b"true" => Some(true),
        b"false" => Some(false),
        _ => None,
    }
}

fn as_viewport(raw: Option<&[u8]>) -> Option<[u32; 2]> {
    let raw = raw?;
    let mut reader = Reader::new(raw);
    reader.expect(b'[').ok()?;
    let width = as_u32(reader.value(1).ok())?;
    reader.skip_ws();
    reader.expect(b',').ok()?;
    let height = as_u32(reader.value(1).ok())?;
    reader.skip_ws();
    reader.expect(b']').ok()?;
    reader.skip_ws();
    if reader.at != raw.len() {
        return None;
    }
    Some([width, height])
}

fn check_surface(
    raw: &[u8],
    contract: &SurfaceContract,
    size_error: PlanError,
    presentation_error: PlanError,
) -> Result<(), PlanError> {
    if as_viewport(member(raw, "logical")?) != Some(contract.logical)
        || as_viewport(member(raw, "physical")?) != Some(contract.physical)
        || as_u32(member(raw, "rasterDensity")?) != Some(contract.raster_density)
    {
        return Err(size_error);
    }
    if as_str(member(raw, "presentation")?) != Some(contract.presentation.as_bytes()) {
        return Err(presentation_error);
    }
    Ok(())
}

/// Admit `plan` (the package's plan section) for a host described by
/// `contract`. Every baked field must match; a `true` feature must be one of
/// the contract's capabilities; `surfaces` and `hostExtension` may appear only
/// when the contract provides for them.
pub fn validate_plan(plan: &[u8], contract: &TargetContract) -> Result<(), PlanError> {
    let mut reader = Reader::new(plan);
    let root = reader.value(0)?;
    reader.skip_ws();
    if reader.at != plan.len() || root.first() != Some(&b'{') {
        return Err(PlanError::Syntax);
    }
    let target = member(root, "target")?.ok_or(PlanError::Target)?;
    if as_str(member(target, "id")?) != Some(contract.target.as_bytes()) {
        return Err(PlanError::Target);
    }
    if as_u32(member(target, "hostAbi")?) != Some(contract.host_abi) {
        return Err(PlanError::HostAbi);
    }
    let viewport = member(root, "viewport")?.ok_or(PlanError::Viewport)?;
    check_surface(
        viewport,
        &contract.primary,
        PlanError::Viewport,
        PlanError::Presentation,
    )?;
    match (member(root, "surfaces")?, &contract.auxiliary) {
        (None, None) => {}
        (Some(surfaces), Some(auxiliary)) => {
            let raw = member(surfaces, "auxiliary")?.ok_or(PlanError::Surfaces)?;
            check_surface(raw, auxiliary, PlanError::Surfaces, PlanError::Surfaces)?;
        }
        _ => return Err(PlanError::Surfaces),
    }
    if member(root, "hostExtension")?.is_some() && !contract.host_extension {
        return Err(PlanError::HostExtension);
    }
    let features = member(root, "features")?.ok_or(PlanError::Features)?;
    members(features, |key, value| {
        let enabled = as_bool(value).ok_or(PlanError::Features)?;
        if enabled && !contract.capabilities.iter().any(|id| id.as_bytes() == key) {
            return Err(PlanError::Features);
        }
        Ok(())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAN: &str = concat!(
        r#"{"app":{"entry":"src/main.ts","framework":"vue-vapor","id":"dev.pocket-stack.clear","output":"clear-main","title":"Clear","version":"1.0.0"},"#,
        r#""companions":[],"features":{"input.touch":true,"text.glyphs.baked":true},"#,
        r#""planHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000","#,
        r#""target":{"hostAbi":8,"id":"ipodtouch4-dev"},"#,
        r#""viewport":{"logical":[320,480],"physical":[640,960],"policy":"fixed","presentation":"native","rasterDensity":2}}"#
    );

    const CAPABILITIES: &[&str] = &["input.touch", "text.glyphs.baked"];

    fn contract() -> TargetContract<'static> {
        TargetContract {
            target: "ipodtouch4-dev",
            host_abi: 8,
            primary: SurfaceContract {
                logical: [320, 480],
                physical: [640, 960],
                raster_density: 2,
                presentation: "native",
            },
            auxiliary: None,
            capabilities: CAPABILITIES,
            host_extension: false,
        }
    }

    fn check(plan: &str) -> Result<(), PlanError> {
        validate_plan(plan.as_bytes(), &contract())
    }

    #[test]
    fn admits_the_canonical_plan() {
        assert_eq!(check(PLAN), Ok(()));
        // Whitespace and member order do not matter; values do.
        let spaced = PLAN.replace(",\"target\"", ", \n \"target\"");
        assert_eq!(check(&spaced), Ok(()));
    }

    #[test]
    fn rejects_every_baked_field_drift() {
        assert_eq!(check(&PLAN.replace("ipodtouch4-dev", "3ds-dev")), Err(PlanError::Target));
        assert_eq!(check(&PLAN.replace("\"hostAbi\":8", "\"hostAbi\":7")), Err(PlanError::HostAbi));
        assert_eq!(check(&PLAN.replace("[320,480]", "[480,320]")), Err(PlanError::Viewport));
        assert_eq!(check(&PLAN.replace("[640,960]", "[640,961]")), Err(PlanError::Viewport));
        assert_eq!(check(&PLAN.replace("\"rasterDensity\":2", "\"rasterDensity\":1")), Err(PlanError::Viewport));
        assert_eq!(check(&PLAN.replace("\"native\"", "\"fill\"")), Err(PlanError::Presentation));
        assert_eq!(check(&PLAN.replace("\"text.glyphs.baked\":true", "\"input.buttons\":true")), Err(PlanError::Features));
        assert_eq!(check(&PLAN.replace("\"text.glyphs.baked\":true", "\"text.glyphs.baked\":1")), Err(PlanError::Features));
        assert_eq!(check(&PLAN.replace("\"companions\":[]", "\"companions\":[],\"surfaces\":{}")), Err(PlanError::Surfaces));
        assert_eq!(check(&PLAN.replace("\"companions\":[]", "\"companions\":[],\"hostExtension\":{}")), Err(PlanError::HostExtension));
    }

    #[test]
    fn unknown_disabled_features_are_fine() {
        let plan = PLAN.replace("\"text.glyphs.baked\":true", "\"text.glyphs.baked\":true,\"input.buttons\":false");
        assert_eq!(check(&plan), Ok(()));
    }

    #[test]
    fn non_canonical_spellings_never_match() {
        assert_eq!(check(&PLAN.replace("\"native\"", "\"nati\\u0076e\"")), Err(PlanError::Presentation));
        assert_eq!(check(&PLAN.replace("\"hostAbi\":8", "\"hostAbi\":8.0")), Err(PlanError::HostAbi));
        assert_eq!(check(&PLAN.replace("\"hostAbi\":8", "\"hostAbi\":08")), Err(PlanError::HostAbi));
        assert_eq!(check(&PLAN.replace("[320,480]", "[320,480,0]")), Err(PlanError::Viewport));
        let duplicate = PLAN.replace("\"presentation\":\"native\"", "\"presentation\":\"fill\",\"presentation\":\"native\"");
        assert_eq!(check(&duplicate), Err(PlanError::Syntax));
    }

    #[test]
    fn rejects_malformed_documents() {
        assert_eq!(check("{ invalid"), Err(PlanError::Syntax));
        assert_eq!(check(""), Err(PlanError::Syntax));
        assert_eq!(check("[]"), Err(PlanError::Syntax));
        assert_eq!(check(&format!("{PLAN} trailing")), Err(PlanError::Syntax));
        assert_eq!(check("{\"target\":\"x\"}"), Err(PlanError::Syntax));
        let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
        assert_eq!(check(&deep), Err(PlanError::Syntax));
        assert_eq!(check("{\"a\":\"\u{1}\"}"), Err(PlanError::Syntax));
    }

    #[test]
    fn auxiliary_surfaces_follow_the_contract() {
        let auxiliary = SurfaceContract {
            logical: [320, 240],
            physical: [320, 240],
            raster_density: 1,
            presentation: "native",
        };
        let dual = TargetContract {
            target: "3ds-dev",
            host_abi: 8,
            primary: SurfaceContract {
                logical: [400, 240],
                physical: [400, 240],
                raster_density: 1,
                presentation: "native",
            },
            auxiliary: Some(auxiliary),
            capabilities: &["input.buttons", "input.touch.auxiliary", "text.glyphs.baked"],
            host_extension: false,
        };
        let plan = concat!(
            r#"{"features":{"input.buttons":true,"input.touch.auxiliary":true},"#,
            r#""surfaces":{"auxiliary":{"logical":[320,240],"physical":[320,240],"presentation":"native","rasterDensity":1}},"#,
            r#""target":{"hostAbi":8,"id":"3ds-dev"},"#,
            r#""viewport":{"logical":[400,240],"physical":[400,240],"policy":"fixed","presentation":"native","rasterDensity":1}}"#
        );
        assert_eq!(validate_plan(plan.as_bytes(), &dual), Ok(()));
        let missing = plan.replace(r#""surfaces":{"auxiliary":{"logical":[320,240],"physical":[320,240],"presentation":"native","rasterDensity":1}},"#, "");
        assert_eq!(validate_plan(missing.as_bytes(), &dual), Err(PlanError::Surfaces));
        let wrong = plan.replace("\"logical\":[320,240]", "\"logical\":[320,200]");
        assert_eq!(validate_plan(wrong.as_bytes(), &dual), Err(PlanError::Surfaces));
    }
}
