//! The helper's wire protocol: one JSON object per line on stdin (commands)
//! and stdout (events). Kept independent of the Bluetooth backend so it is
//! unit-tested on every OS. The TypeScript mirror is
//! apps/desktop/src/main/sensorRelayProtocol.ts; its tests read this file and
//! fail when PROTOCOL or the command/event names below drift apart.
//!
//! Commands (app -> helper):
//!   {"type":"start","services":[{"uuid","characteristics":[{"uuid","properties":[...],"value"}]}]}
//!   {"type":"notify","service","characteristic","value"}   value: lowercase hex
//!   {"type":"stop"}
//!   {"type":"quit"}
//! Events (helper -> app):
//!   ready, adapter, unsupported, started, stopped, advertising, subscribers, write, error
//!
//! Nothing in here may panic on input from the pipe (the release build aborts on panic).

use serde::{Deserialize, Serialize};

/// Bumped on incompatible changes; the app refuses a helper with another one.
pub const PROTOCOL: u32 = 1;

/// Longest accepted command line in bytes (a full `start` is about 2 KB).
pub const MAX_LINE: usize = 64 * 1024;
/// Longest accepted characteristic value in bytes (ATT allows 512).
pub const MAX_VALUE: usize = 512;
/// Upper bounds on what one `start` may create.
pub const MAX_SERVICES: usize = 8;
pub const MAX_CHARACTERISTICS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
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
    Notify { service: String, characteristic: String, value: String },
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
    /// What the OS says about the default Bluetooth adapter (diagnostics).
    #[serde(rename_all = "camelCase")]
    Adapter {
        low_energy_supported: bool,
        peripheral_role_supported: bool,
        central_role_supported: bool,
        /// null when the radio state could not be read.
        radio_on: Option<bool>,
    },
    Unsupported {
        reason: String,
    },
    /// The services that are now published (uuids, canonical lowercase).
    Started {
        services: Vec<String>,
    },
    Stopped,
    /// Advertising status of one service, as the OS reports it.
    Advertising {
        service: String,
        status: String,
    },
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
    Error {
        message: String,
    },
}

/// Event type names as they appear on the wire (kept for the sync test with the TS side).
#[allow(dead_code)]
pub const EVENT_TYPES: [&str; 9] =
    ["ready", "adapter", "unsupported", "started", "stopped", "advertising", "subscribers", "write", "error"];
/// Command type names as they appear on the wire.
#[allow(dead_code)]
pub const COMMAND_TYPES: [&str; 4] = ["start", "notify", "stop", "quit"];

pub fn parse_command(line: &str) -> Result<Command, String> {
    if line.len() > MAX_LINE {
        return Err(format!("bad command: line of {} bytes is too long", line.len()));
    }
    let c = serde_json::from_str::<Command>(line).map_err(|e| format!("bad command: {e}"))?;
    if let Command::Start { services } = &c {
        validate_services(services)?;
    }
    Ok(c)
}

/// Checks a `start` before anything is created, so a bad set fails as a whole.
pub fn validate_services(services: &[ServiceDef]) -> Result<(), String> {
    if services.is_empty() || services.len() > MAX_SERVICES {
        return Err(format!("bad command: {} services (1 to {MAX_SERVICES})", services.len()));
    }
    for s in services {
        parse_uuid(&s.uuid)?;
        if s.characteristics.is_empty() || s.characteristics.len() > MAX_CHARACTERISTICS {
            return Err(format!(
                "bad command: service {} has {} characteristics",
                s.uuid,
                s.characteristics.len()
            ));
        }
        for c in &s.characteristics {
            parse_uuid(&c.uuid)?;
            if c.properties.is_empty() {
                return Err(format!("bad command: characteristic {} has no properties", c.uuid));
            }
            decode_hex(&c.value)?;
        }
    }
    Ok(())
}

pub fn event_line(e: &Event) -> String {
    // Serialising these plain structs cannot fail; never panic regardless.
    serde_json::to_string(e).unwrap_or_else(|_| "{\"type\":\"error\",\"message\":\"serialise\"}".into())
}

