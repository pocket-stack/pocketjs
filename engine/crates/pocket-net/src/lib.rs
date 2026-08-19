//! pocket-net — the reference HTTP Client core behind `globalThis.net`
//! (contracts/spec/net.ts v2) for Rust hosts.
//!
//! The crate owns the guest-visible policy of the module — handle table,
//! immutable endpoint policy, per-handle bounded receive queues, the tick
//! boundary that freezes the visible set (`begin_tick`), the one `poll` batch
//! per tick, `readInto`, cancellation and the stable error vocabulary — and
//! delegates the wire to a host-supplied [`HttpClientBackend`]. A backend
//! implements HTTP/1.1 (or wraps a platform client) and reports streaming
//! completions; it never sees QuickJS. The `mount` feature installs the six
//! v2 ops on a `pocket_mod::Guest`.
//!
//! Frame contract: the host calls
//! [`NetCore::begin_tick`] before every guest `frame()`; the framework
//! service pump then calls `poll` exactly once; completions that arrive
//! after `begin_tick` wait for the next tick.
//!
//! Security authority: the core owns the policy decisions. It checks the
//! endpoint rule and insecureTransport before the backend sees a request,
//! classifies literal addresses, and hands the backend a [`PolicyGate`] that
//! decides every wire-side question — each resolved address, each redirect
//! hop (with the spec's rewrite table and hop budget), the TLS verification
//! mode — and records what it authorized; the response URL a backend reports
//! must be one the gate authorized for that handle or the exchange fails
//! with `permission_denied`. The portable C implementation of the same
//! boundary (engine/net) applies the same rules inside its own dialer;
//! contracts/spec/vectors pin both.

pub mod policy;

use std::collections::{BTreeMap, VecDeque};

use pocketjs_core::spec::net as spec;
use serde::Deserialize;

pub use policy::{
    address_is_multicast, address_is_public, hostname_valid, parse_address, resolve_url, ConnectRule, HostRule,
    ListenRule, NetPolicy, PolicyGate, PortRule, Protocol, RedirectPlan, TlsVerification,
};

/// A request handed to the backend after the core validated it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub handle: i32,
    pub url: String,
    pub method: String,
    /// Lowercased names; framing/connection headers already removed.
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub connect_ms: u32,
    pub headers_ms: u32,
    pub idle_ms: u32,
    pub total_ms: u32,
    pub redirect: RedirectMode,
    pub max_redirects: u32,
    pub max_body_bytes: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedirectMode {
    Follow,
    Manual,
    Error,
}

/// A stable failure: `code` is clamped onto the spec vocabulary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetFailure {
    pub code: String,
    pub message: String,
    pub cause: Option<String>,
}

impl NetFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        Self {
            code: normalize_error_code(&code).to_string(),
            message: message.into(),
            cause: None,
        }
    }
}

/// Streaming completions a backend produces for a handle, in order:
/// `Headers → Body* → End` or `… → Error`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendEvent {
    Headers {
        handle: i32,
        status: u16,
        url: String,
        headers: BTreeMap<String, String>,
        redirected: bool,
        length: Option<u64>,
    },
    Body {
        handle: i32,
        chunk: Vec<u8>,
    },
    End {
        handle: i32,
    },
    Error {
        handle: i32,
        failure: NetFailure,
    },
}

