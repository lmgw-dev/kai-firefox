//! The sidebar as the Chat's host (lmgw's chat-plane design §9.8): what it hands
//! `lmgw_chat_ui::Chat`, and the page around it.
//!
//! - The kit's `Http` over the background's port ([`crate::transport::Relay`]), in context before
//!   the model catalog, which captures it; `http::configure` with no base (paths are lmgw's own)
//!   and the `401 session_required` hook, which marks the device refused.
//! - `ChatHost`: the open thread kept in memory ([`Memory`]), no dashboard to link to, `locked`
//!   from the link to Kai, the Chat's own feed (`ChatLive::Feed`), the HTML preview in the
//!   extension's sandboxed page (`preview.html`, listed in the manifest's `sandbox.pages`), no
//!   voice and no machine check (a paired device's sidebar shows none; design §13: voice in the
//!   sidebar is not built yet).
//! - The kit's toasts before the Chat, its dirty guard with the one page's path, and its question
//!   host, whose "Leave and discard" opens a web link in a tab (the sidebar has no other page).
//! - The message's origin (`ChatHost::origin`): the sentence of `wire::origin_sentence` about the
//!   tab the strip follows.
//! - The strip above the Chat (`crate::strip`) and a notice when Kai left the lmgw this Chat came
//!   from, when the background refused the page, or when lmgw refused Kai's device.

use std::sync::{Arc, Mutex};

use leptos::prelude::*;
use lmgw_chat_ui::{ChatAddress, ChatHost, ChatLocation, PreviewFrame, provide_chat_host};
use lmgw_ui_kit::http::{self, Http};
use lmgw_ui_kit::widgets::ToastHost;
use lmgw_ui_kit::widgets::dirty_guard::{DirtyGuardHost, provide_dirty_guard};

use crate::transport::{self, Relay, Status};

/// The sandbox page the HTML preview loads (relative to `sidebar.html`).
const PREVIEW: &str = "preview.html";

pub fn mount() {
    console_error_panic_hook::set_once();
    http::configure(http::Config {
        base: String::new(),
        on_unauthorized: Some(transport::unauthorized),
    });
    leptos::mount::mount_to_body(App);
}

/// The open thread, kept for as long as the page lives: the sidebar has no address bar, and a
/// sidebar opened again starts at the first thread listed.
#[derive(Default)]
struct Memory(Mutex<Option<i64>>);

impl ChatLocation for Memory {
    fn opened_at(&self) -> ChatAddress {
        ChatAddress {
            thread: *self.0.lock().unwrap_or_else(|e| e.into_inner()),
            ..Default::default()
        }
    }

    fn show_thread(&self, id: Option<i64>) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = id;
    }

    /// No dashboard pages here yet (lmgw's chat-plane §9.8: an absolute URL of lmgw's dashboard
    /// in a tab is a later choice): the Chat leaves those links out.
    fn dashboard_href(&self, _path: &str) -> Option<String> {
        None
    }
}

#[component]
fn App() -> impl IntoView {
    let relay = Relay::open();
    let status = relay.status();
    transport::keep_status(status);
    provide_context(Http::new(relay.clone()));
    relay.keep();
    let locked = status.locked();
    lmgw_ui_kit::catalog::provide_model_catalog(locked);
    let site = crate::strip::SiteState::new();
    let mut host = ChatHost::new(Arc::new(Memory::default()), locked);
    host.preview = PreviewFrame::Posted {
        src: PREVIEW.into(),
    };
    // Without voice no asset of the Chat is loaded by URL; the base is the page's folder.
    host.assets = "./".into();
    // Where the user writes from, read when a message is sent or edited (lmgw stores it with the
    // message): the tab beside the sidebar, named only while Kai's rule for it is act or read.
    host.origin = Some(Arc::new(move || Some(site.origin())));
    provide_chat_host(host);
    // One page: every draft is on it.
    provide_dirty_guard(|| "/chat".to_string());
    let navigate = Callback::new(|to: String| {
        if to.starts_with("https://") || to.starts_with("http://") {
            crate::ext::open_tab(&to);
        }
    });
    view! {
        <ToastHost/>
        <DirtyGuardHost navigate=navigate/>
        <div class="kai-sidebar">
            <crate::strip::SiteStrip state=site/>
            <Notices status=status/>
            <div class="kai-chat">
                <lmgw_chat_ui::Chat/>
            </div>
        </div>
    }
}

/// What the page says about the link besides the strip: Kai left the lmgw this Chat came from, the
/// background refused the page, lmgw refused Kai's device.
#[component]
fn Notices(status: Status) -> impl IntoView {
    let reload = |_| {
        let _ = window().location().reload();
    };
    view! {
        <Show when=move || status.gateway_left.with(Option::is_some)>
            <div class="kai-notice warn" role="alert" data-kai="gateway-left">
                <span>
                    "Kai left the lmgw this Chat came from: "
                    {move || status.gateway_left.get().unwrap_or_default()}
                    ". Reload once Kai is paired."
                </span>
                <button type="button" class="btn sm" on:click=reload>"Reload"</button>
            </div>
        </Show>
        <Show when=move || status.refused.with(Option::is_some)>
            <div class="kai-notice err" role="alert" data-kai="refused">
                "Kai for Firefox's background refused this page: "
                {move || status.refused.get().unwrap_or_default()}
            </div>
        </Show>
        <Show when=move || status.unauthorized.get()>
            <div class="kai-notice err" role="alert" data-kai="unauthorized">
                "lmgw asked for a session that Kai's device link should have given it (401 \
                 session_required). Pair Kai again in its settings."
            </div>
        </Show>
    }
}
