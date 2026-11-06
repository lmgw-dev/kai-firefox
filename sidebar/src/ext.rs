//! The extension's APIs, through `src/ext.js` (the port, the active tab, a file into the Chat's
//! composer, the options page, a new tab).

use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/src/ext.js")]
extern "C" {
    /// The background's port `name`: each message as JSON text, the disconnect's reason once.
    pub fn connect(
        name: &str,
        on_message: &Closure<dyn FnMut(String)>,
        on_disconnect: &Closure<dyn FnMut(String)>,
    ) -> JsValue;
    /// Posts JSON `text` on `port`; false when the port is gone.
    pub fn post(port: &JsValue, text: &str) -> bool;
    /// The sidebar window's active tab as JSON text (`{id, url, title, status, window}`), now and
    /// at every change.
    #[wasm_bindgen(js_name = watchTab)]
    pub fn watch_tab(on_tab: &Closure<dyn FnMut(String)>);
    /// A text file dropped on the Chat's conversation; "" when it went, else why not.
    #[wasm_bindgen(js_name = dropFile)]
    pub fn drop_file(name: &str, kind: &str, text: &str) -> String;
    #[wasm_bindgen(js_name = openOptions)]
    pub fn open_options();
    #[wasm_bindgen(js_name = openTab)]
    pub fn open_tab(url: &str);
}