/// The host-specific wire layer. The core calls it only from the owner
/// thread's `start`/`cancel`/`begin_tick`; a backend that runs I/O elsewhere
/// hands results over through `drain` at the tick boundary.
///
/// The `gate` is the policy authority for everything that happens on the
/// wire side: the backend must call `gate.authorize_address` for every
/// candidate address before connecting, `gate.authorize_redirect` for every
/// redirect response before following it (and follow exactly its plan), and
/// apply `gate.tls_verification` to every TLS connection. It never decides
/// those itself; the core rejects a response whose URL the gate did not
/// authorize.
pub trait HttpClientBackend {
    /// Begin the exchange; refusal is synchronous (`resource_limit` etc.).
    fn start(&mut self, request: HttpRequest, gate: PolicyGate) -> Result<(), NetFailure>;
    /// Best-effort cancellation; a later completion for the handle is dropped.
    fn cancel(&mut self, handle: i32);
    /// Move every completed event into `out` (tick boundary).
    fn drain(&mut self, out: &mut Vec<BackendEvent>);
    /// Whether the transport can carry TLS (advertises the "tls" feature).
    fn supports_tls(&self) -> bool {
        false
    }
    /// The backend stops reading a handle whose queue is at capacity and
    /// resumes when told; the default ignores backpressure hints.
    fn set_paused(&mut self, _handle: i32, _paused: bool) {}
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Host-tightened limits; `default()` is the spec ceiling.
#[derive(Clone, Debug)]
pub struct NetLimits {
    pub max_inflight: usize,
    pub max_request_bytes: usize,
    pub default_queue_bytes: usize,
    pub max_queue_bytes: usize,
    pub default_aggregate_bytes: usize,
    pub max_aggregate_bytes: usize,
    pub max_events_per_tick: usize,
    pub max_tick_bytes: usize,
    pub max_headers: usize,
    pub max_header_bytes: usize,
    pub default_timeout_ms: u32,
    pub max_timeout_ms: u32,
    pub max_redirects: u32,
}

impl Default for NetLimits {
    fn default() -> Self {
        Self {
            max_inflight: spec::MAX_INFLIGHT,
            max_request_bytes: spec::MAX_REQUEST_BYTES,
            default_queue_bytes: spec::DEFAULT_QUEUE_BYTES,
            max_queue_bytes: spec::MAX_QUEUE_BYTES,
            default_aggregate_bytes: spec::DEFAULT_AGGREGATE_BYTES,
            max_aggregate_bytes: spec::MAX_AGGREGATE_BYTES,
            max_events_per_tick: spec::MAX_EVENTS_PER_TICK,
            max_tick_bytes: spec::MAX_TICK_BYTES,
            max_headers: spec::MAX_HEADERS,
            max_header_bytes: spec::MAX_HEADER_BYTES,
            default_timeout_ms: spec::DEFAULT_TIMEOUT_MS,
            max_timeout_ms: spec::MAX_TIMEOUT_MS,
            max_redirects: spec::MAX_REDIRECTS as u32,
        }
    }
}

impl NetLimits {
    fn clamp(mut self) -> Self {
        let d = NetLimits::default();
        self.max_inflight = self.max_inflight.clamp(1, d.max_inflight);
        self.max_request_bytes = self.max_request_bytes.clamp(1, d.max_request_bytes);
        self.max_queue_bytes = self.max_queue_bytes.clamp(1, d.max_queue_bytes);
        self.default_queue_bytes = self.default_queue_bytes.clamp(1, self.max_queue_bytes);
        self.max_aggregate_bytes = self.max_aggregate_bytes.clamp(1, d.max_aggregate_bytes);
        self.default_aggregate_bytes = self.default_aggregate_bytes.clamp(1, self.max_aggregate_bytes);
        self.max_events_per_tick = self.max_events_per_tick.clamp(1, d.max_events_per_tick);
        self.max_tick_bytes = self.max_tick_bytes.clamp(1, d.max_tick_bytes);
        self.max_headers = self.max_headers.clamp(1, d.max_headers);
        self.max_header_bytes = self.max_header_bytes.clamp(1, d.max_header_bytes);
        self.max_timeout_ms = self.max_timeout_ms.clamp(1, d.max_timeout_ms);
        self.default_timeout_ms = self.default_timeout_ms.clamp(1, self.max_timeout_ms);
        self.max_redirects = self.max_redirects.min(d.max_redirects);
        self
    }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartMeta {
    url: String,
    method: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    queue_bytes: Option<usize>,
    #[serde(default)]
    max_body_bytes: Option<usize>,
    #[serde(default)]
    timeouts: Option<Timeouts>,
    #[serde(default)]
    redirect: Option<String>,
    #[serde(default)]
    max_redirects: Option<u32>,
    #[serde(default)]
    tls: Option<TlsMeta>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Timeouts {
    connect_ms: Option<u32>,
    headers_ms: Option<u32>,
    idle_ms: Option<u32>,
    total_ms: Option<u32>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TlsMeta {
    verification: Option<String>,
}

/// One rendered event waiting for a tick boundary or a poll.
struct QueuedEvent {
    handle: i32,
    /// `readable` insertions go before this event for the same handle.
    barrier: bool,
    weight: usize,
    json: String,
}

struct Handle {
    head_pushed: bool,
    terminal: bool,
    queue_bytes: usize,
    max_body_bytes: Option<usize>,
    body_total: usize,
    queue: VecDeque<u8>,
    visible_bytes: usize,
    dirty: bool,
    paused: bool,
}

pub struct NetCore<B: HttpClientBackend> {
    backend: B,
    policy: NetPolicy,
    gate: PolicyGate,
    limits: NetLimits,
    development_build: bool,
    handles: BTreeMap<i32, Handle>,
    next_handle: i32,
    pending: VecDeque<QueuedEvent>,
    visible: VecDeque<QueuedEvent>,
    last_error: String,
    limits_json: String,
}

impl<B: HttpClientBackend> NetCore<B> {
    pub fn new(backend: B, policy: NetPolicy) -> Self {
        Self::with_limits(backend, policy, NetLimits::default())
    }

    pub fn with_limits(backend: B, policy: NetPolicy, limits: NetLimits) -> Self {
        let limits = limits.clamp();
        let gate = PolicyGate::new(policy.clone(), backend.supports_tls());
        let mut core = Self {
            backend,
            policy,
            gate,
            limits,
            development_build: false,
            handles: BTreeMap::new(),
            next_handle: 1,
            pending: VecDeque::new(),
            visible: VecDeque::new(),
            last_error: String::new(),
            limits_json: String::new(),
        };
        core.limits_json = core.render_limits();
        core
    }

    /// Enable `tls.verification = "development-insecure"` when the policy
    /// also allows it (never in production builds).
    pub fn set_development_build(&mut self, enabled: bool) {
        self.development_build = enabled;
        self.gate.set_development_build(enabled);
    }

    /// The policy gate (a clone is cheap): what the backend consults.
    pub fn gate(&self) -> PolicyGate {
        self.gate.clone()
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }

    fn render_limits(&self) -> String {
        let l = &self.limits;
        let features = if self.backend.supports_tls() { "[\"tls\"]" } else { "[]" };
        format!(
            "{{\"specMajor\":{},\"specMinor\":{},\"maxInflight\":{},\"maxTlsInflight\":{},\"maxRequestBytes\":{},\
             \"defaultQueueBytes\":{},\"maxQueueBytes\":{},\"defaultAggregateBytes\":{},\"maxAggregateBytes\":{},\
             \"maxEventsPerTick\":{},\"maxTickBytes\":{},\"maxHeaders\":{},\"maxHeaderBytes\":{},\
             \"defaultTimeoutMs\":{},\"maxTimeoutMs\":{},\"maxRedirects\":{},\"tlsMinVersion\":\"{}\",\"features\":{}}}",
            spec::SPEC_MAJOR,
            spec::SPEC_MINOR,
            l.max_inflight,
            if self.backend.supports_tls() { l.max_inflight } else { 0 },
            l.max_request_bytes,
            l.default_queue_bytes,
            l.max_queue_bytes,
            l.default_aggregate_bytes,
            l.max_aggregate_bytes,
            l.max_events_per_tick,
            l.max_tick_bytes,
            l.max_headers,
            l.max_header_bytes,
            l.default_timeout_ms,
            l.max_timeout_ms,
            l.max_redirects,
            spec::TLS_MIN_VERSION,
            features
        )
    }

    /// `limits()` op: read-only JSON.
    pub fn limits(&self) -> &str {
        &self.limits_json
    }

    /// `lastError()` op.
    pub fn last_error(&self) -> &str {
        &self.last_error
    }

    /// Live handles (for hosts deciding whether to keep ticking the pump).
    pub fn live(&self) -> usize {
        self.handles.values().filter(|h| !h.terminal).count()
    }

    fn refuse(&mut self, code: &str, message: impl Into<String>) -> i32 {
        self.last_error = format!("{}: {}", normalize_error_code(code), message.into());
        -1
    }

    /// `start(metaJson, body)` op: -1 with `lastError()` on refusal.
    pub fn start(&mut self, meta_json: &str, body: &[u8]) -> i32 {
        if self.live() >= self.limits.max_inflight {
            return self.refuse(spec::ERROR_RESOURCE_LIMIT, "too many requests in flight");
        }
        if body.len() > self.limits.max_request_bytes {
            return self.refuse(spec::ERROR_RESOURCE_LIMIT, "request body too large");
        }
        let meta: StartMeta = match serde_json::from_str(meta_json) {
            Ok(meta) => meta,
            Err(_) => return self.refuse(spec::ERROR_INVALID_REQUEST, "malformed request metadata"),
        };
        let (scheme, host, port) = match parse_url(&meta.url) {
            Some(parts) => parts,
            None => return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid url"),
        };
        if scheme != "http" && scheme != "https" {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "url must be http: or https:");
        }
        if scheme == "https" && !self.backend.supports_tls() {
            return self.refuse(spec::ERROR_UNSUPPORTED, "this host does not provide network.http.client.tls");
        }
        if !self.policy.allows_connect(scheme, &host, port) {
            return self.refuse(spec::ERROR_PERMISSION_DENIED, "endpoint is not an allowed connect rule");
        }
        // A literal address skips DNS: classify it now; the refusal arrives as
        // the asynchronous error event the dialer would raise (the C core
        // filters candidates the same way after its own resolve).
        let literal_refused = policy::parse_address(&host).is_some_and(|addr| !self.policy.allows_address(addr));
        if !is_token(&meta.method) {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid method");
        }
        let upper = meta.method.to_ascii_uppercase();
        if spec::METHODS_FORBIDDEN.contains(&upper.as_str()) {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "method not allowed");
        }
        if (upper == "GET" || upper == "HEAD") && !body.is_empty() {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "GET/HEAD cannot carry a body");
        }
        let mut headers = BTreeMap::new();
        let mut header_bytes = 0usize;
        for (name, value) in &meta.headers {
            let lower = name.to_ascii_lowercase();
            if !is_token(&lower) || value.bytes().any(|b| (b < 0x20 && b != b'\t') || b == 0x7f) {
                return self.refuse(spec::ERROR_INVALID_REQUEST, format!("invalid header {name}"));
            }
            if spec::HTTP_CORE_OWNED_REQUEST_HEADERS.contains(&lower.as_str()) {
                continue;
            }
            header_bytes += lower.len() + value.len() + 4;
            headers.insert(lower, value.clone());
            if headers.len() > self.limits.max_headers || header_bytes > self.limits.max_header_bytes {
                return self.refuse(spec::ERROR_RESOURCE_LIMIT, "request headers exceed limits");
            }
        }
        let queue_bytes = meta.queue_bytes.unwrap_or(self.limits.default_queue_bytes);
        if queue_bytes == 0 || queue_bytes > self.limits.max_queue_bytes {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid queueBytes");
        }
        let timeouts = meta.timeouts.unwrap_or_default();
        let bounded = |value: Option<u32>, fallback: u32| -> Option<u32> {
            match value {
                None => Some(fallback),
                Some(v) if v >= 1 && v <= self.limits.max_timeout_ms => Some(v),
                Some(_) => None,
            }
        };
        let (Some(connect_ms), Some(headers_ms), Some(idle_ms), Some(total_ms)) = (
            bounded(timeouts.connect_ms, self.limits.default_timeout_ms),
            bounded(timeouts.headers_ms, self.limits.default_timeout_ms),
            bounded(timeouts.idle_ms, self.limits.default_timeout_ms),
            bounded(timeouts.total_ms, self.limits.max_timeout_ms),
        ) else {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid timeouts");
        };
        let redirect = match meta.redirect.as_deref() {
            None | Some("follow") => RedirectMode::Follow,
            Some("manual") => RedirectMode::Manual,
            Some("error") => RedirectMode::Error,
            Some(_) => return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid redirect"),
        };
        let max_redirects = meta.max_redirects.unwrap_or(self.limits.max_redirects);
        if max_redirects > self.limits.max_redirects {
            return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid maxRedirects");
        }
        if let Some(tls) = &meta.tls {
            match tls.verification.as_deref() {
                None | Some("full") => {}
                Some("development-insecure") => {
                    if !self.development_build || !self.policy.allow_invalid_tls_for_development {
                        return self.refuse(spec::ERROR_UNSUPPORTED, "development-insecure TLS is not enabled");
                    }
                }
                Some(_) => return self.refuse(spec::ERROR_INVALID_REQUEST, "invalid tls.verification"),
            }
        }
        let handle = self.allocate_handle();
        let request = HttpRequest {
            handle,
            url: meta.url,
            method: meta.method,
            headers,
            body: body.to_vec(),
            connect_ms,
            headers_ms,
            idle_ms,
            total_ms,
            redirect,
            max_redirects,
            max_body_bytes: meta.max_body_bytes,
        };
        // Reserve the handle before the backend sees it so a completion
        // draining in the same tick cannot race the insertion.
        self.handles.insert(
            handle,
            Handle {
                head_pushed: false,
                terminal: false,
                queue_bytes,
                max_body_bytes: meta.max_body_bytes,
                body_total: 0,
                queue: VecDeque::new(),
                visible_bytes: 0,
                dirty: false,
                paused: false,
            },
        );
        self.gate.begin(handle, &request.url);
        if literal_refused {
            self.fail(handle, NetFailure::new(spec::ERROR_PERMISSION_DENIED, "resolved address is not permitted by the policy"));
            return handle;
        }
        if let Err(failure) = self.backend.start(request, self.gate.clone()) {
            self.handles.remove(&handle);
            self.gate.forget(handle);
            return self.refuse(&failure.code, failure.message);
        }
        handle
    }

