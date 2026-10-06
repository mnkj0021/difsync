from __future__ import annotations

import ctypes
import json
import os
import re
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


I2C_SMBUS_READ = 1
I2C_SMBUS_WRITE = 0

MAX_RETRIES = 400
I2C_SMBUS_BLOCK_MAX = 32
I2C_SMBUS_UNION_BYTES = I2C_SMBUS_BLOCK_MAX + 2
PAWNIO_UNION_QWORDS = 5
PAWNIO_IN_QWORDS = 9

I2C_SMBUS_QUICK = 0
I2C_SMBUS_BYTE_DATA = 2
I2C_SMBUS_BLOCK_DATA = 5

I801_QUICK = 0x00
I801_BYTE_DATA = 0x08
I801_BLOCK_DATA = 0x14

SMBHSTSTS_OFF = 0
SMBHSTCNT_OFF = 2
SMBHSTCMD_OFF = 3
SMBHSTADD_OFF = 4
SMBHSTDAT0_OFF = 5
SMBHSTDAT1_OFF = 6
SMBBLKDAT_OFF = 7
SMBAUXCTL_OFF = 13

SMBHSTCNT_INTREN = 1 << 0
SMBHSTCNT_KILL = 1 << 1
SMBHSTCNT_LAST_BYTE = 1 << 5
SMBHSTCNT_START = 1 << 6

SMBHSTSTS_BYTE_DONE = 1 << 7
SMBHSTSTS_FAILED = 1 << 4
SMBHSTSTS_BUS_ERR = 1 << 3
SMBHSTSTS_DEV_ERR = 1 << 2
SMBHSTSTS_INTR = 1 << 1
SMBHSTSTS_HOST_BUSY = 1 << 0

SMBAUXCTL_CRC = 1 << 0
SMBAUXCTL_E32B = 1 << 1

STATUS_ERROR_FLAGS = SMBHSTSTS_FAILED | SMBHSTSTS_BUS_ERR | SMBHSTSTS_DEV_ERR
STATUS_FLAGS = SMBHSTSTS_BYTE_DONE | SMBHSTSTS_INTR | STATUS_ERROR_FLAGS

SMBHSTCFG = 0x40
SMBHSTCFG_HST_EN = 1 << 0
PCI_SMBUS_BASE_REG = 0x20

GLOBAL_SMBUS_MUTEX_NAME = "Global\\Access_SMBUS.HTP.Method"
REPO_ROOT = Path(__file__).resolve().parent


def _clamp_u8(value: int) -> int:
    return max(0, min(255, int(value)))


def _run_powershell_json(script: str, timeout_s: float = 8.0) -> list[dict[str, Any]]:
    command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script]
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            check=False,
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

    if isinstance(parsed, dict):
        return [parsed]
    if isinstance(parsed, list):
        return [x for x in parsed if isinstance(x, dict)]
    return []


def _is_user_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _winring_service_binary_hint() -> str:
    try:
        completed = subprocess.run(
            ["sc.exe", "qc", "WinRing0_1_2_0"],
            capture_output=True,
            text=True,
            timeout=3.0,
            check=False,
        )
    except Exception:
        return ""

    text = f"{completed.stdout}\n{completed.stderr}"
    match = re.search(r"BINARY_PATH_NAME\s+:\s+(.+)", text)
    if not match:
        return ""

    raw_path = match.group(1).strip()
    normalized = raw_path.replace("\\??\\", "", 1)
    if normalized and (not os.path.exists(normalized)):
        return f"WinRing service path is stale: '{normalized}' not found."
    return ""


def _format_hresult(code: int) -> str:
    return f"0x{(int(code) & 0xFFFFFFFF):08X}"


@dataclass
class _SmbusController:
    name: str
    vendor_id: int
    device_id: int
    pci_address: int
    base_port: int


@dataclass
class _CorsairEndpoint:
    controller_name: str
    base_port: int
    address: int
    protocol: str
    led_count: int
    label: str


