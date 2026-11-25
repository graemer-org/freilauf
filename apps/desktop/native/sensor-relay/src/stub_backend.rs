//! Backend for systems without a peripheral implementation yet (macOS needs
//! CoreBluetooth's CBPeripheralManager, Linux the BlueZ D-Bus GATT server; see
//! docs/adr/0005-sensor-relay.md). It answers the protocol and reports
//! "unsupported", which is also what the protocol tests run against.

use crate::protocol::{Event, ServiceDef};
use crate::{Backend, Out};

pub struct StubBackend;

impl Backend for StubBackend {
    fn name(&self) -> &'static str {
        "none"
    }
    fn check(&mut self, out: &Out) -> Result<(), String> {
        let reason = format!(
            "This helper has no Bluetooth peripheral support for {} yet.",
            std::env::consts::OS
        );
        out.send(&Event::Unsupported { reason: reason.clone() });
        Err(reason)
    }
    fn start(&mut self, _services: Vec<ServiceDef>, _out: &Out) -> Result<(), String> {
        Err("unsupported".into())
    }
    fn notify(&mut self, _s: &str, _c: &str, _v: Vec<u8>) -> Result<(), String> {
        Ok(())
    }
    fn stop(&mut self, _out: &Out) {}
}
