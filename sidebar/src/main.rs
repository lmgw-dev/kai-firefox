//! The wasm entry point trunk builds. Natively there is nothing to run: `cargo test` runs the wire's
//! tests.

fn main() {
    #[cfg(target_arch = "wasm32")]
    kai_firefox_sidebar::mount();
}
