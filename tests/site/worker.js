// A dedicated worker that writes: the network gate's view of a worker's request.
fetch("/api/worker", { method: "POST", body: "from=worker" }).then((r) => postMessage(`worker saved ${r.status}`), () => postMessage("worker save failed"));