    fn allocate_handle(&mut self) -> i32 {
        loop {
            let handle = self.next_handle;
            self.next_handle = if handle == i32::MAX { 1 } else { handle + 1 };
            if !self.handles.contains_key(&handle) {
                return handle;
            }
        }
    }

    /// `cancel(handle)` op: the terminal `error{cancelled}` arrives at the
    /// next tick; a handle that already ended releases its unread bytes.
    pub fn cancel(&mut self, handle: i32) {
        let Some(h) = self.handles.get(&handle) else { return };
        if h.terminal {
            self.handles.remove(&handle);
            self.gate.forget(handle);
            return;
        }
        self.backend.cancel(handle);
        self.fail(handle, NetFailure::new(spec::ERROR_CANCELLED, "cancelled"));
    }

    fn fail(&mut self, handle: i32, failure: NetFailure) {
        let Some(h) = self.handles.get_mut(&handle) else { return };
        if h.terminal {
            return;
        }
        h.terminal = true;
        h.queue.clear();
        h.visible_bytes = 0;
        h.dirty = false;
        let mut json = format!(
            "{{\"t\":\"error\",\"h\":{},\"code\":{},\"message\":{}",
            handle,
            json_string(&failure.code),
            json_string(&failure.message)
        );
        if let Some(cause) = &failure.cause {
            json.push_str(",\"causeCode\":");
            json.push_str(&json_string(cause));
        }
        json.push('}');
        self.pending.push_back(QueuedEvent { handle, barrier: true, weight: 0, json });
        // The handle stays until the terminal event was polled? No: errors
        // carry no bytes, so nothing remains to read; drop it now.
        self.handles.remove(&handle);
        self.gate.forget(handle);
    }

