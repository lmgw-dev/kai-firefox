//! The sidebar's side of the wire to the background (docs/protocol/operations.md, "The sidebar's
//! requests" and "The page's port"), without a browser: a kit [`Request`] as a `req` frame, the
//! background's frames read, and the bookkeeping of the open requests ([`Core`]), which says what
//! to answer, what to acknowledge and when a request ends. `crate::transport` drives it over the
//! real port; the tests here run natively (`cargo test` in `sidebar/`).
//!
//! The rules it keeps:
//! - `read`: `Read::Stream` is `"stream"`, `Read::Whole` and `Read::Blob` are `"whole"`.
//! - Bodies: JSON as text with `content-type: application/json` unless the request names one;
//!   bytes (a file, a recording, a picked `Blob` read first) as base64, their type the request's
//!   header, else the blob's own. A request's headers go with their names in lower case; Kai
//!   admits `content-type` and `last-event-id` and refuses any other with a visible 400, so none is
//!   dropped here.
//! - A whole answer is gathered here and each of its pieces acknowledged as it is taken from the
//!   port (Kai keeps at most `browser.sidebar_ahead_mb` unacknowledged, so an answer acked only once
//!   complete would wait forever past that window). A stream's pieces are acknowledged by its
//!   consumer as it takes them (`crate::transport`), which is the one place that may pace Kai.
//! - An `end` with an error before the `res` is "no answer" (`send`'s `Err`); after the `res` it is
//!   the stream's error, or, for a whole answer, again `send`'s `Err`. Kai's `gateway_left` is said
//!   to the user besides ([`Out::GatewayLeft`]).
//! - The feed's cursor ([`FeedCursor`]): the page keeps where its feed stands, as the Chat does
//!   (lmgw's chat-plane design §8.3: each record's `id:`, and `hello`'s and `caught_up`'s
//!   `cursor`), so a feed the Chat opens afresh after the link to Kai came back (the Chat closes its
//!   feed while `locked`, and opens a new one without a cursor) resumes where it stood. Each feed
//!   stream reads its records with a [`FeedReader`] of its own; only the cursor is shared.
//! - Rules ([`rule_word`]): `act` and `read` let something through; any other word is `none`.
//! - The origin of a typed message ([`origin_sentence`]): where the user writes from, for lmgw.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use lmgw_ui_kit::http::{Method, Read};
use serde_json::{Map, Value, json};

/// How Kai reads lmgw's answer for the page (`req.read`).
pub fn read_word(read: Read) -> &'static str {
    match read {
        Read::Stream => "stream",
        Read::Whole | Read::Blob => "whole",
    }
}

/// A request's body as the frame carries it: the page has its bytes by now (a `Blob` is read
/// before the frame is made, its type kept).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameBody {
    Empty,
    /// JSON text.
    Json(String),
    /// Bytes, with the blob's own type when they came from one (used where no header names one).
    Bytes {
        bytes: Vec<u8>,
        blob_type: Option<String>,
    },
}

/// The `req` frame of a request: `{t:"req", id, method, path, headers, body, read}`.
pub fn req_frame(
    id: u64,
    method: Method,
    path: &str,
    headers: &[(String, String)],
    body: &FrameBody,
    read: Read,
) -> Value {
    let mut h = Map::new();
    for (name, value) in headers {
        let name = name.to_ascii_lowercase();
        // A header named twice goes as one, its values joined as HTTP joins them: Kai refuses a
        // name twice, and dropping one would change the request behind the caller's back.
        let joined = match h.get(&name).and_then(Value::as_str) {
            Some(prev) => format!("{prev}, {value}"),
            None => value.clone(),
        };
        h.insert(name, Value::String(joined));
    }
    let body = match body {
        FrameBody::Empty => Value::Null,
        FrameBody::Json(text) => {
            h.entry("content-type")
                .or_insert_with(|| Value::String("application/json".into()));
            json!({ "text": text })
        }
        FrameBody::Bytes { bytes, blob_type } => {
            if let Some(kind) = blob_type.as_deref().filter(|k| !k.is_empty()) {
                h.entry("content-type")
                    .or_insert_with(|| Value::String(kind.to_string()));
            }
            json!({ "base64": STANDARD.encode(bytes) })
        }
    };
    json!({
        "t": "req",
        "id": id,
        "method": method.as_str(),
        "path": path,
        "headers": Value::Object(h),
        "body": body,
        "read": read_word(read),
    })
}

/// An error a frame carries: Kai's (`lmgw_broke_off`, `gateway_left`), the background's
/// (`no_link`, `bad_req`) or the port's own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

