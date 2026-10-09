from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import zlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from typing import Any

try:
    import hid  # type: ignore
except Exception:  # pragma: no cover - dependency/runtime issue
    hid = None

try:
    from pc_corsair_ram_smbus import CorsairRamSmbusController
except Exception:  # pragma: no cover - dependency/runtime issue
    CorsairRamSmbusController = None  # type: ignore[assignment]


STEELSERIES_VID = 0x1038
NZXT_VID = 0x1E71
ASUS_VID = 0x0B05
CORSAIR_VID = 0x1B1C

STEELSERIES_AEROX_WIRELESS_PIDS = {
    0x1838,  # Aerox 3 Wireless (2.4 GHz)
    0x183A,  # Aerox 3 Wireless (wired mode)
    0x1852,
    0x1854,
    0x1858,
    0x185A,
}

STEELSERIES_APEX_PIDS = {
    0x1610,  # Apex Pro
    0x1612,  # Apex 7
    0x1614,  # Apex Pro TKL
    0x1618,  # Apex 7 TKL
    0x161C,  # Apex 5
    0x1628,  # Apex Pro TKL 2023
    0x1640,  # Apex Pro 3
}

NZXT_RGB_CHANNELS: dict[int, int] = {
    0x2005: 2,
    0x2006: 2,
    0x2009: 2,
    0x200B: 2,
    0x200D: 2,
    0x200E: 2,
    0x200F: 2,
    0x2010: 2,
    0x2011: 6,
    0x2012: 3,
    0x2014: 3,
    0x2019: 6,
    0x201F: 6,
    0x2020: 6,
    0x2021: 3,
}

NZXT_LED_COUNTS: dict[int, int] = {
    0x01: 10,  # Hue 1 strip
    0x02: 8,  # Aer 1 fan
    0x04: 10,  # Hue 2 strip 10
    0x05: 8,  # Hue 2 strip 8
    0x06: 6,  # Hue 2 strip 6
    0x08: 14,  # Cable comb
    0x09: 15,  # Underglow 300
    0x0A: 10,  # Underglow 200
    0x0B: 8,  # Aer 2 120
    0x0C: 8,  # Aer 2 140
    0x10: 8,  # Kraken X3 ring
    0x11: 1,  # Kraken X3 logo
    0x13: 18,  # F120 RGB
    0x14: 18,  # F140 RGB
    0x15: 20,  # F120 RGB Duo
    0x17: 8,  # F120 RGB Core
    0x18: 8,  # F140 RGB Core
    0x19: 8,  # F120 Core case
    0x1D: 24,  # F360 Core case
    0x1E: 24,  # Kraken Elite ring
}

ASUS_MAINBOARD_PIDS = {0x18F3, 0x1939, 0x19AF, 0x1AA6}
LOW_LEVEL_DRIVER_SERVICES = [
    "WinRing0_1_2_0",
    "WinRing0_1_2_0_NT",
    "pawnio",
    "inpoutx64",
    "AsrDrv103",
    "AsrDrv104",
    "RTCore64",
]
LOW_LEVEL_DRIVER_FILES = [
    r"C:\Windows\System32\drivers\WinRing0x64.sys",
    r"C:\Windows\System32\drivers\pawnio.sys",
    r"C:\Windows\System32\drivers\inpoutx64.sys",
    r"C:\Windows\System32\drivers\RTCore64.sys",
]

STEELSERIES_APEX_KEYS = [
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0A,
    0x0B,
    0x0C,
    0x0D,
    0x0E,
    0x0F,
    0x10,
    0x11,
    0x12,
    0x13,
    0x14,
    0x15,
    0x16,
    0x17,
    0x18,
    0x19,
    0x1A,
    0x1B,
    0x1C,
    0x1D,
    0x1E,
    0x1F,
    0x20,
    0x21,
    0x22,
    0x23,
    0x24,
    0x25,
    0x26,
    0x27,
    0x28,
    0x29,
    0x2A,
    0x2B,
    0x2C,
    0x2D,
    0x2E,
    0x2F,
    0x30,
    0x32,
    0x33,
    0x34,
    0x35,
    0x36,
    0x37,
    0x38,
    0x39,
    0x3A,
    0x3B,
    0x3C,
    0x3D,
    0x3E,
    0x3F,
    0x40,
    0x41,
    0x42,
    0x43,
    0x44,
    0x45,
    0x46,
    0x47,
    0x48,
    0x49,
    0x4A,
    0x4B,
    0x4C,
    0x4D,
    0x4E,
    0x4F,
    0x50,
    0x51,
    0x52,
    0x64,
    0xE0,
    0xE1,
    0xE2,
    0xE3,
    0xE4,
    0xE5,
    0xE6,
    0xE7,
    0xF0,
    0x31,
    0x87,
    0x88,
    0x89,
    0x8A,
    0x8B,
    0x53,
    0x54,
    0x55,
    0x56,
    0x57,
    0x58,
    0x59,
    0x5A,
    0x5B,
    0x5C,
    0x5D,
    0x5E,
    0x5F,
    0x60,
    0x61,
    0x62,
    0x63,
]


@dataclass
class NativeDevice:
    id: int
    name: str
    type: str
    driver: str
    path: bytes
    vid: int
    pid: int
    interface_number: int | None
    usage_page: int | None
    led_count: int = 0
    extra: dict[str, Any] = field(default_factory=dict)


def _bytes_path(path: Any) -> bytes:
    if isinstance(path, bytes):
        return path
    if isinstance(path, str):
        return path.encode("utf-8", errors="ignore")
    return bytes(path or b"")


def _device_id(path: Any) -> int:
    return zlib.crc32(_bytes_path(path)) & 0x7FFFFFFF


def _name_or_default(row: dict[str, Any], fallback: str) -> str:
    value = str(row.get("product_string") or "").strip()
    return value if value else fallback


def _clamp_rgb_tuple(rgb: tuple[int, int, int] | list[int]) -> tuple[int, int, int]:
    return (
        max(0, min(255, int(rgb[0]))),
        max(0, min(255, int(rgb[1]))),
        max(0, min(255, int(rgb[2]))),
    )


