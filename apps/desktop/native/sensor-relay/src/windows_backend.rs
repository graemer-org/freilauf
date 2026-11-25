//! Windows backend: WinRT `GattServiceProvider` (Windows 10 1803+ / Windows 11).
//! One provider per service, advertised connectable and discoverable. Windows
//! advertises with the computer's Bluetooth name; an app cannot set its own.
//!
//! Untested on real hardware at the time of writing (cross-compiled from Linux
//! with x86_64-pc-windows-gnu). See docs/adr/0005-sensor-relay.md.

use crate::protocol::{encode_hex, parse_uuid, uuid_string, Event, Property, ServiceDef};
use crate::{Backend, Out};
use std::sync::{Arc, Mutex};
use windows::core::{Ref, GUID, HSTRING};
use windows::Devices::Bluetooth::BluetoothAdapter;
use windows::Devices::Bluetooth::BluetoothError;
use windows::Devices::Bluetooth::GenericAttributeProfile::{
    GattCharacteristicProperties, GattLocalCharacteristic, GattLocalCharacteristicParameters,
    GattProtectionLevel, GattReadRequestedEventArgs, GattServiceProvider,
    GattServiceProviderAdvertisementStatus, GattServiceProviderAdvertisementStatusChangedEventArgs,
    GattServiceProviderAdvertisingParameters, GattSession, GattWriteOption,
    GattWriteRequestedEventArgs,
};
use windows::Foundation::TypedEventHandler;
use windows::Storage::Streams::{DataReader, DataWriter, IBuffer};

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
        unsafe {
            let _ = windows::Win32::System::WinRT::RoInitialize(
                windows::Win32::System::WinRT::RO_INIT_MULTITHREADED,
            );
        }
        WinRtBackend { providers: Vec::new(), chars: Vec::new() }
    }
}

fn to_buffer(bytes: &[u8]) -> windows::core::Result<IBuffer> {
    let w = DataWriter::new()?;
    w.WriteBytes(bytes)?;
    w.DetachBuffer()
}

fn from_buffer(buf: &IBuffer) -> windows::core::Result<Vec<u8>> {
    let r = DataReader::FromBuffer(buf)?;
    let mut v = vec![0u8; r.UnconsumedBufferLength()? as usize];
    r.ReadBytes(&mut v)?;
    Ok(v)
}

