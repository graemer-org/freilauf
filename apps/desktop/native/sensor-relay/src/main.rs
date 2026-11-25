//! freilauf-sensor-relay: a tiny helper process that makes the computer look
//! like a Bluetooth LE sensor (heart rate, power meter, speed/cadence) so a
//! sports watch can record an indoor ride from the Freilauf app.
//!
//! The Electron main process spawns it and talks newline-delimited JSON over
//! stdin/stdout (see protocol.rs and docs/adr/0005-sensor-relay.md). The app
//! produces every characteristic value; this program only creates the GATT
//! services it is told to, advertises them and forwards bytes. It exits when
//! stdin closes, so it never outlives the app.

mod protocol;
#[cfg(not(windows))]
mod stub_backend;
#[cfg(windows)]
mod windows_backend;

use protocol::{event_line, parse_command, Command, Event, ServiceDef, PROTOCOL};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Thread-safe line writer for events (backend callbacks run on OS threads).
#[derive(Clone)]
pub struct Out(Arc<Mutex<std::io::Stdout>>);

impl Out {
    pub fn send(&self, e: &Event) {
        if let Ok(mut s) = self.0.lock() {
            let _ = writeln!(s, "{}", event_line(e));
            let _ = s.flush();
        }
    }
    pub fn error(&self, message: impl Into<String>) {
        self.send(&Event::Error { message: message.into() });
    }
}

pub trait Backend {
    fn name(&self) -> &'static str;
    /// Checks the adapter; sends `adapter` and, if it cannot work, `unsupported`.
    /// Returns the reason when unsupported.
    fn check(&mut self, out: &Out) -> Result<(), String>;
    fn start(&mut self, services: Vec<ServiceDef>, out: &Out) -> Result<(), String>;
    fn notify(&mut self, service: &str, characteristic: &str, value: Vec<u8>) -> Result<(), String>;
    fn stop(&mut self, out: &Out);
}

fn backend() -> Box<dyn Backend> {
    #[cfg(windows)]
    return Box::new(windows_backend::WinRtBackend::new());
    #[cfg(not(windows))]
    return Box::new(stub_backend::StubBackend);
}

fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("freilauf-sensor-relay {VERSION} (protocol {PROTOCOL})");
        return;
    }
    let out = Out(Arc::new(Mutex::new(std::io::stdout())));
    let mut be = backend();
    out.send(&Event::Ready { version: VERSION, protocol: PROTOCOL, backend: be.name() });
    let support = be.check(&out);
    let mut running = false;

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match parse_command(line) {
            Err(e) => out.error(e),
            Ok(Command::Start { services }) => {
                if let Err(reason) = &support {
                    out.send(&Event::Unsupported { reason: reason.clone() });
                    continue;
                }
                if running {
                    be.stop(&out);
                }
                match be.start(services, &out) {
                    Ok(()) => {
                        running = true;
                        out.send(&Event::Started);
                    }
                    Err(e) => {
                        be.stop(&out);
                        running = false;
                        out.error(format!("start failed: {e}"));
                    }
                }
            }
            Ok(Command::Notify { service, characteristic, value }) => {
                if !running {
                    continue;
                }
                match protocol::decode_hex(&value) {
                    Ok(bytes) => {
                        if let Err(e) = be.notify(&service, &characteristic, bytes) {
                            out.error(e);
                        }
                    }
                    Err(e) => out.error(e),
                }
            }
            Ok(Command::Stop) => {
                if running {
                    be.stop(&out);
                    running = false;
                }
                out.send(&Event::Stopped);
            }
            Ok(Command::Quit) => break,
        }
    }
    if running {
        be.stop(&out);
        out.send(&Event::Stopped);
    }
}
