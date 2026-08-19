//! The network policy and its enforcement gate.
//!
//! `NetPolicy` parses exactly the canonical `ResolvedNetworkPolicy` document
//! the Build Plan resolver emits (contracts/spec/network-policy.ts, version
//! 1) — the same shapes engine/net's `pnet_policy_parse` accepts — and
//! decides connect rules, listen rules and address classification with the
//! reference semantics; contracts/spec/vectors/network-policy.json pins them
//! (see the tests at the bottom of lib.rs).
//!
//! `PolicyGate` is the authority a backend cannot route around: the core
//! hands one clone to the backend with every request, and the backend must
//! ask it for every decision that happens on the wire side of the core —
//! each resolved candidate address (`authorize_address`), each redirect hop
//! (`authorize_redirect`, which also applies the spec's method/body rewrite
//! table and the hop budget) and the TLS verification mode
//! (`tls_verification`). The gate records the URLs it authorized per handle;
//! when the backend reports response headers the core checks the response
//! URL against that record, so a backend that followed a hop on its own
//! (or answered from somewhere else) fails the exchange with
//! `permission_denied` instead of smuggling the response through. Backends
//! therefore implement transport, not policy; the rules live here once.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use pocketjs_core::spec::net as spec;
use serde::Deserialize;

use crate::{NetFailure, RedirectMode};

pub const NETWORK_POLICY_VERSION: u64 = 1;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PolicyDocument {
    #[serde(default)]
    version: Option<u64>,
    #[serde(default)]
    connect: Vec<RuleDocument>,
    #[serde(default)]
    listen: Vec<RuleDocument>,
    #[serde(default)]
    credentials: Vec<String>,
    #[serde(default, rename = "localNetwork")]
    local_network: bool,
    #[serde(default, rename = "insecureTransport")]
    insecure_transport: bool,
    #[serde(default, rename = "allowInvalidTlsForDevelopment")]
    allow_invalid_tls_for_development: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RuleDocument {
    protocol: String,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    address: Option<String>,
    port: serde_json::Value,
}

/// `http` / `https` / `ws` / `wss`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Protocol {
    Http,
    Https,
    Ws,
    Wss,
}

impl Protocol {
    pub fn parse(scheme: &str) -> Option<Self> {
        match scheme {
            "http" => Some(Protocol::Http),
            "https" => Some(Protocol::Https),
            "ws" => Some(Protocol::Ws),
            "wss" => Some(Protocol::Wss),
            _ => None,
        }
    }
    pub fn is_plaintext(self) -> bool {
        matches!(self, Protocol::Http | Protocol::Ws)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PortRule {
    Single(u16),
    Range { min: u16, max: u16 },
    /// Listen only: bind port 0.
    Ephemeral,
}

impl PortRule {
    pub fn matches(self, port: u16) -> bool {
        match self {
            PortRule::Single(p) => p == port,
            PortRule::Range { min, max } => (min..=max).contains(&port),
            PortRule::Ephemeral => port == 0,
        }
    }
}

/// What a rule's host matches.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostRule {
    /// A lowercase ASCII DNS name, compared exactly.
    Name(String),
    /// `*.suffix`: exactly one extra label.
    Wildcard(String),
    /// An IP literal, compared by address.
    Address(IpAddr),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectRule {
    pub protocol: Protocol,
    pub host: HostRule,
    pub port: PortRule,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListenRule {
    pub protocol: Protocol,
    pub address: IpAddr,
    pub port: PortRule,
}

/// The immutable policy (one ResolvedNetworkPolicy).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetPolicy {
    pub connect: Vec<ConnectRule>,
    pub listen: Vec<ListenRule>,
    pub credentials: Vec<String>,
    pub local_network: bool,
    pub insecure_transport: bool,
    pub allow_invalid_tls_for_development: bool,
}

// ---------------------------------------------------------------------------
// Hostnames and addresses (mirrors contracts/spec/network-policy.ts)
// ---------------------------------------------------------------------------

/// Lowercase ASCII DNS name: labels of [a-z0-9-], 1..63 bytes, not starting
/// or ending with '-', whole name <= 253 bytes, last label not all digits.
pub fn hostname_valid(name: &str) -> bool {
    if name.is_empty() || name.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = name.split('.').collect();
    if labels.iter().any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) {
        return false;
    }
    // A name whose last label is all digits is a malformed IPv4 literal.
    !labels[labels.len() - 1].bytes().all(|b| b.is_ascii_digit())
}

/// Parse an IP literal (`1.2.3.4`, `::1`, `[::1]`); IPv4 octets with leading
/// zeros are refused (octal to some resolvers, decimal to others).
pub fn parse_address(text: &str) -> Option<IpAddr> {
    let body = text.strip_prefix('[').and_then(|t| t.strip_suffix(']')).unwrap_or(text);
    if body.contains(':') {
        return body.parse::<Ipv6Addr>().ok().map(IpAddr::V6);
    }
    let parts: Vec<&str> = body.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        if part.len() > 1 && part.starts_with('0') {
            return None;
        }
        octets[i] = part.parse::<u16>().ok().filter(|v| *v <= 255)? as u8;
    }
    Some(IpAddr::V4(Ipv4Addr::from(octets)))
}

