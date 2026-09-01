//! `pocket-net` — the transport-neutral core and mounted surface for the
//! PocketJS NET module (`contracts/spec/net.ts`).
//!
//! This crate owns handles, validation, limits, tick-boundary event batches,
//! response-body ownership and portable errors. It deliberately owns no DNS,
//! socket, TLS, HTTP parser, executor or thread. A runtime supplies an
//! [`HttpTransport`] implemented with the platform facility it already owns
//! (for example ESP-IDF HTTP, ureq, NSURLSession, or an application service).
//! The transport may work on other threads, but [`NetCore::begin_tick`] is
//! the only point at which its completions enter the single-threaded core.
//!
//! Feature `mount` (default) adds [`NetSurface`], the pocket-mod adapter that
//! installs the five ops as `globalThis.net`. A host with its own QuickJS
//! wiring turns it off (`default-features = false`) and drives [`NetCore`]
//! directly — the MCU build then never compiles an engine it doesn't use.

use std::collections::{BTreeMap, HashMap};

use pocketjs_core::spec::net as spec;
use serde::{Deserialize, Serialize};

/// Fully validated request handed to a host-owned transport. The body is an
/// owned copy; a transport may move it to a worker without retaining JS data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpRequest {
    pub handle: i32,
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
    pub timeout_ms: u32,
    pub max_bytes: usize,
    pub max_redirects: usize,
}

/// Normalized failure crossing from a host transport into the core.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetFailure {
    pub code: String,
    pub message: String,
}

impl NetFailure {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: normalize_error_code(&code.into()).to_string(),
            message: message.into(),
        }
    }
}

/// A transport completion. Response headers must already be normalized to
/// lowercase, with repeated fields combined according to that transport's
/// HTTP implementation. Cookie storage is outside the v1 contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TransportCompletion {
    Done {
        handle: i32,
        status: u16,
        url: String,
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    },
    Error {
        handle: i32,
        failure: NetFailure,
    },
}

/// The only host-specific boundary in the reference implementation.
///
/// `start` must return promptly after handing work to its native async
/// mechanism or worker. `drain` is called once at a host tick boundary and
/// must not block. Neither method may call into QuickJS.
pub trait HttpTransport {
    fn start(&mut self, request: HttpRequest) -> std::result::Result<(), NetFailure>;
    fn cancel(&mut self, handle: i32);
    fn drain(&mut self, completions: &mut Vec<TransportCompletion>);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestMeta {
    url: String,
    method: String,
    headers: BTreeMap<String, String>,
    timeout_ms: u32,
    max_bytes: usize,
}

#[derive(Serialize)]
#[serde(tag = "t")]
enum GuestEvent {
    #[serde(rename = "done")]
    Done {
        #[serde(rename = "h")]
        handle: i32,
        status: u16,
        url: String,
        headers: BTreeMap<String, String>,
        bytes: usize,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "h")]
        handle: i32,
        code: String,
        message: String,
    },
}

struct Inflight {
    max_bytes: usize,
}

/// Transport-neutral NET state machine. It is intentionally independent of
/// QuickJS; [`NetSurface`] below is only the namespace adapter.
pub struct NetCore<T: HttpTransport> {
    transport: T,
    inflight: HashMap<i32, Inflight>,
    bodies: HashMap<i32, Vec<u8>>,
    visible: Vec<GuestEvent>,
    next_handle: i32,
    last_error: String,
}

impl<T: HttpTransport> NetCore<T> {
    pub fn new(transport: T) -> Self {
        Self {
            transport,
            inflight: HashMap::new(),
            bodies: HashMap::new(),
            visible: Vec::new(),
            next_handle: 1,
            last_error: String::new(),
        }
    }

    /// Mutable transport access is for host wiring and tests (for example to
    /// push channel-backed completions); it never exposes guest state.
    pub fn transport_mut(&mut self) -> &mut T {
        &mut self.transport
    }

    pub fn start(&mut self, meta_json: &str, body: &[u8]) -> i32 {
        match self.try_start(meta_json, body) {
            Ok(handle) => handle,
            Err(failure) => {
                self.last_error = format!("{}: {}", failure.code, failure.message);
                -1
            }
        }
    }

