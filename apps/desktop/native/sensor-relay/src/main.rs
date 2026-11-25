//! freilauf-sensor-relay: a tiny helper process that makes the computer look
//! like a Bluetooth LE sensor (heart rate, power meter, speed/cadence) so a
//! sports watch can record an indoor ride from the Freilauf app.
//!
//! The Electron main process spawns it and talks newline-delimited JSON over
//! stdin/stdout (see protocol.rs and docs/adr/0005-sensor-relay.md). The app
//! produces every characteristic value; this program only creates the GATT
//! services it is told to, advertises them and forwards bytes. It exits when
//! stdin closes, so it never outlives the app. Diagnostics go to stderr, which
//! the app copies into its diagnostic log.

mod protocol;
#[cfg(not(windows))]
mod stub_backend;
#[cfg(windows)]
mod windows_backend;

use protocol::{
    canonical_uuid, decode_hex, event_line, parse_command, truncate, Command, Event, ServiceDef, MAX_LINE,
    PROTOCOL,
};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// One line to stderr. Never panics (eprintln! would if stderr is gone).
pub fn log(message: &str) {
    let _ = writeln!(std::io::stderr(), "freilauf-sensor-relay: {message}");
}

/// Thread-safe line writer for events (backend callbacks run on OS threads).
#[derive(Clone)]
pub struct Out(Arc<Mutex<Box<dyn Write + Send>>>);

impl Out {
    pub fn new(w: Box<dyn Write + Send>) -> Self {
        Out(Arc::new(Mutex::new(w)))
    }
    pub fn send(&self, e: &Event) {
        if let Ok(mut s) = self.0.lock() {
            let _ = writeln!(s, "{}", event_line(e));
            let _ = s.flush();
        }
    }
    pub fn error(&self, message: impl Into<String>) {
        let message = message.into();
        log(&message);
        self.send(&Event::Error { message });
    }
}

pub trait Backend {
    fn name(&self) -> &'static str;
    /// Checks the adapter; sends `adapter` and, if it cannot work, `unsupported`.
    /// Returns the reason when unsupported.
    fn check(&mut self, out: &Out) -> Result<(), String>;
    /// Publishes the services; returns the uuids that were published (at least one).
    fn start(&mut self, services: Vec<ServiceDef>, out: &Out) -> Result<Vec<String>, String>;
    fn notify(&mut self, service: &str, characteristic: &str, value: Vec<u8>) -> Result<(), String>;
    /// Stops advertising and releases every service. Idempotent.
    fn stop(&mut self, out: &Out);
}

fn backend() -> Box<dyn Backend> {
    #[cfg(windows)]
    return Box::new(windows_backend::WinRtBackend::new());
    #[cfg(not(windows))]
    return Box::new(stub_backend::StubBackend);
}

/// The command loop. Returns when the input ends or on `quit`; always leaves
/// the backend stopped.
pub fn run(input: &mut dyn BufRead, out: &Out, be: &mut dyn Backend) {
    out.send(&Event::Ready { version: VERSION, protocol: PROTOCOL, backend: be.name() });
    let mut support = be.check(out);
    let mut running = false;
    // Notify errors repeat at the update rate; report each distinct one once per start.
    let mut reported: Vec<String> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();

    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) => break, // EOF: the app is gone
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                log(&format!("stdin: {e}"));
                break;
            }
        }
        if buf.len() > MAX_LINE {
            out.error(format!("bad command: line of {} bytes is too long", buf.len()));
            continue;
        }
        let text = String::from_utf8_lossy(&buf);
        let line = text.trim();
        if line.is_empty() {
            continue;
        }
        match parse_command(line) {
            Err(e) => out.error(format!("{} (line: {:?})", e, truncate(line, 80))),
            Ok(Command::Start { services }) => {
                if support.is_err() {
                    // The adapter may have appeared since (a dongle plugged in): look again.
                    support = be.check(out);
                }
                if support.is_err() {
                    continue; // check() has sent `unsupported` with the reason
                }
                if running {
                    be.stop(out);
                    running = false;
                }
                reported.clear();
                log(&format!("start: {} services", services.len()));
                match be.start(services, out) {
                    Ok(published) => {
                        running = true;
                        log(&format!("started: {}", published.join(", ")));
                        out.send(&Event::Started { services: published });
                    }
                    Err(e) => {
                        be.stop(out);
                        out.error(format!("start failed: {e}"));
                    }
                }
            }
            Ok(Command::Notify { service, characteristic, value }) => {
                if !running {
                    continue;
                }
                let r = decode_hex(&value).and_then(|bytes| {
                    let s = canonical_uuid(&service)?;
                    let c = canonical_uuid(&characteristic)?;
                    be.notify(&s, &c, bytes)
                });
                if let Err(e) = r {
                    if !reported.contains(&e) && reported.len() < 32 {
                        reported.push(e.clone());
                        out.error(e);
                    }
                }
            }
            Ok(Command::Stop) => {
                if running {
                    be.stop(out);
                    running = false;
                }
                log("stopped");
                out.send(&Event::Stopped);
            }
            Ok(Command::Quit) => break,
        }
    }
    if running {
        be.stop(out);
        out.send(&Event::Stopped);
    }
}