/// Lowercase, drop one trailing root dot; None when not a valid name.
pub fn normalize_hostname(host: &str) -> Option<String> {
    if !host.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return None;
    }
    let mut lower = host.to_ascii_lowercase();
    if lower.len() > 1 && lower.ends_with('.') {
        lower.pop();
    }
    if hostname_valid(&lower) {
        Some(lower)
    } else {
        None
    }
}

pub fn address_is_multicast(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => (v4.octets()[0] & 0xf0) == 0xe0,
        IpAddr::V6(v6) => v6.octets()[0] == 0xff,
    }
}

/// Globally routable unicast, the classification shared with engine/net's
/// pnet_addr_is_public and the TypeScript reference.
pub fn address_is_public(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => {
            let a = v4.octets();
            !(a[0] == 0
                || a[0] == 10
                || a[0] == 127
                || (a[0] == 169 && a[1] == 254)
                || (a[0] == 172 && (a[1] & 0xf0) == 16)
                || (a[0] == 192 && a[1] == 168)
                || (a[0] == 100 && (a[1] & 0xc0) == 64)
                || (a[0] & 0xf0) == 0xe0
                || a == [255, 255, 255, 255])
        }
        IpAddr::V6(v6) => {
            let a = v6.octets();
            if a[..15].iter().all(|b| *b == 0) && (a[15] == 0 || a[15] == 1) {
                return false;
            }
            if a[0] == 0xfe && (a[1] & 0xc0) == 0x80 {
                return false;
            }
            if (a[0] & 0xfe) == 0xfc {
                return false;
            }
            if a[0] == 0xff {
                return false;
            }
            if a[..10].iter().all(|b| *b == 0) && a[10] == 0xff && a[11] == 0xff {
                return address_is_public(IpAddr::V4(Ipv4Addr::new(a[12], a[13], a[14], a[15])));
            }
            true
        }
    }
}

impl HostRule {
    fn parse(text: &str) -> Option<Self> {
        if let Some(addr) = parse_address(text) {
            return Some(HostRule::Address(addr));
        }
        if !text.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
            return None;
        }
        let lower = text.to_ascii_lowercase();
        let lower = if lower.len() > 1 && lower.ends_with('.') { &lower[..lower.len() - 1] } else { &lower[..] };
        if let Some(suffix) = lower.strip_prefix("*.") {
            if parse_address(suffix).is_some() || !hostname_valid(suffix) {
                return None;
            }
            return Some(HostRule::Wildcard(suffix.to_string()));
        }
        if lower.starts_with('*') {
            return None; // a bare `*` or `*foo` is not a rule
        }
        if hostname_valid(lower) {
            Some(HostRule::Name(lower.to_string()))
        } else {
            None
        }
    }

    /// `host` as the URL parser hands it over (brackets allowed).
    pub fn matches(&self, host: &str) -> bool {
        match self {
            HostRule::Address(addr) => parse_address(host) == Some(*addr),
            HostRule::Name(name) => normalize_hostname(host).as_deref() == Some(name.as_str()),
            HostRule::Wildcard(suffix) => match normalize_hostname(host) {
                Some(target) => {
                    target.len() > suffix.len() + 1
                        && target.ends_with(suffix)
                        && target.as_bytes()[target.len() - suffix.len() - 1] == b'.'
                        && !target[..target.len() - suffix.len() - 1].contains('.')
                }
                None => false,
            },
        }
    }
}