    fn try_start(&mut self, meta_json: &str, body: &[u8]) -> std::result::Result<i32, NetFailure> {
        if self.inflight.len() >= spec::MAX_INFLIGHT {
            return Err(NetFailure::new(
                spec::ERROR_BUSY,
                format!("at most {} requests may be in flight", spec::MAX_INFLIGHT),
            ));
        }
        if body.len() > spec::MAX_REQUEST_BYTES {
            return Err(invalid("request body exceeds 64 KiB"));
        }
        let meta: RequestMeta =
            serde_json::from_str(meta_json).map_err(|_| invalid("malformed request metadata"))?;
        validate_meta(&meta, body)?;

        let handle = self.allocate_handle();
        let request = HttpRequest {
            handle,
            url: meta.url,
            method: meta.method,
            headers: meta.headers,
            body: body.to_vec(),
            timeout_ms: meta.timeout_ms,
            max_bytes: meta.max_bytes,
            max_redirects: spec::MAX_REDIRECTS,
        };
        let max_bytes = request.max_bytes;
        // Reserve before submit so a transport that queues work immediately
        // cannot race the accounting boundary. Roll back on refusal.
        self.inflight.insert(handle, Inflight { max_bytes });
        if let Err(failure) = self.transport.start(request) {
            self.inflight.remove(&handle);
            return Err(failure);
        }
        Ok(handle)
    }

    fn allocate_handle(&mut self) -> i32 {
        loop {
            let handle = self.next_handle;
            self.next_handle = if self.next_handle == i32::MAX {
                1
            } else {
                self.next_handle + 1
            };
            if !self.inflight.contains_key(&handle) && !self.bodies.contains_key(&handle) {
                return handle;
            }
        }
    }

    /// Drain non-blocking transport completions at a host tick boundary.
    /// Call before the corresponding guest `frame()`; `poll()` during that
    /// turn sees the resulting batch and never sees mid-tick transport state.
    pub fn begin_tick(&mut self) {
        let mut completions = Vec::new();
        self.transport.drain(&mut completions);
        for completion in completions {
            self.complete(completion);
        }
    }

    fn complete(&mut self, completion: TransportCompletion) {
        match completion {
            TransportCompletion::Done {
                handle,
                status,
                url,
                headers,
                body,
            } => {
                let Some(request) = self.inflight.remove(&handle) else {
                    return; // cancelled, stale or duplicate completion
                };
                let header_bytes = header_bytes(&headers);
                let protocol_error = if !(100..=599).contains(&status) {
                    Some("invalid HTTP status")
                } else if !is_http_url(&url) {
                    Some("invalid final URL")
                } else if headers.len() > spec::MAX_HEADERS
                    || header_bytes > spec::MAX_HEADER_BYTES
                    || !valid_headers(&headers)
                {
                    Some("response headers exceed the portable contract")
                } else {
                    None
                };
                if let Some(message) = protocol_error {
                    self.push_error(handle, spec::ERROR_PROTOCOL, message);
                } else if body.len() > request.max_bytes || body.len() > spec::MAX_RESPONSE_BYTES {
                    self.push_error(
                        handle,
                        spec::ERROR_RESPONSE_TOO_LARGE,
                        format!("response exceeded {} bytes", request.max_bytes),
                    );
                } else {
                    let bytes = body.len();
                    self.bodies.insert(handle, body);
                    self.visible.push(GuestEvent::Done {
                        handle,
                        status,
                        url,
                        headers,
                        bytes,
                    });
                }
            }
            TransportCompletion::Error { handle, failure } => {
                if self.inflight.remove(&handle).is_none() {
                    return;
                }
                self.push_error(handle, &failure.code, failure.message);
            }
        }
    }

    fn push_error(&mut self, handle: i32, code: &str, message: impl Into<String>) {
        self.visible.push(GuestEvent::Error {
            handle,
            code: normalize_error_code(code).to_string(),
            message: message.into(),
        });
    }

    pub fn cancel(&mut self, handle: i32) {
        self.transport.cancel(handle);
        self.inflight.remove(&handle);
        self.bodies.remove(&handle);
        self.visible.retain(|event| match event {
            GuestEvent::Done { handle: h, .. } | GuestEvent::Error { handle: h, .. } => {
                *h != handle
            }
        });
    }