class _WinRingBridge:
    def __init__(self) -> None:
        self._dll = None
        self._dll_path = ""
        self._initialized = False
        self._init_error = ""
        self._mutex = threading.Lock()
        self._global_mutex_handle = None
        self._kernel32 = ctypes.windll.kernel32

    @property
    def dll_path(self) -> str:
        return self._dll_path

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def init_error(self) -> str:
        return self._init_error

    def _candidate_paths(self) -> list[Path]:
        candidates = []
        env_path = os.getenv("PC_RGB_WINRING_DLL", "").strip()
        if env_path:
            candidates.append(Path(env_path))

        candidates.extend(
            [
                Path(r"I:\OpenRGB\WinRing0x64.dll"),
                REPO_ROOT / "OpenRGB" / "dependencies" / "winring0" / "x64" / "WinRing0x64.dll",
                Path(r"C:\Program Files\OpenRGB\WinRing0x64.dll"),
            ]
        )
        return candidates

    def _load_dll(self) -> None:
        if self._dll is not None:
            return

        for path in self._candidate_paths():
            if not path.exists():
                continue
            try:
                dll = ctypes.WinDLL(str(path))
            except Exception:
                continue

            dll.InitializeOls.argtypes = []
            dll.InitializeOls.restype = ctypes.c_bool
            dll.DeinitializeOls.argtypes = []
            dll.DeinitializeOls.restype = None
            dll.GetDllStatus.argtypes = []
            dll.GetDllStatus.restype = ctypes.c_uint32
            dll.FindPciDeviceById.argtypes = [ctypes.c_uint16, ctypes.c_uint16, ctypes.c_uint8]
            dll.FindPciDeviceById.restype = ctypes.c_uint32
            dll.ReadPciConfigWord.argtypes = [ctypes.c_uint32, ctypes.c_uint8]
            dll.ReadPciConfigWord.restype = ctypes.c_uint16
            dll.ReadIoPortByte.argtypes = [ctypes.c_uint16]
            dll.ReadIoPortByte.restype = ctypes.c_uint8
            dll.WriteIoPortByte.argtypes = [ctypes.c_uint16, ctypes.c_uint8]
            dll.WriteIoPortByte.restype = None

            self._dll = dll
            self._dll_path = str(path)
            return

        self._init_error = "WinRing0x64.dll not found. Set PC_RGB_WINRING_DLL in .env."

    def initialize(self) -> bool:
        with self._mutex:
            if self._initialized:
                return True

            self._load_dll()
            if self._dll is None:
                return False

            try:
                self._global_mutex_handle = self._kernel32.CreateMutexW(None, False, GLOBAL_SMBUS_MUTEX_NAME)
            except Exception:
                self._global_mutex_handle = None

            status_before = int(self._dll.GetDllStatus())
            ok = bool(self._dll.InitializeOls())
            status_after = int(self._dll.GetDllStatus())

            if not ok:
                self._initialized = False
                stale_hint = _winring_service_binary_hint()
                extra = f" {stale_hint}" if stale_hint else ""
                self._init_error = (
                    f"WinRing0 initialize failed (status_before={status_before}, status_after={status_after}). "
                    "Run DifSync as Administrator once to load the kernel driver."
                    f"{extra}"
                )
                return False

            self._initialized = True
            self._init_error = ""
            return True

    def shutdown(self) -> None:
        with self._mutex:
            if self._dll is not None and self._initialized:
                try:
                    self._dll.DeinitializeOls()
                except Exception:
                    pass
            self._initialized = False

            if self._global_mutex_handle:
                try:
                    self._kernel32.CloseHandle(self._global_mutex_handle)
                except Exception:
                    pass
                self._global_mutex_handle = None

    def _lock_global(self) -> None:
        if not self._global_mutex_handle:
            return
        self._kernel32.WaitForSingleObject(self._global_mutex_handle, 0xFFFFFFFF)

    def _unlock_global(self) -> None:
        if not self._global_mutex_handle:
            return
        self._kernel32.ReleaseMutex(self._global_mutex_handle)

    def read_io8(self, port: int) -> int:
        return int(self._dll.ReadIoPortByte(ctypes.c_uint16(port)))

    def write_io8(self, port: int, value: int) -> None:
        self._dll.WriteIoPortByte(ctypes.c_uint16(port), ctypes.c_uint8(value & 0xFF))

    def find_pci_device(self, vendor_id: int, device_id: int) -> int:
        return int(self._dll.FindPciDeviceById(vendor_id & 0xFFFF, device_id & 0xFFFF, 0))

    def read_pci_word(self, pci_addr: int, reg: int) -> int:
        return int(self._dll.ReadPciConfigWord(pci_addr, reg & 0xFF))