impl WireError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    fn of(v: Option<&Value>) -> Option<Self> {
        let v = v?.as_object()?;
        Some(Self {
            code: v
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string(),
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        })
    }

    /// The words the Chat shows ("connection failed: …" in the kit): the message, then the code.
    pub fn text(&self) -> String {
        if self.message.is_empty() {
            self.code.clone()
        } else {
            format!("{} ({})", self.message, self.code)
        }
    }
}

/// A frame from the background, read.
#[derive(Debug, Clone, PartialEq)]
pub enum FromBackground {
    /// Whether Kai is linked: when the port opens and at every change.
    Link {
        up: bool,
    },
    /// The background does not take this page's port.
    Refused {
        reason: String,
    },
    /// An answer's head; `text`: the pieces are text, else base64.
    Res {
        id: u64,
        status: u16,
        headers: Vec<(String, String)>,
        text: bool,
    },
    Chunk {
        id: u64,
        seq: u64,
        data: String,
    },
    End {
        id: u64,
        seq: Option<u64>,
        error: Option<WireError>,
    },
    /// The background's `error` about a request it did not take (`bad_req`).
    Error {
        id: Option<u64>,
        error: WireError,
    },
    /// The answer to one of the page's own calls to the background (`call`: the site's rule, the
    /// page's text, the hints).
    Answer {
        id: u64,
        result: Result<Value, WireError>,
    },
    /// Anything else: `t` as it came.
    Unknown(String),
}