    /// Tick boundary: drain the backend, apply completions, freeze the
    /// visible set under the per-tick budget. Call before every `frame()`.
    pub fn begin_tick(&mut self) {
        let mut events = Vec::new();
        self.backend.drain(&mut events);
        for event in events {
            self.apply(event);
        }
        // Freeze readable watermarks (inserted before the handle's barrier).
        let dirty: Vec<i32> = self
            .handles
            .iter()
            .filter(|(_, h)| h.dirty && h.head_pushed)
            .map(|(k, _)| *k)
            .collect();
        for handle in dirty {
            let h = self.handles.get_mut(&handle).unwrap();
            h.dirty = false;
            h.visible_bytes = h.queue.len();
            let json = format!("{{\"t\":\"readable\",\"h\":{},\"avail\":{}}}", handle, h.visible_bytes);
            let ev = QueuedEvent { handle, barrier: false, weight: h.visible_bytes, json };
            let at = self.pending.iter().position(|e| e.handle == handle && e.barrier);
            match at {
                Some(i) => self.pending.insert(i, ev),
                None => self.pending.push_back(ev),
            }
        }
        // Budget: at least one event per tick, then cut on count or bytes.
        let mut events = 0usize;
        let mut bytes = 0usize;
        while let Some(front) = self.pending.front() {
            if events > 0 && (events >= self.limits.max_events_per_tick || bytes + front.weight > self.limits.max_tick_bytes) {
                break;
            }
            let ev = self.pending.pop_front().unwrap();
            events += 1;
            bytes += ev.weight;
            self.visible.push_back(ev);
        }
    }

    fn apply(&mut self, event: BackendEvent) {
        match event {
            BackendEvent::Headers { handle, status, url, headers, redirected, length } => {
                let Some(h) = self.handles.get(&handle) else { return };
                if h.terminal || h.head_pushed {
                    return;
                }
                if !(100..=599).contains(&status) || !is_http_url(&url) {
                    self.backend.cancel(handle);
                    self.fail(handle, NetFailure::new(spec::ERROR_PROTOCOL, "malformed response head"));
                    return;
                }
                // The response must come from the URL the gate last authorized
                // for this handle (the start URL, or the latest redirect hop the
                // backend asked the gate about), and `redirected` must say so.
                let authorized = self.gate.authorized_urls(handle);
                let expected = authorized.last().cloned().unwrap_or_default();
                if url != expected || redirected != (authorized.len() > 1) {
                    self.backend.cancel(handle);
                    self.fail(
                        handle,
                        NetFailure::new(spec::ERROR_PERMISSION_DENIED, "response from a URL the policy gate did not authorize"),
                    );
                    return;
                }
                let header_bytes: usize = headers.iter().map(|(k, v)| k.len() + v.len() + 4).sum();
                if headers.len() > self.limits.max_headers
                    || header_bytes > self.limits.max_header_bytes
                    || !headers.iter().all(|(k, v)| is_token(k) && !v.contains(['\r', '\n']))
                {
                    self.backend.cancel(handle);
                    self.fail(handle, NetFailure::new(spec::ERROR_PROTOCOL, "response headers exceed the portable contract"));
                    return;
                }
                if let (Some(len), Some(max)) = (length, h.max_body_bytes) {
                    if len > max as u64 {
                        self.backend.cancel(handle);
                        self.fail(handle, NetFailure::new(spec::ERROR_RESPONSE_TOO_LARGE, "response exceeds maxBodyBytes"));
                        return;
                    }
                }
                let mut json = format!("{{\"t\":\"headers\",\"h\":{},\"status\":{},\"url\":{},\"headers\":{{", handle, status, json_string(&url));
                let mut first = true;
                for (name, value) in &headers {
                    if !first {
                        json.push(',');
                    }
                    first = false;
                    json.push_str(&json_string(&name.to_ascii_lowercase()));
                    json.push(':');
                    json.push_str(&json_string(value));
                }
                json.push_str(&format!("}},\"redirected\":{}", redirected));
                if let Some(len) = length {
                    json.push_str(&format!(",\"length\":{len}"));
                }
                json.push('}');
                let weight = json.len();
                self.pending.push_back(QueuedEvent { handle, barrier: false, weight, json });
                self.handles.get_mut(&handle).unwrap().head_pushed = true;
            }
            BackendEvent::Body { handle, chunk } => {
                let Some(h) = self.handles.get_mut(&handle) else { return };
                if h.terminal || !h.head_pushed {
                    return;
                }
                if let Some(max) = h.max_body_bytes {
                    if h.body_total + chunk.len() > max {
                        self.backend.cancel(handle);
                        self.fail(handle, NetFailure::new(spec::ERROR_RESPONSE_TOO_LARGE, "response exceeds maxBodyBytes"));
                        return;
                    }
                }
                h.body_total += chunk.len();
                h.queue.extend(chunk);
                h.dirty = true;
                if h.queue.len() >= h.queue_bytes && !h.paused {
                    h.paused = true;
                    self.backend.set_paused(handle, true);
                }
            }
            BackendEvent::End { handle } => {
                let Some(h) = self.handles.get_mut(&handle) else { return };
                if h.terminal {
                    return;
                }
                if !h.head_pushed {
                    self.fail(handle, NetFailure::new(spec::ERROR_PROTOCOL, "end before headers"));
                    return;
                }
                h.terminal = true;
                let json = format!("{{\"t\":\"end\",\"h\":{handle}}}");
                self.pending.push_back(QueuedEvent { handle, barrier: true, weight: 0, json });
                if h.queue.is_empty() && !h.dirty {
                    self.handles.remove(&handle);
                    self.gate.forget(handle);
                }
            }
            BackendEvent::Error { handle, failure } => self.fail(handle, failure),
        }
    }

    /// `poll()` op: the visible batch as one JSON array, or None.
    pub fn poll(&mut self) -> Option<String> {
        if self.visible.is_empty() {
            return None;
        }
        let mut out = String::from("[");
        let mut first = true;
        while let Some(ev) = self.visible.pop_front() {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(&ev.json);
        }
        out.push(']');
        Some(out)
    }

    /// `readInto(handle, buffer)` op: copies visible bytes; -1 for an unknown
    /// or fully drained terminal handle, 0 when nothing is visible yet.
    pub fn read_into(&mut self, handle: i32, into: &mut [u8]) -> i32 {
        let Some(h) = self.handles.get_mut(&handle) else { return -1 };
        if !h.head_pushed {
            return -1;
        }
        let want = into.len().min(h.visible_bytes);
        for (i, slot) in into.iter_mut().take(want).enumerate() {
            *slot = h.queue[i];
        }
        h.queue.drain(..want);
        h.visible_bytes -= want;
        if h.paused && h.queue.len() < h.queue_bytes {
            h.paused = false;
            self.backend.set_paused(handle, false);
        }
        if h.terminal && h.queue.is_empty() && !h.dirty {
            self.handles.remove(&handle);
            self.gate.forget(handle);
        }
        want as i32
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b > 0x20 && b < 0x7f && !b"()<>@,;:\\\"/[]?={}".contains(&b))
}

fn is_http_url(url: &str) -> bool {
    parse_url(url).is_some_and(|(scheme, _, _)| scheme == "http" || scheme == "https")
}

/// (scheme, lowercased host, effective port) for http/https/ws/wss URLs.
fn parse_url(url: &str) -> Option<(&'static str, String, u16)> {
    let (scheme_raw, rest) = url.split_once("://")?;
    let scheme: &'static str = match scheme_raw.to_ascii_lowercase().as_str() {
        "http" => "http",
        "https" => "https",
        "ws" => "ws",
        "wss" => "wss",
        _ => return None,
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
        return None;
    }
    let default_port = if scheme == "https" || scheme == "wss" { 443 } else { 80 };
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let end = stripped.find(']')?;
        let host = &stripped[..end];
        let after = &stripped[end + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse::<u16>().ok()?,
            None if after.is_empty() => default_port,
            None => return None,
        };
        (host.to_string(), port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        (host.to_string(), port.parse::<u16>().ok()?)
    } else {
        (authority.to_string(), default_port)
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, host.to_ascii_lowercase(), port))
}