fn parse_port(value: &serde_json::Value, listen: bool) -> Option<PortRule> {
    match value {
        serde_json::Value::Number(n) => {
            let v = n.as_u64()?;
            if (1..=65535).contains(&v) { Some(PortRule::Single(v as u16)) } else { None }
        }
        serde_json::Value::String(s) if listen && s == "ephemeral" => Some(PortRule::Ephemeral),
        serde_json::Value::Object(map) => {
            let min = map.get("min")?.as_u64()?;
            let max = map.get("max")?.as_u64()?;
            if map.len() != 2 || min < 1 || max > 65535 || min > max {
                return None;
            }
            Some(PortRule::Range { min: min as u16, max: max as u16 })
        }
        _ => None,
    }
}

impl NetPolicy {
    /// Parse the canonical policy JSON; `Err` names the first fault.
    pub fn parse(json: &str) -> Result<Self, String> {
        let doc: PolicyDocument = serde_json::from_str(json).map_err(|e| e.to_string())?;
        if let Some(version) = doc.version {
            if version != NETWORK_POLICY_VERSION {
                return Err(format!("unsupported network policy version {version}"));
            }
        }
        let mut connect = Vec::with_capacity(doc.connect.len());
        for (i, rule) in doc.connect.iter().enumerate() {
            let protocol = Protocol::parse(&rule.protocol).ok_or_else(|| format!("connect[{i}]: unknown protocol"))?;
            let host = rule.host.as_deref().ok_or_else(|| format!("connect[{i}]: host missing"))?;
            let host = HostRule::parse(host).ok_or_else(|| format!("connect[{i}]: invalid host"))?;
            let port = parse_port(&rule.port, false).ok_or_else(|| format!("connect[{i}]: invalid port"))?;
            if rule.address.is_some() {
                return Err(format!("connect[{i}]: unexpected address"));
            }
            connect.push(ConnectRule { protocol, host, port });
        }
        let mut listen = Vec::with_capacity(doc.listen.len());
        for (i, rule) in doc.listen.iter().enumerate() {
            let protocol = Protocol::parse(&rule.protocol).ok_or_else(|| format!("listen[{i}]: unknown protocol"))?;
            let address = rule.address.as_deref().ok_or_else(|| format!("listen[{i}]: address missing"))?;
            let address = parse_address(address).ok_or_else(|| format!("listen[{i}]: address must be an IP literal"))?;
            let port = parse_port(&rule.port, true).ok_or_else(|| format!("listen[{i}]: invalid port"))?;
            if rule.host.is_some() {
                return Err(format!("listen[{i}]: unexpected host"));
            }
            listen.push(ListenRule { protocol, address, port });
        }
        if doc.credentials.iter().any(|c| c.is_empty()) {
            return Err("credentials: empty id".into());
        }
        Ok(NetPolicy {
            connect,
            listen,
            credentials: doc.credentials,
            local_network: doc.local_network,
            insecure_transport: doc.insecure_transport,
            allow_invalid_tls_for_development: doc.allow_invalid_tls_for_development,
        })
    }

