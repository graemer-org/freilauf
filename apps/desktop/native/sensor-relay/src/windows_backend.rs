//! Windows backend: WinRT `GattServiceProvider` (Windows 10 1803+ / Windows 11).
//! One provider per service, advertised connectable and discoverable. Windows
//! advertises with the computer's Bluetooth name; an app cannot set its own.
//!
//! Threading: the process joins the multithreaded apartment; the command loop
//! runs on the main thread and blocks on WinRT async operations with `join()`
//! (fine in the MTA). Read/write/subscription/advertising callbacks arrive on
//! thread-pool threads; they only touch `Out` and the shared value cell.
//!
//! Untested on real hardware at the time of writing (cross-compiled from Linux
//! with x86_64-pc-windows-gnu). See docs/adr/0005-sensor-relay.md.

use crate::protocol::{decode_hex, encode_hex, parse_uuid, uuid_string, Event, Property, ServiceDef};
use crate::{log, Backend, Out};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use windows::core::{Ref, GUID, HSTRING};
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristicProperties, GattCommunicationStatus, GattLocalCharacteristic,
    GattLocalCharacteristicParameters, GattProtectionLevel, GattProtocolError, GattReadRequestedEventArgs,
    GattServiceProvider, GattServiceProviderAdvertisementStatus,
    GattServiceProviderAdvertisementStatusChangedEventArgs, GattServiceProviderAdvertisingParameters,
    GattSession, GattWriteOption, GattWriteRequestedEventArgs,
};
use windows::Devices::Bluetooth::{BluetoothAdapter, BluetoothError};
use windows::Devices::Radios::RadioState;
use windows::Foundation::TypedEventHandler;
use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

type WinResult<T> = windows::core::Result<T>;

struct Char {
    service: String,
    uuid: String,
    ch: GattLocalCharacteristic,
    value: Arc<Mutex<Vec<u8>>>,
    pushes: bool,
}

pub struct WinRtBackend {
    providers: Vec<(String, GattServiceProvider)>,
    chars: Vec<Char>,
}

impl WinRtBackend {
    pub fn new() -> Self {
        // MTA: event handlers arrive on thread-pool threads; nothing here needs an STA.
        // Already initialised (S_FALSE) or a different mode are both fine to ignore.
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            );
        }
        WinRtBackend { providers: Vec::new(), chars: Vec::new() }
    }
}

fn to_buffer(bytes: &[u8]) -> WinResult<IBuffer> {
    let w = DataWriter::new()?;
    w.WriteBytes(bytes)?;
    w.DetachBuffer()
}

fn from_buffer(buf: &IBuffer) -> WinResult<Vec<u8>> {
    let r = DataReader::FromBuffer(buf)?;
    let n = (r.UnconsumedBufferLength()? as usize).min(4096);
    let mut v = vec![0u8; n];
    r.ReadBytes(&mut v)?;
    Ok(v)
}

/// Short opaque id for a central: a hash of the OS device id, so Bluetooth
/// addresses never reach the app or its log.
fn central_id(session: WinResult<GattSession>) -> String {
    let id: String = session
        .and_then(|s| s.DeviceId())
        .and_then(|d| d.Id())
        .map(|h: HSTRING| h.to_string_lossy())
        .unwrap_or_default();
    let mut h: u64 = 0xcbf29ce484222325;
    for b in id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("c{:08x}", (h >> 32) as u32)
}

fn status_name(s: GattServiceProviderAdvertisementStatus) -> String {
    match s {
        GattServiceProviderAdvertisementStatus::Created => "created".into(),
        GattServiceProviderAdvertisementStatus::Stopped => "stopped".into(),
        GattServiceProviderAdvertisementStatus::Started => "started".into(),
        GattServiceProviderAdvertisementStatus::Aborted => "aborted".into(),
        GattServiceProviderAdvertisementStatus::StartedWithoutAllAdvertisementData => {
            "startedWithoutAllAdvertisementData".into()
        }
        other => format!("status{}", other.0),
    }
}

