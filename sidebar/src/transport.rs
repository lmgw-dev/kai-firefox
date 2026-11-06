//! The kit's `Transport` over the background's `kai-sidebar` port (design §8.2; lmgw's chat-plane
//! design §8.9; docs/protocol/operations.md, "The page's port"). Every request of the Chat goes
//! as a `req` frame to the background, which relays it to Kai, which sends it to lmgw with its own
//! certificate; `crate::wire` maps the frames, this module keeps the port and the open requests.
//!
//! - **No link of its own:** `link` answers `None`, so pictures, recordings and downloads come as
//!   bytes and show by object URLs.
//! - **Acks:** a whole answer's pieces are acknowledged as they come off the port; a stream's as its
//!   consumer takes them from the [`ByteStream`], which is the one place that may pace Kai.
//! - **Cancel:** the request's `AbortSignal`, dropping `send`'s future before it answered, and
//!   dropping a stream before its end each send `abort` (lmgw sees the connection go: a send's
//!   turn stops as the dashboard's Stop stops it). The error then says "cancelled"; the Chat asks
//!   the signal, not the words (lmgw's D28).
//! - **The link:** the background says whether Kai is linked (`link {up}`); [`Status::locked`] is
//!   true while it is not (or the port is down), which closes the Chat's feed and opens it again
//!   when Kai is back. A port that drops (the background suspended, the extension reloaded) ends
//!   every open request and is opened again after 1 s, doubling to 30 s, since the page cannot
//!   know when the background is back; a refused one is not (the reason is shown).
//! - **Kai left its lmgw** (`gateway_left`): said in [`Status::gateway_left`], which the page
//!   shows with a way to reload.
//! - **The feed's cursor** (`wire::FeedCursor`): kept as the Chat takes the feed's pieces, each
//!   feed stream reading its records with a `wire::FeedReader` of its own. The Chat closes its feed
//!   while `locked` and opens a new one without a cursor when the link is back, so a feed it opens
//!   without `Last-Event-ID` gets the kept cursor and resumes where it stood (lmgw names what
//!   changed meanwhile). One lmgw cannot read (`400`) is asked again at once without it, and the
//!   cursor is dropped, as the Chat drops its own; Kai leaving its lmgw drops it too.
//!
//! Besides lmgw's requests the page asks the background a few things of its own ([`Relay::call`]:
//! the site's rule, the page's text, the hints), answered by `answer` frames.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::pin::Pin;
use std::rc::{Rc, Weak};
use std::task::{Context, Poll, Waker};

use futures::Stream;
use futures::channel::oneshot;
use futures::future::LocalBoxFuture;
use leptos::prelude::*;
use lmgw_ui_kit::http::{Body, Request, Response, Transport, blob_bytes};
use serde_json::{Map, Value, json};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::ext;
use crate::wire::{self, Core, FeedCursor, FeedReader, FrameBody, FromBackground, Out, WireError};

/// The port's name the background takes from the sidebar page only (design §4.4).
pub const PORT: &str = "kai-sidebar";
/// The first wait before the port is opened again, and the longest.
const RETRY_FIRST_MS: i32 = 1000;
const RETRY_MAX_MS: i32 = 30_000;

/// What the page shows of the port and the link.
#[derive(Clone, Copy)]
pub struct Status {
    /// The port to the background is open.
    pub port: RwSignal<bool>,
    /// Kai is linked, as the background last said (`None` before it said).
    pub link: RwSignal<Option<bool>>,
    /// The background refused this page's port: why.
    pub refused: RwSignal<Option<String>>,
    /// Kai left the lmgw this Chat came from (a re-pair, a revoked key): its words.
    pub gateway_left: RwSignal<Option<String>>,
    /// lmgw answered `401 session_required`, which Kai's device certificate should never get.
    pub unauthorized: RwSignal<bool>,
}

impl Status {
    /// The Chat's `locked`: no port, no link, or lmgw refused the device.
    pub fn locked(self) -> Signal<bool> {
        Signal::derive(move || {
            !self.port.get() || self.link.get() != Some(true) || self.unauthorized.get()
        })
    }
}

/// A stream's pieces as they come, for its consumer.
#[derive(Default)]
struct Queue {
    pieces: VecDeque<(u64, Vec<u8>)>,
    end: Option<Result<(), String>>,
    waker: Option<Waker>,
}

impl Queue {
    fn wake(&mut self) {
        if let Some(w) = self.waker.take() {
            w.wake();
        }
    }
}