fn main() {
    if std::env::args().any(|a| a == "--version") {
        let _ = writeln!(std::io::stdout(), "freilauf-sensor-relay {VERSION} (protocol {PROTOCOL})");
        return;
    }
    let out = Out::new(Box::new(std::io::stdout()));
    let mut be = backend();
    log(&format!("{VERSION} (protocol {PROTOCOL}, backend {}) starting", be.name()));
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    run(&mut input, &out, be.as_mut());
    log("exiting");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// Captures what the loop writes to stdout.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);
    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Sink {
        fn events(&self) -> Vec<serde_json::Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            text.lines().map(|l| serde_json::from_str(l).expect("every line is JSON")).collect()
        }
        fn types(&self) -> Vec<String> {
            self.events().iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
        }
    }

    /// Records calls; supported or not as configured.
    #[derive(Default)]
    struct Fake {
        supported: bool,
        calls: Vec<String>,
        fail_start: bool,
    }
    impl Backend for Fake {
        fn name(&self) -> &'static str {
            "fake"
        }
        fn check(&mut self, out: &Out) -> Result<(), String> {
            self.calls.push("check".into());
            if self.supported {
                Ok(())
            } else {
                out.send(&Event::Unsupported { reason: "no".into() });
                Err("no".into())
            }
        }
        fn start(&mut self, services: Vec<ServiceDef>, _out: &Out) -> Result<Vec<String>, String> {
            self.calls.push(format!("start {}", services.len()));
            if self.fail_start {
                return Err("radio off".into());
            }
            Ok(services.iter().map(|s| s.uuid.clone()).collect())
        }
        fn notify(&mut self, s: &str, c: &str, v: Vec<u8>) -> Result<(), String> {
            if c.starts_with("0000ffff") {
                return Err("unknown characteristic".into());
            }
            self.calls.push(format!("notify {s} {c} {}", protocol::encode_hex(&v)));
            Ok(())
        }
        fn stop(&mut self, _out: &Out) {
            self.calls.push("stop".into());
        }
    }

    const HR: &str = "0000180d-0000-1000-8000-00805f9b34fb";
    const HRM: &str = "00002a37-0000-1000-8000-00805f9b34fb";

    fn start_line() -> String {
        format!(
            "{{\"type\":\"start\",\"services\":[{{\"uuid\":\"{HR}\",\"characteristics\":[{{\"uuid\":\"{HRM}\",\"properties\":[\"notify\"],\"value\":\"0000\"}}]}}]}}\n"
        )
    }

    fn drive(input: &str, be: &mut Fake) -> Sink {
        let sink = Sink::default();
        let out = Out::new(Box::new(sink.clone()));
        run(&mut Cursor::new(input.as_bytes().to_vec()), &out, be);
        sink
    }

    #[test]
    fn handshake_start_notify_stop() {
        let mut be = Fake { supported: true, ..Default::default() };
        let input = format!(
            "{}{{\"type\":\"notify\",\"service\":\"{}\",\"characteristic\":\"{HRM}\",\"value\":\"0050\"}}\n{{\"type\":\"stop\"}}\n",
            start_line(),
            HR.to_uppercase()
        );
        let sink = drive(&input, &mut be);
        assert_eq!(sink.types(), vec!["ready", "started", "stopped"]);
        let ev = sink.events();
        assert_eq!(ev[0]["protocol"], PROTOCOL);
        assert_eq!(ev[0]["backend"], "fake");
        assert_eq!(ev[1]["services"][0], HR);
        // UUIDs reach the backend in canonical lowercase form.
        assert_eq!(
            be.calls,
            vec!["check".to_string(), "start 1".into(), format!("notify {HR} {HRM} 0050"), "stop".into()]
        );
    }

    #[test]
    fn eof_stops_a_running_set() {
        let mut be = Fake { supported: true, ..Default::default() };
        let sink = drive(&start_line(), &mut be);
        assert_eq!(sink.types(), vec!["ready", "started", "stopped"]);
        assert_eq!(be.calls.last().unwrap(), "stop");
    }

    #[test]
    fn quit_ends_the_loop_and_ignores_the_rest() {
        let mut be = Fake { supported: true, ..Default::default() };
        let sink = drive(&format!("{}{{\"type\":\"quit\"}}\n{}", start_line(), start_line()), &mut be);
        assert_eq!(sink.types(), vec!["ready", "started", "stopped"]);
        assert_eq!(be.calls.iter().filter(|c| c.starts_with("start")).count(), 1);
    }

    #[test]
    fn unsupported_backend_answers_start_with_unsupported_and_rechecks() {
        let mut be = Fake::default();
        let sink = drive(&format!("{}{}", start_line(), start_line()), &mut be);
        assert_eq!(sink.types(), vec!["ready", "unsupported", "unsupported", "unsupported"]);
        assert_eq!(be.calls, vec!["check", "check", "check"]);
    }

    #[test]
    fn restart_replaces_the_running_set() {
        let mut be = Fake { supported: true, ..Default::default() };
        drive(&format!("{}{}", start_line(), start_line()), &mut be);
        assert_eq!(be.calls, vec!["check", "start 1", "stop", "start 1", "stop"]);
    }

    #[test]
    fn failed_start_reports_an_error_and_stays_stopped() {
        let mut be = Fake { supported: true, fail_start: true, ..Default::default() };
        let input = format!(
            "{}{{\"type\":\"notify\",\"service\":\"{HR}\",\"characteristic\":\"{HRM}\",\"value\":\"00\"}}\n",
            start_line()
        );
        let sink = drive(&input, &mut be);
        assert_eq!(sink.types(), vec!["ready", "error"]);
        assert!(sink.events()[1]["message"].as_str().unwrap().contains("radio off"));
        assert!(!be.calls.iter().any(|c| c.starts_with("notify")));
    }

    #[test]
    fn junk_lines_are_errors_not_crashes() {
        let mut be = Fake { supported: true, ..Default::default() };
        let mut input: Vec<u8> = Vec::new();
        input.extend_from_slice(b"garbage\n\n   \n{\"type\":\"notify\"}\n");
        input.extend_from_slice(&[0xff, 0xfe, b'\n']); // not UTF-8
        input.extend_from_slice(format!("{}\n", "x".repeat(MAX_LINE + 10)).as_bytes());
        input.extend_from_slice(b"{\"type\":\"stop\"}"); // no trailing newline
        let sink = Sink::default();
        let out = Out::new(Box::new(sink.clone()));
        run(&mut Cursor::new(input), &out, &mut be);
        assert_eq!(sink.types(), vec!["ready", "error", "error", "error", "error", "stopped"]);
    }

    #[test]
    fn notify_errors_are_reported_once() {
        let mut be = Fake { supported: true, ..Default::default() };
        let bad = format!("{{\"type\":\"notify\",\"service\":\"{HR}\",\"characteristic\":\"0000ffff-0000-1000-8000-00805f9b34fb\",\"value\":\"00\"}}\n");
        let badhex = format!(
            "{{\"type\":\"notify\",\"service\":\"{HR}\",\"characteristic\":\"{HRM}\",\"value\":\"0\"}}\n"
        );
        let input = format!("{}{bad}{bad}{bad}{badhex}{badhex}", start_line());
        let sink = drive(&input, &mut be);
        assert_eq!(sink.types(), vec!["ready", "started", "error", "error", "stopped"]);
    }

    #[test]
    fn notify_before_start_is_ignored() {
        let mut be = Fake { supported: true, ..Default::default() };
        let input = format!(
            "{{\"type\":\"notify\",\"service\":\"{HR}\",\"characteristic\":\"{HRM}\",\"value\":\"00\"}}\n"
        );
        let sink = drive(&input, &mut be);
        assert_eq!(sink.types(), vec!["ready"]);
        assert_eq!(be.calls, vec!["check"]);
    }

    #[cfg(not(windows))]
    #[test]
    fn stub_backend_reports_unsupported() {
        let sink = Sink::default();
        let out = Out::new(Box::new(sink.clone()));
        let mut be = stub_backend::StubBackend;
        run(&mut Cursor::new(start_line().into_bytes()), &out, &mut be);
        let ev = sink.events();
        assert_eq!(sink.types(), vec!["ready", "unsupported", "unsupported"]);
        assert_eq!(ev[0]["backend"], "none");
        assert!(ev[1]["reason"].as_str().unwrap().contains(std::env::consts::OS));
    }
}