/// Lowercase or uppercase hex, even length, at most MAX_VALUE bytes. Works on
/// bytes, so non-ASCII input is an error and never a slicing panic.
pub fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    let b = s.as_bytes();
    if b.len() % 2 != 0 || b.len() > MAX_VALUE * 2 {
        return Err(format!("bad hex value of length {}", b.len()));
    }
    fn nibble(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            b'A'..=b'F' => Some(c - b'A' + 10),
            _ => None,
        }
    }
    b.chunks_exact(2)
        .map(|p| match (nibble(p[0]), nibble(p[1])) {
            (Some(h), Some(l)) => Ok(h << 4 | l),
            _ => Err("bad hex value".to_string()),
        })
        .collect()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn encode_hex(b: &[u8]) -> String {
    const D: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(D[(x >> 4) as usize] as char);
        s.push(D[(x & 15) as usize] as char);
    }
    s
}

/// Parses a 128-bit UUID "0000180d-0000-1000-8000-00805f9b34fb" (case-insensitive).
/// Strict: 8-4-4-4-12 hex digits, nothing else.
pub fn parse_uuid(s: &str) -> Result<u128, String> {
    let b = s.as_bytes();
    let shape_ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        });
    if !shape_ok {
        return Err(format!("bad uuid {:?}", truncate(s, 40)));
    }
    let hex: String = s.chars().filter(|c| *c != '-').collect();
    u128::from_str_radix(&hex, 16).map_err(|_| format!("bad uuid {:?}", truncate(s, 40)))
}

/// Lowercase canonical form, so ids from the OS and from the app compare equal.
pub fn uuid_string(v: u128) -> String {
    let h = format!("{v:032x}");
    format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
}

/// The canonical form of a UUID given as text.
pub fn canonical_uuid(s: &str) -> Result<String, String> {
    parse_uuid(s).map(uuid_string)
}