def _normalize_pixels(
    colors: list[tuple[int, int, int]] | None, led_count: int, fallback: tuple[int, int, int]
) -> list[tuple[int, int, int]]:
    count = max(1, int(led_count))
    base = _clamp_rgb_tuple(fallback)
    if not colors:
        return [base for _ in range(count)]

    out: list[tuple[int, int, int]] = []
    for idx in range(count):
        src = colors[idx] if idx < len(colors) else colors[-1]
        out.append(_clamp_rgb_tuple(src))
    return out


def _avg_pixels(colors: list[tuple[int, int, int]], fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    if not colors:
        return _clamp_rgb_tuple(fallback)
    return (
        int(sum(c[0] for c in colors) / len(colors)),
        int(sum(c[1] for c in colors) / len(colors)),
        int(sum(c[2] for c in colors) / len(colors)),
    )


def _run_powershell_json(script: str, timeout_s: float = 8.0) -> list[dict[str, Any]]:
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return []

    raw = (completed.stdout or "").strip()
    if not raw:
        return []

    try:
        parsed = json.loads(raw)
    except Exception:
        return []

    if isinstance(parsed, list):
        return [x for x in parsed if isinstance(x, dict)]
    if isinstance(parsed, dict):
        return [parsed]
    return []


def _service_state(name: str, timeout_s: float = 3.0) -> str:
    try:
        completed = subprocess.run(
            ["sc.exe", "query", name],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return "unavailable"

    text = f"{completed.stdout}\n{completed.stderr}".upper()
    if "RUNNING" in text:
        return "running"
    if "STOPPED" in text:
        return "stopped"
    if "FAILED 1060" in text:
        return "missing"
    return "unknown"


def _service_binary_path(name: str, timeout_s: float = 3.0) -> str:
    try:
        completed = subprocess.run(
            ["sc.exe", "qc", name],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return ""

    text = f"{completed.stdout}\n{completed.stderr}"
    match = re.search(r"BINARY_PATH_NAME\s+:\s+(.+)", text)
    if not match:
        return ""

    raw_path = match.group(1).strip().strip('"')
    normalized = raw_path.replace("\\??\\", "", 1)
    if normalized.upper().startswith("\\SYSTEMROOT\\"):
        normalized = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), normalized[12:].lstrip("\\/"))
    elif normalized.upper().startswith("SYSTEM32\\"):
        normalized = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), normalized)
    return os.path.normpath(normalized)


