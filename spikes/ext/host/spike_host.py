#!/usr/bin/python3 -I
"""WP0 (a) spike native-messaging host. Firefox starts it on connectNative.

Framing: 4-byte little-endian length + UTF-8 JSON, both ways. Logs one JSON line per event to
$SPIKE_HOST_LOG/host-<pid>.jsonl (wall-clock ms in "t"): start (pid, ppid, argv: Firefox passes
the manifest path and the extension id), every message, stdin EOF, SIGTERM, exit.

Environment (inherited from the Firefox the harness started):
  SPIKE_HOST_LOG   log folder (default: ./hostlog next to this file's spike folder's target)
  SPIKE_HOST_MODE  eof-exit  - exit on stdin EOF (what kai-browser-host should do)
                   term-exit - keep running after EOF, exit on SIGTERM
                   stubborn  - ignore EOF and SIGTERM; only SIGKILL ends it
  SPIKE_PING_S     send {"t":"ping"} every N seconds (default 30; 0 = never)
  SPIKE_PIPE_SZ    if set, fcntl(F_SETPIPE_SZ) on stdin and stdout to this many bytes

Messages it understands from the extension:
  {"t":"send_big","bytes":N}  answer one message whose JSON is exactly N bytes ({"t":"big","pad":...})
  {"t":"big","pad":...}       a large message from the extension; answered {"t":"big_ack","len":...}
  anything else               logged
"""
import json
import os
import signal
import struct
import sys
import threading
import time

LOG_DIR = os.environ.get("SPIKE_HOST_LOG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "hostlog")
MODE = os.environ.get("SPIKE_HOST_MODE", "eof-exit")
PING_S = float(os.environ.get("SPIKE_PING_S", "30"))

os.makedirs(LOG_DIR, exist_ok=True)
_log = open(os.path.join(LOG_DIR, "host-%d.jsonl" % os.getpid()), "a", buffering=1)
_log_lock = threading.Lock()
_out_lock = threading.Lock()
_eof = threading.Event()


def log(ev, **kw):
    kw.update(ev=ev, t=round(time.time() * 1000, 1), pid=os.getpid())
    with _log_lock:
        _log.write(json.dumps(kw) + "\n")
        _log.flush()


def send(obj=None, raw=None):
    data = raw if raw is not None else json.dumps(obj, separators=(",", ":")).encode()
    try:
        with _out_lock:
            sys.stdout.buffer.write(struct.pack("<I", len(data)))
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        return True
    except (BrokenPipeError, OSError) as e:
        log("write_error", error=str(e), len=len(data))
        return False


def read_exact(n):
    buf = bytearray()
    while len(buf) < n:
        chunk = sys.stdin.buffer.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def on_term(signum, frame):
    log("sigterm", mode=MODE)
    if MODE in ("eof-exit", "term-exit"):
        log("exit", why="sigterm")
        os._exit(0)


def reader():
    while True:
        head = read_exact(4)
        if head is None:
            break
        (n,) = struct.unpack("<I", head)
        t0 = time.time()
        body = read_exact(n)
        if body is None:
            log("eof_mid_message", len=n)
            break
        read_ms = round((time.time() - t0) * 1000, 1)
        try:
            msg = json.loads(body)
        except ValueError as e:
            log("bad_json", len=n, error=str(e))
            continue
        t = msg.get("t")
        small = {k: v for k, v in msg.items() if k != "pad" and not (isinstance(v, str) and len(v) > 200)}
        if t == "big":
            log("msg", len=n, read_ms=read_ms, pad_len=len(msg.get("pad", "")), sent_at=msg.get("sent_at"), msg=small)
            send({"t": "big_ack", "len": n, "pad_len": len(msg.get("pad", ""))})
        elif t == "send_big":
            want = int(msg["bytes"])
            frame = b'{"t":"big","pad":"' + b"x" * (want - 20) + b'"}'
            assert len(frame) == want, (len(frame), want)
            log("msg", len=n, msg=small)
            ok = send(raw=frame)
            log("sent_big", len=len(frame), ok=ok)
        else:
            log("msg", len=n, msg=small)
    log("eof", mode=MODE)
    _eof.set()
    if MODE == "eof-exit":
        log("exit", why="eof")
        os._exit(0)


def set_pipe_size():
    want = os.environ.get("SPIKE_PIPE_SZ")
    if not want:
        return None
    import fcntl
    got = {}
    for name, fd in (("stdin", 0), ("stdout", 1)):
        try:
            got[name] = fcntl.fcntl(fd, 1031, int(want))  # F_SETPIPE_SZ
        except OSError as e:
            got[name] = str(e)
    return got


def main():
    signal.signal(signal.SIGTERM, on_term)
    pipe = set_pipe_size()
    log("start", ppid=os.getppid(), argv=sys.argv, mode=MODE, ping_s=PING_S, pipe_size=pipe)
    threading.Thread(target=reader, daemon=True).start()
    seq = 0
    next_ping = time.time() + PING_S if PING_S > 0 else None
    while True:
        time.sleep(0.2)
        if next_ping and not _eof.is_set() and time.time() >= next_ping:
            seq += 1
            ok = send({"t": "ping", "seq": seq, "host_pid": os.getpid(), "sent_at": time.time() * 1000})
            log("ping", seq=seq, ok=ok)
            next_ping += PING_S


if __name__ == "__main__":
    main()