type Answer = oneshot::Sender<Result<Response, String>>;
/// A request's signal and the listener that aborts it.
type Listener = (web_sys::AbortSignal, Closure<dyn FnMut()>);
/// The port's message and disconnect callbacks.
type Callbacks = (Closure<dyn FnMut(String)>, Closure<dyn FnMut(String)>);

#[derive(Default)]
struct State {
    port: Option<JsValue>,
    core: Core,
    next_id: u64,
    /// `send` futures waiting for their answer (a whole one, or a stream's head).
    waiting: HashMap<u64, Answer>,
    /// Streams handed out, by id.
    streams: HashMap<u64, Rc<RefCell<Queue>>>,
    /// The page's own calls to the background.
    calls: HashMap<u64, oneshot::Sender<Result<Value, WireError>>>,
    /// The abort listener on each request's signal.
    listeners: HashMap<u64, Listener>,
    /// The port's two callbacks, kept while it is open.
    callbacks: Option<Callbacks>,
    retry_ms: i32,
    refused: bool,
    /// Where the feed stands, as the Chat took it.
    cursor: FeedCursor,
    /// The open requests that are feeds.
    feeds: std::collections::HashSet<u64>,
}

struct Inner {
    st: RefCell<State>,
    status: Status,
}

/// The sidebar's transport and its port: one per page.
#[derive(Clone)]
pub struct Relay(Rc<Inner>);

impl Relay {
    /// Opens the port. Call inside the page's reactive owner (the status signals live there).
    pub fn open() -> Self {
        let relay = Relay(Rc::new(Inner {
            st: RefCell::new(State {
                next_id: 1,
                retry_ms: RETRY_FIRST_MS,
                ..Default::default()
            }),
            status: Status {
                port: RwSignal::new(false),
                link: RwSignal::new(None),
                refused: RwSignal::new(None),
                gateway_left: RwSignal::new(None),
                unauthorized: RwSignal::new(false),
            },
        }));
        relay.connect();
        relay
    }

    pub fn status(&self) -> Status {
        self.0.status
    }

    fn weak(&self) -> Weak<Inner> {
        Rc::downgrade(&self.0)
    }

    fn connect(&self) {
        let me = self.weak();
        let on_message = Closure::<dyn FnMut(String)>::new(move |text: String| {
            if let Some(i) = me.upgrade() {
                Relay(i).message(&text);
            }
        });
        let me = self.weak();
        let on_disconnect = Closure::<dyn FnMut(String)>::new(move |why: String| {
            if let Some(i) = me.upgrade() {
                Relay(i).disconnected(&why);
            }
        });
        let port = ext::connect(PORT, &on_message, &on_disconnect);
        let mut st = self.0.st.borrow_mut();
        st.port = Some(port);
        st.callbacks = Some((on_message, on_disconnect));
        drop(st);
        self.0.status.port.set(true);
    }

    fn post(&self, frame: &Value) -> bool {
        let port = self.0.st.borrow().port.clone();
        port.is_some_and(|p| ext::post(&p, &frame.to_string()))
    }

    /// One of the page's own calls to the background (`{t, id, …fields}`), answered by an
    /// `answer` frame; ends with the port.
    pub async fn call(&self, t: &str, fields: Value) -> Result<Value, WireError> {
        let (id, rx) = {
            let mut st = self.0.st.borrow_mut();
            if st.port.is_none() {
                return Err(WireError::new(
                    "no_port",
                    "the sidebar is not connected to Kai for Firefox's background",
                ));
            }
            let id = st.next_id;
            st.next_id += 1;
            let (tx, rx) = oneshot::channel();
            st.calls.insert(id, tx);
            (id, rx)
        };
        let mut frame = match fields {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        frame.insert("t".into(), json!(t));
        frame.insert("id".into(), json!(id));
        if !self.post(&Value::Object(frame)) {
            self.0.st.borrow_mut().calls.remove(&id);
            return Err(WireError::new(
                "no_port",
                "the sidebar's port to the background closed",
            ));
        }
        rx.await.unwrap_or_else(|_| {
            Err(WireError::new(
                "no_port",
                "the sidebar's port to the background closed",
            ))
        })
    }

    fn message(&self, text: &str) {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            leptos::logging::warn!(
                "Kai's sidebar: a message from the background that is no JSON; ignored"
            );
            return;
        };
        let status = self.0.status;
        match FromBackground::read(&v) {
            FromBackground::Link { up } => {
                self.0.st.borrow_mut().retry_ms = RETRY_FIRST_MS;
                if up {
                    status.unauthorized.set(false);
                }
                status.link.set(Some(up));
            }
            FromBackground::Refused { reason } => {
                self.0.st.borrow_mut().refused = true;
                status.refused.set(Some(reason));
            }
            FromBackground::Answer { id, result } => {
                if let Some(tx) = self.0.st.borrow_mut().calls.remove(&id) {
                    let _ = tx.send(result);
                }
            }
            FromBackground::Unknown(t) => {
                leptos::logging::log!("Kai's sidebar: a {t} message from the background; ignored");
            }
            frame => {
                let outs = self.0.st.borrow_mut().core.take(frame);
                self.apply(outs);
            }
        }
    }

