//! Markdown to HTML for a message, with the Chat's two safety rules (lmgw-ui `chat_markdown.rs`):
//! raw HTML in the source becomes escaped text, and a link keeps its target only for
//! http(s)/mailto/relative URLs. Math, remote images and the rest of the Chat's rules are
//! not part of this spike.

use pulldown_cmark::{CowStr, Event, Options, Parser, Tag, html};

fn safe_href(url: CowStr<'_>) -> CowStr<'_> {
    let lower = url.trim_start().to_ascii_lowercase();
    let ok = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("mailto:")
        || !lower.contains(':');
    if ok { url } else { CowStr::Borrowed("#") }
}

pub fn md_to_html(src: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    let events = Parser::new_ext(src, opts).map(|ev| match ev {
        Event::Html(s) | Event::InlineHtml(s) => Event::Text(s),
        Event::Start(Tag::Link { link_type, dest_url, title, id }) => Event::Start(Tag::Link {
            link_type,
            dest_url: safe_href(dest_url),
            title,
            id,
        }),
        other => other,
    });
    let mut out = String::new();
    html::push_html(&mut out, events);
    out
}
