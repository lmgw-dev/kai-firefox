//! WP0 (c): a minimal Leptos sidebar on lmgw's UI kit. A thread list, a few rendered markdown
//! messages, a composer and one kit widget (Modal) whose body holds the two `srcdoc`/sandbox
//! frames the Chat's HTML preview needs.

mod md;

use leptos::prelude::*;
use lmgw_ui_kit::widgets::{Modal, ModalSize, Section};
use wasm_bindgen::JsCast;

const THREADS: [(&str, &str, &str); 5] = [
    ("Kai", "Open the pull request for me", "2 min"),
    ("Release notes for 0.5", "Draft is in the thread", "1 h"),
    ("Why does the CSP block my script?", "Because it is inline", "yesterday"),
    ("Groceries", "Oat milk, coffee, bread", "Mon"),
    ("Sidebar width", "280 px is the floor", "Sun"),
];

const MESSAGES: [(&str, &str); 4] = [
    ("user", "Summarize this page and tell me what to click first."),
    (
        "assistant",
        "**Short version:** the page is a *release checklist*.\n\n\
## What to do first\n\n\
1. Open the `Build` tab\n2. Press **Run all**\n3. Wait for the green check\n\n\
| Step | Owner | State |\n|---|---|---|\n| Build | CI | done |\n| Sign | you | open |\n\n\
```rust\nfn main() {\n    println!(\"hello from a code block\");\n}\n```\n\n\
Details are on [the page](https://example.org/releases) and in <script>alert(1)</script> (shown as text, not run).",
    ),
    ("user", "Draw me a small status card as HTML."),
    (
        "assistant",
        "Here is a card. Use **Preview HTML** below the thread to see it in the sandboxed frame.\n\n\
```html\n<div class=\"card\">Status: <b>green</b></div>\n```",
    ),
];

/// What a model's HTML answer looks like: a style block, an inline script that reports back.
const PREVIEW_HTML: &str = r#"<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px system-ui,sans-serif;margin:0;padding:10px;background:#fff;color:#111}
#box{background:rgb(200,30,30);color:#fff;padding:8px;border-radius:6px}
</style></head><body><b>Status:</b> green
<div id="box">styled by an inline style block</div>
<p id="out">script: not run</p>
<script>
document.getElementById('out').textContent = 'script: ran inline';
parent.postMessage({ kind: 'PREVIEW_KIND', scriptRan: true, origin: String(location.origin) }, '*');
</script></body></html>"#;

fn preview_html(kind: &str) -> String {
    PREVIEW_HTML.replace("PREVIEW_KIND", kind)
}

#[component]
fn Thread(idx: usize, active: RwSignal<usize>) -> impl IntoView {
    let (title, sub, when) = THREADS[idx];
    view! {
        <li>
            <button class="thread" class:active=move || active.get() == idx
                on:click=move |_| active.set(idx)>
                <span class="t-title">{title}</span>
                <span class="t-when">{when}</span>
                <span class="t-sub">{sub}</span>
            </button>
        </li>
    }
}

#[component]
fn Message(role: &'static str, text: &'static str) -> impl IntoView {
    if role == "user" {
        view! { <div class="msg-user"><div class="msg-user-text">{text}</div></div> }.into_any()
    } else {
        view! { <div class="msg-assistant md" inner_html=md::md_to_html(text)></div> }.into_any()
    }
}

/// The sandbox page is an iframe `src`: once it loaded, hand it the HTML to render. The frame's
/// `id` (V2, V2b, V3) names which variant's report the nested script sends.
fn send_preview_to_sandbox(ev: web_sys::Event) {
    let Some(frame) = ev
        .target()
        .and_then(|t| t.dyn_into::<web_sys::HtmlIFrameElement>().ok())
    else {
        return;
    };
    if let Some(win) = frame.content_window() {
        let msg = js_sys_object(&preview_html(&format!("{}-nested", frame.id())));
        let _ = win.post_message(&msg, "*");
    }
}

fn js_sys_object(html: &str) -> wasm_bindgen::JsValue {
    // {html: "<...>"} without pulling serde-wasm-bindgen in.
    let o = web_sys::js_sys::Object::new();
    let _ = web_sys::js_sys::Reflect::set(&o, &"html".into(), &html.into());
    o.into()
}

#[component]
fn App() -> impl IntoView {
    let active = RwSignal::new(0usize);
    let preview_open = RwSignal::new(false);
    let draft = RwSignal::new(String::new());
    view! {
        <div class="sb">
            <div class="site-strip">
                <span class="site">"example.org"</span>
                <span class="rule">"read"</span>
                <label class="hints"><input type="checkbox" checked/>" hints"</label>
            </div>
            <aside class="threads-col">
                <Section title="Threads" count=Signal::derive(|| THREADS.len().to_string())>
                    <ul class="threads">
                        {(0..THREADS.len()).map(|i| view! { <Thread idx=i active=active/> }).collect_view()}
                    </ul>
                </Section>
            </aside>
            <main class="messages" id="messages">
                {MESSAGES.iter().map(|(r, t)| view! { <Message role=*r text=*t/> }).collect_view()}
            </main>
            <footer class="composer">
                <textarea class="input ta" rows="2" placeholder="Message Kai"
                    prop:value=move || draft.get()
                    on:input=move |ev| draft.set(event_target_value(&ev))></textarea>
                <div class="composer-row">
                    <button class="btn sm ghost" id="attach-page">"Attach this page"</button>
                    <button class="btn sm" id="open-preview" on:click=move |_| preview_open.set(true)>
                        "Preview HTML"
                    </button>
                    <span class="spacer"></span>
                    <button class="btn sm primary" id="send">"Send"</button>
                </div>
            </footer>
            <Modal open=preview_open title="Preview" size=ModalSize::Full fill=true>
                // Mounted only while open (an iframe in a closed <dialog> gets no browsing context).
                <Show when=move || preview_open.get()>
                    <div class="frames fill-pane">
                        <div class="fcell">
                            <span class="preview-lang">"V1 srcdoc in the sidebar page"</span>
                            <iframe id="v1" class="preview-frame" sandbox="allow-scripts"
                                srcdoc=preview_html("v1")></iframe>
                        </div>
                        <div class="fcell">
                            <span class="preview-lang">"V2 sandbox page + srcdoc"</span>
                            <iframe id="v2" class="preview-frame" src="preview.html#v2"
                                on:load=move |ev| send_preview_to_sandbox(ev)></iframe>
                        </div>
                        <div class="fcell">
                            <span class="preview-lang">"V2b as V2, sandbox attribute"</span>
                            <iframe id="v2b" class="preview-frame" src="preview.html#v2b"
                                sandbox="allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock"
                                on:load=move |ev| send_preview_to_sandbox(ev)></iframe>
                        </div>
                        <div class="fcell">
                            <span class="preview-lang">"V3 plain page + srcdoc"</span>
                            <iframe id="v3" class="preview-frame" src="plain.html#v3"
                                on:load=move |ev| send_preview_to_sandbox(ev)></iframe>
                        </div>
                        <div class="fcell">
                            <span class="preview-lang">"V3b as V3, sandbox attribute"</span>
                            <iframe id="v3b" class="preview-frame" src="plain.html#v3b"
                                sandbox="allow-scripts allow-modals allow-forms allow-popups allow-pointer-lock"
                                on:load=move |ev| send_preview_to_sandbox(ev)></iframe>
                        </div>
                    </div>
                </Show>
            </Modal>
        </div>
    }
}

fn main() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(App);
}