    /// Carries out what [`Core`] said.
    fn apply(&self, outs: Vec<Out>) {
        for out in outs {
            match out {
                Out::Whole {
                    id,
                    status,
                    headers,
                    body,
                } => {
                    let tx = self.0.st.borrow_mut().waiting.remove(&id);
                    self.finish(id);
                    if let Some(tx) = tx {
                        let _ = tx.send(Ok(Response::whole(status, headers, body)));
                    }
                }
                Out::Head {
                    id,
                    status,
                    headers,
                } => {
                    let q = Rc::new(RefCell::new(Queue::default()));
                    let tx = {
                        let mut st = self.0.st.borrow_mut();
                        st.streams.insert(id, q.clone());
                        st.waiting.remove(&id)
                    };
                    let feed = self
                        .0
                        .st
                        .borrow()
                        .feeds
                        .contains(&id)
                        .then(FeedReader::default);
                    let stream = Pieces {
                        relay: self.weak(),
                        id,
                        q,
                        over: false,
                        feed,
                    };
                    match tx {
                        Some(tx) => {
                            let _ =
                                tx.send(Ok(Response::streamed(status, headers, Box::pin(stream))));
                        }
                        // Nobody waits: dropping the stream aborts it.
                        None => drop(stream),
                    }
                }
                Out::Piece { id, seq, bytes } => {
                    let q = self.0.st.borrow().streams.get(&id).cloned();
                    if let Some(q) = q {
                        let mut q = q.borrow_mut();
                        q.pieces.push_back((seq, bytes));
                        q.wake();
                    }
                }
                Out::StreamEnd { id, result } => {
                    let q = self.0.st.borrow_mut().streams.remove(&id);
                    self.finish(id);
                    if let Some(q) = q {
                        let mut q = q.borrow_mut();
                        q.end = Some(result);
                        q.wake();
                    }
                }
                Out::Failed { id, error } => {
                    let tx = self.0.st.borrow_mut().waiting.remove(&id);
                    self.finish(id);
                    if let Some(tx) = tx {
                        let _ = tx.send(Err(error));
                    }
                }
                Out::Ack { id, seq } => {
                    self.post(&json!({"t": "ack", "id": id, "seq": seq}));
                }
                Out::Abort { id } => {
                    self.finish(id);
                    self.post(&json!({"t": "abort", "id": id}));
                }
                Out::GatewayLeft { message } => {
                    self.0.st.borrow_mut().cursor.clear();
                    self.0.status.gateway_left.set(Some(message));
                }
            }
        }
    }

    /// The request `id` ended: its signal's listener goes.
    fn finish(&self, id: u64) {
        self.0.st.borrow_mut().feeds.remove(&id);
        let gone = self.0.st.borrow_mut().listeners.remove(&id);
        if let Some((signal, cb)) = gone {
            let _ =
                signal.remove_event_listener_with_callback("abort", cb.as_ref().unchecked_ref());
        }
    }

    /// The page dropped request `id` (its signal, a dropped future or stream): it ends with `why`
    /// here, and Kai is told once.
    fn abort(&self, id: u64, why: &str) {
        let (was, tx, q) = {
            let mut st = self.0.st.borrow_mut();
            (
                st.core.forget(id),
                st.waiting.remove(&id),
                st.streams.remove(&id),
            )
        };
        self.finish(id);
        if let Some(tx) = tx {
            let _ = tx.send(Err(why.to_string()));
        }
        if let Some(q) = q {
            let mut q = q.borrow_mut();
            q.end = Some(Err(why.to_string()));
            q.wake();
        }
        if was {
            self.post(&json!({"t": "abort", "id": id}));
        }
    }