impl FromBackground {
    pub fn read(v: &Value) -> Self {
        let t = v.get("t").and_then(Value::as_str).unwrap_or("");
        let id = v.get("id").and_then(Value::as_u64);
        match (t, id) {
            ("link", _) => FromBackground::Link {
                up: v.get("up").and_then(Value::as_bool).unwrap_or(false),
            },
            ("refused", _) => FromBackground::Refused {
                reason: v
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            },
            ("res", Some(id)) => FromBackground::Res {
                id,
                status: v
                    .get("status")
                    .and_then(Value::as_u64)
                    .and_then(|s| u16::try_from(s).ok())
                    .unwrap_or(0),
                headers: v
                    .get("headers")
                    .and_then(Value::as_object)
                    .map(|h| {
                        h.iter()
                            .filter_map(|(k, v)| {
                                Some((k.to_ascii_lowercase(), v.as_str()?.to_string()))
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                text: v.get("body").and_then(Value::as_str) != Some("base64"),
            },
            ("chunk", Some(id)) => FromBackground::Chunk {
                id,
                seq: v.get("seq").and_then(Value::as_u64).unwrap_or(0),
                data: v
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            },
            ("end", Some(id)) => FromBackground::End {
                id,
                seq: v.get("seq").and_then(Value::as_u64),
                error: WireError::of(v.get("error")),
            },
            ("error", id) => FromBackground::Error {
                id,
                error: WireError::new(
                    v.get("code").and_then(Value::as_str).unwrap_or("error"),
                    v.get("message").and_then(Value::as_str).unwrap_or(""),
                ),
            },
            ("answer", Some(id)) => FromBackground::Answer {
                id,
                result: match WireError::of(v.get("error")) {
                    Some(e) => Err(e),
                    None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
                },
            },
            (other, _) => FromBackground::Unknown(other.to_string()),
        }
    }
}

/// A piece's bytes: text as UTF-8, base64 decoded on its own (each piece decodes alone).
pub fn piece_bytes(text: bool, data: &str) -> Result<Vec<u8>, String> {
    if text {
        Ok(data.as_bytes().to_vec())
    } else {
        STANDARD
            .decode(data)
            .map_err(|e| format!("a piece of the answer is no base64: {e}"))
    }
}

/// What [`Core`] says to do about a frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Out {
    /// `send` answers a whole response (`Read::Whole`, `Read::Blob`).
    Whole {
        id: u64,
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// `send` answers a stream's head (`Read::Stream`); its pieces follow as [`Out::Piece`].
    Head {
        id: u64,
        status: u16,
        headers: Vec<(String, String)>,
    },
    /// A stream's next piece; its consumer acknowledges it as it takes it (`seq + 1`).
    Piece { id: u64, seq: u64, bytes: Vec<u8> },
    /// A stream ended: whole (`Ok`) or broken off (`Err`).
    StreamEnd { id: u64, result: Result<(), String> },
    /// `send` fails: no answer (or a whole one that did not come whole).
    Failed { id: u64, error: String },
    /// Acknowledge the pieces of a whole answer taken so far (`{t:"ack", id, seq}`).
    Ack { id: u64, seq: u64 },
    /// Kai left the lmgw the page's requests went to (a re-pair, a revoked key): said to the user.
    GatewayLeft { message: String },
    /// The page gave up on a request Kai still holds (its answer does not read): `abort` it.
    Abort { id: u64 },
}

#[derive(Debug)]
enum Entry {
    /// Sent; no head yet.
    Asked { stream: bool },
    /// A whole answer's head came; its pieces are gathered.
    Whole {
        status: u16,
        headers: Vec<(String, String)>,
        text: bool,
        body: Vec<u8>,
        pieces: u64,
    },
    /// A stream's head went to `send`; its pieces go to the consumer.
    Stream { text: bool, pieces: u64 },
}

/// The page's open requests and what each frame of the background means for them.
#[derive(Debug, Default)]
pub struct Core {
    open: HashMap<u64, Entry>,
}

impl Core {
    /// A request sent under `id`.
    pub fn open(&mut self, id: u64, read: Read) {
        self.open.insert(
            id,
            Entry::Asked {
                stream: read == Read::Stream,
            },
        );
    }

    /// Whether `id` is open.
    pub fn is_open(&self, id: u64) -> bool {
        self.open.contains_key(&id)
    }

    /// The page dropped `id` (its signal aborted, its future or stream was dropped): whether it
    /// was open, so an `abort` goes to the background.
    pub fn forget(&mut self, id: u64) -> bool {
        self.open.remove(&id).is_some()
    }

    /// The ids open now.
    pub fn ids(&self) -> Vec<u64> {
        self.open.keys().copied().collect()
    }

    /// The port is gone: every open request ends with `why`.
    pub fn close_all(&mut self, why: &str) -> Vec<Out> {
        let mut out: Vec<Out> = self
            .open
            .drain()
            .map(|(id, e)| match e {
                Entry::Stream { .. } => Out::StreamEnd {
                    id,
                    result: Err(why.to_string()),
                },
                _ => Out::Failed {
                    id,
                    error: why.to_string(),
                },
            })
            .collect();
        out.sort_by_key(|o| match o {
            Out::StreamEnd { id, .. } | Out::Failed { id, .. } => *id,
            _ => 0,
        });
        out
    }

    /// What a frame from the background means. Frames for an id that is not open (an abort on its
    /// way, a late frame) are dropped.
    pub fn take(&mut self, frame: FromBackground) -> Vec<Out> {
        let mut out = Vec::new();
        match frame {
            FromBackground::Res {
                id,
                status,
                headers,
                text,
            } => match self.open.get_mut(&id) {
                Some(e @ Entry::Asked { stream: true }) => {
                    *e = Entry::Stream { text, pieces: 0 };
                    out.push(Out::Head {
                        id,
                        status,
                        headers,
                    });
                }
                Some(e @ Entry::Asked { stream: false }) => {
                    *e = Entry::Whole {
                        status,
                        headers,
                        text,
                        body: Vec::new(),
                        pieces: 0,
                    };
                }
                // A second head: the request is already answered; nothing to do.
                _ => {}
            },
            FromBackground::Chunk { id, seq, data } => match self.open.get_mut(&id) {
                Some(Entry::Whole {
                    text, body, pieces, ..
                }) => match piece_bytes(*text, &data) {
                    Ok(b) => {
                        body.extend_from_slice(&b);
                        *pieces = (*pieces).max(seq + 1);
                        out.push(Out::Ack { id, seq: *pieces });
                    }
                    Err(e) => {
                        self.open.remove(&id);
                        out.push(Out::Failed { id, error: e });
                        out.push(Out::Abort { id });
                    }
                },
                Some(Entry::Stream { text, pieces }) => match piece_bytes(*text, &data) {
                    Ok(bytes) => {
                        *pieces = (*pieces).max(seq + 1);
                        out.push(Out::Piece { id, seq, bytes });
                    }
                    Err(e) => {
                        self.open.remove(&id);
                        out.push(Out::StreamEnd { id, result: Err(e) });
                        out.push(Out::Abort { id });
                    }
                },
                // A piece before the head breaks the order Kai keeps; the request cannot be read.
                Some(Entry::Asked { .. }) => {
                    self.open.remove(&id);
                    out.push(Out::Failed {
                        id,
                        error: "a piece of the answer came before its head".into(),
                    });
                    out.push(Out::Abort { id });
                }
                None => {}
            },
            FromBackground::End { id, error, .. } => {
                let Some(entry) = self.open.remove(&id) else {
                    return out;
                };
                if let Some(e) = &error
                    && e.code == "gateway_left"
                {
                    out.push(Out::GatewayLeft {
                        message: e.message.clone(),
                    });
                }
                match (entry, error) {
                    (Entry::Asked { .. }, Some(e)) => out.push(Out::Failed {
                        id,
                        error: e.text(),
                    }),
                    (Entry::Asked { .. }, None) => out.push(Out::Failed {
                        id,
                        error: "the answer ended before its head".into(),
                    }),
                    (Entry::Whole { .. }, Some(e)) => out.push(Out::Failed {
                        id,
                        error: e.text(),
                    }),
                    (
                        Entry::Whole {
                            status,
                            headers,
                            body,
                            ..
                        },
                        None,
                    ) => out.push(Out::Whole {
                        id,
                        status,
                        headers,
                        body,
                    }),
                    (Entry::Stream { .. }, Some(e)) => out.push(Out::StreamEnd {
                        id,
                        result: Err(e.text()),
                    }),
                    (Entry::Stream { .. }, None) => out.push(Out::StreamEnd { id, result: Ok(()) }),
                }
            }
            FromBackground::Error {
                id: Some(id),
                error,
            } => {
                if let Some(entry) = self.open.remove(&id) {
                    out.push(match entry {
                        Entry::Stream { .. } => Out::StreamEnd {
                            id,
                            result: Err(error.text()),
                        },
                        _ => Out::Failed {
                            id,
                            error: error.text(),
                        },
                    });
                }
            }
            _ => {}
        }
        out
    }
}

/// Whether `path` is the Chat's feed (`GET /chat/api/feed`, its query aside).
pub fn is_feed(method: Method, path: &str) -> bool {
    method == Method::Get && path.split('?').next() == Some("/chat/api/feed")
}

/// Where the feed stands, shared by the page's feed streams: the last whole record's `id:` (an
/// empty one clears it), or the `cursor` of a `hello` or `caught_up` record's data, as each
/// stream's [`FeedReader`] reads them.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FeedCursor {
    cursor: Option<String>,
}

impl FeedCursor {
    /// The cursor now.
    pub fn get(&self) -> Option<&str> {
        self.cursor.as_deref()
    }

    /// Forget it (a feed that could not read it, Kai left its lmgw).
    pub fn clear(&mut self) {
        self.cursor = None;
    }
}

/// One feed stream's SSE records, read off its bytes as the page takes them: pieces may split a
/// line, a CRLF or a UTF-8 character anywhere. Each stream has its own, so a stream that ends half
/// way through a record (a lost link) leaves nothing in the next one's; only the cursor its whole
/// records give is shared.
#[derive(Debug, Default)]
pub struct FeedReader {
    line: Vec<u8>,
    event: String,
    data: String,
    id: Option<String>,
    after_cr: bool,
}

impl FeedReader {
    /// The stream's next piece; its whole records move `cursor`.
    pub fn push(&mut self, bytes: &[u8], cursor: &mut FeedCursor) {
        for &b in bytes {
            match b {
                // The LF of a CRLF, the CR having ended the line.
                b'\n' if self.after_cr => self.after_cr = false,
                b'\n' | b'\r' => {
                    self.after_cr = b == b'\r';
                    let line = std::mem::take(&mut self.line);
                    self.field(&String::from_utf8_lossy(&line), cursor);
                }
                b => {
                    self.after_cr = false;
                    self.line.push(b);
                }
            }
        }
    }

    fn field(&mut self, line: &str, cursor: &mut FeedCursor) {
        if line.is_empty() {
            self.record(cursor);
            return;
        }
        if line.starts_with(':') {
            return;
        }
        let (name, value) = match line.split_once(':') {
            Some((n, v)) => (n, v.strip_prefix(' ').unwrap_or(v)),
            None => (line, ""),
        };
        match name {
            "id" => self.id = Some(value.to_string()),
            "event" => self.event = value.to_string(),
            "data" => {
                if !self.data.is_empty() {
                    self.data.push('\n');
                }
                self.data.push_str(value);
            }
            _ => {}
        }
    }

    fn record(&mut self, cursor: &mut FeedCursor) {
        if let Some(id) = self.id.take() {
            cursor.cursor = (!id.is_empty()).then_some(id);
        }
        if matches!(self.event.as_str(), "hello" | "caught_up")
            && let Ok(v) = serde_json::from_str::<Value>(&self.data)
            && let Some(c) = v.get("cursor").and_then(Value::as_str)
            && !c.is_empty()
        {
            cursor.cursor = Some(c.to_string());
        }
        self.event.clear();
        self.data.clear();
    }
}

/// A rule of Kai's site rules as the page applies it: `act` and `read` as they are, and every other
/// word, or none, `none`: a word this version does not know lets nothing through (design §14 item
/// 69).
pub fn rule_word(rule: Option<&str>) -> &'static str {
    match rule {
        Some("act") => "act",
        Some("read") => "read",
        _ => "none",
    }
}

/// The sentence the Chat sends with a typed message (lmgw's `origin`): where the user writes from.
/// `tab` is the sidebar window's active tab as (title, URL) and is named only when its rule
/// (`rule`, as [`rule_word`] gave it) is `act` or `read`; with a `none` site, a page that is no
/// site, or a rule not known yet, the tab stays unnamed (Kai keeps a `none` site from the model
/// entirely). Whole title and URL, no truncation.
pub fn origin_sentence(rule: Option<&str>, tab: Option<(&str, &str)>) -> String {
    const BASE: &str = "Typed in Kai's sidebar in Firefox";
    match (rule, tab) {
        (Some("act" | "read"), Some((title, url))) if !url.is_empty() => {
            if title.trim().is_empty() {
                format!("{BASE}, beside the tab {url}.")
            } else {
                format!("{BASE}, beside the tab \u{201c}{title}\u{201d} ({url}).")
            }
        }
        _ => format!("{BASE}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_names_the_tab_only_for_act_and_read() {
        let tab = Some(("Docs", "https://a.example/x"));
        let named = "Typed in Kai's sidebar in Firefox, beside the tab \u{201c}Docs\u{201d} (https://a.example/x).";
        assert_eq!(origin_sentence(Some("act"), tab), named);
        assert_eq!(origin_sentence(Some("read"), tab), named);
        let bare = "Typed in Kai's sidebar in Firefox.";
        assert_eq!(origin_sentence(Some("none"), tab), bare);
        assert_eq!(origin_sentence(None, tab), bare);
        assert_eq!(origin_sentence(Some("act"), None), bare);
        assert_eq!(
            origin_sentence(Some("read"), Some(("  ", "https://a.example/"))),
            "Typed in Kai's sidebar in Firefox, beside the tab https://a.example/."
        );
    }

    #[test]
    fn the_feed_s_cursor_is_its_last_id_or_hello_s_and_caught_up_s() {
        let mut c = FeedCursor::default();
        let mut r = FeedReader::default();
        let mut push = |t: &str, c: &mut FeedCursor| r.push(t.as_bytes(), c);
        // hello's cursor, its record split mid-line.
        push("event: hel", &mut c);
        push(
            "lo\ndata: {\"cursor\":\"e1:9:aa\",\"keepalive_s\":20}\n",
            &mut c,
        );
        assert_eq!(c.get(), None, "a record counts once it is whole");
        push("\n", &mut c);
        assert_eq!(c.get(), Some("e1:9:aa"));
        // A record's id; a keep-alive comment changes nothing.
        push(
            ": keep-alive\n\nid: e1:10:bb\r\nevent: thread.updated\r",
            &mut c,
        );
        push("\ndata: {}\r\n", &mut c);
        assert_eq!(
            c.get(),
            Some("e1:9:aa"),
            "a CRLF split across pieces is one line end"
        );
        push("\r\n", &mut c);
        assert_eq!(c.get(), Some("e1:10:bb"));
        push(
            "event: caught_up\ndata: {\"cursor\":\"e1:12:cc\"}\n\n",
            &mut c,
        );
        assert_eq!(c.get(), Some("e1:12:cc"));
        // An empty id clears it.
        push("id:\ndata: x\n\n", &mut c);
        assert_eq!(c.get(), None);
        push("id: e2:1:00\n\n", &mut c);
        assert_eq!(c.get(), Some("e2:1:00"));
        c.clear();
        assert_eq!(c.get(), None);
    }

    #[test]
    fn each_feed_stream_reads_its_own_records_and_only_the_cursor_is_shared() {
        let mut c = FeedCursor::default();
        let mut gone = FeedReader::default();
        // A stream the lost link cut off half way through a record.
        gone.push(
            b"id: e1:5:aa\nevent: thread.updated\ndata: {\"half\":",
            &mut c,
        );
        assert_eq!(c.get(), None);
        // The next stream: its records alone count; the cut one's half is not in them.
        let mut next = FeedReader::default();
        next.push(b"data: {\"x\":1}\n\n", &mut c);
        assert_eq!(
            c.get(),
            None,
            "no id of the stream before joined this record"
        );
        next.push(b"event: hello\ndata: {\"cursor\":\"e1:6:bb\"}\n\n", &mut c);
        assert_eq!(c.get(), Some("e1:6:bb"));
        // The old one's pieces, should any still come, do not move the next one's records.
        gone.push(b"1}\n\n", &mut c);
        assert_eq!(
            c.get(),
            Some("e1:5:aa"),
            "a whole record of its own moves the shared cursor"
        );
        next.push(b"id: e1:7:cc\n\n", &mut c);
        assert_eq!(c.get(), Some("e1:7:cc"));
    }

    #[test]
    fn a_utf8_character_split_across_pieces_stays_whole() {
        let mut c = FeedCursor::default();
        let mut r = FeedReader::default();
        let record = "event: hello\ndata: {\"title\":\"Café\",\"cursor\":\"e1:9:é\"}\n\n";
        let bytes = record.as_bytes();
        // The two bytes of each é in separate pieces.
        let cut = record.find('é').unwrap() + 1;
        let cut2 = record.rfind('é').unwrap() + 1;
        r.push(&bytes[..cut], &mut c);
        r.push(&bytes[cut..cut2], &mut c);
        r.push(&bytes[cut2..], &mut c);
        assert_eq!(c.get(), Some("e1:9:é"));
    }

    #[test]
    fn only_act_and_read_let_anything_through() {
        assert_eq!(rule_word(Some("act")), "act");
        assert_eq!(rule_word(Some("read")), "read");
        for other in [
            Some("none"),
            Some(""),
            Some("ACT"),
            Some("ask"),
            Some("act "),
            None,
        ] {
            assert_eq!(rule_word(other), "none", "{other:?}");
        }
    }

    #[test]
    fn only_get_chat_api_feed_is_the_feed() {
        assert!(is_feed(Method::Get, "/chat/api/feed"));
        assert!(is_feed(Method::Get, "/chat/api/feed?keepalive_s=20"));
        assert!(!is_feed(Method::Post, "/chat/api/feed"));
        assert!(!is_feed(Method::Get, "/chat/api/feeds"));
    }

    fn res(id: u64, status: u16, text: bool) -> FromBackground {
        FromBackground::read(&json!({
            "t": "res", "id": id, "status": status,
            "headers": {"Content-Type": "application/json", "x-lmgw-fallback": "cloud"},
            "body": if text { "text" } else { "base64" },
        }))
    }
    fn chunk(id: u64, seq: u64, data: &str) -> FromBackground {
        FromBackground::read(&json!({"t": "chunk", "id": id, "seq": seq, "data": data}))
    }
    fn end(id: u64, seq: u64, error: Option<(&str, &str)>) -> FromBackground {
        let mut v = json!({"t": "end", "id": id, "seq": seq});
        if let Some((code, message)) = error {
            v["error"] = json!({"code": code, "message": message});
        }
        FromBackground::read(&v)
    }

    #[test]
    fn read_is_stream_for_a_stream_and_whole_for_whole_and_blob() {
        assert_eq!(read_word(Read::Stream), "stream");
        assert_eq!(read_word(Read::Whole), "whole");
        assert_eq!(read_word(Read::Blob), "whole");
    }

    #[test]
    fn json_goes_as_text_with_its_type_and_bytes_as_base64() {
        let f = req_frame(
            7,
            Method::Post,
            "/chat/api/threads",
            &[],
            &FrameBody::Json(r#"{"title":"x"}"#.into()),
            Read::Whole,
        );
        assert_eq!(
            f,
            json!({"t": "req", "id": 7, "method": "POST", "path": "/chat/api/threads",
                   "headers": {"content-type": "application/json"},
                   "body": {"text": "{\"title\":\"x\"}"}, "read": "whole"})
        );
        // A type the request names stays.
        let f = req_frame(
            8,
            Method::Post,
            "/x",
            &[("Content-Type".into(), "application/merge-patch+json".into())],
            &FrameBody::Json("{}".into()),
            Read::Whole,
        );
        assert_eq!(
            f["headers"],
            json!({"content-type": "application/merge-patch+json"})
        );
        // Bytes: base64, the request's type.
        let f = req_frame(
            9,
            Method::Post,
            "/chat/api/threads/3/transcribe",
            &[("Content-Type".into(), "audio/wav".into())],
            &FrameBody::Bytes {
                bytes: vec![0, 1, 2, 250, 251],
                blob_type: None,
            },
            Read::Whole,
        );
        assert_eq!(f["body"], json!({"base64": "AAEC+vs="}));
        assert_eq!(f["headers"], json!({"content-type": "audio/wav"}));
        // A blob's bytes: its own type where no header names one, the header's where one does.
        let blob = |kind: &str| FrameBody::Bytes {
            bytes: b"%PDF".to_vec(),
            blob_type: Some(kind.into()),
        };
        let f = req_frame(
            1,
            Method::Post,
            "/a",
            &[],
            &blob("application/pdf"),
            Read::Whole,
        );
        assert_eq!(f["headers"], json!({"content-type": "application/pdf"}));
        assert_eq!(f["body"], json!({"base64": "JVBERg=="}));
        let f = req_frame(
            1,
            Method::Post,
            "/a",
            &[("content-type".into(), "text/plain".into())],
            &blob("application/pdf"),
            Read::Whole,
        );
        assert_eq!(f["headers"], json!({"content-type": "text/plain"}));
        // A blob without a type and no header: no type.
        let f = req_frame(1, Method::Post, "/a", &[], &blob(""), Read::Whole);
        assert_eq!(f["headers"], json!({}));
        // No body: null; the feed's cursor goes as last-event-id, read as a stream.
        let f = req_frame(
            2,
            Method::Get,
            "/chat/api/feed",
            &[("Last-Event-ID".into(), "e1:9:bb".into())],
            &FrameBody::Empty,
            Read::Stream,
        );
        assert_eq!(
            f,
            json!({"t": "req", "id": 2, "method": "GET", "path": "/chat/api/feed",
                   "headers": {"last-event-id": "e1:9:bb"}, "body": null, "read": "stream"})
        );
    }

    #[test]
    fn a_header_named_twice_goes_once_with_both_values() {
        let f = req_frame(
            1,
            Method::Get,
            "/a",
            &[("X-A".into(), "1".into()), ("x-a".into(), "2".into())],
            &FrameBody::Empty,
            Read::Whole,
        );
        assert_eq!(f["headers"], json!({"x-a": "1, 2"}));
    }

    #[test]
    fn a_whole_answer_acks_each_piece_as_it_comes_and_answers_at_its_end() {
        let mut c = Core::default();
        c.open(1, Read::Whole);
        assert_eq!(
            c.take(res(1, 200, true)),
            vec![],
            "no answer before the body is in"
        );
        assert_eq!(
            c.take(chunk(1, 0, "{\"id\":")),
            vec![Out::Ack { id: 1, seq: 1 }]
        );
        assert_eq!(c.take(chunk(1, 1, "7}")), vec![Out::Ack { id: 1, seq: 2 }]);
        assert_eq!(
            c.take(end(1, 2, None)),
            vec![Out::Whole {
                id: 1,
                status: 200,
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("x-lmgw-fallback".into(), "cloud".into())
                ],
                body: b"{\"id\":7}".to_vec(),
            }]
        );
        assert!(!c.is_open(1));
        // A late frame for it is dropped.
        assert_eq!(c.take(chunk(1, 2, "x")), vec![]);
    }

    #[test]
    fn a_blob_is_read_whole_and_its_base64_pieces_decode_one_by_one() {
        let mut c = Core::default();
        c.open(4, Read::Blob);
        c.take(res(4, 200, false));
        assert_eq!(
            c.take(chunk(4, 0, "iVBO")),
            vec![Out::Ack { id: 4, seq: 1 }]
        );
        assert_eq!(
            c.take(chunk(4, 1, "Rw==")),
            vec![Out::Ack { id: 4, seq: 2 }]
        );
        match &c.take(end(4, 2, None))[0] {
            Out::Whole { body, .. } => assert_eq!(body, &[0x89, b'P', b'N', b'G']),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_stream_answers_its_head_and_hands_on_its_pieces_without_acking_them() {
        let mut c = Core::default();
        c.open(2, Read::Stream);
        assert_eq!(
            c.take(res(2, 200, true)),
            vec![Out::Head {
                id: 2,
                status: 200,
                headers: vec![
                    ("content-type".into(), "application/json".into()),
                    ("x-lmgw-fallback".into(), "cloud".into())
                ],
            }]
        );
        assert_eq!(
            c.take(chunk(2, 0, "data: a\n\n")),
            vec![Out::Piece {
                id: 2,
                seq: 0,
                bytes: b"data: a\n\n".to_vec()
            }]
        );
        assert_eq!(
            c.take(end(
                2,
                1,
                Some(("lmgw_broke_off", "lmgw's answer broke off: reset"))
            )),
            vec![Out::StreamEnd {
                id: 2,
                result: Err("lmgw's answer broke off: reset (lmgw_broke_off)".into())
            }]
        );
        c.open(3, Read::Stream);
        c.take(res(3, 200, true));
        assert_eq!(
            c.take(end(3, 0, None)),
            vec![Out::StreamEnd {
                id: 3,
                result: Ok(())
            }]
        );
    }

    #[test]
    fn an_error_before_the_head_is_no_answer_and_after_it_the_streams() {
        let mut c = Core::default();
        c.open(1, Read::Whole);
        assert_eq!(
            c.take(FromBackground::read(&json!({"t": "end", "id": 1,
                "error": {"code": "no_link", "message": "Kai is not linked"}}))),
            vec![Out::Failed {
                id: 1,
                error: "Kai is not linked (no_link)".into()
            }]
        );
        // A whole answer cut after its head fails `send` too.
        c.open(2, Read::Whole);
        c.take(res(2, 200, true));
        c.take(chunk(2, 0, "{"));
        assert_eq!(
            c.take(end(
                2,
                1,
                Some(("no_link", "the link to Kai closed (Kai quit)"))
            )),
            vec![Out::Failed {
                id: 2,
                error: "the link to Kai closed (Kai quit) (no_link)".into()
            }]
        );
        // The background's bad_req and Kai's duplicate_req end what they name.
        c.open(5, Read::Stream);
        assert_eq!(
            c.take(FromBackground::read(
                &json!({"t": "error", "code": "bad_req", "id": 5,
                "message": "a request needs a whole-number id that is not open on this port"})
            )),
            vec![Out::Failed {
                id: 5,
                error: "a request needs a whole-number id that is not open on this port (bad_req)"
                    .into()
            }]
        );
    }

    #[test]
    fn gateway_left_ends_the_request_and_is_said_before_or_after_the_head() {
        let mut c = Core::default();
        c.open(1, Read::Whole);
        c.open(2, Read::Stream);
        c.take(res(2, 200, true));
        let left = Some(("gateway_left", "Kai was paired with another lmgw"));
        assert_eq!(
            c.take(FromBackground::read(&json!({"t": "end", "id": 1,
                "error": {"code": "gateway_left", "message": "Kai was paired with another lmgw"}}))),
            vec![
                Out::GatewayLeft {
                    message: "Kai was paired with another lmgw".into()
                },
                Out::Failed {
                    id: 1,
                    error: "Kai was paired with another lmgw (gateway_left)".into()
                }
            ]
        );
        assert_eq!(
            c.take(end(2, 0, left)),
            vec![
                Out::GatewayLeft {
                    message: "Kai was paired with another lmgw".into()
                },
                Out::StreamEnd {
                    id: 2,
                    result: Err("Kai was paired with another lmgw (gateway_left)".into())
                }
            ]
        );
    }

    #[test]
    fn a_dropped_request_is_forgotten_and_the_port_s_end_ends_the_rest() {
        let mut c = Core::default();
        c.open(1, Read::Whole);
        c.open(2, Read::Stream);
        c.take(res(2, 200, true));
        assert!(c.forget(1));
        assert!(!c.forget(1), "an abort goes once");
        assert_eq!(
            c.take(res(1, 200, true)),
            vec![],
            "its late head is dropped"
        );
        c.open(3, Read::Whole);
        assert_eq!(
            c.close_all("the port closed"),
            vec![
                Out::StreamEnd {
                    id: 2,
                    result: Err("the port closed".into())
                },
                Out::Failed {
                    id: 3,
                    error: "the port closed".into()
                }
            ]
        );
        assert!(c.ids().is_empty());
    }

    #[test]
    fn a_piece_that_does_not_decode_fails_the_request() {
        let mut c = Core::default();
        c.open(1, Read::Whole);
        c.take(res(1, 200, false));
        let out = c.take(chunk(1, 0, "not base64!"));
        assert!(matches!(&out[0], Out::Failed { id: 1, error } if error.contains("no base64")));
        assert_eq!(out[1], Out::Abort { id: 1 }, "Kai holds the rest: aborted");
        assert!(!c.is_open(1));
    }

    #[test]
    fn the_background_s_frames_read() {
        assert_eq!(
            FromBackground::read(&json!({"t": "link", "up": true})),
            FromBackground::Link { up: true }
        );
        assert_eq!(
            FromBackground::read(&json!({"t": "refused", "reason": "only the sidebar"})),
            FromBackground::Refused {
                reason: "only the sidebar".into()
            }
        );
        assert_eq!(
            FromBackground::read(&json!({"t": "answer", "id": 3, "ok": {"rule": "read"}})),
            FromBackground::Answer {
                id: 3,
                result: Ok(json!({"rule": "read"}))
            }
        );
        assert_eq!(
            FromBackground::read(&json!({"t": "answer", "id": 3,
                "error": {"code": "site_none", "message": "no"}})),
            FromBackground::Answer {
                id: 3,
                result: Err(WireError::new("site_none", "no"))
            }
        );
        assert_eq!(
            FromBackground::read(&json!({"t": "zzz"})),
            FromBackground::Unknown("zzz".into())
        );
    }
}