/// At most `max` characters of `s` (for error messages about bad input).
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const HR: &str = "0000180d-0000-1000-8000-00805f9b34fb";

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
    fn start_value_defaults_to_empty() {
        let c = parse_command(&format!(
            r#"{{"type":"start","services":[{{"uuid":"{HR}","characteristics":[{{"uuid":"{HR}","properties":["write","indicate"]}}]}}]}}"#
        ))
        .unwrap();
        let Command::Start { services } = c else { panic!() };
        assert_eq!(services[0].characteristics[0].value, "");
    }

    #[test]
    fn rejects_bad_start_sets() {
        assert!(parse_command(r#"{"type":"start","services":[]}"#).is_err());
        assert!(
            parse_command(r#"{"type":"start","services":[{"uuid":"180d","characteristics":[]}]}"#).is_err()
        );
        let no_chars = format!(r#"{{"type":"start","services":[{{"uuid":"{HR}","characteristics":[]}}]}}"#);
        assert!(parse_command(&no_chars).is_err());
        let no_props = format!(
            r#"{{"type":"start","services":[{{"uuid":"{HR}","characteristics":[{{"uuid":"{HR}","properties":[]}}]}}]}}"#
        );
        assert!(parse_command(&no_props).is_err());
        let bad_value = format!(
            r#"{{"type":"start","services":[{{"uuid":"{HR}","characteristics":[{{"uuid":"{HR}","properties":["read"],"value":"xyz"}}]}}]}}"#
        );
        assert!(parse_command(&bad_value).is_err());
        let bad_prop = format!(
            r#"{{"type":"start","services":[{{"uuid":"{HR}","characteristics":[{{"uuid":"{HR}","properties":["broadcast"]}}]}}]}}"#
        );
        assert!(parse_command(&bad_prop).is_err());
    }

    #[test]
    fn parses_notify_stop_quit_and_rejects_junk() {
        assert_eq!(
            parse_command(r#"{"type":"notify","service":"a","characteristic":"b","value":"00ff"}"#).unwrap(),
            Command::Notify { service: "a".into(), characteristic: "b".into(), value: "00ff".into() }
        );
        assert_eq!(parse_command(r#"{"type":"stop"}"#).unwrap(), Command::Stop);
        assert_eq!(parse_command(r#"{"type":"quit"}"#).unwrap(), Command::Quit);
        for junk in [
            "not json",
            "",
            "null",
            "[]",
            "42",
            r#"{"type":"explode"}"#,
            r#"{"type":"notify"}"#,
            r#"{"type":"notify","service":1,"characteristic":"b","value":"00"}"#,
            r#"{"type":"START"}"#,
            "{\"type\":\"stop\"",
        ] {
            assert!(parse_command(junk).is_err(), "{junk:?} should be rejected");
        }
        let long = format!(r#"{{"type":"stop","x":"{}"}}"#, "a".repeat(MAX_LINE));
        assert!(parse_command(&long).is_err());
    }

    #[test]
    fn hex_round_trip_and_never_panics() {
        assert_eq!(decode_hex("00ff10").unwrap(), vec![0, 255, 16]);
        assert_eq!(decode_hex("00FF").unwrap(), vec![0, 255]);
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
        assert_eq!(encode_hex(&[0, 255, 16]), "00ff10");
        assert!(decode_hex("0").is_err());
        assert!(decode_hex("zz").is_err());
        assert!(decode_hex("+1").is_err());
        // Multi-byte UTF-8 at odd byte offsets used to panic in a str slice.
        assert!(decode_hex("aé").is_err());
        assert!(decode_hex("aéb").is_err());
        assert!(decode_hex("éé").is_err());
        assert!(decode_hex(&"00".repeat(MAX_VALUE)).is_ok());
        assert!(decode_hex(&"00".repeat(MAX_VALUE + 1)).is_err());
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(decode_hex(&encode_hex(&all)).unwrap(), all);
    }

    #[test]
    fn uuid_round_trip_and_strictness() {
        let v = parse_uuid("0000180D-0000-1000-8000-00805f9b34fb").unwrap();
        assert_eq!(v, 0x0000180d_0000_1000_8000_00805f9b34fb);
        assert_eq!(uuid_string(v), HR);
        assert_eq!(canonical_uuid("0000180D-0000-1000-8000-00805F9B34FB").unwrap(), HR);
        for bad in [
            "180d",
            "",
            "+000180d-0000-1000-8000-00805f9b34fb",
            "0000180d00000-1000-8000-00805f9b34fb",
            "0000180d-0000-1000-8000-00805f9b34f-",
            "0000180d-0000-1000-8000-00805f9b34fg",
            "0000180d-0000-1000-8000-00805f9b34fbb",
            "é000180d-0000-1000-8000-00805f9b34f",
        ] {
            assert!(parse_uuid(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn events_serialise_camel_case() {
        assert_eq!(
            event_line(&Event::Adapter {
                low_energy_supported: true,
                peripheral_role_supported: true,
                central_role_supported: false,
                radio_on: None
            }),
            r#"{"type":"adapter","lowEnergySupported":true,"peripheralRoleSupported":true,"centralRoleSupported":false,"radioOn":null}"#
        );
        assert_eq!(
            event_line(&Event::Ready { version: "1", protocol: 1, backend: "winrt" }),
            r#"{"type":"ready","version":"1","protocol":1,"backend":"winrt"}"#
        );
        assert_eq!(
            event_line(&Event::Started { services: vec![HR.into()] }),
            format!(r#"{{"type":"started","services":["{HR}"]}}"#)
        );
        assert_eq!(event_line(&Event::Stopped), r#"{"type":"stopped"}"#);
        assert_eq!(
            event_line(&Event::Subscribers {
                service: "s".into(),
                characteristic: "c".into(),
                centrals: vec!["c1".into()]
            }),
            r#"{"type":"subscribers","service":"s","characteristic":"c","centrals":["c1"]}"#
        );
    }

    #[test]
    fn event_type_list_matches_the_enum() {
        let samples = [
            Event::Ready { version: "x", protocol: PROTOCOL, backend: "none" },
            Event::Adapter {
                low_energy_supported: false,
                peripheral_role_supported: false,
                central_role_supported: false,
                radio_on: Some(true),
            },
            Event::Unsupported { reason: "r".into() },
            Event::Started { services: vec![] },
            Event::Stopped,
            Event::Advertising { service: "s".into(), status: "started".into() },
            Event::Subscribers { service: "s".into(), characteristic: "c".into(), centrals: vec![] },
            Event::Write {
                service: "s".into(),
                characteristic: "c".into(),
                value: "01".into(),
                central: "c1".into(),
            },
            Event::Error { message: "m".into() },
        ];
        for (e, name) in samples.iter().zip(EVENT_TYPES) {
            let v: serde_json::Value = serde_json::from_str(&event_line(e)).unwrap();
            assert_eq!(v["type"], name);
        }
    }
}