    /// The Chat took a piece of a feed stream (`reader`, the stream's own): where the feed stands
    /// moves.
    fn took_feed(&self, reader: &mut FeedReader, bytes: &[u8]) {
        reader.push(bytes, &mut self.0.st.borrow_mut().cursor);
    }

    /// The cursor to resume a feed the Chat opens without one, if any.
    fn feed_resume(&self) -> Option<String> {
        self.0.st.borrow().cursor.get().map(str::to_string)
    }

    fn drop_cursor(&self) {
        self.0.st.borrow_mut().cursor.clear();
    }

    /// A stream's consumer took pieces up to `seq` (exclusive).
    fn ack(&self, id: u64, seq: u64) {
        if self.0.st.borrow().core.is_open(id) {
            self.post(&json!({"t": "ack", "id": id, "seq": seq}));
        }
    }

    fn disconnected(&self, why: &str) {
        let why = if why.is_empty() {
            "the sidebar's port to Kai for Firefox's background closed".to_string()
        } else {
            format!("the sidebar's port to Kai for Firefox's background closed: {why}")
        };
        let (outs, calls, again) = {
            let mut st = self.0.st.borrow_mut();
            st.port = None;
            // The callbacks may not be dropped while one of them runs (this one): later.
            let cbs = st.callbacks.take();
            let me = cbs;
            wasm_bindgen_futures::spawn_local(async move { drop(me) });
            let outs = st.core.close_all(&why);
            let calls: Vec<_> = st.calls.drain().map(|(_, tx)| tx).collect();
            let again = (!st.refused).then(|| {
                let wait = st.retry_ms;
                st.retry_ms = (st.retry_ms * 2).min(RETRY_MAX_MS);
                wait
            });
            (outs, calls, again)
        };
        self.apply(outs);
        for tx in calls {
            let _ = tx.send(Err(WireError::new("no_port", why.clone())));
        }
        self.0.status.port.set(false);
        self.0.status.link.set(None);
        if let Some(ms) = again {
            let me = self.weak();
            let cb = Closure::once_into_js(move || {
                if let Some(i) = me.upgrade() {
                    Relay(i).connect();
                }
            });
            let _ = web_sys::window().map(|w| {
                w.set_timeout_with_callback_and_timeout_and_arguments_0(cb.unchecked_ref(), ms)
            });
        }
    }

    /// Registers request `req` (its body ready) and posts its frame; its answer comes on the
    /// receiver.
    fn start(
        &self,
        req: &Request,
        body: &FrameBody,
    ) -> Result<(u64, oneshot::Receiver<Result<Response, String>>), String> {
        let (id, rx) = {
            let mut st = self.0.st.borrow_mut();
            if st.port.is_none() {
                return Err(if st.refused {
                    "Kai for Firefox's background refused this page".into()
                } else {
                    "the sidebar is not connected to Kai for Firefox's background".into()
                });
            }
            let id = st.next_id;
            st.next_id += 1;
            st.core.open(id, req.read);
            if wire::is_feed(req.method, &req.path) {
                st.feeds.insert(id);
            }
            let (tx, rx) = oneshot::channel();
            st.waiting.insert(id, tx);
            (id, rx)
        };
        if let Some(signal) = &req.signal {
            let me = self.weak();
            let cb = Closure::<dyn FnMut()>::new(move || {
                if let Some(i) = me.upgrade() {
                    Relay(i).abort(id, "cancelled");
                }
            });
            let _ = signal.add_event_listener_with_callback("abort", cb.as_ref().unchecked_ref());
            self.0
                .st
                .borrow_mut()
                .listeners
                .insert(id, (signal.clone(), cb));
        }
        let frame = wire::req_frame(id, req.method, &req.path, &req.headers, body, req.read);
        if !self.post(&frame) {
            self.abort(id, "the sidebar's port to the background closed");
            return Err("the sidebar's port to the background closed".into());
        }
        Ok((id, rx))
    }
}

/// Aborts its request when dropped while armed: `send`'s future dropped before it answered.
struct Armed {
    relay: Weak<Inner>,
    id: u64,
    armed: bool,
}

impl Drop for Armed {
    fn drop(&mut self) {
        if self.armed
            && let Some(i) = self.relay.upgrade()
        {
            Relay(i).abort(self.id, "cancelled");
        }
    }
}

