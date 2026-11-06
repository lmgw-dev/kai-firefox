//! The site strip (design §8.1): one line above the Chat about the page beside it, the sidebar
//! window's active tab: its site, the rule Kai's site rules give it (act, read, none; Kai's
//! `[browser.sites]`, asked through the background, which asks Kai), a switch for the hint labels
//! and "Attach this page". It follows the tab: another tab activated, a navigation, a new title.
//!
//! - **The rule** is Kai's: the strip cannot change a rule yet; Kai's settings do
//!   (`browser.sites`). A page that is no site (Firefox's own pages, another extension's) shows
//!   none. `act` and `read` are shown as they are; any other word Kai might send is `none`
//!   (`wire::rule_word`), as the background applies it. A Kai too old to answer the question
//!   (`kai_too_old` from the background, or Kai's `unknown_frame`) is said in the chip.
//! - **Hints**: while the switch is on, the active tab shows its hint labels (the numbers Kai's
//!   tools call its controls by), again after each navigation and on the tab activated next; the
//!   previous tab's go. A `none` site gets none (the background asks Kai first). What the strip
//!   asked last counts: each change takes a new generation before its calls go, and a call that
//!   comes back under an older one changes nothing.
//! - **Attach this page**: the page's readable text, as `page.text@1` reads it, as a text file in
//!   the Chat's composer headed "Page: <title> (<URL>)". The background reads it only on a web page
//!   or a local file whose rule is not `none`, and leaves out the frames of `none` sites. The file
//!   goes in by the Chat's own drop path (`ext::drop_file`): lmgw-chat-ui has no seam for a host's
//!   composer action yet.

use leptos::prelude::*;
use lmgw_ui_kit::widgets::use_toasts;
use serde::Deserialize;
use serde_json::json;
use wasm_bindgen::prelude::*;

use crate::ext;
use crate::transport::Relay;
use crate::wire::{WireError, rule_word};

/// The sidebar window's active tab.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
pub(crate) struct Tab {
    id: i64,
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    status: String,
}

/// What Kai's site rules say of the tab's page.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Rule {
    /// Asking.
    Asking,
    /// The site and its rule (`act`, `read`, `none`; any other word Kai sends is `none`).
    Of {
        site: String,
        rule: &'static str,
        /// The URL the question was about.
        url: String,
    },
    /// Not a site Kai for Firefox reads (Firefox's own pages, another extension's).
    NoSite(String),
    /// The question failed (no link, the port, a Kai too old to answer it): why.
    Unknown(WireError),
}

impl Rule {
    /// Whether the rule lets Kai read the page (`act` or `read`).
    fn reads(&self) -> bool {
        matches!(self, Rule::Of { rule, .. } if *rule != "none")
    }
}

/// Whether the background's or Kai's error says Kai does not answer the question yet.
fn kai_too_old(e: &WireError) -> bool {
    matches!(e.code.as_str(), "kai_too_old" | "unknown_frame")
}

/// Whether Kai for Firefox reads a page at `url` at all: web pages and local files (design §3, §14
/// item 38's allow-list); never Firefox's own or an extension's pages.
fn readable(url: &str) -> bool {
    ["http://", "https://", "file://"]
        .iter()
        .any(|s| url.starts_with(s))
}