fn bt_error(e: BluetoothError) -> String {
    match e {
        BluetoothError::Success => "success".into(),
        BluetoothError::RadioNotAvailable => "the Bluetooth radio is off or not available".into(),
        BluetoothError::ResourceInUse => "resource in use".into(),
        BluetoothError::DeviceNotConnected => "device not connected".into(),
        BluetoothError::NotSupported => "not supported by this adapter".into(),
        BluetoothError::DisabledByPolicy => "disabled by policy".into(),
        BluetoothError::DisabledByUser => "disabled by the user".into(),
        BluetoothError::ConsentRequired => "consent required".into(),
        BluetoothError::TransportNotSupported => "transport not supported".into(),
        other => format!("Bluetooth error {}", other.0),
    }
}

fn subscribers(ch: &GattLocalCharacteristic) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(list) = ch.SubscribedClients() {
        for c in list {
            let id = central_id(c.Session());
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// Notification failures are logged to stderr, but only the first few (they
/// repeat at the update rate when a watch walks away).
static NOTIFY_FAILURES: AtomicU32 = AtomicU32::new(0);

fn note_notify_failure(what: String) {
    let n = NOTIFY_FAILURES.fetch_add(1, Ordering::Relaxed);
    if n < 20 {
        log(&format!("notify failed: {what}"));
    } else if n == 20 {
        log("notify failed again; not logging further notify failures");
    }
}

/// Answers a read with the current value (honouring the offset of a long
/// read). The deferral is completed on every path.
fn answer_read(args: &GattReadRequestedEventArgs, value: &Arc<Mutex<Vec<u8>>>) -> WinResult<()> {
    let deferral = args.GetDeferral()?;
    let result = (|| -> WinResult<()> {
        let req = args.GetRequestAsync()?.join()?;
        let bytes = value.lock().map(|g| g.clone()).unwrap_or_default();
        let offset = req.Offset().unwrap_or(0) as usize;
        if offset > bytes.len() {
            return req.RespondWithProtocolError(GattProtocolError::InvalidOffset()?);
        }
        req.RespondWithValue(&to_buffer(&bytes[offset..])?)
    })();
    let _ = deferral.Complete();
    result
}

/// Acknowledges a write and returns its bytes. The deferral is completed on every path.
fn answer_write(args: &GattWriteRequestedEventArgs) -> WinResult<Vec<u8>> {
    let deferral = args.GetDeferral()?;
    let result = (|| -> WinResult<Vec<u8>> {
        let req = args.GetRequestAsync()?.join()?;
        let bytes = from_buffer(&req.Value()?)?;
        if req.Option()? == GattWriteOption::WriteWithResponse {
            req.Respond()?;
        }
        Ok(bytes)
    })();
    let _ = deferral.Complete();
    result
}

impl WinRtBackend {
    fn create_service(&mut self, def: &ServiceDef, out: &Out) -> Result<(), String> {
        let sid = uuid_string(parse_uuid(&def.uuid)?);
        let result = GattServiceProvider::CreateAsync(GUID::from_u128(parse_uuid(&sid)?))
            .and_then(|op| op.join())
            .map_err(|e| format!("service {sid}: {}", e.message()))?;
        let err = result.Error().map_err(|e| e.message())?;
        if err != BluetoothError::Success {
            return Err(format!("service {sid}: {}", bt_error(err)));
        }
        let provider = result.ServiceProvider().map_err(|e| e.message())?;
        let service = provider.Service().map_err(|e| e.message())?;
        let mut chars: Vec<Char> = Vec::new();

        for c in &def.characteristics {
            let cid = uuid_string(parse_uuid(&c.uuid)?);
            let mut props = GattCharacteristicProperties::None;
            for p in &c.properties {
                props = props
                    | match p {
                        Property::Read => GattCharacteristicProperties::Read,
                        Property::Notify => GattCharacteristicProperties::Notify,
                        Property::Indicate => GattCharacteristicProperties::Indicate,
                        Property::Write => GattCharacteristicProperties::Write,
                    };
            }
            let werr = |e: windows::core::Error| format!("characteristic {cid}: {}", e.message());
            let params = GattLocalCharacteristicParameters::new().map_err(werr)?;
            params.SetCharacteristicProperties(props).map_err(werr)?;
            // No pairing or encryption: sensors like these are read in the clear.
            params.SetReadProtectionLevel(GattProtectionLevel::Plain).map_err(werr)?;
            params.SetWriteProtectionLevel(GattProtectionLevel::Plain).map_err(werr)?;
            let r = service
                .CreateCharacteristicAsync(GUID::from_u128(parse_uuid(&cid)?), &params)
                .and_then(|op| op.join())
                .map_err(werr)?;
            let err = r.Error().map_err(werr)?;
            if err != BluetoothError::Success {
                return Err(format!("characteristic {cid}: {}", bt_error(err)));
            }
            let ch = r.Characteristic().map_err(werr)?;
            let value = Arc::new(Mutex::new(decode_hex(&c.value)?));

            if c.properties.contains(&Property::Read) {
                let v = value.clone();
                let name = cid.clone();
                ch.ReadRequested(&TypedEventHandler::new(
                    move |_s: Ref<GattLocalCharacteristic>, args: Ref<GattReadRequestedEventArgs>| {
                        let args = args.ok()?;
                        if let Err(e) = answer_read(args, &v) {
                            log(&format!("read of {name} failed: {}", e.message()));
                        }
                        Ok(())
                    },
                ))
                .map_err(werr)?;
            }
            if c.properties.contains(&Property::Write) {
                let o = out.clone();
                let (svc, chr) = (sid.clone(), cid.clone());
                ch.WriteRequested(&TypedEventHandler::new(
                    move |_s: Ref<GattLocalCharacteristic>, args: Ref<GattWriteRequestedEventArgs>| {
                        let args = args.ok()?;
                        let central = central_id(args.Session());
                        match answer_write(args) {
                            Ok(bytes) => o.send(&Event::Write {
                                service: svc.clone(),
                                characteristic: chr.clone(),
                                value: encode_hex(&bytes),
                                central,
                            }),
                            Err(e) => log(&format!("write to {chr} failed: {}", e.message())),
                        }
                        Ok(())
                    },
                ))
                .map_err(werr)?;
            }
            let pushes =
                c.properties.contains(&Property::Notify) || c.properties.contains(&Property::Indicate);
            if pushes {
                let o = out.clone();
                let (svc, chr) = (sid.clone(), cid.clone());
                ch.SubscribedClientsChanged(&TypedEventHandler::new(
                    move |s: Ref<GattLocalCharacteristic>, _a: Ref<windows::core::IInspectable>| {
                        let ch = s.ok()?;
                        o.send(&Event::Subscribers {
                            service: svc.clone(),
                            characteristic: chr.clone(),
                            centrals: subscribers(ch),
                        });
                        Ok(())
                    },
                ))
                .map_err(werr)?;
            }
            chars.push(Char { service: sid.clone(), uuid: cid, ch, value, pushes });
        }

        let o = out.clone();
        let svc = sid.clone();
        provider
            .AdvertisementStatusChanged(&TypedEventHandler::new(
                move |_p: Ref<GattServiceProvider>,
                      a: Ref<GattServiceProviderAdvertisementStatusChangedEventArgs>| {
                    let a = a.ok()?;
                    let mut status = status_name(a.Status()?);
                    if let Ok(e) = a.Error() {
                        if e != BluetoothError::Success {
                            status = format!("{status} ({})", bt_error(e));
                        }
                    }
                    log(&format!("advertising {svc}: {status}"));
                    o.send(&Event::Advertising { service: svc.clone(), status });
                    Ok(())
                },
            ))
            .map_err(|e| e.message())?;
        let adv = GattServiceProviderAdvertisingParameters::new().map_err(|e| e.message())?;
        adv.SetIsConnectable(true).map_err(|e| e.message())?;
        adv.SetIsDiscoverable(true).map_err(|e| e.message())?;
        provider
            .StartAdvertisingWithParameters(&adv)
            .map_err(|e| format!("service {sid}: start advertising: {}", e.message()))?;
        // Only now: a service that failed halfway is dropped (and so released) above.
        self.chars.append(&mut chars);
        self.providers.push((sid, provider));
        Ok(())
    }
}

impl Backend for WinRtBackend {
    fn name(&self) -> &'static str {
        "winrt"
    }

    fn check(&mut self, out: &Out) -> Result<(), String> {
        let adapter = match BluetoothAdapter::GetDefaultAsync().and_then(|op| op.join()) {
            Ok(a) => a,
            Err(e) => {
                let reason = format!("No Bluetooth adapter was found ({}).", e.message());
                log(&reason);
                out.send(&Event::Unsupported { reason: reason.clone() });
                return Err(reason);
            }
        };
        let le = adapter.IsLowEnergySupported().unwrap_or(false);
        let peripheral = adapter.IsPeripheralRoleSupported().unwrap_or(false);
        let central = adapter.IsCentralRoleSupported().unwrap_or(false);
        let radio_on = adapter
            .GetRadioAsync()
            .and_then(|op| op.join())
            .and_then(|r| r.State())
            .map(|s| s == RadioState::On)
            .ok();
        log(&format!(
            "adapter: lowEnergy={le} peripheralRole={peripheral} centralRole={central} radioOn={radio_on:?}"
        ));
        out.send(&Event::Adapter {
            low_energy_supported: le,
            peripheral_role_supported: peripheral,
            central_role_supported: central,
            radio_on,
        });
        let reason = if !le {
            "This computer's Bluetooth adapter does not support Bluetooth Low Energy."
        } else if !peripheral {
            "This computer's Bluetooth adapter cannot act as a sensor (it does not support the peripheral role)."
        } else {
            return Ok(());
        };
        out.send(&Event::Unsupported { reason: reason.into() });
        Err(reason.into())
    }

    fn start(&mut self, services: Vec<ServiceDef>, out: &Out) -> Result<Vec<String>, String> {
        NOTIFY_FAILURES.store(0, Ordering::Relaxed);
        let mut failures = Vec::new();
        for def in &services {
            if let Err(e) = self.create_service(def, out) {
                out.error(format!("could not publish {e}"));
                failures.push(e);
            }
        }
        if self.providers.is_empty() {
            return Err(failures.join("; "));
        }
        Ok(self.providers.iter().map(|(s, _)| s.clone()).collect())
    }

    fn notify(&mut self, service: &str, characteristic: &str, value: Vec<u8>) -> Result<(), String> {
        let Some(c) = self.chars.iter().find(|c| c.service == service && c.uuid == characteristic) else {
            return Err(format!("unknown characteristic {service}/{characteristic}"));
        };
        if let Ok(mut g) = c.value.lock() {
            *g = value.clone();
        }
        if !c.pushes {
            return Ok(());
        }
        let has_subscribers = c.ch.SubscribedClients().map(|l| l.Size().unwrap_or(0) > 0).unwrap_or(false);
        if !has_subscribers {
            return Ok(());
        }
        let buf = to_buffer(&value).map_err(|e| e.message())?;
        let op =
            c.ch.NotifyValueAsync(&buf).map_err(|e| format!("notify {characteristic}: {}", e.message()))?;
        // Not joined: a slow or vanished central must not stall the command
        // loop. The outcome per client is checked when it completes.
        let name = c.uuid.clone();
        let _ = op.when(move |r| match r {
            Ok(results) => {
                for res in results {
                    if let Ok(st) = res.Status() {
                        if st != GattCommunicationStatus::Success {
                            note_notify_failure(format!("{name}: status {}", st.0));
                        }
                    }
                }
            }
            Err(e) => note_notify_failure(format!("{name}: {}", e.message())),
        });
        Ok(())
    }

    fn stop(&mut self, _out: &Out) {
        for (sid, p) in self.providers.drain(..) {
            if let Err(e) = p.StopAdvertising() {
                log(&format!("stop advertising {sid}: {}", e.message()));
            }
        }
        // Dropping the last references releases the providers, which removes
        // the services from the GATT database.
        self.chars.clear();
    }
}