    pub fn take(&mut self, handle: i32) -> Option<Vec<u8>> {
        self.bodies.remove(&handle)
    }

    pub fn take_into(&mut self, handle: i32, into: &mut [u8]) -> i32 {
        let Some(body) = self.bodies.get(&handle) else {
            return -1;
        };
        if body.len() != into.len() {
            return -1;
        }
        into.copy_from_slice(body);
        self.bodies.remove(&handle);
        into.len() as i32
    }

    /// Drain the whole tick batch in one serialization and one FFI crossing.
    pub fn poll(&mut self) -> Option<String> {
        if self.visible.is_empty() {
            return None;
        }
        let events = std::mem::take(&mut self.visible);
        Some(serde_json::to_string(&events).expect("GuestEvent serialization is infallible"))
    }

    pub fn last_error(&self) -> &str {
        &self.last_error
    }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

#[cfg(feature = "mount")]
use std::cell::RefCell;
#[cfg(feature = "mount")]
use std::rc::Rc;

#[cfg(feature = "mount")]
use anyhow::Result;
#[cfg(feature = "mount")]
use pocket_mod::Guest;
#[cfg(feature = "mount")]
use pocket_mod::qjs::{ArrayBuffer, Function};

/// Clone-cheap mounted NET module. The host keeps a copy and calls
/// [`begin_tick`](Self::begin_tick); the namespace closures share the core.
/// Feature `mount` (default); a host with its own QuickJS wiring turns it
/// off and drives [`NetCore`] directly, spelling the five ops itself.
#[cfg(feature = "mount")]
pub struct NetSurface<T: HttpTransport> {
    inner: Rc<RefCell<NetCore<T>>>,
}

#[cfg(feature = "mount")]
impl<T: HttpTransport> Clone for NetSurface<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

#[cfg(feature = "mount")]
impl<T: HttpTransport + 'static> NetSurface<T> {
    pub fn new(transport: T) -> Self {
        Self {
            inner: Rc::new(RefCell::new(NetCore::new(transport))),
        }
    }

    pub fn begin_tick(&self) {
        self.inner.borrow_mut().begin_tick();
    }

    pub fn with_core<R>(&self, f: impl FnOnce(&mut NetCore<T>) -> R) -> R {
        f(&mut self.inner.borrow_mut())
    }