    /// A development/test policy: plaintext and TLS to loopback names and
    /// `*.test` on any port, local network allowed. Never a bare wildcard —
    /// the contract has none.
    pub fn permissive() -> Self {
        let any = PortRule::Range { min: 1, max: 65535 };
        let hosts = [
            HostRule::Name("localhost".into()),
            HostRule::Address(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            HostRule::Address(IpAddr::V6(Ipv6Addr::LOCALHOST)),
            HostRule::Wildcard("test".into()),
        ];
        let mut connect = Vec::new();
        for protocol in [Protocol::Http, Protocol::Https, Protocol::Ws, Protocol::Wss] {
            for host in &hosts {
                connect.push(ConnectRule { protocol, host: host.clone(), port: any });
            }
        }
        Self {
            connect,
            listen: vec![
                ListenRule { protocol: Protocol::Http, address: IpAddr::V4(Ipv4Addr::LOCALHOST), port: any },
                ListenRule { protocol: Protocol::Http, address: IpAddr::V4(Ipv4Addr::LOCALHOST), port: PortRule::Ephemeral },
            ],
            credentials: Vec::new(),
            local_network: true,
            insecure_transport: true,
            allow_invalid_tls_for_development: false,
        }
    }

    /// Endpoint rule + insecureTransport, before DNS.
    pub fn allows_connect(&self, scheme: &str, host: &str, port: u16) -> bool {
        let Some(protocol) = Protocol::parse(scheme) else { return false };
        if protocol.is_plaintext() && !self.insecure_transport {
            return false;
        }
        self.connect
            .iter()
            .any(|rule| rule.protocol == protocol && rule.port.matches(port) && rule.host.matches(host))
    }

    /// A resolved candidate address: public, or local with `localNetwork`;
    /// multicast never.
    pub fn allows_address(&self, addr: IpAddr) -> bool {
        if address_is_multicast(addr) {
            return false;
        }
        address_is_public(addr) || self.local_network
    }

    pub fn allows_listen(&self, scheme: &str, address: &str, port: u16) -> bool {
        let Some(protocol) = Protocol::parse(scheme) else { return false };
        if protocol.is_plaintext() && !self.insecure_transport {
            return false;
        }
        let Some(addr) = parse_address(address) else { return false };
        self.listen
            .iter()
            .any(|rule| rule.protocol == protocol && rule.address == addr && rule.port.matches(port))
    }

    pub fn has_credential(&self, id: &str) -> bool {
        self.credentials.iter().any(|c| c == id)
    }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/// The plan a redirect gets from the gate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RedirectPlan {
    /// Not a redirect the client follows here (no redirect status, no
    /// Location, or `redirect: "manual"`): deliver the response as it is.
    Deliver,
    /// Follow: the next hop's absolute URL, the method to use, and whether
    /// the request body is dropped (303 for everything but HEAD, 301/302
    /// for POST).
    Follow { url: String, method: String, drop_body: bool },
}

/// TLS verification the backend must apply to a connection.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TlsVerification {
    /// Verify the chain and the hostname (DNS-ID) — always, except the
    /// development-insecure case the policy + build admitted.
    pub verify_peer: bool,
    /// SNI / DNS-ID: the authorized hostname.
    pub server_name: String,
    pub min_version: &'static str,
}

struct GateInner {
    policy: NetPolicy,
    development_build: AtomicBool,
    tls_available: bool,
    /// Per handle: every URL the gate authorized, in order (the first entry
    /// is the start URL).
    hops: Mutex<BTreeMap<i32, Vec<String>>>,
}

/// Clone-cheap, `Send + Sync`: a backend keeps one and consults it from
/// whatever thread runs its I/O.
#[derive(Clone)]
pub struct PolicyGate {
    inner: Arc<GateInner>,
}

impl PolicyGate {
    pub(crate) fn new(policy: NetPolicy, tls_available: bool) -> Self {
        Self {
            inner: Arc::new(GateInner {
                policy,
                development_build: AtomicBool::new(false),
                tls_available,
                hops: Mutex::new(BTreeMap::new()),
            }),
        }
    }

    pub(crate) fn set_development_build(&self, enabled: bool) {
        self.inner.development_build.store(enabled, Ordering::SeqCst);
    }

    pub fn policy(&self) -> &NetPolicy {
        &self.inner.policy
    }

    /// The core records the start URL when it admits a request.
    pub(crate) fn begin(&self, handle: i32, url: &str) {
        self.inner.hops.lock().unwrap().insert(handle, vec![url.to_string()]);
    }

    pub(crate) fn forget(&self, handle: i32) {
        self.inner.hops.lock().unwrap().remove(&handle);
    }

    /// The URLs authorized for `handle` so far (start URL first).
    pub fn authorized_urls(&self, handle: i32) -> Vec<String> {
        self.inner.hops.lock().unwrap().get(&handle).cloned().unwrap_or_default()
    }

    /// Endpoint rule + insecureTransport for an arbitrary tuple (proxies,
    /// alternate services). The core already ran it for the start URL.
    pub fn authorize_endpoint(&self, scheme: &str, host: &str, port: u16) -> Result<(), NetFailure> {
        if self.inner.policy.allows_connect(scheme, host, port) {
            Ok(())
        } else {
            Err(NetFailure::new(spec::ERROR_PERMISSION_DENIED, "endpoint is not an allowed connect rule"))
        }
    }

    /// Every candidate address the resolver produced, before connecting to
    /// it: loopback / link-local / private / CGNAT / ULA only with
    /// localNetwork, multicast never.
    pub fn authorize_address(&self, addr: IpAddr) -> Result<(), NetFailure> {
        if self.inner.policy.allows_address(addr) {
            Ok(())
        } else {
            Err(NetFailure::new(spec::ERROR_PERMISSION_DENIED, "resolved address is not permitted by the policy"))
        }
    }