class _PawnIoBridge:
    def __init__(self) -> None:
        self._dll = None
        self._dll_path = ""
        self._blob_path = ""
        self._blob_data = b""
        self._initialized = False
        self._init_error = ""
        self._handle = ctypes.c_void_p()
        self._mutex = threading.Lock()
        self._global_mutex_handle = None
        self._kernel32 = ctypes.windll.kernel32

    @property
    def dll_path(self) -> str:
        return self._dll_path

    @property
    def blob_path(self) -> str:
        return self._blob_path

    @property
    def initialized(self) -> bool:
        return self._initialized

    @property
    def init_error(self) -> str:
        return self._init_error

    def _candidate_dll_paths(self) -> list[Path]:
        candidates: list[Path] = []
        env_path = os.getenv("PC_RGB_PAWNIO_DLL", "").strip()
        if env_path:
            candidates.append(Path(env_path))

        candidates.extend(
            [
                REPO_ROOT / "PawnIOLib.dll",
                REPO_ROOT / "_winget_dl" / "openrgb_extract" / "OpenRGB" / "PawnIOLib.dll",
                Path(r"C:\Program Files\OpenRGB\PawnIOLib.dll"),
            ]
        )
        return candidates

    def _candidate_blob_paths(self, dll_path: Path) -> list[Path]:
        candidates: list[Path] = []
        env_path = os.getenv("PC_RGB_PAWNIO_I801_BIN", "").strip()
        if env_path:
            candidates.append(Path(env_path))

        candidates.extend(
            [
                dll_path.parent / "SmbusI801.bin",
                REPO_ROOT / "SmbusI801.bin",
                REPO_ROOT / "_winget_dl" / "openrgb_extract" / "OpenRGB" / "SmbusI801.bin",
                Path(r"C:\Program Files\OpenRGB\SmbusI801.bin"),
            ]
        )
        return candidates

    def _load_dll(self) -> None:
        if self._dll is not None:
            return

        for path in self._candidate_dll_paths():
            if not path.exists():
                continue
            try:
                dll = ctypes.WinDLL(str(path))
            except Exception:
                continue

            dll.pawnio_version.argtypes = [ctypes.POINTER(ctypes.c_uint32)]
            dll.pawnio_version.restype = ctypes.c_int32
            dll.pawnio_open.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
            dll.pawnio_open.restype = ctypes.c_int32
            dll.pawnio_load.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t]
            dll.pawnio_load.restype = ctypes.c_int32
            dll.pawnio_execute.argtypes = [
                ctypes.c_void_p,
                ctypes.c_char_p,
                ctypes.POINTER(ctypes.c_uint64),
                ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_uint64),
                ctypes.c_size_t,
                ctypes.POINTER(ctypes.c_size_t),
            ]
            dll.pawnio_execute.restype = ctypes.c_int32
            dll.pawnio_close.argtypes = [ctypes.c_void_p]
            dll.pawnio_close.restype = ctypes.c_int32

            self._dll = dll
            self._dll_path = str(path)
            return

        self._init_error = "PawnIOLib.dll not found. Set PC_RGB_PAWNIO_DLL in .env."

    def _load_blob(self) -> bool:
        if self._blob_data:
            return True

        if not self._dll_path:
            return False

        dll_path = Path(self._dll_path)
        for path in self._candidate_blob_paths(dll_path):
            if not path.exists():
                continue
            try:
                blob = path.read_bytes()
            except Exception:
                continue
            if not blob:
                continue
            self._blob_path = str(path)
            self._blob_data = blob
            return True

        self._init_error = "SmbusI801.bin not found. Set PC_RGB_PAWNIO_I801_BIN in .env."
        return False

    def initialize(self) -> bool:
        with self._mutex:
            if self._initialized:
                return True

            self._load_dll()
            if self._dll is None:
                return False

            if not self._load_blob():
                return False

            version = ctypes.c_uint32(0)
            hr_version = int(self._dll.pawnio_version(ctypes.byref(version)))
            if hr_version != 0:
                self._init_error = f"PawnIO runtime not available (code={_format_hresult(hr_version)})."
                return False

            handle = ctypes.c_void_p()
            hr_open = int(self._dll.pawnio_open(ctypes.byref(handle)))
            if hr_open != 0:
                if (hr_open & 0xFFFFFFFF) == 0x80070005:
                    self._init_error = "PawnIO open failed: access denied. Run DifSync as Administrator."
                else:
                    self._init_error = (
                        f"PawnIO open failed (code={_format_hresult(hr_open)}). "
                        "Install PawnIO driver: `winget install namazso.PawnIO`."
                    )
                return False

            blob = (ctypes.c_ubyte * len(self._blob_data)).from_buffer_copy(self._blob_data)
            hr_load = int(self._dll.pawnio_load(handle, blob, len(self._blob_data)))
            if hr_load != 0:
                try:
                    self._dll.pawnio_close(handle)
                except Exception:
                    pass
                self._init_error = (
                    f"PawnIO i801 load failed (code={_format_hresult(hr_load)}). "
                    "Install/repair PawnIO driver."
                )
                return False

            try:
                self._global_mutex_handle = self._kernel32.CreateMutexW(None, False, GLOBAL_SMBUS_MUTEX_NAME)
            except Exception:
                self._global_mutex_handle = None

            self._handle = handle
            self._initialized = True
            self._init_error = ""
            return True

    def shutdown(self) -> None:
        with self._mutex:
            if self._dll is not None and self._initialized and self._handle:
                try:
                    self._dll.pawnio_close(self._handle)
                except Exception:
                    pass
            self._handle = ctypes.c_void_p()
            self._initialized = False

            if self._global_mutex_handle:
                try:
                    self._kernel32.CloseHandle(self._global_mutex_handle)
                except Exception:
                    pass
                self._global_mutex_handle = None

    def _lock_global(self) -> None:
        if not self._global_mutex_handle:
            return
        self._kernel32.WaitForSingleObject(self._global_mutex_handle, 0xFFFFFFFF)

    def _unlock_global(self) -> None:
        if not self._global_mutex_handle:
            return
        self._kernel32.ReleaseMutex(self._global_mutex_handle)

    def _xfer(
        self,
        address: int,
        read_write: int,
        command: int,
        size: int,
        union_payload: bytes | None,
    ) -> tuple[int, bytes]:
        if (not self._initialized) or (self._dll is None) or (not self._handle):
            return -1, b""

        in_args = (ctypes.c_uint64 * PAWNIO_IN_QWORDS)()
        out_args = (ctypes.c_uint64 * PAWNIO_UNION_QWORDS)()
        return_size = ctypes.c_size_t(0)
        in_args[0] = ctypes.c_uint64(address & 0x7F).value
        in_args[1] = ctypes.c_uint64(read_write & 0x01).value
        in_args[2] = ctypes.c_uint64(command & 0xFF).value
        in_args[3] = ctypes.c_uint64(size & 0xFFFFFFFF).value

        if union_payload is not None:
            payload = bytes(union_payload[:I2C_SMBUS_UNION_BYTES]).ljust(I2C_SMBUS_UNION_BYTES, b"\x00")
            ctypes.memmove(ctypes.byref(in_args, 4 * ctypes.sizeof(ctypes.c_uint64)), payload, len(payload))

        hr = int(
            self._dll.pawnio_execute(
                self._handle,
                b"ioctl_smbus_xfer",
                in_args,
                PAWNIO_IN_QWORDS,
                out_args,
                PAWNIO_UNION_QWORDS,
                ctypes.byref(return_size),
            )
        )
        if hr != 0:
            return hr, b""

        out_payload = ctypes.string_at(ctypes.byref(out_args), I2C_SMBUS_UNION_BYTES)
        return 0, out_payload

    def smbus_write_quick(self, address: int, read_write: int) -> int:
        hr, _ = self._xfer(address, read_write, 0, I2C_SMBUS_QUICK, None)
        return 0 if hr == 0 else -5

    def smbus_read_byte_data(self, address: int, command: int) -> int:
        hr, out_payload = self._xfer(address, I2C_SMBUS_READ, command, I2C_SMBUS_BYTE_DATA, bytes(1))
        if hr != 0:
            return -5
        if not out_payload:
            return -5
        return int(out_payload[0])

    def smbus_write_byte_data(self, address: int, command: int, value: int) -> int:
        hr, _ = self._xfer(
            address,
            I2C_SMBUS_WRITE,
            command,
            I2C_SMBUS_BYTE_DATA,
            bytes([value & 0xFF]),
        )
        return 0 if hr == 0 else -5

    def smbus_write_block_data(self, address: int, command: int, payload: bytes) -> int:
        data = bytes(payload[:I2C_SMBUS_BLOCK_MAX])
        union = bytes([len(data) & 0xFF]) + data
        hr, _ = self._xfer(address, I2C_SMBUS_WRITE, command, I2C_SMBUS_BLOCK_DATA, union)
        return 0 if hr == 0 else -5