fn json_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".into())
}

/// Clamp a code onto the shared vocabulary; unknown codes become `other`.
pub fn normalize_error_code(code: &str) -> &'static str {
    match code {
        spec::ERROR_INVALID_REQUEST => spec::ERROR_INVALID_REQUEST,
        spec::ERROR_INVALID_STATE => spec::ERROR_INVALID_STATE,
        spec::ERROR_UNSUPPORTED => spec::ERROR_UNSUPPORTED,
        spec::ERROR_PERMISSION_DENIED => spec::ERROR_PERMISSION_DENIED,
        spec::ERROR_BUSY => spec::ERROR_BUSY,
        spec::ERROR_RESOURCE_LIMIT => spec::ERROR_RESOURCE_LIMIT,
        spec::ERROR_DNS => spec::ERROR_DNS,
        spec::ERROR_CONNECT => spec::ERROR_CONNECT,
        spec::ERROR_ADDRESS_IN_USE => spec::ERROR_ADDRESS_IN_USE,
        spec::ERROR_CLOSED => spec::ERROR_CLOSED,
        spec::ERROR_TIMEOUT => spec::ERROR_TIMEOUT,
        spec::ERROR_TLS_CERTIFICATE_INVALID => spec::ERROR_TLS_CERTIFICATE_INVALID,
        spec::ERROR_TLS_HOSTNAME_MISMATCH => spec::ERROR_TLS_HOSTNAME_MISMATCH,
        spec::ERROR_TLS_HANDSHAKE_FAILED => spec::ERROR_TLS_HANDSHAKE_FAILED,
        spec::ERROR_TLS_CLOCK_UNTRUSTED => spec::ERROR_TLS_CLOCK_UNTRUSTED,
        spec::ERROR_REDIRECT => spec::ERROR_REDIRECT,
        spec::ERROR_RESPONSE_TOO_LARGE => spec::ERROR_RESPONSE_TOO_LARGE,
        spec::ERROR_PROTOCOL => spec::ERROR_PROTOCOL,
        spec::ERROR_WEBSOCKET_HANDSHAKE_FAILED => spec::ERROR_WEBSOCKET_HANDSHAKE_FAILED,
        spec::ERROR_WEBSOCKET_PROTOCOL_ERROR => spec::ERROR_WEBSOCKET_PROTOCOL_ERROR,
        spec::ERROR_MESSAGE_TOO_LARGE => spec::ERROR_MESSAGE_TOO_LARGE,
        spec::ERROR_CANCELLED => spec::ERROR_CANCELLED,
        spec::ERROR_UNAVAILABLE => spec::ERROR_UNAVAILABLE,
        _ => spec::ERROR_OTHER,
    }
}

// ---------------------------------------------------------------------------
// Mount (rquickjs)
// ---------------------------------------------------------------------------

#[cfg(feature = "mount")]
use anyhow::Result;
#[cfg(feature = "mount")]
use pocket_mod::Guest;
#[cfg(feature = "mount")]
use pocket_mod::qjs::{ArrayBuffer, Function, Value};
#[cfg(feature = "mount")]
use std::cell::RefCell;
#[cfg(feature = "mount")]
use std::rc::Rc;

/// Clone-cheap mounted NET module. The host keeps a copy and calls
/// [`begin_tick`](Self::begin_tick) before every frame; the namespace closures
/// share the core.
#[cfg(feature = "mount")]
pub struct NetSurface<B: HttpClientBackend> {
    inner: Rc<RefCell<NetCore<B>>>,
}

#[cfg(feature = "mount")]
impl<B: HttpClientBackend> Clone for NetSurface<B> {
    fn clone(&self) -> Self {
        Self { inner: self.inner.clone() }
    }
}