class NativePcRgbManager:
    def __init__(self) -> None:
        self._last_error = ""
        self._last_scan_ts = 0.0
        self._scan_interval = max(0.5, float(os.getenv("PC_RGB_NATIVE_SCAN_SECONDS", "5.0")))
        self._devices: list[NativeDevice] = []
        self._last_color: dict[int, tuple[int, int, int]] = {}
        self._nzxt_led_cache: dict[int, tuple[float, list[int]]] = {}
        self._asus_channel_cache: dict[int, tuple[float, list[dict[str, int]]]] = {}
        self._asus_addressable_default_leds = max(
            1,
            min(40, int(os.getenv("PC_RGB_ASUS_ADDRESSABLE_LEDS", "24"))),
        )
        self._asus_static_fallback = os.getenv("PC_RGB_ASUS_STATIC_FALLBACK", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self._asus_force_static_all_channels = os.getenv(
            "PC_RGB_ASUS_FORCE_STATIC_ALL_CHANNELS", "true"
        ).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self._asus_reassert_direct_after_static = os.getenv(
            "PC_RGB_ASUS_REASSERT_DIRECT_AFTER_STATIC", "true"
        ).strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self._asus_write_passes = max(1, min(4, int(os.getenv("PC_RGB_ASUS_WRITE_PASSES", "3"))))
        self._asus_addressable_per_header = self._parse_led_list(
            os.getenv("PC_RGB_ASUS_ADDRESSABLE_LEDS_PER_HEADER", "")
        )
        self._nzxt_force_unknown_channels = os.getenv("PC_RGB_NZXT_FORCE_UNKNOWN_CHANNELS", "true").strip().lower() in {
            "1",
            "true",
            "yes",
            "on",
        }
        self._nzxt_unknown_led_count = max(1, min(40, int(os.getenv("PC_RGB_NZXT_UNKNOWN_LED_COUNT", "18"))))
        self._aerox_initialized: set[int] = set()
        self._ram_probe_cache: tuple[float, dict[str, Any]] | None = None
        self._ram_probe_seconds = max(5.0, float(os.getenv("PC_RGB_RAM_PROBE_SECONDS", "30")))
        self._corsair_smbus = CorsairRamSmbusController() if CorsairRamSmbusController is not None else None
        self._write_lock = threading.Lock()
        # Animation writes use per-device locks so a slow wireless HID device
        # cannot stall the keyboard/NZXT render lane. Static scene writes still
        # use _write_lock to preserve the existing transactional behavior.
        self._realtime_lock_guard = threading.Lock()
        self._realtime_device_locks: dict[int, threading.Lock] = {}
        self._sensitive_write_lock = threading.Lock()
        self._sensitive_drivers = {"asus_aura_mainboard", "corsair_ram_smbus_custom"}
        self._sensitive_min_interval = max(0.0, float(os.getenv("PC_RGB_SENSITIVE_MIN_INTERVAL_MS", "180"))) / 1000.0
        self._sensitive_retry_delay = max(0.0, float(os.getenv("PC_RGB_SENSITIVE_RETRY_DELAY_MS", "28"))) / 1000.0
        self._last_sensitive_write_ts = 0.0

    @staticmethod
    def _parse_led_list(raw: str) -> list[int]:
        out: list[int] = []
        for token in str(raw or "").split(","):
            value = token.strip()
            if not value:
                continue
            try:
                count = int(value)
            except Exception:
                continue
            out.append(max(1, min(40, count)))
        return out

    @property
    def backend_name(self) -> str:
        return "native"

    def prime(self) -> None:
        rows = self._scan(force=True)

        for dev in rows:
            # Aerox needs no RGB initialization packet.  On current firmware
            # 0x2D is a sensitivity/DPI command, so do not touch it here.
            if dev.driver == "nzxt_hue2" and dev.id not in self._nzxt_led_cache:
                try:
                    handle = self._open_hid(dev.path)
                    try:
                        self._nzxt_channel_leds(dev, handle)
                    finally:
                        handle.close()
                except Exception:
                    continue

    def diagnostics(self) -> dict[str, Any]:
        probe = self._corsair_ram_probe(force=False)
        return {"backend": self.backend_name, "corsair_ram": probe}

    def _probe_baseboard(self) -> dict[str, Any]:
        rows = _run_powershell_json(
            "Get-CimInstance Win32_BaseBoard | "
            "Select-Object Manufacturer,Product,SerialNumber | "
            "ConvertTo-Json -Compress"
        )
        if not rows:
            return {}
        row = rows[0]
        return {
            "manufacturer": str(row.get("Manufacturer") or "").strip(),
            "product": str(row.get("Product") or "").strip(),
            "serial": str(row.get("SerialNumber") or "").strip(),
        }

    def _probe_memory_modules(self) -> list[dict[str, Any]]:
        rows = _run_powershell_json(
            "Get-CimInstance Win32_PhysicalMemory | "
            "Select-Object BankLabel,Manufacturer,PartNumber,SerialNumber,Capacity,ConfiguredClockSpeed | "
            "ConvertTo-Json -Compress"
        )
        out: list[dict[str, Any]] = []
        for row in rows:
            manufacturer = str(row.get("Manufacturer") or "").strip()
            part_number = str(row.get("PartNumber") or "").strip()
            out.append(
                {
                    "bank": str(row.get("BankLabel") or "").strip(),
                    "manufacturer": manufacturer,
                    "part_number": part_number,
                    "serial": str(row.get("SerialNumber") or "").strip(),
                    "capacity_bytes": int(row.get("Capacity") or 0),
                    "configured_clock_mhz": int(row.get("ConfiguredClockSpeed") or 0),
                    "is_corsair": ("corsair" in manufacturer.lower()) or ("cmh" in part_number.lower()),
                }
            )
        return out

    def _probe_low_level_transport(self) -> dict[str, Any]:
        services = []
        driver_files = {path for path in LOW_LEVEL_DRIVER_FILES if os.path.exists(path)}
        for service_name in LOW_LEVEL_DRIVER_SERVICES:
            state = _service_state(service_name)
            binary_path = _service_binary_path(service_name)
            if binary_path and os.path.exists(binary_path):
                driver_files.add(binary_path)
            entry = {"name": service_name, "state": state}
            if binary_path:
                entry["binary_path"] = binary_path
            services.append(entry)

        has_transport = bool(driver_files) or any(item["state"] in {"running", "stopped"} for item in services)

        return {"present": has_transport, "driver_files": sorted(driver_files), "services": services}

    def _corsair_ram_probe(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        cached = self._ram_probe_cache
        if not force and cached and (now - cached[0]) < self._ram_probe_seconds:
            return dict(cached[1])

        modules = self._probe_memory_modules()
        corsair_modules = [dict(m) for m in modules if bool(m.get("is_corsair"))]
        baseboard = self._probe_baseboard()
        low_level_transport = self._probe_low_level_transport()

        corsair_hid: list[dict[str, Any]] = []
        if hid is not None:
            for row in hid.enumerate():
                vid = int(row.get("vendor_id") or 0)
                if vid != CORSAIR_VID:
                    continue
                corsair_hid.append(
                    {
                        "pid": int(row.get("product_id") or 0),
                        "product": str(row.get("product_string") or "").strip(),
                        "interface": row.get("interface_number"),
                        "usage_page": row.get("usage_page"),
                    }
                )

        smbus_probe: dict[str, Any] = {}
        if self._corsair_smbus is not None and corsair_modules:
            try:
                smbus_probe = self._corsair_smbus.probe(corsair_modules, force=force)
            except Exception as exc:
                smbus_probe = {
                    "ready": False,
                    "reason": f"SMBus probe failed: {exc}",
                    "endpoint_count": 0,
                    "endpoints": [],
                    "controllers": [],
                }

        controllable = False
        reason = "No Corsair RAM modules found in SMBIOS."
        if corsair_modules:
            if self._corsair_smbus is None:
                reason = "SMBus engine not available in this DifSync build."
            elif bool(smbus_probe.get("ready")) and int(smbus_probe.get("endpoint_count", 0)) > 0:
                controllable = True
                active_transport = str(smbus_probe.get("transport") or "").strip()
                if active_transport:
                    reason = f"Pure-custom SMBus path active ({active_transport})."
                else:
                    reason = "Pure-custom SMBus path active."
            else:
                smbus_reason = str(smbus_probe.get("reason") or "").strip()
                if smbus_reason:
                    reason = smbus_reason
                elif not low_level_transport.get("present"):
                    reason = "Low-level SMBus transport not detected."
                else:
                    reason = "Corsair SMBus endpoints not detected."

        protocol_stage = "phase2_smbus_experimental" if self._corsair_smbus is not None else "phase1_probe_only"

        probe = {
            "detected": bool(corsair_modules),
            "module_count": len(corsair_modules),
            "modules": corsair_modules,
            "corsair_hid_count": len(corsair_hid),
            "corsair_hid": corsair_hid,
            "low_level_transport": low_level_transport,
            "smbus": smbus_probe,
            "baseboard": baseboard,
            "protocol_stage": protocol_stage,
            "controllable": controllable,
            "reason": reason,
        }
        self._ram_probe_cache = (now, dict(probe))
        return probe

    def _build_corsair_ram_virtual_device(self) -> NativeDevice | None:
        probe = self._corsair_ram_probe(force=False)
        modules = probe.get("modules") or []
        if not modules:
            return None

        dimm_count = len(modules)
        part_tokens = [str(m.get("part_number") or "").strip() for m in modules]
        token = ",".join(x for x in part_tokens if x) or f"dimm-{dimm_count}"
        synthetic_path = _bytes_path(f"difsync:corsair-ram:{token}")
        note = str(probe.get("reason") or "").strip()

        return NativeDevice(
            id=_device_id(synthetic_path),
            name=f"Corsair RGB RAM ({dimm_count} DIMM{'s' if dimm_count != 1 else ''})",
            type="MEMORY",
            driver="corsair_ram_smbus_custom",
            path=synthetic_path,
            vid=CORSAIR_VID,
            pid=0,
            interface_number=None,
            usage_page=None,
            led_count=dimm_count * 10,
            extra={"probe": probe, "write_supported": bool(probe.get("controllable")), "note": note},
        )

    def status(self) -> dict[str, Any]:
        if hid is None:
            return {"connected": False, "error": "hidapi not installed", "device_count": 0}
        try:
            rows = self._scan(force=False)
            return {"connected": True, "error": "", "device_count": len(rows), "backend": self.backend_name}
        except Exception as exc:
            self._last_error = str(exc)
            return {"connected": False, "error": self._last_error, "device_count": 0, "backend": self.backend_name}

    def list_devices(self) -> list[dict[str, Any]]:
        rows = self._scan(force=False)
        out = []
        for dev in rows:
            per_led_supported = dev.driver in {
                "steelseries_aerox_wireless",
                "steelseries_apex",
                "nzxt_hue2",
                "asus_aura_mainboard",
                "corsair_ram_smbus_custom",
            }
            out.append(
                {
                    "id": dev.id,
                    "name": dev.name,
                    "type": dev.type,
                    "led_count": dev.led_count,
                    "active_mode": "direct",
                    "avg_rgb": self._last_color.get(dev.id, (0, 0, 0)),
                    "driver": dev.driver,
                    "backend": self.backend_name,
                    "write_supported": bool(dev.extra.get("write_supported", True)),
                    "per_led_supported": per_led_supported,
                    "note": str(dev.extra.get("note", "")).strip(),
                }
            )
        return out

    def _build_device_layout(self, dev: NativeDevice) -> dict[str, Any]:
        segments: list[dict[str, Any]] = []
        cursor = 0

        if dev.driver == "steelseries_aerox_wireless":
            names = ["Scroll", "Logo", "Underglow"]
            for idx, label in enumerate(names):
                segments.append({"id": idx, "label": label, "start": cursor, "count": 1})
                cursor += 1
        elif dev.driver == "steelseries_apex":
            count = len(STEELSERIES_APEX_KEYS)
            segments.append({"id": 0, "label": "Keyboard Matrix", "start": 0, "count": count})
            cursor = count
        elif dev.driver == "nzxt_hue2":
            channel_counts: list[int] = []
            try:
                handle = self._open_hid(dev.path)
                try:
                    channel_counts = self._nzxt_channel_leds(dev, handle)
                finally:
                    handle.close()
            except Exception:
                channel_counts = []
            if not channel_counts:
                channels = max(1, int(dev.extra.get("rgb_channels", 1)))
                channel_counts = [int(dev.led_count / channels)] * channels
            for idx, count in enumerate(channel_counts):
                leds = max(0, int(count))
                if leds <= 0:
                    continue
                segments.append({"id": idx, "label": f"Channel {idx + 1}", "start": cursor, "count": leds})
                cursor += leds
        elif dev.driver == "asus_aura_mainboard":
            channels: list[dict[str, int]] = []
            try:
                handle = self._open_hid(dev.path)
                try:
                    channels = self._asus_channels(dev, handle)
                finally:
                    handle.close()
            except Exception:
                channels = []

            for idx, channel in enumerate(channels):
                leds = max(0, int(channel.get("led_count") or 0))
                if leds <= 0:
                    continue
                direct_channel = int(channel.get("direct_channel") or 0)
                if direct_channel == 0x04:
                    label = "Mainboard RGB"
                else:
                    label = f"ARGB Header {direct_channel + 1}"
                segments.append(
                    {
                        "id": idx,
                        "label": label,
                        "start": cursor,
                        "count": leds,
                        "direct_channel": direct_channel,
                        "effect_channel": int(channel.get("effect_channel") or 0),
                    }
                )
                cursor += leds
        elif dev.driver == "corsair_ram_smbus_custom":
            probe = self._corsair_ram_probe(force=False)
            rows = probe.get("smbus", {}).get("endpoints", []) if isinstance(probe.get("smbus"), dict) else []
            if isinstance(rows, list):
                for idx, row in enumerate(rows):
                    leds = max(0, int(row.get("led_count") or 0)) if isinstance(row, dict) else 0
                    if leds <= 0:
                        continue
                    label = str(row.get("label") or f"DIMM {idx + 1}") if isinstance(row, dict) else f"DIMM {idx + 1}"
                    segments.append({"id": idx, "label": label, "start": cursor, "count": leds})
                    cursor += leds

        if not segments:
            fallback_count = max(1, int(dev.led_count or 1))
            segments = [{"id": 0, "label": "Full Device", "start": 0, "count": fallback_count}]
            cursor = fallback_count

        led_count = max(1, cursor)
        last = self._last_color.get(dev.id, (255, 255, 255))
        return {
            "device_id": dev.id,
            "name": dev.name,
            "driver": dev.driver,
            "type": dev.type,
            "led_count": led_count,
            "segments": segments,
            "pixels": [list(last) for _ in range(led_count)],
            "backend": self.backend_name,
        }

    def get_device_layout(self, device_id: int) -> dict[str, Any]:
        rows = self._scan(force=False)
        dev = next((x for x in rows if int(x.id) == int(device_id)), None)
        if dev is None:
            raise RuntimeError(f"Device {device_id} not found")
        return self._build_device_layout(dev)

    def _device_is_sensitive(self, dev: NativeDevice) -> bool:
        return str(dev.driver or "") in self._sensitive_drivers

    def _wait_sensitive_write_window(self, selected: list[NativeDevice]) -> None:
        if self._sensitive_min_interval <= 0:
            return
        if not any(self._device_is_sensitive(dev) for dev in selected):
            return
        elapsed = time.time() - self._last_sensitive_write_ts
        if elapsed < self._sensitive_min_interval:
            time.sleep(self._sensitive_min_interval - elapsed)

    def _mark_sensitive_write(self, selected: list[NativeDevice]) -> None:
        if any(self._device_is_sensitive(dev) for dev in selected):
            self._last_sensitive_write_ts = time.time()

    def _apply_with_retry(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        attempts = 2 if self._device_is_sensitive(dev) else 1
        last_exc: Exception | None = None
        for idx in range(attempts):
            try:
                self._apply_device_color(dev, rgb)
                return
            except Exception as exc:
                last_exc = exc
                if idx + 1 >= attempts:
                    raise
                if self._sensitive_retry_delay > 0:
                    time.sleep(self._sensitive_retry_delay)
        if last_exc is not None:
            raise last_exc

    def set_color(self, rgb: tuple[int, int, int], device_ids: list[int] | None = None) -> dict[str, Any]:
        with self._write_lock:
            scan_each_write = os.getenv("PC_RGB_SCAN_EACH_WRITE", "false").strip().lower() in {"1", "true", "yes", "on"}
            rows = self._scan(force=scan_each_write)
            target: set[int] | None = None
            if device_ids is not None:
                target = {int(x) for x in device_ids}
            selected = [dev for dev in rows if target is None or dev.id in target]

            changed = 0
            skipped: list[dict[str, Any]] = []
            if not selected:
                return {"changed": 0, "skipped": [], "backend": self.backend_name}

            self._wait_sensitive_write_window(selected)
            contains_sensitive = any(self._device_is_sensitive(dev) for dev in selected)
            worker_count = max(1, int(os.getenv("PC_RGB_NATIVE_WORKERS", "6")))
            if contains_sensitive:
                worker_count = 1

            if len(selected) == 1 or worker_count == 1:
                for dev in selected:
                    try:
                        self._apply_with_retry(dev, rgb)
                        self._last_color[dev.id] = rgb
                        changed += 1
                    except Exception as exc:
                        skipped.append({"id": dev.id, "name": dev.name, "error": str(exc)})
                self._mark_sensitive_write(selected)
                return {"changed": changed, "skipped": skipped, "backend": self.backend_name}

            max_workers = min(worker_count, len(selected))
            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {executor.submit(self._apply_with_retry, dev, rgb): dev for dev in selected}
                for future in as_completed(futures):
                    dev = futures[future]
                    try:
                        future.result()
                        self._last_color[dev.id] = rgb
                        changed += 1
                    except Exception as exc:
                        skipped.append({"id": dev.id, "name": dev.name, "error": str(exc)})

            self._mark_sensitive_write(selected)
            return {"changed": changed, "skipped": skipped, "backend": self.backend_name}

    def set_device_pixels(
        self, device_id: int, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int] = (255, 255, 255)
    ) -> dict[str, Any]:
        with self._write_lock:
            rows = self._scan(force=False)
            dev = next((x for x in rows if int(x.id) == int(device_id)), None)
            if dev is None:
                raise RuntimeError(f"Device {device_id} not found")

            layout = self._build_device_layout(dev)
            led_count = max(1, int(layout.get("led_count") or 1))
            normalized = _normalize_pixels(pixels, led_count, fallback)

            if self._device_is_sensitive(dev):
                self._wait_sensitive_write_window([dev])
            self._apply_device_pixels(dev, normalized, fallback)
            self._last_color[dev.id] = _avg_pixels(normalized, fallback)
            self._mark_sensitive_write([dev])
            return {"changed": 1, "skipped": [], "device_id": dev.id, "led_count": led_count, "backend": self.backend_name}

    def set_device_pixels_realtime(
        self,
        device_id: int,
        pixels: list[tuple[int, int, int]],
        fallback: tuple[int, int, int] = (255, 255, 255),
        led_count_hint: int | None = None,
    ) -> dict[str, Any]:
        """Low-jitter animation write.

        Uses the warm device cache plus a per-device lock. This prevents slow
        wireless devices from blocking unrelated USB controllers while still
        preventing overlapping writes to the same hardware.
        """
        device_id = int(device_id)
        rows = list(self._devices) if self._devices else self._scan(force=False)
        dev = next((x for x in rows if int(x.id) == device_id), None)
        if dev is None:
            rows = self._scan(force=True)
            dev = next((x for x in rows if int(x.id) == device_id), None)
        if dev is None:
            raise RuntimeError(f"Device {device_id} not found")

        with self._realtime_lock_guard:
            dev_lock = self._realtime_device_locks.get(device_id)
            if dev_lock is None:
                dev_lock = threading.Lock()
                self._realtime_device_locks[device_id] = dev_lock

        with dev_lock:
            # The animation engine already resolved the topology. Do not query
            # NZXT/AURA layout on every frame; some controllers take seconds
            # to answer topology requests. Each driver below still normalizes
            # its own packet shape, so the hint is safe and avoids discovery.
            led_count = max(1, int(led_count_hint or len(pixels) or dev.led_count or 1))
            normalized = _normalize_pixels(pixels, led_count, fallback)

            if self._device_is_sensitive(dev):
                with self._sensitive_write_lock:
                    self._wait_sensitive_write_window([dev])
                    self._apply_device_pixels(dev, normalized, fallback)
                    self._mark_sensitive_write([dev])
            else:
                self._apply_device_pixels(dev, normalized, fallback)

            self._last_color[dev.id] = _avg_pixels(normalized, fallback)
            return {
                "changed": 1,
                "skipped": [],
                "device_id": dev.id,
                "led_count": led_count,
                "backend": self.backend_name,
                "realtime": True,
            }

    def _scan(self, force: bool) -> list[NativeDevice]:
        if hid is None:
            raise RuntimeError("hidapi not installed")

        now = time.time()
        if not force and self._devices and (now - self._last_scan_ts) < self._scan_interval:
            return list(self._devices)

        entries = hid.enumerate()
        found: list[NativeDevice] = []

        for row in entries:
            vid = int(row.get("vendor_id") or 0)
            pid = int(row.get("product_id") or 0)
            iface = row.get("interface_number")
            usage_page = row.get("usage_page")
            path = _bytes_path(row.get("path"))

            if vid == STEELSERIES_VID and pid in STEELSERIES_AEROX_WIRELESS_PIDS:
                if iface == 3 and int(usage_page or 0) == 0xFFC0:
                    found.append(
                        NativeDevice(
                            id=_device_id(path),
                            name=_name_or_default(row, f"SteelSeries {pid:04X}"),
                            type="MOUSE",
                            driver="steelseries_aerox_wireless",
                            path=path,
                            vid=vid,
                            pid=pid,
                            interface_number=iface,
                            usage_page=usage_page,
                            led_count=3,
                        )
                    )
                continue

            if vid == STEELSERIES_VID and pid in STEELSERIES_APEX_PIDS:
                if iface == 1 and int(usage_page or 0) == 0xFFC0:
                    found.append(
                        NativeDevice(
                            id=_device_id(path),
                            name=_name_or_default(row, f"SteelSeries Apex {pid:04X}"),
                            type="KEYBOARD",
                            driver="steelseries_apex",
                            path=path,
                            vid=vid,
                            pid=pid,
                            interface_number=iface,
                            usage_page=usage_page,
                            led_count=len(STEELSERIES_APEX_KEYS),
                        )
                    )
                continue

            if vid == NZXT_VID and pid in NZXT_RGB_CHANNELS:
                if iface in (0, None):
                    rgb_channels = NZXT_RGB_CHANNELS[pid]
                    found.append(
                        NativeDevice(
                            id=_device_id(path),
                            name=_name_or_default(row, f"NZXT Device {pid:04X}"),
                            type="LEDSTRIP",
                            driver="nzxt_hue2",
                            path=path,
                            vid=vid,
                            pid=pid,
                            interface_number=iface,
                            usage_page=usage_page,
                            led_count=rgb_channels * 40,
                            extra={"rgb_channels": rgb_channels},
                        )
                    )
                continue

            if vid == ASUS_VID and pid in ASUS_MAINBOARD_PIDS:
                found.append(
                    NativeDevice(
                        id=_device_id(path),
                        name=_name_or_default(row, "ASUS Aura USB Mainboard"),
                        type="MOTHERBOARD",
                        driver="asus_aura_mainboard",
                        path=path,
                        vid=vid,
                        pid=pid,
                        interface_number=iface,
                        usage_page=usage_page,
                        led_count=0,
                    )
                )

        corsair_ram_device = self._build_corsair_ram_virtual_device()
        if corsair_ram_device is not None:
            found.append(corsair_ram_device)

        # The Aerox 3 Wireless exposes both a 2.4 GHz receiver (0x1838)
        # and a wired HID interface (0x183A) when the USB cable is connected.
        # They are two transports for one physical mouse, not two lights.
        # Keep the wireless controller first to retain existing saved layout IDs.
        aerox_pids = {
            dev.pid for dev in found if dev.driver == "steelseries_aerox_wireless"
        }
        if 0x1838 in aerox_pids and 0x183A in aerox_pids:
            found = [
                dev for dev in found
                if dev.driver != "steelseries_aerox_wireless" or dev.pid != 0x183A
            ]

        unique: dict[int, NativeDevice] = {}
        for dev in found:
            if dev.id not in unique:
                unique[dev.id] = dev
        self._devices = sorted(unique.values(), key=lambda d: d.name.lower())
        self._last_scan_ts = now
        return list(self._devices)

    def _open_hid(self, path: bytes):
        if hid is None:
            raise RuntimeError("hidapi not installed")
        handle = hid.device()
        handle.open_path(path)
        handle.set_nonblocking(0)
        return handle

    def _apply_device_color(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_device_pixels(dev, [], rgb)

    def _apply_device_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        if dev.driver == "steelseries_aerox_wireless":
            self._apply_steelseries_aerox_pixels(dev, pixels, fallback)
            return
        if dev.driver == "steelseries_apex":
            self._apply_steelseries_apex_pixels(dev, pixels, fallback)
            return
        if dev.driver == "nzxt_hue2":
            self._apply_nzxt_hue2_pixels(dev, pixels, fallback)
            return
        if dev.driver == "asus_aura_mainboard":
            self._apply_asus_mainboard_pixels(dev, pixels, fallback)
            return
        if dev.driver == "corsair_ram_smbus_custom":
            self._apply_corsair_ram_custom_pixels(dev, pixels, fallback)
            return
        raise RuntimeError(f"Unsupported native driver: {dev.driver}")

    def _apply_corsair_ram_custom(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_corsair_ram_custom_pixels(dev, [], rgb)

    def _apply_corsair_ram_custom_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        _ = dev
        probe = self._corsair_ram_probe(force=False)
        if not probe.get("detected"):
            raise RuntimeError("Corsair RAM not detected by pure-custom probe.")
        if self._corsair_smbus is None:
            raise RuntimeError("Corsair SMBus engine is unavailable.")
        if not probe.get("controllable"):
            raise RuntimeError(str(probe.get("reason") or "Corsair RAM pure-custom protocol unavailable."))

        result = self._corsair_smbus.apply_pixels(probe.get("modules") or [], pixels, fallback)
        if int(result.get("changed", 0)) <= 0:
            raise RuntimeError(str(result.get("error") or "Corsair RAM write failed"))

    def _apply_steelseries_aerox(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_steelseries_aerox_pixels(dev, [], rgb)

    def _apply_steelseries_aerox_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        target_path = dev.path
        target_pid = dev.pid
        if dev.pid == 0x1838 and hid is not None:
            # Prefer wired HID when the same Aerox is plugged in. Its receiver
            # remains enumerated even while it cannot alter the wired mouse LEDs.
            wired = next((row for row in hid.enumerate()
                          if int(row.get("vendor_id") or 0) == STEELSERIES_VID
                          and int(row.get("product_id") or 0) == 0x183A
                          and row.get("interface_number") == 3
                          and int(row.get("usage_page") or 0) == 0xFFC0), None)
            if wired:
                target_path = _bytes_path(wired.get("path"))
                target_pid = 0x183A
        handle = self._open_hid(target_path)
        try:
            cmd_flag = 0x40 if target_pid == 0x1838 else 0x00
            colors = _normalize_pixels(pixels, 3, fallback)

            for zone in (0, 1, 2):
                # Match current rivalcfg exactly. Aerox expects a short output
                # report, not a 64-byte padded packet:
                #   00 61 01 <zone> <R> <G> <B>   (2.4 GHz)
                #   00 21 01 <zone> <R> <G> <B>   (wired)
                packet = [
                    0x00,
                    0x21 | cmd_flag,
                    0x01,
                    zone,
                    colors[zone][0],
                    colors[zone][1],
                    colors[zone][2],
                ]
                written = handle.write(packet)
                if written <= 0:
                    raise RuntimeError(f"Aerox zone {zone} HID write failed")

                if cmd_flag:
                    reply = handle.read(64, 250)
                    if not reply or int(reply[0]) != int(packet[1]):
                        time.sleep(0.05)
                        written = handle.write(packet)
                        if written <= 0:
                            raise RuntimeError(f"Aerox zone {zone} HID retry failed")
                        reply = handle.read(64, 300)
                        if not reply or int(reply[0]) != int(packet[1]):
                            raise RuntimeError(f"Aerox zone {zone} did not acknowledge RGB command")

                # rivalcfg intentionally spaces commands to avoid overrunning
                # SteelSeries wireless firmware.
                time.sleep(0.05)

            # Do not send command 0x23/0x63. On current Aerox 3 Wireless
            # firmware it configures the dim timer; it is not RGB brightness.
        finally:
            handle.close()

    def _apply_steelseries_apex(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_steelseries_apex_pixels(dev, [], rgb)

    def _apply_steelseries_apex_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        handle = self._open_hid(dev.path)
        try:
            packet = [0x00] * 643
            packet[0] = 0x00
            packet[1] = 0x3A
            packet[2] = len(STEELSERIES_APEX_KEYS)
            colors = _normalize_pixels(pixels, len(STEELSERIES_APEX_KEYS), fallback)

            for i, key in enumerate(STEELSERIES_APEX_KEYS):
                base = (i * 4) + 3
                packet[base] = key
                packet[base + 1] = colors[i][0]
                packet[base + 2] = colors[i][1]
                packet[base + 3] = colors[i][2]

            if handle.send_feature_report(packet) <= 0:
                raise RuntimeError("SteelSeries Apex RGB feature report was not accepted")
        finally:
            handle.close()

    def _nzxt_wait_reply(self, handle, b0: int, b1: int, timeout_s: float) -> list[int] | None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            payload = handle.read(64, 150)
            if not payload:
                continue
            if len(payload) >= 2 and payload[0] == b0 and payload[1] == b1:
                return payload
        return None

    def _nzxt_channel_leds(self, dev: NativeDevice, handle) -> list[int]:
        cached = self._nzxt_led_cache.get(dev.id)
        nzxt_cache_seconds = max(15.0, float(os.getenv("PC_RGB_NZXT_CACHE_SECONDS", "600")))
        if cached and (time.time() - cached[0]) < nzxt_cache_seconds:
            return list(cached[1])

        channels = int(dev.extra.get("rgb_channels", 0))
        if channels <= 0:
            return []

        # CAM can reject reads while leaving the RGB output reports writable.
        # Mapping queries are optional for color writes, so fall back to the
        # declared controller channels on transport read errors.
        mapping = None
        try:
            handle.write([0x10, 0x01] + [0x00] * 62)
            self._nzxt_wait_reply(handle, 0x11, 0x01, timeout_s=1.5)
            handle.write([0x20, 0x03] + [0x00] * 62)
            mapping = self._nzxt_wait_reply(handle, 0x21, 0x03, timeout_s=4.5)
        except OSError:
            # No fan-speed or pump commands are sent by this driver.
            mapping = None
        if mapping is None:
            fallback = [20] * channels
            self._nzxt_led_cache[dev.id] = (time.time(), fallback)
            return fallback

        led_counts: list[int] = []
        for ch in range(channels):
            start = 0x0F + (6 * ch)
            leds = 0
            for offset in range(6):
                dev_id = mapping[start + offset] if (start + offset) < len(mapping) else 0
                leds += NZXT_LED_COUNTS.get(int(dev_id), 0)
            led_counts.append(max(0, min(40, leds)))

        self._nzxt_led_cache[dev.id] = (time.time(), led_counts)
        return led_counts
    def _apply_nzxt_hue2(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_nzxt_hue2_pixels(dev, [], rgb)

    def _apply_nzxt_hue2_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        handle = self._open_hid(dev.path)
        try:
            channel_leds = self._nzxt_channel_leds(dev, handle)
            declared_channels = max(int(dev.extra.get("rgb_channels", 0)), len(channel_leds))
            cursor = 0
            for channel in range(declared_channels):
                leds = int(channel_leds[channel]) if channel < len(channel_leds) else 0
                if leds <= 0 and self._nzxt_force_unknown_channels:
                    leds = self._nzxt_unknown_led_count
                if leds <= 0:
                    continue

                chunk = pixels[cursor : cursor + leds] if pixels else []
                cursor += leds
                channel_colors = _normalize_pixels(chunk, leds, fallback)

                # NZXT direct packets are fixed 20-LED chunks (GRB order).
                color_stream: list[int] = []
                for idx in range(max(40, leds)):
                    src = channel_colors[idx] if idx < leds else channel_colors[-1]
                    color_stream.extend([src[1], src[0], src[2]])

                packet0 = [0x00] * 64
                packet0[0] = 0x22
                packet0[1] = 0x10
                packet0[2] = (1 << channel)
                packet0[3] = 0x00
                packet0[4:64] = color_stream[0:60]
                if handle.write(packet0) <= 0:
                    raise RuntimeError(f"NZXT RGB channel {channel + 1} rejected color packet")

                if leds > 20:
                    packet1 = [0x00] * 64
                    packet1[0] = 0x22
                    packet1[1] = 0x11
                    packet1[2] = (1 << channel)
                    packet1[3] = 0x00
                    packet1[4:64] = color_stream[60:120]
                    if handle.write(packet1) <= 0:
                        raise RuntimeError(f"NZXT RGB channel {channel + 1} rejected second color packet")

                apply_packet = [0x00] * 64
                apply_packet[0] = 0x22
                apply_packet[1] = 0xA0
                apply_packet[2] = (1 << channel)
                apply_packet[4] = 0x01
                apply_packet[7] = 0x28
                apply_packet[10] = 0x80
                apply_packet[12] = 0x32
                apply_packet[15] = 0x01
                if handle.write(apply_packet) <= 0:
                    raise RuntimeError(f"NZXT RGB channel {channel + 1} rejected apply packet")
        finally:
            handle.close()

    def _asus_wait_config(self, handle) -> list[int] | None:
        handle.write([0xEC, 0x82] + [0x00] * 63)
        handle.read(65, 200)

        handle.write([0xEC, 0xB0] + [0x00] * 63)
        deadline = time.time() + 1.5
        while time.time() < deadline:
            payload = handle.read(65, 150)
            if payload and len(payload) >= 64 and payload[1] == 0x30:
                return payload
        return None

    def _asus_channels(self, dev: NativeDevice, handle) -> list[dict[str, int]]:
        cached = self._asus_channel_cache.get(dev.id)
        asus_cache_seconds = max(20.0, float(os.getenv("PC_RGB_ASUS_CACHE_SECONDS", "600")))
        if cached and (time.time() - cached[0]) < asus_cache_seconds:
            return [dict(x) for x in cached[1]]

        config_payload = self._asus_wait_config(handle)
        if config_payload is None:
            raise RuntimeError("ASUS Aura config table not received")

        config_table = config_payload[4:64]
        if len(config_table) < 0x1E:
            raise RuntimeError("ASUS Aura config table too short")

        total_leds = int(config_table[0x1B])
        rgb_headers = int(config_table[0x1D])
        addr_headers = int(config_table[0x02])

        if total_leds < rgb_headers:
            rgb_headers = 0

        channels: list[dict[str, int]] = []
        effect_channel = 0
        if total_leds > 0:
            channels.append(
                {
                    "effect_channel": effect_channel,
                    "direct_channel": 0x04,
                    "led_count": total_leds,
                    "rgb_headers": rgb_headers,
                }
            )
            effect_channel += 1

        for i in range(addr_headers):
            led_count = (
                self._asus_addressable_per_header[i]
                if i < len(self._asus_addressable_per_header)
                else self._asus_addressable_default_leds
            )
            channels.append(
                {
                    "effect_channel": effect_channel,
                    "direct_channel": i,
                    "led_count": led_count,
                    "rgb_headers": 0,
                }
            )
            effect_channel += 1

        self._asus_channel_cache[dev.id] = (time.time(), channels)
        return [dict(x) for x in channels]
    def _asus_send_direct(self, handle, direct_channel: int, led_count: int, rgb: tuple[int, int, int]) -> None:
        colors = _normalize_pixels([], led_count, rgb)
        self._asus_send_direct_pixels(handle, direct_channel, colors)

    def _asus_send_direct_pixels(self, handle, direct_channel: int, colors: list[tuple[int, int, int]]) -> None:
        if not colors:
            return
        led_count = len(colors)
        remaining = max(1, min(40, int(led_count)))
        offset = 0

        while offset < remaining:
            chunk = min(20, remaining - offset)
            packet = [0x00] * 65
            packet[0] = 0xEC
            packet[1] = 0x40
            packet[2] = (0x80 if (offset + chunk) >= remaining else 0x00) | int(direct_channel)
            packet[3] = offset
            packet[4] = chunk

            for idx in range(chunk):
                base = 0x05 + (idx * 3)
                src = colors[offset + idx]
                packet[base] = src[0]
                packet[base + 1] = src[1]
                packet[base + 2] = src[2]

            handle.write(packet)
            offset += chunk

    def _asus_send_effect_mode(self, handle, effect_channel: int, mode: int, shutdown_effect: bool = False) -> None:
        packet = [0x00] * 65
        packet[0] = 0xEC
        packet[1] = 0x35
        packet[2] = int(effect_channel) & 0xFF
        packet[3] = 0x00
        packet[4] = 0x01 if shutdown_effect else 0x00
        packet[5] = int(mode) & 0xFF
        handle.write(packet)

    def _asus_send_effect_color(
        self,
        handle,
        start_led: int,
        led_count: int,
        rgb: tuple[int, int, int],
        shutdown_effect: bool = False,
    ) -> None:
        led_count = max(1, min(16, int(led_count)))
        start_led = max(0, min(15, int(start_led)))
        mask = ((1 << led_count) - 1) << start_led
        packet = [0x00] * 65
        packet[0] = 0xEC
        packet[1] = 0x36
        packet[2] = (mask >> 8) & 0xFF
        packet[3] = mask & 0xFF
        packet[4] = 0x01 if shutdown_effect else 0x00

        for idx in range(led_count):
            base = 0x05 + ((start_led + idx) * 3)
            if base + 2 >= len(packet):
                break
            packet[base] = rgb[0]
            packet[base + 1] = rgb[1]
            packet[base + 2] = rgb[2]

        handle.write(packet)

    def _apply_asus_mainboard(self, dev: NativeDevice, rgb: tuple[int, int, int]) -> None:
        self._apply_asus_mainboard_pixels(dev, [], rgb)

    def _apply_asus_mainboard_pixels(
        self, dev: NativeDevice, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int]
    ) -> None:
        handle = self._open_hid(dev.path)
        try:
            channels = self._asus_channels(dev, handle)
            if not channels:
                raise RuntimeError("ASUS Aura reports no RGB channels")

            for _ in range(self._asus_write_passes):
                start_led = 0
                cursor = 0
                for channel in channels:
                    led_count = int(channel.get("led_count") or 0)
                    direct_channel = int(channel.get("direct_channel") or 0)
                    effect_channel = int(channel["effect_channel"])
                    if led_count <= 0:
                        continue
                    chunk = pixels[cursor : cursor + led_count] if pixels else []
                    channel_colors = _normalize_pixels(chunk, led_count, fallback)
                    cursor += max(0, led_count)

                    self._asus_send_effect_mode(
                        handle=handle,
                        effect_channel=effect_channel,
                        mode=0xFF,  # direct mode
                        shutdown_effect=False,
                    )

                    self._asus_send_direct_pixels(handle=handle, direct_channel=direct_channel, colors=channel_colors)

                    apply_static = self._asus_static_fallback and led_count > 0 and (
                        self._asus_force_static_all_channels or direct_channel == 0x04
                    )
                    if apply_static:
                        self._asus_send_effect_mode(
                            handle=handle,
                            effect_channel=effect_channel,
                            mode=0x01,  # static
                            shutdown_effect=False,
                        )
                        effect_leds = max(1, min(16, led_count))
                        effect_start = start_led if direct_channel == 0x04 else 0
                        self._asus_send_effect_color(
                            handle=handle,
                            start_led=effect_start,
                            led_count=effect_leds,
                            rgb=channel_colors[0],
                            shutdown_effect=False,
                        )
                        if self._asus_reassert_direct_after_static:
                            self._asus_send_effect_mode(
                                handle=handle,
                                effect_channel=effect_channel,
                                mode=0xFF,
                                shutdown_effect=False,
                            )
                            self._asus_send_direct_pixels(handle=handle, direct_channel=direct_channel, colors=channel_colors)
                    start_led += max(0, led_count)

                commit_packet = [0x00] * 65
                commit_packet[0] = 0xEC
                commit_packet[1] = 0x3F
                commit_packet[2] = 0x55
                handle.write(commit_packet)
                time.sleep(0.003)
        finally:
            handle.close()