class CorsairRamSmbusController:
    def __init__(self) -> None:
        self._winring = _WinRingBridge()
        self._pawnio = _PawnIoBridge()
        self._active_transport = "none"
        self._transport_reason = ""
        self._cache_lock = threading.Lock()
        self._probe_cache: tuple[float, dict[str, Any]] | None = None
        self._probe_seconds = max(3.0, float(os.getenv("PC_RGB_RAM_PROBE_SECONDS", "30")))

    def _transport_state(self) -> dict[str, Any]:
        return {
            "active": self._active_transport,
            "reason": self._transport_reason,
            "winring": {
                "ready": self._winring.initialized,
                "dll_path": self._winring.dll_path,
                "reason": self._winring.init_error,
            },
            "pawnio": {
                "ready": self._pawnio.initialized,
                "dll_path": self._pawnio.dll_path,
                "blob_path": self._pawnio.blob_path,
                "reason": self._pawnio.init_error,
            },
        }

    def _initialize_transport(self) -> bool:
        if self._active_transport == "winring" and self._winring.initialized:
            return True
        if self._active_transport == "pawnio" and self._pawnio.initialized:
            return True

        if self._winring.initialize():
            self._active_transport = "winring"
            self._transport_reason = ""
            return True

        winring_reason = self._winring.init_error
        if self._pawnio.initialize():
            self._active_transport = "pawnio"
            self._transport_reason = ""
            return True

        pawnio_reason = self._pawnio.init_error
        self._active_transport = "none"
        self._transport_reason = "; ".join(
            [x for x in [winring_reason, pawnio_reason] if str(x).strip()]
        ).strip()
        return False

    def _lock_transport(self) -> None:
        if self._active_transport == "winring":
            self._winring._lock_global()
        elif self._active_transport == "pawnio":
            self._pawnio._lock_global()

    def _unlock_transport(self) -> None:
        if self._active_transport == "winring":
            self._winring._unlock_global()
        elif self._active_transport == "pawnio":
            self._pawnio._unlock_global()

    @staticmethod
    def _led_count_from_part_number(part_number: str) -> tuple[int, str]:
        pn = (part_number or "").strip().upper()
        model_prefix = pn[:3]
        if model_prefix == "CMT":
            return 12, "Corsair Dominator Platinum"
        if model_prefix == "CMH":
            return 10, "Corsair Vengeance Pro SL"
        if model_prefix == "CMN":
            return 10, "Corsair Vengeance RGB RT"
        if model_prefix == "CMG":
            return 6, "Corsair Vengeance RGB RS"
        if model_prefix == "CMP":
            return 11, "Corsair Dominator Titanium"
        return 10, "Corsair RGB DRAM"

    @staticmethod
    def _extract_smbus_devices() -> list[dict[str, Any]]:
        rows = _run_powershell_json(
            "Get-CimInstance Win32_PnPSignedDriver | "
            "Where-Object { ($_.Description -like '*SMBUS*' -or $_.Description -like '*SM BUS*') "
            "-and ($_.Manufacturer -match 'Intel|INTEL') } | "
            "Select-Object DeviceID,Description,Manufacturer | ConvertTo-Json -Compress"
        )
        return rows

    def _discover_i801_controllers(self) -> tuple[list[_SmbusController], str]:
        if self._active_transport == "pawnio":
            return [
                _SmbusController(
                    name="PawnIO i801",
                    vendor_id=0,
                    device_id=0,
                    pci_address=0,
                    base_port=0,
                )
            ], ""

        rows = self._extract_smbus_devices()
        if not rows:
            return [], "No Intel SMBus controller found via WMI."

        controllers: list[_SmbusController] = []
        for row in rows:
            device_id_text = str(row.get("DeviceID") or "").upper()
            description = str(row.get("Description") or "Intel SMBus").strip()
            match = re.search(r"VEN_([0-9A-F]{4}).*DEV_([0-9A-F]{4})", device_id_text)
            if not match:
                continue

            vendor_id = int(match.group(1), 16)
            device_id = int(match.group(2), 16)
            pci_addr = self._winring.find_pci_device(vendor_id, device_id)
            if pci_addr == 0xFFFFFFFF:
                continue

            host_cfg = self._winring.read_pci_word(pci_addr, SMBHSTCFG) & 0xFF
            if (host_cfg & SMBHSTCFG_HST_EN) == 0:
                continue

            base_port = self._winring.read_pci_word(pci_addr, PCI_SMBUS_BASE_REG) & 0xFFFE
            if base_port <= 0 or base_port == 0xFFFE:
                continue

            controllers.append(
                _SmbusController(
                    name=description,
                    vendor_id=vendor_id,
                    device_id=device_id,
                    pci_address=pci_addr,
                    base_port=base_port,
                )
            )

        if not controllers:
            return [], "SMBus controller exists, but i801 base port was not readable."
        return controllers, ""

    def _port(self, base: int, offset: int) -> int:
        return (base + offset) & 0xFFFF

    def _check_pre(self, base: int) -> int:
        status = self._winring.read_io8(self._port(base, SMBHSTSTS_OFF))
        if status & SMBHSTSTS_HOST_BUSY:
            return -16

        status &= STATUS_FLAGS
        if status:
            self._winring.write_io8(self._port(base, SMBHSTSTS_OFF), status)
            status2 = self._winring.read_io8(self._port(base, SMBHSTSTS_OFF)) & STATUS_FLAGS
            if status2:
                return -16
        return 0

    def _check_post(self, base: int, status: int) -> int:
        if status < 0:
            cnt = self._winring.read_io8(self._port(base, SMBHSTCNT_OFF))
            self._winring.write_io8(self._port(base, SMBHSTCNT_OFF), cnt | SMBHSTCNT_KILL)
            time.sleep(0.001)
            cnt2 = self._winring.read_io8(self._port(base, SMBHSTCNT_OFF))
            self._winring.write_io8(self._port(base, SMBHSTCNT_OFF), cnt2 & (~SMBHSTCNT_KILL))
            self._winring.write_io8(self._port(base, SMBHSTSTS_OFF), STATUS_FLAGS)
            return -110

        result = 0
        if status & SMBHSTSTS_FAILED:
            result = -5
        if status & SMBHSTSTS_DEV_ERR:
            result = -6
        if status & SMBHSTSTS_BUS_ERR:
            result = -11

        self._winring.write_io8(self._port(base, SMBHSTSTS_OFF), status)
        return result

    def _wait_intr(self, base: int) -> int:
        timeout = 0
        while timeout < MAX_RETRIES:
            status = self._winring.read_io8(self._port(base, SMBHSTSTS_OFF))
            busy = bool(status & SMBHSTSTS_HOST_BUSY)
            done = bool(status & (STATUS_ERROR_FLAGS | SMBHSTSTS_INTR))
            if (not busy) and done:
                return status & (STATUS_ERROR_FLAGS | SMBHSTSTS_INTR)
            timeout += 1
        return -110

    def _wait_byte_done(self, base: int) -> int:
        timeout = 0
        while timeout < MAX_RETRIES:
            time.sleep(0.001)
            status = self._winring.read_io8(self._port(base, SMBHSTSTS_OFF))
            if status & (STATUS_ERROR_FLAGS | SMBHSTSTS_BYTE_DONE):
                return status & STATUS_ERROR_FLAGS
            timeout += 1
        return -110

    def _transaction(self, base: int, xact: int) -> int:
        result = self._check_pre(base)
        if result < 0:
            return result

        cnt_port = self._port(base, SMBHSTCNT_OFF)
        cnt = self._winring.read_io8(cnt_port)
        self._winring.write_io8(cnt_port, cnt & (~SMBHSTCNT_INTREN))
        self._winring.write_io8(cnt_port, (xact | SMBHSTCNT_START) & 0xFF)

        status = self._wait_intr(base)
        return self._check_post(base, status)

    def _smbus_write_quick(self, base: int, address: int, read_write: int) -> int:
        if self._active_transport == "pawnio":
            return self._pawnio.smbus_write_quick(address, read_write)
        self._winring.write_io8(self._port(base, SMBHSTADD_OFF), ((address & 0x7F) << 1) | (read_write & 0x01))
        return self._transaction(base, I801_QUICK)

    def _smbus_read_byte_data(self, base: int, address: int, command: int) -> int:
        if self._active_transport == "pawnio":
            return self._pawnio.smbus_read_byte_data(address, command)
        self._winring.write_io8(self._port(base, SMBHSTADD_OFF), ((address & 0x7F) << 1) | I2C_SMBUS_READ)
        self._winring.write_io8(self._port(base, SMBHSTCMD_OFF), command & 0xFF)
        result = self._transaction(base, I801_BYTE_DATA)
        if result < 0:
            return result
        return self._winring.read_io8(self._port(base, SMBHSTDAT0_OFF))

    def _smbus_write_byte_data(self, base: int, address: int, command: int, value: int) -> int:
        if self._active_transport == "pawnio":
            return self._pawnio.smbus_write_byte_data(address, command, value)
        self._winring.write_io8(self._port(base, SMBHSTADD_OFF), ((address & 0x7F) << 1) | I2C_SMBUS_WRITE)
        self._winring.write_io8(self._port(base, SMBHSTCMD_OFF), command & 0xFF)
        self._winring.write_io8(self._port(base, SMBHSTDAT0_OFF), value & 0xFF)
        return self._transaction(base, I801_BYTE_DATA)

    def _smbus_write_block_data(self, base: int, address: int, command: int, payload: bytes) -> int:
        if self._active_transport == "pawnio":
            return self._pawnio.smbus_write_block_data(address, command, payload)

        data = payload[:I2C_SMBUS_BLOCK_MAX]
        length = len(data)
        if length <= 0:
            return 0

        result = self._check_pre(base)
        if result < 0:
            return result

        self._winring.write_io8(self._port(base, SMBHSTADD_OFF), ((address & 0x7F) << 1) | I2C_SMBUS_WRITE)
        self._winring.write_io8(self._port(base, SMBHSTCMD_OFF), command & 0xFF)
        self._winring.write_io8(self._port(base, SMBHSTDAT0_OFF), length & 0xFF)
        self._winring.write_io8(self._port(base, SMBBLKDAT_OFF), data[0])

        smbcmd = I801_BLOCK_DATA
        for i in range(1, length + 1):
            if i == length:
                smbcmd |= SMBHSTCNT_LAST_BYTE
            self._winring.write_io8(self._port(base, SMBHSTCNT_OFF), smbcmd & 0xFF)

            if i == 1:
                cnt = self._winring.read_io8(self._port(base, SMBHSTCNT_OFF))
                self._winring.write_io8(self._port(base, SMBHSTCNT_OFF), cnt | SMBHSTCNT_START)

            status = self._wait_byte_done(base)
            if status < 0:
                return self._check_post(base, status)
            if status > 0:
                return self._check_post(base, status)

            if i < length:
                self._winring.write_io8(self._port(base, SMBBLKDAT_OFF), data[i])

            self._winring.write_io8(self._port(base, SMBHSTSTS_OFF), SMBHSTSTS_BYTE_DONE)

        final_status = self._wait_intr(base)
        return self._check_post(base, final_status)

    def _probe_corsair_endpoint(self, base: int, address: int) -> tuple[str, int] | None:
        if self._smbus_write_quick(base, address, I2C_SMBUS_WRITE) < 0:
            return None

        sig_43 = self._smbus_read_byte_data(base, address, 0x43)
        sig_44 = self._smbus_read_byte_data(base, address, 0x44)
        if sig_43 < 0 or sig_44 < 0:
            return None

        if sig_43 in (0x1A, 0x1B) and sig_44 == 0x04:
            return "dominator_platinum", 10
        if sig_43 == 0x1C and sig_44 in (0x03, 0x04):
            return "vengeance_pro", 10
        return None

    @staticmethod
    def _crc8(init: int, poly: int, data: bytes) -> int:
        crc = init & 0xFF
        for value in data:
            val = value & 0xFF
            mask = 0x80
            while mask != 0:
                if val & mask:
                    bit = (crc & 0x80) ^ 0x80
                else:
                    bit = crc & 0x80
                if bit == 0:
                    crc = (crc << 1) & 0xFF
                else:
                    crc = ((crc << 1) ^ poly) & 0xFF
                mask >>= 1
        return crc & 0xFF

    @staticmethod
    def _normalize_pixels(
        colors: list[tuple[int, int, int]] | None, led_count: int, fallback: tuple[int, int, int]
    ) -> list[tuple[int, int, int]]:
        count = max(1, int(led_count))
        base = (_clamp_u8(fallback[0]), _clamp_u8(fallback[1]), _clamp_u8(fallback[2]))
        if not colors:
            return [base for _ in range(count)]
        out: list[tuple[int, int, int]] = []
        for idx in range(count):
            src = colors[idx] if idx < len(colors) else colors[-1]
            out.append((_clamp_u8(src[0]), _clamp_u8(src[1]), _clamp_u8(src[2])))
        return out

    def _write_dominator_color(self, endpoint: _CorsairEndpoint, rgb: tuple[int, int, int]) -> int:
        return self._write_dominator_pixels(endpoint, None, rgb)

    def _write_dominator_pixels(
        self, endpoint: _CorsairEndpoint, colors: list[tuple[int, int, int]] | None, fallback: tuple[int, int, int]
    ) -> int:
        led_count = max(1, min(12, int(endpoint.led_count)))
        normalized = self._normalize_pixels(colors, led_count, fallback)
        data = bytearray(38)
        data[0] = 0x0C
        for led in range(led_count):
            r, g, b = normalized[led]
            off = (led * 3) + 1
            data[off] = r
            data[off + 1] = g
            data[off + 2] = b
        data[-1] = self._crc8(0x00, 0x07, bytes(data[:-1]))

        head = bytes(data[:32])
        tail = bytes(data[32:])
        res1 = self._smbus_write_block_data(endpoint.base_port, endpoint.address, 0x31, head)
        if res1 < 0:
            return res1
        time.sleep(0.0008)
        res2 = self._smbus_write_block_data(endpoint.base_port, endpoint.address, 0x32, tail)
        if res2 < 0:
            return res2
        time.sleep(0.0002)
        return 0

    def _write_vengeance_pro_color(self, endpoint: _CorsairEndpoint, rgb: tuple[int, int, int]) -> int:
        return self._write_vengeance_pro_pixels(endpoint, None, rgb)

    def _write_vengeance_pro_pixels(
        self, endpoint: _CorsairEndpoint, colors: list[tuple[int, int, int]] | None, fallback: tuple[int, int, int]
    ) -> int:
        led_count = max(1, min(10, int(endpoint.led_count)))
        normalized = self._normalize_pixels(colors, led_count, fallback)
        result = self._smbus_write_byte_data(endpoint.base_port, endpoint.address, 0x26, 0x02)
        if result < 0:
            return result
        time.sleep(0.001)
        result = self._smbus_write_byte_data(endpoint.base_port, endpoint.address, 0x21, 0x00)
        if result < 0:
            return result
        time.sleep(0.001)

        for led in range(led_count):
            r, g, b = normalized[led]
            for value in (r, g, b, 0xFF):
                result = self._smbus_write_byte_data(endpoint.base_port, endpoint.address, 0x20, value)
                if result < 0:
                    return result

        return self._smbus_write_byte_data(endpoint.base_port, endpoint.address, 0x82, 0x02)

    def _discover_endpoints(self, modules: list[dict[str, Any]]) -> tuple[list[_CorsairEndpoint], str]:
        controllers, error = self._discover_i801_controllers()
        if not controllers:
            return [], error

        part_numbers = [str(m.get("part_number") or "") for m in modules]
        led_models = [self._led_count_from_part_number(x) for x in part_numbers]

        endpoints: list[_CorsairEndpoint] = []
        address_order = list(range(0x58, 0x60)) + list(range(0x18, 0x20))
        slot_idx = 0

        for controller in controllers:
            for address in address_order:
                match = self._probe_corsair_endpoint(controller.base_port, address)
                if not match:
                    continue

                protocol, default_leds = match
                if slot_idx < len(led_models):
                    led_count, label = led_models[slot_idx]
                else:
                    led_count, label = (default_leds, "Corsair RGB DRAM")
                slot_idx += 1

                endpoints.append(
                    _CorsairEndpoint(
                        controller_name=controller.name,
                        base_port=controller.base_port,
                        address=address,
                        protocol=protocol,
                        led_count=led_count,
                        label=label,
                    )
                )

        if not endpoints:
            return [], "No Corsair RGB DIMM endpoints responded on i801 SMBus."
        return endpoints, ""

    def probe(self, modules: list[dict[str, Any]], force: bool = False) -> dict[str, Any]:
        now = time.time()
        with self._cache_lock:
            if not force and self._probe_cache and (now - self._probe_cache[0]) < self._probe_seconds:
                return dict(self._probe_cache[1])

        is_admin = _is_user_admin()
        if not self._initialize_transport():
            transport = self._transport_state()
            probe = {
                "ready": False,
                "is_admin": is_admin,
                "transport": transport.get("active"),
                "reason": transport.get("reason") or "No low-level SMBus transport available.",
                "transport_details": transport,
                "controllers": [],
                "endpoint_count": 0,
                "endpoints": [],
            }
            with self._cache_lock:
                self._probe_cache = (now, dict(probe))
            return probe

        self._lock_transport()
        try:
            endpoints, error = self._discover_endpoints(modules)
        finally:
            self._unlock_transport()

        rows = [
            {
                "controller": ep.controller_name,
                "base_port": f"0x{ep.base_port:04X}",
                "address": f"0x{ep.address:02X}",
                "protocol": ep.protocol,
                "led_count": ep.led_count,
                "label": ep.label,
            }
            for ep in endpoints
        ]

        probe = {
            "ready": bool(endpoints),
            "is_admin": is_admin,
            "transport": self._active_transport,
            "transport_details": self._transport_state(),
            "reason": "" if endpoints else error,
            "controllers": sorted({row["controller"] for row in rows}),
            "endpoint_count": len(rows),
            "endpoints": rows,
        }
        with self._cache_lock:
            self._probe_cache = (now, dict(probe))
        return probe

    def apply_color(self, modules: list[dict[str, Any]], rgb: tuple[int, int, int]) -> dict[str, Any]:
        return self.apply_pixels(modules, [], rgb)

    def apply_pixels(
        self,
        modules: list[dict[str, Any]],
        pixels: list[tuple[int, int, int]],
        fallback: tuple[int, int, int] = (255, 255, 255),
    ) -> dict[str, Any]:
        probe = self.probe(modules, force=False)
        if not probe.get("ready"):
            return {
                "changed": 0,
                "error": str(probe.get("reason") or "Corsair SMBus not ready."),
                "details": probe,
            }

        endpoints: list[_CorsairEndpoint] = []
        for row in probe.get("endpoints", []):
            try:
                base_port = int(str(row.get("base_port", "")).replace("0x", ""), 16)
                address = int(str(row.get("address", "")).replace("0x", ""), 16)
                endpoints.append(
                    _CorsairEndpoint(
                        controller_name=str(row.get("controller") or "SMBus"),
                        base_port=base_port,
                        address=address,
                        protocol=str(row.get("protocol") or ""),
                        led_count=int(row.get("led_count") or 10),
                        label=str(row.get("label") or "Corsair RGB DRAM"),
                    )
                )
            except Exception:
                continue

        if not endpoints:
            return {"changed": 0, "error": "No writable Corsair endpoints found.", "details": probe}

        changed = 0
        errors: list[str] = []
        pixels_index = 0

        self._lock_transport()
        try:
            for endpoint in endpoints:
                endpoint_leds = max(1, int(endpoint.led_count))
                chunk = pixels[pixels_index : pixels_index + endpoint_leds] if pixels else []
                pixels_index += endpoint_leds
                if endpoint.protocol == "dominator_platinum":
                    result = self._write_dominator_pixels(endpoint, chunk, fallback)
                elif endpoint.protocol == "vengeance_pro":
                    result = self._write_vengeance_pro_pixels(endpoint, chunk, fallback)
                else:
                    result = -95

                if result < 0:
                    errors.append(
                        f"{endpoint.label} at {endpoint.controller_name}/{endpoint.address:02X} failed ({result})"
                    )
                else:
                    changed += 1
        finally:
            self._unlock_transport()

        if changed <= 0 and errors:
            return {"changed": 0, "error": "; ".join(errors), "details": probe}

        return {"changed": changed, "error": "; ".join(errors), "details": probe}
