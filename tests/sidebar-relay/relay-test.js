// Tests only: stands in for the sidebar page (WP8b) at sidebar/sidebar.html in the tests' copy of
// the extension (tests/lib/sidebar.mjs). It opens the relay's port as the sidebar will and keeps
// what comes back in `relayTest.st`, which the tests read through the panel's frame-script bridge.
// It acknowledges each chunk as it takes it (`ack`, cumulative), or holds the acks back while
// `hold(true)` until `release()`.
const st = { refused: null, disconnected: false, link: [], reqs: {}, hold: false, postError: null };
let port = null;
let held = {};

const req = (id) => (st.reqs[id] ??= { res: null, chunks: [], end: null });

function connect() {
  st.refused = null;
  st.disconnected = false;
  port = browser.runtime.connect({ name: "kai-sidebar" });
  port.onMessage.addListener((m) => {
    if (m.t === "refused") st.refused = m.reason;
    else if (m.t === "link") st.link.push(m.up);
    else if (m.t === "res") req(m.id).res = m;
    else if (m.t === "chunk") {
      req(m.id).chunks.push(m);
      if (st.hold) held[m.id] = m.seq + 1;
      else port.postMessage({ t: "ack", id: m.id, seq: m.seq + 1 });
    } else if (m.t === "end") req(m.id).end = m;
  });
  port.onDisconnect.addListener(() => (st.disconnected = true));
}

function attempt(m) {
  try {
    port.postMessage(m);
  } catch (e) {
    st.postError = String(e);
  }
  return 1;
}

window.relayTest = {
  st,
  send: (r) => attempt({ t: "req", ...r }),
  abort: (id) => attempt({ t: "abort", id }),
  hold: (on) => ((st.hold = on), 1),
  release() {
    for (const [id, seq] of Object.entries(held)) attempt({ t: "ack", id: Number(id), seq });
    held = {};
    return 1;
  },
};

connect();