    /// The redirect decision for a response: the spec's followed statuses
    /// and rewrite table, the hop budget, the scheme and TLS availability,
    /// the endpoint policy for the target — recorded for the core's check.
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_redirect(
        &self,
        handle: i32,
        from_url: &str,
        method: &str,
        status: u16,
        location: Option<&str>,
        redirects_left: u32,
        mode: RedirectMode,
    ) -> Result<RedirectPlan, NetFailure> {
        if !spec::HTTP_REDIRECT_STATUS.contains(&status) {
            return Ok(RedirectPlan::Deliver);
        }
        let Some(location) = location else { return Ok(RedirectPlan::Deliver) };
        match mode {
            RedirectMode::Manual => return Ok(RedirectPlan::Deliver),
            RedirectMode::Error => return Err(NetFailure::new(spec::ERROR_REDIRECT, "redirect refused by policy")),
            RedirectMode::Follow => {}
        }
        if redirects_left == 0 {
            return Err(NetFailure::new(spec::ERROR_REDIRECT, "too many redirects"));
        }
        let Some(next) = resolve_url(from_url, location) else {
            return Err(NetFailure::new(spec::ERROR_REDIRECT, "invalid Location"));
        };
        let Some((scheme, host, port)) = crate::parse_url(&next) else {
            return Err(NetFailure::new(spec::ERROR_REDIRECT, "invalid Location"));
        };
        if scheme != "http" && scheme != "https" {
            return Err(NetFailure::new(spec::ERROR_REDIRECT, "redirect to a non-HTTP scheme"));
        }
        if scheme == "https" && !self.inner.tls_available {
            return Err(NetFailure::new(spec::ERROR_UNSUPPORTED, "redirect to https without network.http.client.tls"));
        }
        if !self.inner.policy.allows_connect(scheme, &host, port) {
            return Err(NetFailure::new(spec::ERROR_PERMISSION_DENIED, "redirect target is not an allowed endpoint"));
        }
        let upper = method.to_ascii_uppercase();
        let to_get = (spec::HTTP_REDIRECT_ANY_TO_GET_STATUS.contains(&status) && upper != "HEAD")
            || (spec::HTTP_REDIRECT_POST_TO_GET_STATUS.contains(&status) && upper == "POST");
        self.inner.hops.lock().unwrap().entry(handle).or_default().push(next.clone());
        Ok(RedirectPlan::Follow {
            url: next,
            method: if to_get { "GET".to_string() } else { method.to_string() },
            drop_body: to_get,
        })
    }

    /// Verification for a TLS connection to `server_name`; the
    /// development-insecure mode applies only when the policy, the build and
    /// the request all asked for it.
    pub fn tls_verification(&self, server_name: &str, development_insecure_requested: bool) -> TlsVerification {
        let insecure = development_insecure_requested
            && self.inner.development_build.load(Ordering::SeqCst)
            && self.inner.policy.allow_invalid_tls_for_development;
        TlsVerification { verify_peer: !insecure, server_name: server_name.to_string(), min_version: spec::TLS_MIN_VERSION }
    }
}

/// Resolve a Location against the current URL: absolute, scheme-relative,
/// path-absolute, or relative to the current path's directory. Query and
/// fragment of the Location are kept; the base's are dropped.
pub fn resolve_url(base: &str, location: &str) -> Option<String> {
    let location = location.trim();
    if location.is_empty() {
        return None;
    }
    if location.contains("://") {
        return Some(location.to_string());
    }
    let (scheme, rest) = base.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if let Some(stripped) = location.strip_prefix("//") {
        return Some(format!("{scheme}://{stripped}"));
    }
    let base_path = {
        let after = &rest[authority_end..];
        let end = after.find(['?', '#']).unwrap_or(after.len());
        let path = &after[..end];
        if path.is_empty() { "/" } else { path }
    };
    if location.starts_with('/') {
        return Some(format!("{scheme}://{authority}{location}"));
    }
    let dir = match base_path.rfind('/') {
        Some(i) => &base_path[..=i],
        None => "/",
    };
    Some(format!("{scheme}://{authority}{dir}{location}"))
}