/// Short opaque id for a central: a hash of the OS device id, so Bluetooth
/// addresses never reach the app or its log.
fn central_id(session: windows::core::Result<GattSession>) -> String {
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

impl WinRtBackend {
    fn create_service(&mut self, def: &ServiceDef, out: &Out) -> Result<(), String> {
        let sid = uuid_string(parse_uuid(&def.uuid)?);
        let result = GattServiceProvider::CreateAsync(GUID::from_u128(parse_uuid(&sid)?))
            .and_then(|op| op.join())
            .map_err(|e| format!("service {sid}: {e}"))?;
        let err = result.Error().map_err(|e| e.to_string())?;
        if err != BluetoothError::Success {
            return Err(format!("service {sid}: {}", bt_error(err)));
        }
        let provider = result.ServiceProvider().map_err(|e| e.to_string())?;
        let service = provider.Service().map_err(|e| e.to_string())?;

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
            let params = GattLocalCharacteristicParameters::new().map_err(|e| e.to_string())?;
            params.SetCharacteristicProperties(props).map_err(|e| e.to_string())?;
            params.SetReadProtectionLevel(GattProtectionLevel::Plain).map_err(|e| e.to_string())?;
            params.SetWriteProtectionLevel(GattProtectionLevel::Plain).map_err(|e| e.to_string())?;
            let r = service
                .CreateCharacteristicAsync(GUID::from_u128(parse_uuid(&cid)?), &params)
                .and_then(|op| op.join())
                .map_err(|e| format!("characteristic {cid}: {e}"))?;
            let err = r.Error().map_err(|e| e.to_string())?;
            if err != BluetoothError::Success {
                return Err(format!("characteristic {cid}: {}", bt_error(err)));
            }
            let ch = r.Characteristic().map_err(|e| e.to_string())?;
            let initial = crate::protocol::decode_hex(&c.value)?;
            let value = Arc::new(Mutex::new(initial));

            if c.properties.contains(&Property::Read) {
                let v = value.clone();
                ch.ReadRequested(&TypedEventHandler::new(
                    move |_s: Ref<GattLocalCharacteristic>, args: Ref<GattReadRequestedEventArgs>| {
                        let args = args.ok()?;
                        let deferral = args.GetDeferral()?;
                        let req = args.GetRequestAsync()?.join()?;
                        let bytes = v.lock().map(|g| g.clone()).unwrap_or_default();
                        req.RespondWithValue(&to_buffer(&bytes)?)?;
                        deferral.Complete()
                    },
                ))
                .map_err(|e| e.to_string())?;
            }
            if c.properties.contains(&Property::Write) {
                let o = out.clone();
                let (svc, chr) = (sid.clone(), cid.clone());
                ch.WriteRequested(&TypedEventHandler::new(
                    move |_s: Ref<GattLocalCharacteristic>, args: Ref<GattWriteRequestedEventArgs>| {
                        let args = args.ok()?;
                        let deferral = args.GetDeferral()?;
                        let central = central_id(args.Session());
                        let req = args.GetRequestAsync()?.join()?;
                        let bytes = from_buffer(&req.Value()?)?;
                        if req.Option()? == GattWriteOption::WriteWithResponse {
                            req.Respond()?;
                        }
                        deferral.Complete()?;
                        o.send(&Event::Write {
                            service: svc.clone(),
                            characteristic: chr.clone(),
                            value: encode_hex(&bytes),
                            central,
                        });
                        Ok(())
                    },
                ))
                .map_err(|e| e.to_string())?;
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
                .map_err(|e| e.to_string())?;
            }
            self.chars.push(Char { service: sid.clone(), uuid: cid, ch, value, pushes });
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
                    o.send(&Event::Advertising { service: svc.clone(), status });
                    Ok(())
                },
            ))
            .map_err(|e| e.to_string())?;
        let adv = GattServiceProviderAdvertisingParameters::new().map_err(|e| e.to_string())?;
        adv.SetIsConnectable(true).map_err(|e| e.to_string())?;
        adv.SetIsDiscoverable(true).map_err(|e| e.to_string())?;
        provider
            .StartAdvertisingWithParameters(&adv)
            .map_err(|e| format!("service {sid}: start advertising: {e}"))?;
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
                out.send(&Event::Unsupported { reason: reason.clone() });
                return Err(reason);
            }
        };
        let le = adapter.IsLowEnergySupported().unwrap_or(false);
        let peripheral = adapter.IsPeripheralRoleSupported().unwrap_or(false);
        out.send(&Event::Adapter { peripheral_role_supported: peripheral, low_energy_supported: le });
        let reason = if !le {
            "This computer's Bluetooth adapter does not support Bluetooth Low Energy."
        } else if !peripheral {
            "This computer's Bluetooth adapter cannot act as a sensor (no peripheral role)."
        } else {
            return Ok(());
        };
        out.send(&Event::Unsupported { reason: reason.into() });
        Err(reason.into())
    }

    fn start(&mut self, services: Vec<ServiceDef>, out: &Out) -> Result<(), String> {
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
        Ok(())
    }

    fn notify(&mut self, service: &str, characteristic: &str, value: Vec<u8>) -> Result<(), String> {
        let sid = uuid_string(parse_uuid(service)?);
        let cid = uuid_string(parse_uuid(characteristic)?);
        let Some(c) = self.chars.iter().find(|c| c.service == sid && c.uuid == cid) else {
            return Err(format!("unknown characteristic {sid}/{cid}"));
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
        // Fire and forget: the result only says which client got it.
        let buf = to_buffer(&value).map_err(|e| e.to_string())?;
        c.ch.NotifyValueAsync(&buf).map(|_| ()).map_err(|e| format!("notify {cid}: {e}"))
    }

    fn stop(&mut self, _out: &Out) {
        for (_, p) in self.providers.drain(..) {
            let _ = p.StopAdvertising();
        }
        self.chars.clear();
    }
}
