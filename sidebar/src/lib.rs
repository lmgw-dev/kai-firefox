//! Kai for Firefox's sidebar page (design §8): lmgw's Chat (`lmgw-chat-ui`) in Firefox's sidebar,
//! its every request relayed through the extension's background to Kai, which sends it to lmgw as
//! Kai (decision 9), with a strip for the page beside it (the site, its rule, the hints, attaching
//! the page).
//!
//! - `wire`: the frames, without a browser (its tests run natively).
//! - `transport`: the kit's `Transport` over the background's `kai-sidebar` port.
//! - `page`: the host (`ChatHost`, the toasts, the dirty guard) and the page around the Chat.
//! - `strip`: the site strip and "Attach this page".

pub mod wire;

#[cfg(target_arch = "wasm32")]
mod ext;
#[cfg(target_arch = "wasm32")]
mod page;
#[cfg(target_arch = "wasm32")]
mod strip;
#[cfg(target_arch = "wasm32")]
pub mod transport;

/// Mounts the page (the wasm's start).
#[cfg(target_arch = "wasm32")]
pub fn mount() {
    page::mount();
}