    /// Mount exactly the five ops pinned in `contracts/spec/net.ts`.
    pub fn mount(&self, guest: &Guest) -> Result<()> {
        guest.mount("net", |ctx, ns| {
            let core = self.inner.clone();
            ns.set(
                "start",
                Function::new(ctx.clone(), move |meta: String, body: ArrayBuffer| {
                    let Some(bytes) = body.as_bytes() else {
                        core.borrow_mut().last_error =
                            format!("{}: detached request body", spec::ERROR_INVALID_REQUEST);
                        return -1;
                    };
                    core.borrow_mut().start(&meta, bytes)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "take",
                Function::new(ctx.clone(), move |handle: i32, into: ArrayBuffer| {
                    let Some(raw) = into.as_raw() else {
                        return -1;
                    };
                    // QuickJS owns this mutable ArrayBuffer for the duration
                    // of the synchronous call. rquickjs exposes its raw span
                    // but intentionally cannot express JS mutability as &mut.
                    let bytes =
                        unsafe { std::slice::from_raw_parts_mut(raw.ptr.as_ptr(), raw.len) };
                    core.borrow_mut().take_into(handle, bytes)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "cancel",
                Function::new(ctx.clone(), move |handle: i32| {
                    core.borrow_mut().cancel(handle)
                })?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "poll",
                Function::new(ctx.clone(), move || core.borrow_mut().poll())?,
            )?;

            let core = self.inner.clone();
            ns.set(
                "lastError",
                Function::new(ctx.clone(), move || core.borrow().last_error().to_string())?,
            )?;
            Ok(())
        })
    }
}

fn invalid(message: impl Into<String>) -> NetFailure {
    NetFailure::new(spec::ERROR_INVALID_REQUEST, message)
}

fn is_http_url(url: &str) -> bool {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"));
    matches!(rest, Some(value) if !value.is_empty()
        && !value.starts_with('/')
        && !value.bytes().any(|b| b.is_ascii_whitespace()))
}

fn header_bytes(headers: &BTreeMap<String, String>) -> usize {
    headers
        .iter()
        .map(|(name, value)| name.len() + value.len() + 4)
        .sum()
}

fn valid_headers(headers: &BTreeMap<String, String>) -> bool {
    headers.iter().all(|(name, value)| {
        !name.is_empty()
            && name.bytes().all(|b| {
                b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(
                        b,
                        b'!' | b'#'
                            | b'$'
                            | b'%'
                            | b'&'
                            | b'\''
                            | b'*'
                            | b'+'
                            | b'-'
                            | b'.'
                            | b'^'
                            | b'_'
                            | b'`'
                            | b'|'
                            | b'~'
                    )
            })
            && !value.contains(['\r', '\n'])
    })
}

fn validate_meta(meta: &RequestMeta, body: &[u8]) -> std::result::Result<(), NetFailure> {
    if !is_http_url(&meta.url) {
        return Err(invalid("url must be absolute http:// or https://"));
    }
    if !spec::METHODS.contains(&meta.method.as_str()) {
        return Err(invalid(format!("unsupported method {}", meta.method)));
    }
    if matches!(meta.method.as_str(), "GET" | "HEAD") && !body.is_empty() {
        return Err(invalid(format!("{} cannot have a body", meta.method)));
    }
    if meta.timeout_ms == 0 || meta.timeout_ms > spec::MAX_TIMEOUT_MS {
        return Err(invalid(format!(
            "timeoutMs must be 1..{}",
            spec::MAX_TIMEOUT_MS
        )));
    }
    if meta.max_bytes == 0 || meta.max_bytes > spec::MAX_RESPONSE_BYTES {
        return Err(invalid(format!(
            "maxBytes must be 1..{}",
            spec::MAX_RESPONSE_BYTES
        )));
    }
    if meta.headers.len() > spec::MAX_HEADERS
        || header_bytes(&meta.headers) > spec::MAX_HEADER_BYTES
        || !valid_headers(&meta.headers)
    {
        return Err(invalid("request headers exceed the portable contract"));
    }
    Ok(())
}

fn normalize_error_code(code: &str) -> &'static str {
    match code {
        spec::ERROR_UNAVAILABLE => spec::ERROR_UNAVAILABLE,
        spec::ERROR_INVALID_REQUEST => spec::ERROR_INVALID_REQUEST,
        spec::ERROR_BUSY => spec::ERROR_BUSY,
        spec::ERROR_DNS => spec::ERROR_DNS,
        spec::ERROR_CONNECT => spec::ERROR_CONNECT,
        spec::ERROR_TLS => spec::ERROR_TLS,
        spec::ERROR_TIMEOUT => spec::ERROR_TIMEOUT,
        spec::ERROR_REDIRECT => spec::ERROR_REDIRECT,
        spec::ERROR_RESPONSE_TOO_LARGE => spec::ERROR_RESPONSE_TOO_LARGE,
        spec::ERROR_PROTOCOL => spec::ERROR_PROTOCOL,
        spec::ERROR_CANCELLED => spec::ERROR_CANCELLED,
        _ => spec::ERROR_OTHER,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct FixtureTransport {
        started: Vec<HttpRequest>,
        cancelled: Vec<i32>,
        completions: VecDeque<TransportCompletion>,
    }

    impl HttpTransport for FixtureTransport {
        fn start(&mut self, request: HttpRequest) -> std::result::Result<(), NetFailure> {
            self.started.push(request);
            Ok(())
        }

        fn cancel(&mut self, handle: i32) {
            self.cancelled.push(handle);
        }

        fn drain(&mut self, completions: &mut Vec<TransportCompletion>) {
            completions.extend(self.completions.drain(..));
        }
    }

    fn meta(max_bytes: usize) -> String {
        format!(
            r#"{{"url":"https://example.test/a","method":"GET","headers":{{}},"timeoutMs":30000,"maxBytes":{max_bytes}}}"#
        )
    }

    #[test]
    fn accepted_request_is_owned_and_only_visible_at_tick_boundary() {
        let mut core = NetCore::new(FixtureTransport::default());
        let handle = core.start(&meta(16), &[]);
        assert_eq!(handle, 1);
        assert!(core.poll().is_none());
        assert_eq!(
            core.transport_mut().started[0].max_redirects,
            spec::MAX_REDIRECTS
        );

        core.transport_mut()
            .completions
            .push_back(TransportCompletion::Done {
                handle,
                status: 200,
                url: "https://example.test/a".into(),
                headers: BTreeMap::from([("content-type".into(), "text/plain".into())]),
                body: b"hello".to_vec(),
            });
        assert!(core.poll().is_none());
        core.begin_tick();
        let batch = core.poll().unwrap();
        assert_eq!(
            batch,
            r#"[{"t":"done","h":1,"status":200,"url":"https://example.test/a","headers":{"content-type":"text/plain"},"bytes":5}]"#
        );
        assert_eq!(core.take(handle).as_deref(), Some(&b"hello"[..]));
        assert!(core.take(handle).is_none());
    }

    #[test]
    fn limit_is_checked_again_after_transport_completion() {
        let mut core = NetCore::new(FixtureTransport::default());
        let handle = core.start(&meta(4), &[]);
        core.transport_mut()
            .completions
            .push_back(TransportCompletion::Done {
                handle,
                status: 200,
                url: "https://example.test/a".into(),
                headers: BTreeMap::new(),
                body: b"12345".to_vec(),
            });
        core.begin_tick();
        assert!(
            core.poll()
                .unwrap()
                .contains(spec::ERROR_RESPONSE_TOO_LARGE)
        );
        assert!(core.take(handle).is_none());
    }

    #[test]
    fn rejects_invalid_and_excess_inflight_requests_synchronously() {
        let mut core = NetCore::new(FixtureTransport::default());
        assert_eq!(core.start("{}", &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_INVALID_REQUEST));
        assert!(core.start(&meta(16), &[]) > 0);
        assert!(core.start(&meta(16), &[]) > 0);
        assert_eq!(core.start(&meta(16), &[]), -1);
        assert!(core.last_error().starts_with(spec::ERROR_BUSY));
    }

    #[test]
    fn cancellation_discards_late_completion() {
        let mut core = NetCore::new(FixtureTransport::default());
        let handle = core.start(&meta(16), &[]);
        core.cancel(handle);
        core.transport_mut()
            .completions
            .push_back(TransportCompletion::Error {
                handle,
                failure: NetFailure::new(spec::ERROR_TIMEOUT, "late"),
            });
        core.begin_tick();
        assert!(core.poll().is_none());
        assert_eq!(core.transport_mut().cancelled, vec![handle]);
    }

    #[cfg(feature = "mount")]
    #[test]
    fn mounted_surface_copies_into_guest_owned_arraybuffer() {
        let guest = Guest::new().unwrap();
        let surface = NetSurface::new(FixtureTransport::default());
        surface.mount(&guest).unwrap();
        let source = format!(
            "globalThis.h = net.start({}, new ArrayBuffer(0)); globalThis.before = net.poll();",
            serde_json::to_string(&meta(16)).unwrap()
        );
        guest.eval("start", &source).unwrap();
        let handle: i32 = guest.with(|ctx| ctx.globals().get("h").unwrap());
        let before: Option<String> = guest.with(|ctx| ctx.globals().get("before").unwrap());
        assert_eq!(handle, 1);
        assert!(before.is_none());

        surface.with_core(|core| {
            core.transport_mut()
                .completions
                .push_back(TransportCompletion::Done {
                    handle,
                    status: 200,
                    url: "https://example.test/a".into(),
                    headers: BTreeMap::new(),
                    body: vec![7, 8, 9],
                });
        });
        surface.begin_tick();
        guest
            .eval(
                "take",
                "const e = JSON.parse(net.poll())[0];\
                 const out = new ArrayBuffer(e.bytes);\
                 globalThis.copied = net.take(e.h, out);\
                 globalThis.first = new Uint8Array(out)[0];\
                 globalThis.again = net.take(e.h, out);",
            )
            .unwrap();
        let values: (i32, i32, i32) = guest.with(|ctx| {
            let g = ctx.globals();
            (
                g.get("copied").unwrap(),
                g.get("first").unwrap(),
                g.get("again").unwrap(),
            )
        });
        assert_eq!(values, (3, 7, -1));
    }
}