/// The file name an attached page gets: its title (or URL) with what a file name cannot hold
/// taken out, at its whole length (lmgw takes the name or says why not).
fn file_name(title: &str, url: &str) -> String {
    let base = if title.trim().is_empty() { url } else { title };
    let clean: String = base
        .chars()
        .map(|c| {
            if "/\\:*?\"<>|".contains(c) || c.is_control() {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("{}.txt", if clean.is_empty() { "page" } else { &clean })
}

/// What the strip knows of the page beside the sidebar, kept where the page can read it
/// synchronously (the Chat's origin, [`SiteState::origin`]).
#[derive(Clone, Copy)]
pub struct SiteState {
    tab: RwSignal<Option<Tab>>,
    rule: RwSignal<Rule>,
}

impl SiteState {
    pub fn new() -> Self {
        Self {
            tab: RwSignal::new(None),
            rule: RwSignal::new(Rule::Asking),
        }
    }

    /// The sentence for a message typed now: the tab is named only when Kai's rule for the very
    /// URL the tab holds is act or read.
    pub fn origin(&self) -> String {
        let tab = self.tab.get_untracked();
        let rule = self.rule.get_untracked();
        match (&rule, &tab) {
            (Rule::Of { rule, url, .. }, Some(t)) if *url == t.url => {
                crate::wire::origin_sentence(Some(rule), Some((&t.title, &t.url)))
            }
            _ => crate::wire::origin_sentence(None, None),
        }
    }
}

#[component]
pub fn SiteStrip(state: SiteState) -> impl IntoView {
    let relay = Relay::current();
    let status = relay.status();
    let toasts = use_toasts();
    let SiteState { tab, rule } = state;
    let hints = RwSignal::new(false);
    // The tab whose hints this page turned on, and the page they were drawn on: set when the
    // calls are sent, not when they come back, so the next change sees what was asked.
    let hinted = StoredValue::new(None::<(i64, String)>);
    // The hint calls' generation: each change takes the next before its calls go, and a call's
    // answer under an older one changes nothing (a later change decided meanwhile).
    let hint_gen = StoredValue::new(0_u64);
    let attaching = RwSignal::new(false);

    let on_tab = Closure::<dyn FnMut(String)>::new(move |text: String| {
        if let Ok(t) = serde_json::from_str::<Tab>(&text) {
            tab.set(Some(t));
        }
    });
    ext::watch_tab(&on_tab);
    on_tab.forget();

    // The rule: asked again when the tab's URL changes or the link comes back.
    let r = relay.clone();
    Effect::new(move |_| {
        let url = tab.with(|t| t.as_ref().map(|t| t.url.clone()));
        let linked = status.link.get() == Some(true);
        let Some(url) = url else { return };
        if !readable(&url) {
            let scheme = url.split(':').next().unwrap_or("").to_string();
            rule.set(Rule::NoSite(scheme));
            return;
        }
        if !linked {
            rule.set(Rule::Unknown(WireError::new(
                "no_link",
                "Kai is not linked",
            )));
            return;
        }
        rule.set(Rule::Asking);
        let r = r.clone();
        leptos::task::spawn_local(async move {
            let answer = r.call("site", json!({ "url": url })).await;
            // A newer tab or URL asked meanwhile: its answer is the one that counts.
            if tab.with_untracked(|t| t.as_ref().map(|t| t.url.as_str()) != Some(url.as_str())) {
                return;
            }
            rule.set(match answer {
                Ok(v) => Rule::Of {
                    url: url.clone(),
                    site: v["site"].as_str().unwrap_or_default().to_string(),
                    rule: rule_word(v["rule"].as_str()),
                },
                Err(e) => Rule::Unknown(e),
            });
        });
    });

    // The hints follow the switch, the tab and its loads: shown once a page is complete (a
    // navigation takes the labels of the page before with it), on the tab activated next, and off
    // on the tab left.
    let r = relay.clone();
    Effect::new(move |_| {
        let on = hints.get();
        let Some(t) = tab.get() else { return };
        let allowed = rule.with(Rule::reads);
        let want = on && allowed;
        let before = hinted.get_value();
        if want && t.status != "complete" {
            // Loading: drawn again once it is complete.
            if before.as_ref().is_some_and(|(id, _)| *id == t.id) {
                hinted.set_value(Some((t.id, String::new())));
            }
            return;
        }
        if want && before.as_ref() == Some(&(t.id, t.url.clone())) {
            return;
        }
        if !want && before.is_none() {
            return;
        }
        // What this change asks, recorded before its calls go.
        let generation = hint_gen.get_value() + 1;
        hint_gen.set_value(generation);
        hinted.set_value(want.then(|| (t.id, t.url.clone())));
        let r = r.clone();
        leptos::task::spawn_local(async move {
            if let Some((old, _)) = before
                && (old != t.id || !want)
            {
                let _ = r.call("hints", json!({ "tab": old, "on": false })).await;
            }
            if want
                && let Err(e) = r.call("hints", json!({ "tab": t.id, "on": true })).await
                && hint_gen.get_value() == generation
            {
                hinted.set_value(None);
                toasts.err(format!("The hints could not be shown: {}", e.text()));
            }
        });
    });

    let r = relay.clone();
    let attach = move |_| {
        let Some(t) = tab.get_untracked() else { return };
        attaching.set(true);
        let r = r.clone();
        leptos::task::spawn_local(async move {
            let answer = r.call("page_text", json!({ "tab": t.id })).await;
            attaching.set(false);
            match answer {
                Ok(v) => {
                    let title = v["title"].as_str().unwrap_or_default();
                    let url = v["url"].as_str().unwrap_or_default();
                    let text = v["text"].as_str().unwrap_or_default();
                    let body = format!("Page: {title} ({url})\n\n{text}\n");
                    let why = ext::drop_file(&file_name(title, url), "text/plain", &body);
                    if !why.is_empty() {
                        toasts.err(format!("The page could not be attached: {why}"));
                    }
                }
                Err(e) => toasts.err(format!("The page could not be attached: {}", e.text())),
            }
        });
    };

    let site_text = move || match rule.get() {
        Rule::Of { site, .. } if !site.is_empty() => site,
        Rule::NoSite(scheme) if scheme == "moz-extension" => "An extension's page".into(),
        Rule::NoSite(_) => "Firefox's own page".into(),
        _ => tab
            .with(|t| t.as_ref().map(|t| host_of(&t.url)))
            .unwrap_or_default(),
    };
    let chip = move || match rule.get() {
        Rule::Of { rule, .. } => {
            let (class, title) = match rule {
                "act" => (
                    "chip ok",
                    "Kai may read and act on this site (Kai's site rules).",
                ),
                "read" => (
                    "chip warn",
                    "Kai may read this site but not act on it (Kai's site rules).",
                ),
                _ => (
                    "chip err",
                    "Kai neither reads nor acts on this site (Kai's site rules).",
                ),
            };
            view! { <span class=class title=title data-kai="rule">{rule}</span> }.into_any()
        }
        Rule::Asking => view! { <span class="chip off" data-kai="rule">"…"</span> }.into_any(),
        Rule::NoSite(_) => view! {
            <span class="chip off" data-kai="rule"
                title="Kai for Firefox reads web pages and local files only.">"no site"</span>
        }
        .into_any(),
        Rule::Unknown(e) if kai_too_old(&e) => view! {
            <span class="chip warn" data-kai="rule" title=e.text()>"update Kai"</span>
        }
        .into_any(),
        Rule::Unknown(e) => view! {
            <span class="chip off" data-kai="rule" title=e.text()>"?"</span>
        }
        .into_any(),
    };
    let can_attach =
        move || !attaching.get() && status.link.get() == Some(true) && rule.with(Rule::reads);
    let can_hint = move || rule.with(Rule::reads);
    let attach_title = move || match rule.get() {
        Rule::Of { rule: "none", .. } => {
            "Kai reads nothing of this site (its rule is none).".to_string()
        }
        Rule::NoSite(_) => "Kai for Firefox reads web pages and local files only.".into(),
        _ => "Attach this page's readable text to the message".into(),
    };

    view! {
        <div class="kai-strip" data-kai="strip">
            <Show
                when=move || status.link.get() == Some(true)
                fallback=move || view! {
                    <button type="button" class="chip err kai-link" data-kai="link"
                        title=move || match status.refused.get() {
                            Some(why) => format!("Kai for Firefox's background refused this page: {why}"),
                            None => "Kai for Firefox's status: whether Kai runs and is linked".into(),
                        }
                        on:click=|_| ext::open_options()>
                        {move || if status.refused.with(Option::is_some) {
                            "Refused"
                        } else if status.port.get() {
                            "Kai is not linked"
                        } else {
                            "Connecting…"
                        }}
                    </button>
                }
            >
                <span class="kai-site" data-kai="site" title=move || tab.with(|t| t.as_ref().map(|t| t.url.clone()).unwrap_or_default())>
                    {site_text}
                </span>
                {chip}
            </Show>
            <span class="kai-strip-gap"></span>
            <label class="kai-hints" title="Show the hint labels: the numbers Kai calls this page's controls by">
                <input type="checkbox" data-kai="hints"
                    prop:checked=move || hints.get()
                    disabled=move || !can_hint()
                    on:change=move |ev| hints.set(event_target_checked(&ev))/>
                "Hints"
            </label>
            <button type="button" class="btn sm ghost kai-attach" data-kai="attach"
                title=attach_title
                disabled=move || !can_attach()
                on:click=attach>
                <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M14.29 7.37l-6.13 6.13a4 4 0 0 1-5.66-5.66l6.13-6.13a2.67 2.67 0 0 1 3.77 3.77l-6.13 6.13a1.33 1.33 0 0 1-1.89-1.89l5.65-5.65"/>
                </svg>
                "Page"
            </button>
        </div>
    }
}

/// The host a URL names, for the line before Kai has answered.
fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        .unwrap_or("")
        .to_string()
}
