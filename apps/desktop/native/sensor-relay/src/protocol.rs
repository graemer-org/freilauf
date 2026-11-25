//! The helper's wire protocol: one JSON object per line on stdin (commands)
//! and stdout (events). Kept independent of the Bluetooth backend so it is
//! unit-tested on every OS. The TypeScript side (apps/desktop/src/main/
//! sensorRelayProtocol.ts) is the reference; both must agree on PROTOCOL.

use serde::{Deserialize, Serialize};

/// Bumped on incompatible changes; the app refuses a helper with another one.
pub const PROTOCOL: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Property {
    Read,
    Notify,
    Indicate,
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CharacteristicDef {
    pub uuid: String,
    pub properties: Vec<Property>,
    /// Initial value, hex.
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ServiceDef {
    pub uuid: String,
    pub characteristics: Vec<CharacteristicDef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Command {
    /// Create the services and start advertising them (replaces a running set).
    Start { services: Vec<ServiceDef> },
    /// Set a characteristic's value and notify/indicate its subscribers.
    Notify {
        service: String,
        characteristic: String,
        value: String,
    },
    /// Stop advertising and remove the services.
    Stop,
    /// Stop and exit.
    Quit,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    #[serde(rename_all = "camelCase")]
    Ready {
        version: &'static str,
        protocol: u32,
        backend: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Adapter {
        peripheral_role_supported: bool,
        low_energy_supported: bool,
    },
    Unsupported { reason: String },
    Started,
    Stopped,
    /// Advertising status of one service, as the OS reports it.
    Advertising { service: String, status: String },
    /// The centrals currently subscribed to one characteristic (opaque ids).
    Subscribers {
        service: String,
        characteristic: String,
        centrals: Vec<String>,
    },
    /// A central wrote to a characteristic (already acknowledged).
    Write {
        service: String,
        characteristic: String,
        value: String,
        central: String,
    },
    Error { message: String },
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    serde_json::from_str::<Command>(line).map_err(|e| format!("bad command: {e}"))
}

pub fn event_line(e: &Event) -> String {
    // Serialising these plain structs cannot fail.
    serde_json::to_string(e).unwrap_or_else(|_| "{\"type\":\"error\",\"message\":\"serialise\"}".into())
}

pub fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 || s.len() > 1024 {
        return Err(format!("bad hex value of length {}", s.len()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| format!("bad hex value {s:?}")))
        .collect()
}

pub fn encode_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Parses a 128-bit UUID "0000180d-0000-1000-8000-00805f9b34fb" (case-insensitive).
pub fn parse_uuid(s: &str) -> Result<u128, String> {
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    if hex.len() != 32 || s.len() != 36 {
        return Err(format!("bad uuid {s:?}"));
    }
    u128::from_str_radix(&hex, 16).map_err(|_| format!("bad uuid {s:?}"))
}

/// Lowercase canonical form, so ids from the OS and from the app compare equal.
pub fn uuid_string(v: u128) -> String {
    let h = format!("{v:032x}");
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_start() {
        let c = parse_command(
            r#"{"type":"start","services":[{"uuid":"0000180d-0000-1000-8000-00805f9b34fb","characteristics":[{"uuid":"00002a37-0000-1000-8000-00805f9b34fb","properties":["notify"],"value":"0000"}]}]}"#,
        )
        .unwrap();
        match c {
            Command::Start { services } => {
                assert_eq!(services.len(), 1);
                assert_eq!(services[0].characteristics[0].properties, vec![Property::Notify]);
            }
            _ => panic!("expected start"),
        }
    }

    #[test]
    fn parses_notify_stop_quit_and_rejects_junk() {
        assert_eq!(
            parse_command(r#"{"type":"notify","service":"a","characteristic":"b","value":"00ff"}"#).unwrap(),
            Command::Notify { service: "a".into(), characteristic: "b".into(), value: "00ff".into() }
        );
        assert_eq!(parse_command(r#"{"type":"stop"}"#).unwrap(), Command::Stop);
        assert_eq!(parse_command(r#"{"type":"quit"}"#).unwrap(), Command::Quit);
        assert!(parse_command("not json").is_err());
        assert!(parse_command(r#"{"type":"explode"}"#).is_err());
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(decode_hex("00ff10").unwrap(), vec![0, 255, 16]);
        assert_eq!(encode_hex(&[0, 255, 16]), "00ff10");
        assert!(decode_hex("0").is_err());
        assert!(decode_hex("zz").is_err());
    }

    #[test]
    fn uuid_round_trip() {
        let v = parse_uuid("0000180D-0000-1000-8000-00805f9b34fb").unwrap();
        assert_eq!(v, 0x0000180d_0000_1000_8000_00805f9b34fb);
        assert_eq!(uuid_string(v), "0000180d-0000-1000-8000-00805f9b34fb");
        assert!(parse_uuid("180d").is_err());
    }

    #[test]
    fn events_serialise_camel_case() {
        assert_eq!(
            event_line(&Event::Adapter { peripheral_role_supported: true, low_energy_supported: true }),
            r#"{"type":"adapter","peripheralRoleSupported":true,"lowEnergySupported":true}"#
        );
        assert_eq!(
            event_line(&Event::Ready { version: "1", protocol: 1, backend: "winrt" }),
            r#"{"type":"ready","version":"1","protocol":1,"backend":"winrt"}"#
        );
    }
}