impl Transport for Relay {
    fn send(&self, req: Request) -> LocalBoxFuture<'static, Result<Response, String>> {
        let me = self.clone();
        Box::pin(async move {
            let aborted = |r: &Request| r.signal.as_ref().is_some_and(|s| s.aborted());
            if aborted(&req) {
                return Err("cancelled".into());
            }
            let body = match &req.body {
                Body::Empty => FrameBody::Empty,
                Body::Json(t) => FrameBody::Json(t.clone()),
                Body::Bytes(b) => FrameBody::Bytes {
                    bytes: b.clone(),
                    blob_type: None,
                },
                // A frame carries bytes: a picked file is read (lmgw's §8.9), its type kept.
                Body::Blob(b) => FrameBody::Bytes {
                    bytes: blob_bytes(b).await?,
                    blob_type: Some(b.type_()),
                },
            };
            // A feed the Chat opens afresh resumes from where the last one stood.
            let feed = wire::is_feed(req.method, &req.path);
            let resume = if feed {
                let kept = me.feed_resume();
                req.header_value("last-event-id")
                    .is_none()
                    .then_some(kept)
                    .flatten()
            } else {
                None
            };
            let mut tries = match resume {
                Some(c) => vec![req.clone().header("last-event-id", &c), req],
                None => vec![req],
            };
            loop {
                let one = tries.remove(0);
                if aborted(&one) {
                    return Err("cancelled".into());
                }
                let (id, rx) = me.start(&one, &body)?;
                let mut armed = Armed {
                    relay: me.weak(),
                    id,
                    armed: true,
                };
                let answer = rx.await.unwrap_or_else(|_| Err("cancelled".into()));
                // Answered: a whole answer and a failure have ended the request, and a stream's
                // own drop aborts it from now on.
                armed.armed = false;
                match answer {
                    // lmgw could not read the cursor the page added: dropped, asked again
                    // without it (the Chat's own rule for its cursor).
                    Ok(r) if r.status == 400 && !tries.is_empty() => {
                        me.drop_cursor();
                        drop(r);
                    }
                    other => return other,
                }
            }
        })
    }
}

/// A stream's pieces for its consumer, acknowledged as they are taken; dropped before its end, it
/// aborts its request.
struct Pieces {
    relay: Weak<Inner>,
    id: u64,
    q: Rc<RefCell<Queue>>,
    over: bool,
    /// The Chat's feed: this stream's records, read as its pieces are taken, move the cursor.
    feed: Option<FeedReader>,
}

impl Stream for Pieces {
    type Item = Result<Vec<u8>, String>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if self.over {
            return Poll::Ready(None);
        }
        let mut q = self.q.borrow_mut();
        if let Some((seq, bytes)) = q.pieces.pop_front() {
            drop(q);
            if let Some(i) = self.relay.upgrade() {
                let relay = Relay(i);
                let id = self.id;
                if let Some(reader) = self.feed.as_mut() {
                    relay.took_feed(reader, &bytes);
                }
                relay.ack(id, seq + 1);
            }
            return Poll::Ready(Some(Ok(bytes)));
        }
        match q.end.take() {
            Some(Ok(())) => {
                drop(q);
                self.over = true;
                Poll::Ready(None)
            }
            Some(Err(e)) => {
                drop(q);
                self.over = true;
                Poll::Ready(Some(Err(e)))
            }
            None => {
                q.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl Drop for Pieces {
    fn drop(&mut self) {
        if !self.over
            && let Some(i) = self.relay.upgrade()
        {
            Relay(i).abort(self.id, "cancelled");
        }
    }
}

/// The kit's `401 session_required` hook (`http::Config::on_unauthorized`, a plain `fn`): lmgw
/// refused Kai's device, which the page says; it reads the relay's status from its thread-local.
pub fn unauthorized() {
    STATUS.with(|s| {
        if let Some(s) = s.borrow().as_ref() {
            s.unauthorized.set(true);
        }
    });
}

thread_local! {
    static STATUS: RefCell<Option<Status>> = const { RefCell::new(None) };
}

/// Keeps `status` for [`unauthorized`].
pub fn keep_status(status: Status) {
    STATUS.with(|s| *s.borrow_mut() = Some(status));
}

thread_local! {
    static RELAY: RefCell<Option<Relay>> = const { RefCell::new(None) };
}

impl Relay {
    /// Keeps this relay as the page's (a `Rc` cannot go into Leptos' context, which wants `Send`).
    pub fn keep(&self) {
        RELAY.with(|r| *r.borrow_mut() = Some(self.clone()));
    }

    /// The page's relay ([`Relay::keep`]).
    pub fn current() -> Relay {
        RELAY
            .with(|r| r.borrow().clone())
            .expect("the page keeps its relay before it renders")
    }
}