#[cfg(feature = "mount")]
impl<B: HttpClientBackend + 'static> NetSurface<B> {
    pub fn new(core: NetCore<B>) -> Self {
        Self { inner: Rc::new(RefCell::new(core)) }
    }

    pub fn begin_tick(&self) {
        self.inner.borrow_mut().begin_tick();
    }

    pub fn with_core<R>(&self, f: impl FnOnce(&mut NetCore<B>) -> R) -> R {
        f(&mut self.inner.borrow_mut())
    }

    /// Mount the six v2 ops of `contracts/spec/net.ts` on `globalThis.net`.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("net", |ctx, ns| {
            let core = self.inner.clone();
            ns.set(
                "start",
                Function::new(ctx.clone(), move |meta: String, body: Value| -> i32 {
                    let bytes: Vec<u8> = if body.is_null() || body.is_undefined() {
                        Vec::new()
                    } else if let Some(buffer) = body.as_object().and_then(|o| ArrayBuffer::from_object(o.clone())) {
                        match buffer.as_bytes() {
                            Some(b) => b.to_vec(),
                            None => {
                                core.borrow_mut().last_error = format!("{}: detached request body", spec::ERROR_INVALID_STATE);
                                return -1;
                            }
                        }
                    } else {
                        core.borrow_mut().last_error = format!("{}: body must be an ArrayBuffer or null", spec::ERROR_INVALID_REQUEST);
                        return -1;
                    };
                    core.borrow_mut().start(&meta, &bytes)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "cancel",
                Function::new(ctx.clone(), move |handle: i32| core.borrow_mut().cancel(handle))?,
            )?;

            let core = self.inner.clone();
            ns.set("poll", Function::new(ctx.clone(), move || core.borrow_mut().poll())?)?;

            let core = self.inner.clone();
            ns.set(
                "lastError",
                Function::new(ctx.clone(), move || core.borrow().last_error().to_string())?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "readInto",
                Function::new(ctx.clone(), move |handle: i32, into: ArrayBuffer, offset: f64, length: f64| -> i32 {
                    let Some(raw) = into.as_raw() else { return -1 };
                    let (offset, length) = (offset as usize, length as usize);
                    if offset > raw.len || length > raw.len - offset {
                        return -1;
                    }
                    // QuickJS owns this mutable ArrayBuffer for the duration
                    // of the synchronous call; rquickjs exposes the raw span
                    // but cannot express JS mutability as &mut.
                    let bytes = unsafe { std::slice::from_raw_parts_mut(raw.ptr.as_ptr().add(offset), length) };
                    core.borrow_mut().read_into(handle, bytes)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "limits",
                Function::new(ctx.clone(), move || core.borrow().limits().to_string())?,
            )?;
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Fixture {
        started: Vec<HttpRequest>,
        gates: Vec<PolicyGate>,
        cancelled: Vec<i32>,
        queue: VecDeque<BackendEvent>,
        paused: Vec<(i32, bool)>,
        refuse: bool,
    }

    impl HttpClientBackend for Fixture {
        fn start(&mut self, request: HttpRequest, gate: PolicyGate) -> Result<(), NetFailure> {
            if self.refuse {
                return Err(NetFailure::new(spec::ERROR_RESOURCE_LIMIT, "no sockets"));
            }
            self.started.push(request);
            self.gates.push(gate);
            Ok(())
        }
        fn cancel(&mut self, handle: i32) {
            self.cancelled.push(handle);
        }
        fn drain(&mut self, out: &mut Vec<BackendEvent>) {
            out.extend(self.queue.drain(..));
        }
        fn set_paused(&mut self, handle: i32, paused: bool) {
            self.paused.push((handle, paused));
        }
    }

    fn core() -> NetCore<Fixture> {
        NetCore::new(Fixture::default(), NetPolicy::permissive())
    }

    fn headers(handle: i32, length: Option<u64>) -> BackendEvent {
        let mut h = BTreeMap::new();
        h.insert("content-type".to_string(), "text/plain".to_string());
        BackendEvent::Headers { handle, status: 200, url: "http://example.test/".into(), headers: h, redirected: false, length }
    }

    const META: &str = r#"{"url":"http://example.test/","method":"GET","headers":{"x-a":"1"}}"#;

    #[test]
    fn events_become_visible_only_at_the_tick_boundary_in_order() {
        let mut core = core();
        let h = core.start(META, &[]);
        assert!(h > 0);
        assert_eq!(core.backend_mut().started[0].headers.get("x-a").map(String::as_str), Some("1"));
        core.backend_mut().queue.push_back(headers(h, Some(5)));
        core.backend_mut().queue.push_back(BackendEvent::Body { handle: h, chunk: b"hello".to_vec() });
        core.backend_mut().queue.push_back(BackendEvent::End { handle: h });
        assert_eq!(core.poll(), None, "nothing visible before begin_tick");
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert_eq!(
            batch,
            format!(
                "[{{\"t\":\"headers\",\"h\":{h},\"status\":200,\"url\":\"http://example.test/\",\"headers\":{{\"content-type\":\"text/plain\"}},\"redirected\":false,\"length\":5}},{{\"t\":\"readable\",\"h\":{h},\"avail\":5}},{{\"t\":\"end\",\"h\":{h}}}]"
            )
        );
        let mut buf = [0u8; 8];
        assert_eq!(core.read_into(h, &mut buf), 5);
        assert_eq!(&buf[..5], b"hello");
        assert_eq!(core.read_into(h, &mut buf), -1, "drained terminal handle retires");
        assert_eq!(core.live(), 0);
    }

    #[test]
    fn readable_watermark_is_frozen_per_tick_and_backpressure_pauses() {
        let mut core = NetCore::with_limits(
            Fixture::default(),
            NetPolicy::permissive(),
            NetLimits { max_queue_bytes: 4, default_queue_bytes: 4, ..NetLimits::default() },
        );
        let h = core.start(META, &[]);
        core.backend_mut().queue.push_back(headers(h, None));
        core.backend_mut().queue.push_back(BackendEvent::Body { handle: h, chunk: b"abcd".to_vec() });
        core.begin_tick();
        assert!(core.poll().unwrap().contains("\"avail\":4"));
        assert_eq!(core.backend_mut().paused, vec![(h, true)]);
        // Bytes arriving after the boundary are not visible yet.
        core.backend_mut().queue.push_back(BackendEvent::Body { handle: h, chunk: b"ef".to_vec() });
        let mut buf = [0u8; 8];
        assert_eq!(core.read_into(h, &mut buf), 4);
        assert_eq!(core.backend_mut().paused.last(), Some(&(h, false)));
        core.begin_tick();
        assert!(core.poll().unwrap().contains("\"avail\":2"));
        assert_eq!(core.read_into(h, &mut buf), 2);
        assert_eq!(&buf[..2], b"ef");
    }

    #[test]
    fn synchronous_refusals_and_policy() {
        let mut core = core();
        assert_eq!(core.start(r#"{"url":"https://example.test/","method":"GET"}"#, &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_UNSUPPORTED));
        assert_eq!(core.start(r#"{"url":"http://example.test/","method":"TRACE"}"#, &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        assert_eq!(core.start(r#"{"url":"http://example.test/","method":"GET","bogus":1}"#, &[]), -1);
        assert_eq!(core.start(META, b"x"), -1, "GET with a body");
        let strict = NetPolicy::parse(r#"{"connect":[{"protocol":"http","host":"*.devices.test","port":{"min":8000,"max":8100}}],"insecureTransport":true}"#).unwrap();
        let mut core = NetCore::new(Fixture::default(), strict);
        assert!(core.start(r#"{"url":"http://a.devices.test:8050/","method":"GET"}"#, &[]) > 0);
        assert_eq!(core.start(r#"{"url":"http://a.b.devices.test:8050/","method":"GET"}"#, &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_PERMISSION_DENIED));
        let closed = NetPolicy::parse(r#"{"connect":[{"protocol":"http","host":"h","port":80}]}"#).unwrap();
        let mut core = NetCore::new(Fixture::default(), closed);
        assert_eq!(core.start(r#"{"url":"http://h/","method":"GET"}"#, &[]), -1, "insecureTransport off");
        let mut core = NetCore::new(Fixture { refuse: true, ..Default::default() }, NetPolicy::permissive());
        assert_eq!(core.start(META, &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_RESOURCE_LIMIT));
        assert_eq!(core.live(), 0, "refused starts do not hold a handle");
    }

    #[test]
    fn cancel_and_late_completions() {
        let mut core = core();
        let h = core.start(META, &[]);
        core.cancel(h);
        assert_eq!(core.backend_mut().cancelled, vec![h]);
        core.backend_mut().queue.push_back(headers(h, Some(1)));
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert!(batch.contains("\"code\":\"cancelled\""));
        assert!(!batch.contains("\"t\":\"headers\""), "late completion discarded");
        assert_eq!(core.poll(), None);
    }

    #[test]
    fn budget_truncation_preserves_order_across_ticks() {
        let mut core = NetCore::with_limits(
            Fixture::default(),
            NetPolicy::permissive(),
            NetLimits { max_events_per_tick: 2, ..NetLimits::default() },
        );
        let h = core.start(META, &[]);
        core.backend_mut().queue.push_back(headers(h, Some(2)));
        core.backend_mut().queue.push_back(BackendEvent::Body { handle: h, chunk: b"ab".to_vec() });
        core.backend_mut().queue.push_back(BackendEvent::End { handle: h });
        core.begin_tick();
        let first = core.poll().unwrap();
        assert!(first.contains("\"t\":\"headers\"") && first.contains("\"t\":\"readable\"") && !first.contains("\"t\":\"end\""));
        core.begin_tick();
        assert!(core.poll().unwrap().contains("\"t\":\"end\""));
    }

    #[test]
    fn limits_report_the_spec_major_and_features() {
        let core = core();
        assert!(core.limits().contains("\"specMajor\":2"));
        assert!(core.limits().contains("\"features\":[]"));
    }

    #[test]
    fn literal_addresses_are_classified_without_dns() {
        let strict = NetPolicy::parse(
            r#"{"version":1,"connect":[{"protocol":"http","host":"10.0.0.5","port":80},{"protocol":"http","host":"93.184.216.34","port":80}],"insecureTransport":true,"localNetwork":false}"#,
        )
        .unwrap();
        let mut core = NetCore::new(Fixture::default(), strict);
        // Private literal under localNetwork:false: admitted synchronously,
        // refused with the asynchronous permission_denied the dialer raises.
        let h = core.start(r#"{"url":"http://10.0.0.5/","method":"GET"}"#, &[]);
        assert!(h > 0);
        assert!(core.backend_mut().started.is_empty(), "the backend never sees it");
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert!(batch.contains("\"code\":\"permission_denied\""), "{batch}");
        // A public literal starts.
        assert!(core.start(r#"{"url":"http://93.184.216.34/","method":"GET"}"#, &[]) > 0);
        assert_eq!(core.backend_mut().started.len(), 1);
    }

    #[test]
    fn the_gate_decides_addresses_redirects_and_tls_and_the_core_checks_the_response_url() {
        let policy = NetPolicy::parse(
            r#"{"version":1,"connect":[{"protocol":"http","host":"example.test","port":80},{"protocol":"http","host":"next.test","port":80},{"protocol":"https","host":"secure.test","port":443}],"insecureTransport":true,"localNetwork":false}"#,
        )
        .unwrap();
        let mut core = NetCore::new(Fixture::default(), policy);
        let h = core.start(r#"{"url":"http://example.test/start","method":"POST","headers":{}}"#, b"body");
        assert!(h > 0);
        let gate = core.backend_mut().gates[0].clone();
        // Addresses: public yes, private no, multicast never.
        assert!(gate.authorize_address("93.184.216.34".parse().unwrap()).is_ok());
        assert_eq!(gate.authorize_address("10.1.2.3".parse().unwrap()).unwrap_err().code, spec::ERROR_PERMISSION_DENIED);
        assert_eq!(gate.authorize_address("224.0.0.1".parse().unwrap()).unwrap_err().code, spec::ERROR_PERMISSION_DENIED);
        // Redirects: the spec table (302 POST → GET without body), the
        // endpoint policy on the target, the budget, the scheme, TLS.
        assert_eq!(
            gate.authorize_redirect(h, "http://example.test/start", "POST", 302, Some("http://next.test/landed"), 3, RedirectMode::Follow),
            Ok(RedirectPlan::Follow { url: "http://next.test/landed".into(), method: "GET".into(), drop_body: true })
        );
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/landed", "GET", 307, Some("/again?x=1"), 2, RedirectMode::Follow),
            Ok(RedirectPlan::Follow { url: "http://next.test/again?x=1".into(), method: "GET".into(), drop_body: false })
        );
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/a", "GET", 301, Some("http://evil.test/"), 1, RedirectMode::Follow).unwrap_err().code,
            spec::ERROR_PERMISSION_DENIED
        );
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/a", "GET", 301, Some("http://next.test/b"), 0, RedirectMode::Follow).unwrap_err().code,
            spec::ERROR_REDIRECT
        );
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/a", "GET", 301, Some("https://secure.test/"), 1, RedirectMode::Follow).unwrap_err().code,
            spec::ERROR_UNSUPPORTED,
            "https without a TLS-capable backend"
        );
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/a", "GET", 301, Some("ftp://next.test/"), 1, RedirectMode::Follow).unwrap_err().code,
            spec::ERROR_REDIRECT
        );
        assert_eq!(gate.authorize_redirect(h, "http://next.test/a", "GET", 200, None, 1, RedirectMode::Follow), Ok(RedirectPlan::Deliver));
        assert_eq!(gate.authorize_redirect(h, "http://next.test/a", "GET", 302, Some("/x"), 1, RedirectMode::Manual), Ok(RedirectPlan::Deliver));
        assert_eq!(
            gate.authorize_redirect(h, "http://next.test/a", "GET", 302, Some("/x"), 1, RedirectMode::Error).unwrap_err().code,
            spec::ERROR_REDIRECT
        );
        // TLS: verify unless policy + build + request all ask otherwise.
        assert!(gate.tls_verification("secure.test", true).verify_peer);
        assert_eq!(gate.tls_verification("secure.test", false).min_version, spec::TLS_MIN_VERSION);
        // The core accepts the response only from the last authorized hop,
        // and only with `redirected` set.
        let mut h2 = BTreeMap::new();
        h2.insert("content-type".to_string(), "text/plain".to_string());
        core.backend_mut().queue.push_back(BackendEvent::Headers {
            handle: h,
            status: 200,
            url: "http://elsewhere.test/".into(),
            headers: h2.clone(),
            redirected: true,
            length: Some(0),
        });
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert!(batch.contains("\"code\":\"permission_denied\""), "{batch}");
        // A fresh request answered from an authorized hop passes.
        let h = core.start(r#"{"url":"http://example.test/start","method":"GET","headers":{}}"#, &[]);
        let gate = core.backend_mut().gates.last().unwrap().clone();
        gate.authorize_redirect(h, "http://example.test/start", "GET", 301, Some("http://next.test/landed"), 5, RedirectMode::Follow).unwrap();
        core.backend_mut().queue.push_back(BackendEvent::Headers {
            handle: h,
            status: 200,
            url: "http://next.test/landed".into(),
            headers: h2,
            redirected: true,
            length: Some(0),
        });
        core.backend_mut().queue.push_back(BackendEvent::End { handle: h });
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert!(batch.contains("\"t\":\"headers\"") && batch.contains("\"redirected\":true"), "{batch}");
    }

    #[derive(Deserialize)]
    struct PolicyVectors {
        policies: BTreeMap<String, serde_json::Value>,
        invalid: Vec<InvalidVector>,
        connect: Vec<ConnectVector>,
        address: Vec<AddressVector>,
        listen: Vec<ListenVector>,
    }
    #[derive(Deserialize)]
    struct InvalidVector {
        name: String,
        policy: serde_json::Value,
    }
    #[derive(Deserialize)]
    struct ConnectVector {
        policy: String,
        protocol: String,
        host: String,
        port: u16,
        allowed: bool,
    }
    #[derive(Deserialize)]
    struct AddressVector {
        address: String,
        public: bool,
        multicast: bool,
    }
    #[derive(Deserialize)]
    struct ListenVector {
        policy: String,
        protocol: String,
        address: String,
        port: u16,
        allowed: bool,
    }

    #[test]
    fn shared_policy_vectors() {
        let vectors: PolicyVectors =
            serde_json::from_str(include_str!("../../../../contracts/spec/vectors/network-policy.json")).unwrap();
        let mut policies = BTreeMap::new();
        for (name, doc) in &vectors.policies {
            policies.insert(name.clone(), NetPolicy::parse(&doc.to_string()).unwrap_or_else(|e| panic!("{name}: {e}")));
        }
        for v in &vectors.invalid {
            assert!(NetPolicy::parse(&v.policy.to_string()).is_err(), "invalid vector accepted: {}", v.name);
        }
        for v in &vectors.connect {
            let policy = &policies[&v.policy];
            assert_eq!(policy.allows_connect(&v.protocol, &v.host, v.port), v.allowed, "connect {:?}", (&v.policy, &v.protocol, &v.host, v.port));
        }
        let open = &policies["standard"];
        let closed = &policies["secure-only"];
        for v in &vectors.address {
            let addr = policy::parse_address(&v.address).unwrap_or_else(|| panic!("{}", v.address));
            assert_eq!(policy::address_is_public(addr), v.public, "{}", v.address);
            assert_eq!(policy::address_is_multicast(addr), v.multicast, "{}", v.address);
            assert_eq!(closed.allows_address(addr), v.public, "{}", v.address);
            assert_eq!(open.allows_address(addr), !v.multicast, "{}", v.address);
        }
        for v in &vectors.listen {
            let policy = &policies[&v.policy];
            assert_eq!(policy.allows_listen(&v.protocol, &v.address, v.port), v.allowed, "listen {:?}", (&v.policy, &v.protocol, &v.address, v.port));
        }
    }

    #[derive(Deserialize)]
    struct SemanticsVectors {
        methods: Vec<MethodVector>,
        #[serde(rename = "requestHeaders")]
        request_headers: Vec<HeaderVector>,
        status: Vec<StatusVector>,
        redirect: Vec<RedirectVector>,
    }
    #[derive(Deserialize)]
    struct MethodVector {
        method: String,
        accepted: bool,
    }
    #[derive(Deserialize)]
    struct HeaderVector {
        name: String,
        #[serde(rename = "coreOwned")]
        core_owned: bool,
    }
    #[derive(Deserialize)]
    struct StatusVector {
        status: u16,
        #[serde(rename = "bodylessFraming")]
        bodyless_framing: bool,
        #[serde(rename = "nullBody")]
        null_body: bool,
    }
    #[derive(Deserialize)]
    struct RedirectVector {
        status: u16,
        method: String,
        followed: bool,
        #[serde(rename = "nextMethod")]
        next_method: Option<String>,
        #[serde(rename = "keepBody")]
        keep_body: Option<bool>,
    }

    #[test]
    fn shared_http_semantics_vectors() {
        let vectors: SemanticsVectors =
            serde_json::from_str(include_str!("../../../../contracts/spec/vectors/http-semantics.json")).unwrap();
        for v in &vectors.methods {
            let mut core = core();
            let meta = serde_json::json!({"url": "http://example.test/", "method": v.method, "headers": {}}).to_string();
            let h = core.start(&meta, &[]);
            assert_eq!(h > 0, v.accepted, "method {:?}", v.method);
        }
        for v in &vectors.request_headers {
            let mut core = core();
            let meta = serde_json::json!({"url": "http://example.test/", "method": "GET", "headers": {v.name.clone(): "v"}}).to_string();
            assert!(core.start(&meta, &[]) > 0);
            let sent = &core.backend_mut().started[0].headers;
            assert_eq!(!sent.contains_key(&v.name.to_ascii_lowercase()), v.core_owned, "header {}", v.name);
        }
        for v in &vectors.status {
            let framing = (100..200).contains(&v.status) || spec::HTTP_BODYLESS_STATUS.contains(&v.status);
            assert_eq!(framing, v.bodyless_framing, "framing {}", v.status);
            assert_eq!(spec::HTTP_NULL_BODY_STATUS.contains(&v.status), v.null_body, "null body {}", v.status);
        }
        let gate = PolicyGate::new(NetPolicy::permissive(), false);
        for v in &vectors.redirect {
            gate.begin(1, "http://example.test/a");
            let plan = gate.authorize_redirect(1, "http://example.test/a", &v.method, v.status, Some("http://example.test/b"), 5, RedirectMode::Follow);
            match plan {
                Ok(RedirectPlan::Follow { method, drop_body, .. }) => {
                    assert!(v.followed, "{} {} followed", v.status, v.method);
                    assert_eq!(&method, v.next_method.as_ref().unwrap(), "{} {}", v.status, v.method);
                    assert_eq!(!drop_body, v.keep_body.unwrap(), "{} {} body", v.status, v.method);
                }
                Ok(RedirectPlan::Deliver) => assert!(!v.followed, "{} {} delivered", v.status, v.method),
                Err(e) => panic!("{} {}: {:?}", v.status, v.method, e.code),
            }
        }
    }

    #[cfg(feature = "mount")]
    #[test]
    fn mounts_the_v2_ops() {
        use pocket_mod::qjs::Ctx;
        let surface = NetSurface::new(core());
        let guest = Guest::new().unwrap();
        surface.mount(&guest).unwrap();
        guest.eval("t", "globalThis.h = net.start(JSON.stringify({url:'http://example.test/',method:'GET',headers:{}}), null);").unwrap();
        let h: i32 = guest.with(|ctx: Ctx| ctx.globals().get("h").unwrap());
        assert!(h > 0);
        surface.with_core(|c| {
            c.backend_mut().queue.push_back(headers(h, Some(3)));
            c.backend_mut().queue.push_back(BackendEvent::Body { handle: h, chunk: b"abc".to_vec() });
            c.backend_mut().queue.push_back(BackendEvent::End { handle: h });
        });
        surface.begin_tick();
        guest
            .eval(
                "t",
                "const batch = JSON.parse(net.poll()); const buf = new ArrayBuffer(8); globalThis.n = net.readInto(globalThis.h, buf, 1, 4); globalThis.s = String.fromCharCode(...new Uint8Array(buf, 1, 3)); globalThis.k = batch.map(e => e.t).join(',');",
            )
            .unwrap();
        let (n, s, k): (i32, String, String) = guest.with(|ctx: Ctx| {
            let g = ctx.globals();
            (g.get("n").unwrap(), g.get("s").unwrap(), g.get("k").unwrap())
        });
        assert_eq!((n, s.as_str(), k.as_str()), (3, "abc", "headers,readable,end"));
    }
}
