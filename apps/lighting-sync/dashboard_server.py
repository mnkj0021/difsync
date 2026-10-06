import hmac
import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import colorsys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory

from pc_native_backend import NativePcRgbManager

try:
    from openrgb import OpenRGBClient, utils as orgb_utils
    from openrgb.utils import DeviceType, RGBColor
except Exception:
    OpenRGBClient = None
    orgb_utils = None
    DeviceType = None
    RGBColor = None

load_dotenv()

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"
PRESETS_PATH = ROOT / "dashboard_presets.json"
STATE_PATH = ROOT / "difsync_state.json"
WEB_UI_ROOT = ROOT / "clients" / "difsync-react" / "dist"
_STATE_LOCK = threading.Lock()
GOVEE_BASE = "https://developer-api.govee.com/v1"
REQUEST_TIMEOUT = 10

APP_HOST = os.getenv("DASHBOARD_HOST", "0.0.0.0")
APP_PORT = int(os.getenv("DASHBOARD_PORT", "8080"))
APP_TOKEN = os.getenv("DASHBOARD_TOKEN", "").strip()
GOVEE_API_KEY = os.getenv("GOVEE_API_KEY", "").strip()
GOVEE_CONTROL_TIMEOUT = max(2.0, float(os.getenv("GOVEE_CONTROL_TIMEOUT_SECONDS", "6")))
GOVEE_WORKERS = max(1, int(os.getenv("GOVEE_WORKERS", "1")))
GOVEE_SESSION = requests.Session()
_GOVEE_CACHE_LOCK = threading.Lock()
_GOVEE_CACHE_TS = 0.0
_GOVEE_CACHE_DEVICES: list[dict[str, Any]] = []
_GOVEE_STATE_LOCK = threading.Lock()
_GOVEE_LAST_BRIGHTNESS: dict[str, int] = {}
_GOVEE_LAST_COLOR: dict[str, tuple[int, int, int]] = {}
_GOVEE_RATE_LOCK = threading.Lock()
_GOVEE_NEXT_ALLOWED_TS = 0.0

DEFAULT_PRESETS = [
    {
        "name": "Sunset Punch",
        "rgb": [255, 96, 38],
        "brightness": 100,
        "target": "scene",
        "openrgb_device_ids": [],
        "govee_device_ids": [],
    },
    {
        "name": "Arctic Bloom",
        "rgb": [0, 166, 255],
        "brightness": 100,
        "target": "scene",
        "openrgb_device_ids": [],
        "govee_device_ids": [],
    },
    {
        "name": "Lime Voltage",
        "rgb": [130, 255, 20],
        "brightness": 100,
        "target": "scene",
        "openrgb_device_ids": [],
        "govee_device_ids": [],
    },
]


def env_flag(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def clamp(value: Any) -> int:
    return max(0, min(255, int(round(float(value)))))


def clamp_brightness(value: Any) -> int:
    return max(0, min(100, int(round(float(value)))))


def exc_text(exc: Exception) -> str:
    text = str(exc).strip()
    return text if text else exc.__class__.__name__


def load_config() -> dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8-sig") as handle:
        return json.load(handle)

DEFAULT_RUNTIME_STATE: dict[str, Any] = {
    "cloud_enabled": True,
    "theme": "dark",
    "layout": [],
    "layout_direction": "forward",
    "ai_model": "",
}


def load_runtime_state() -> dict[str, Any]:
    with _STATE_LOCK:
        data: dict[str, Any] = {}
        try:
            if STATE_PATH.exists():
                raw = json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
                if isinstance(raw, dict):
                    data = raw
        except Exception:
            data = {}
        return {**DEFAULT_RUNTIME_STATE, **data}


def save_runtime_state(patch: dict[str, Any]) -> dict[str, Any]:
    allowed = {"cloud_enabled", "theme", "layout", "layout_direction", "ai_model"}
    with _STATE_LOCK:
        current: dict[str, Any] = {}
        try:
            if STATE_PATH.exists():
                raw = json.loads(STATE_PATH.read_text(encoding="utf-8-sig"))
                if isinstance(raw, dict):
                    current = raw
        except Exception:
            current = {}
        state = {**DEFAULT_RUNTIME_STATE, **current}
        for key in allowed:
            if key not in patch:
                continue
            value = patch[key]
            if key == "cloud_enabled":
                state[key] = bool(value)
            elif key == "theme":
                state[key] = "light" if str(value).lower() == "light" else "dark"
            elif key == "layout_direction":
                state[key] = "reverse" if str(value).lower() == "reverse" else "forward"
            elif key == "layout":
                state[key] = list(value) if isinstance(value, list) else []
            elif key == "ai_model":
                state[key] = str(value or "").strip()[:120]
        tmp = STATE_PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        tmp.replace(STATE_PATH)
        return state


def is_cloud_enabled() -> bool:
    return bool(load_runtime_state().get("cloud_enabled", True))


def _scene_from_prompt_fallback(prompt: str) -> dict[str, Any]:
    q = str(prompt or "").strip().lower()
    rgb = [82, 168, 255]
    palette = [[82, 168, 255], [135, 92, 255], [255, 79, 165]]
    effect = "wave"
    brightness = 78
    speed_ms = 90

    color_words = [
        (("red", "crimson"), [255, 52, 72]),
        (("orange", "amber"), [255, 142, 46]),
        (("yellow", "gold"), [255, 211, 77]),
        (("green", "lime"), [67, 220, 118]),
        (("cyan", "aqua"), [40, 220, 255]),
        (("blue", "ocean"), [62, 126, 255]),
        (("purple", "violet"), [154, 92, 255]),
        (("pink", "magenta"), [255, 76, 173]),
        (("white", "ice"), [235, 246, 255]),
        (("warm", "sunset"), [255, 106, 55]),
    ]
    for words, value in color_words:
        if any(word in q for word in words):
            rgb = value
            break
    if "rainbow" in q:
        effect = "rainbow"
        palette = [[255, 64, 96], [255, 182, 62], [78, 224, 129], [62, 184, 255], [146, 92, 255]]
    elif "pulse" in q or "breath" in q:
        effect = "pulse"
    elif "chase" in q or "run" in q:
        effect = "chase"
    elif "static" in q or "solid" in q:
        effect = "static"
    if "slow" in q or "calm" in q:
        speed_ms = 180
    if "fast" in q or "energetic" in q:
        speed_ms = 55
    if "dim" in q:
        brightness = 35
    if "bright" in q:
        brightness = 100
    palette = [rgb, palette[1], palette[2]]
    return {
        "name": "AI Scene",
        "rgb": rgb,
        "brightness": brightness,
        "effect": effect,
        "speed_ms": speed_ms,
        "palette": palette,
        "source": "fallback",
        "reason": "Generated locally from prompt keywords.",
    }


def generate_ai_scene(prompt: str) -> dict[str, Any]:
    prompt = str(prompt or "").strip()
    if not prompt:
        raise ValueError("Prompt is required")

    state = load_runtime_state()
    ollama_url = os.getenv("DIFSYNC_SYNC_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    model = str(state.get("ai_model") or os.getenv("DIFSYNC_SYNC_AI_MODEL", "")).strip()

    try:
        try:
            tags = requests.get(f"{ollama_url}/api/tags", timeout=1.5).json()
        except Exception:
            exe = shutil.which("ollama")
            if not exe:
                raise
            subprocess.Popen(
                [exe, "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            tags = None
            for _ in range(6):
                time.sleep(0.4)
                try:
                    tags = requests.get(f"{ollama_url}/api/tags", timeout=1.2).json()
                    break
                except Exception:
                    continue
            if tags is None:
                raise RuntimeError("Ollama did not start")

        models = [str(x.get("name") or "") for x in tags.get("models", []) if isinstance(x, dict)]
        if not model and models:
            preferred = [x for x in models if any(k in x.lower() for k in ("qwen", "llama", "gemma"))]
            candidates = preferred or models
            candidates.sort(key=lambda x: (0 if any(k in x.lower() for k in ("7b","8b","1b","3b")) else 1, len(x)))
            model = candidates[0]
        if not model:
            raise RuntimeError("No local Ollama model available")

        system = (
            "You are DifSync lighting director. Return ONLY compact JSON with keys: "
            "name (string), rgb ([0-255,0-255,0-255]), brightness (0-100), "
            "effect (one of static,wave,pulse,chase,rainbow), speed_ms (45-500), "
            "palette (2-5 RGB arrays), reason (short string). No markdown."
        )
        payload = {
            "model": model,
            "stream": False,
            "prompt": f"{system}\nUser lighting request: {prompt}",
            "options": {"temperature": 0.35},
        }
        result = requests.post(f"{ollama_url}/api/generate", json=payload, timeout=8).json()
        raw = str(result.get("response") or "").strip()
        match = re.search(r"\{.*\}", raw, flags=re.S)
        if not match:
            raise RuntimeError("AI did not return JSON")
        data = json.loads(match.group(0))
        rgb = rgb_from_payload({"rgb": data.get("rgb", [82,168,255])})
        palette_raw = data.get("palette", [])
        palette = []
        if isinstance(palette_raw, list):
            for item in palette_raw[:5]:
                if isinstance(item, (list,tuple)) and len(item) >= 3:
                    palette.append([clamp(item[0]),clamp(item[1]),clamp(item[2])])
        if not palette:
            palette = [[rgb[0],rgb[1],rgb[2]]]
        effect = str(data.get("effect") or "wave").lower()
        if effect not in {"static","wave","pulse","chase","rainbow"}:
            effect = "wave"
        return {
            "name": str(data.get("name") or "AI Scene")[:64],
            "rgb": [rgb[0],rgb[1],rgb[2]],
            "brightness": clamp_brightness(data.get("brightness", 80)),
            "effect": effect,
            "speed_ms": max(45,min(500,int(data.get("speed_ms",90)))),
            "palette": palette,
            "source": "ollama",
            "model": model,
            "reason": str(data.get("reason") or "")[:240],
        }
    except Exception as exc:
        fallback = _scene_from_prompt_fallback(prompt)
        fallback["ai_error"] = exc_text(exc)
        return fallback


def rgb_from_payload(payload: dict[str, Any]) -> tuple[int, int, int]:
    if all(k in payload for k in ("r", "g", "b")):
        return (clamp(payload["r"]), clamp(payload["g"]), clamp(payload["b"]))
    if "rgb" in payload and isinstance(payload["rgb"], (list, tuple)) and len(payload["rgb"]) >= 3:
        return (clamp(payload["rgb"][0]), clamp(payload["rgb"][1]), clamp(payload["rgb"][2]))
    raise ValueError("Body must contain r/g/b or rgb array")


def brightness_from_payload(payload: dict[str, Any], default: int = 100) -> int:
    if "brightness" in payload:
        return clamp_brightness(payload["brightness"])
    if "bri" in payload:
        return clamp_brightness(payload["bri"])
    return clamp_brightness(default)


def apply_brightness(rgb: tuple[int, int, int], brightness: int) -> tuple[int, int, int]:
    scale = clamp_brightness(brightness) / 100.0
    return (
        clamp(rgb[0] * scale),
        clamp(rgb[1] * scale),
        clamp(rgb[2] * scale),
    )


def parse_pixels_payload(payload: dict[str, Any], key: str = "pixels") -> list[tuple[int, int, int]]:
    raw = payload.get(key)
    if not isinstance(raw, list):
        raise ValueError(f"'{key}' must be an array of [r,g,b] values")
    out: list[tuple[int, int, int]] = []
    for item in raw:
        if not isinstance(item, (list, tuple)) or len(item) < 3:
            raise ValueError(f"Each item in '{key}' must be [r,g,b]")
        out.append((clamp(item[0]), clamp(item[1]), clamp(item[2])))
    return out


def normalize_pixels(colors: list[tuple[int, int, int]], led_count: int, fallback: tuple[int, int, int]) -> list[tuple[int, int, int]]:
    count = max(1, int(led_count))
    base = (clamp(fallback[0]), clamp(fallback[1]), clamp(fallback[2]))
    if not colors:
        return [base for _ in range(count)]
    out: list[tuple[int, int, int]] = []
    for idx in range(count):
        src = colors[idx] if idx < len(colors) else colors[-1]
        out.append((clamp(src[0]), clamp(src[1]), clamp(src[2])))
    return out


def normalize_preset(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ValueError("Preset name is required")
    if len(name) > 64:
        raise ValueError("Preset name must be 64 characters or less")

    rgb = rgb_from_payload(payload)
    brightness = brightness_from_payload(payload, default=100)
    target = str(payload.get("target", "scene")).strip().lower()
    if target not in {"scene", "openrgb", "govee"}:
        raise ValueError("Preset target must be one of: scene, openrgb, govee")

    openrgb_device_ids_raw = payload.get("openrgb_device_ids", [])
    if openrgb_device_ids_raw is None:
        openrgb_device_ids_raw = []
    govee_device_ids_raw = payload.get("govee_device_ids", [])
    if govee_device_ids_raw is None:
        govee_device_ids_raw = []

    openrgb_device_ids = sorted({int(x) for x in openrgb_device_ids_raw}) if isinstance(openrgb_device_ids_raw, list) else []
    govee_device_ids = sorted({str(x) for x in govee_device_ids_raw}) if isinstance(govee_device_ids_raw, list) else []

    return {
        "name": name,
        "rgb": [rgb[0], rgb[1], rgb[2]],
        "brightness": brightness,
        "target": target,
        "openrgb_device_ids": openrgb_device_ids,
        "govee_device_ids": govee_device_ids,
    }


def load_presets() -> list[dict[str, Any]]:
    if not PRESETS_PATH.exists():
        save_presets(DEFAULT_PRESETS)
        return [dict(x) for x in DEFAULT_PRESETS]

    try:
        raw = json.loads(PRESETS_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("Presets file must contain a list")
        return [normalize_preset(x if isinstance(x, dict) else {}) for x in raw]
    except Exception:
        save_presets(DEFAULT_PRESETS)
        return [dict(x) for x in DEFAULT_PRESETS]


def save_presets(presets: list[dict[str, Any]]) -> None:
    PRESETS_PATH.write_text(json.dumps(presets, indent=2), encoding="utf-8")


def upsert_preset(preset: dict[str, Any]) -> list[dict[str, Any]]:
    presets = load_presets()
    replaced = False
    for i, item in enumerate(presets):
        if item["name"].lower() == preset["name"].lower():
            presets[i] = preset
            replaced = True
            break
    if not replaced:
        presets.append(preset)
    save_presets(presets)
    return presets


def delete_preset(name: str) -> tuple[list[dict[str, Any]], bool]:
    presets = load_presets()
    kept = [p for p in presets if p["name"].lower() != name.lower()]
    removed = len(kept) != len(presets)
    if removed:
        save_presets(kept)
    return kept, removed


def govee_headers() -> dict[str, str]:
    if not GOVEE_API_KEY:
        raise RuntimeError("Missing GOVEE_API_KEY in .env")
    return {"Govee-API-Key": GOVEE_API_KEY, "Content-Type": "application/json"}


def fetch_govee_inventory(force_refresh: bool = False) -> list[dict[str, Any]]:
    if not GOVEE_API_KEY:
        return []

    ttl = max(5.0, float(os.getenv("GOVEE_INVENTORY_CACHE_SECONDS", "45")))
    now = time.time()

    global _GOVEE_CACHE_TS, _GOVEE_CACHE_DEVICES
    with _GOVEE_CACHE_LOCK:
        if not force_refresh and _GOVEE_CACHE_DEVICES and (now - _GOVEE_CACHE_TS) < ttl:
            return [dict(x) for x in _GOVEE_CACHE_DEVICES]

    response = GOVEE_SESSION.get(f"{GOVEE_BASE}/devices", headers=govee_headers(), timeout=GOVEE_CONTROL_TIMEOUT)
    response.raise_for_status()
    devices = response.json().get("data", {}).get("devices", [])

    with _GOVEE_CACHE_LOCK:
        _GOVEE_CACHE_TS = now
        _GOVEE_CACHE_DEVICES = [dict(x) for x in devices if isinstance(x, dict)]

    return [dict(x) for x in _GOVEE_CACHE_DEVICES]


def list_govee_devices() -> list[dict[str, Any]]:
    cfg_devices = load_config().get("devices", []) or []
    inventory = {d.get("device"): d for d in fetch_govee_inventory(force_refresh=False) if d.get("device")}
    out = []
    for item in cfg_devices:
        device_id = item.get("device")
        model = item.get("model", "")
        if not device_id:
            continue
        inv = inventory.get(device_id, {})
        out.append(
            {
                "device": device_id,
                "model": model or inv.get("model", ""),
                "device_name": inv.get("deviceName", "") or inv.get("sku", ""),
                "retrievable": bool(inv),
            }
        )
    return out


def _apply_target_govee_devices(device_ids: list[str] | None = None) -> list[dict[str, str]]:
    cfg_devices = load_config().get("devices", []) or []
    target: set[str] | None = None
    if device_ids is not None:
        target = {str(x) for x in device_ids}

    # Avoid inventory API calls in hot path unless a model is missing in config.
    needs_inventory = any(not str(item.get("model", "")).strip() for item in cfg_devices)
    inventory: dict[str, dict[str, Any]] = {}
    if needs_inventory:
        inventory = {d.get("device"): d for d in fetch_govee_inventory(force_refresh=False) if d.get("device")}

    out: list[dict[str, str]] = []
    for item in cfg_devices:
        device_id = str(item.get("device", "")).strip()
        if not device_id:
            continue
        if target is not None and device_id not in target:
            continue

        model = str(item.get("model", "")).strip()
        if not model and inventory:
            model = str(inventory.get(device_id, {}).get("model", "")).strip()

        if not model:
            out.append({"device": device_id, "model": "", "error": "Missing model"})
            continue

        out.append({"device": device_id, "model": model})
    return out


def apply_govee_color(
    rgb: tuple[int, int, int], brightness: int | None = None, device_ids: list[str] | None = None
) -> list[dict[str, Any]]:
    targets = _apply_target_govee_devices(device_ids)
    if not targets:
        return []

    report: list[dict[str, Any]] = []

    if len(targets) == 1 or GOVEE_WORKERS == 1:
        for dev in targets:
            if dev.get("error"):
                report.append({"device": dev["device"], "ok": False, "message": dev["error"]})
                continue
            success, message = set_govee_color(dev["device"], dev["model"], rgb, brightness=brightness)
            report.append({"device": dev["device"], "ok": success, "message": message})
        return report

    with ThreadPoolExecutor(max_workers=min(GOVEE_WORKERS, len(targets))) as executor:
        futures = {}
        for dev in targets:
            if dev.get("error"):
                report.append({"device": dev["device"], "ok": False, "message": dev["error"]})
                continue
            futures[executor.submit(set_govee_color, dev["device"], dev["model"], rgb, brightness)] = dev

        for future in as_completed(futures):
            dev = futures[future]
            try:
                success, message = future.result()
                report.append({"device": dev["device"], "ok": success, "message": message})
            except Exception as exc:
                report.append({"device": dev["device"], "ok": False, "message": exc_text(exc)})

    return report


def _set_govee_cmd(device_id: str, model: str, name: str, value: Any) -> tuple[bool, str]:
    payload = {
        "device": device_id,
        "model": model,
        "cmd": {"name": name, "value": value},
    }
    response = GOVEE_SESSION.put(
        f"{GOVEE_BASE}/devices/control", headers=govee_headers(), json=payload, timeout=GOVEE_CONTROL_TIMEOUT
    )
    if response.status_code == 200:
        return True, "ok"
    return False, f"{response.status_code}: {response.text[:180]}"


def _extract_retry_seconds(message: str) -> float:
    m = re.search(r"retry in\s+([0-9]+(?:\.[0-9]+)?)\s*seconds?", str(message or ""), flags=re.IGNORECASE)
    if not m:
        return 0.0
    try:
        return max(0.0, float(m.group(1)))
    except Exception:
        return 0.0


def _govee_rate_wait() -> None:
    while True:
        with _GOVEE_RATE_LOCK:
            wait_s = _GOVEE_NEXT_ALLOWED_TS - time.time()
        if wait_s <= 0:
            return
        time.sleep(min(wait_s, 0.5))


def _govee_rate_push(seconds: float) -> None:
    if seconds <= 0:
        return
    with _GOVEE_RATE_LOCK:
        global _GOVEE_NEXT_ALLOWED_TS
        _GOVEE_NEXT_ALLOWED_TS = max(_GOVEE_NEXT_ALLOWED_TS, time.time() + seconds)


def _set_govee_cmd_with_retry(device_id: str, model: str, name: str, value: Any, retries: int = 3) -> tuple[bool, str]:
    last_msg = ""
    attempts = max(1, min(8, int(retries)))
    base_backoff = max(0.05, float(os.getenv("GOVEE_RATE_LIMIT_BACKOFF_SECONDS", "0.12")))
    for attempt in range(attempts):
        _govee_rate_wait()
        ok, msg = _set_govee_cmd(device_id, model, name, value)
        if ok:
            return True, msg
        last_msg = msg
        if "429" not in str(msg):
            continue
        retry_s = _extract_retry_seconds(msg)
        if retry_s <= 0:
            retry_s = base_backoff * (attempt + 1)
        # Add a tiny safety margin so parallel calls do not re-hit the same bucket edge.
        _govee_rate_push(retry_s + 0.08)
    return False, last_msg


def set_govee_color(
    device_id: str, model: str, rgb: tuple[int, int, int], brightness: int | None = None
) -> tuple[bool, str]:
    b = clamp_brightness(100 if brightness is None else brightness)
    cmd_retries = max(1, min(8, int(os.getenv("GOVEE_CMD_RETRIES", "4"))))
    rgb_tuple = (int(rgb[0]), int(rgb[1]), int(rgb[2]))
    with _GOVEE_STATE_LOCK:
        prev_color = _GOVEE_LAST_COLOR.get(device_id)
        prev_brightness = _GOVEE_LAST_BRIGHTNESS.get(device_id)

    skip_redundant_color = env_flag("GOVEE_SKIP_REDUNDANT_COLOR", True)
    color_unchanged = prev_color == rgb_tuple
    if not (skip_redundant_color and color_unchanged):
        ok_color, msg_color = _set_govee_cmd_with_retry(
            device_id,
            model,
            "color",
            {"r": rgb_tuple[0], "g": rgb_tuple[1], "b": rgb_tuple[2]},
            retries=cmd_retries,
        )
        if not ok_color:
            return False, msg_color
        with _GOVEE_STATE_LOCK:
            _GOVEE_LAST_COLOR[device_id] = rgb_tuple
    elif brightness is None:
        return True, "ok (color unchanged)"

    if brightness is None:
        return True, "ok"

    if b <= 0:
        ok_off, msg_off = _set_govee_cmd_with_retry(device_id, model, "turn", "off", retries=cmd_retries)
        return (ok_off, "ok (brightness 0%; turned off)") if ok_off else (False, f"brightness 0% off failed: {msg_off}")

    target_brightness = max(1, b)
    use_brightness_cmd = env_flag("GOVEE_ENABLE_BRIGHTNESS_CMD", True)
    if not use_brightness_cmd:
        if target_brightness == 100:
            return True, "ok (brightness command disabled; color applied)"
        return False, "hardware brightness disabled by GOVEE_ENABLE_BRIGHTNESS_CMD"

    retries = max(1, min(5, int(os.getenv("GOVEE_BRIGHTNESS_RETRIES", "3"))))
    retry_delay = max(0.0, float(os.getenv("GOVEE_BRIGHTNESS_RETRY_DELAY_SECONDS", "0.08")))
    last_msg = ""
    skip_redundant_brightness = env_flag("GOVEE_SKIP_REDUNDANT_BRIGHTNESS", True)
    if skip_redundant_brightness and prev_brightness == target_brightness:
        return True, f"ok (brightness {target_brightness}% unchanged)"

    if env_flag("GOVEE_TURN_ON_BEFORE_BRIGHTNESS", False):
        _set_govee_cmd_with_retry(device_id, model, "turn", "on", retries=cmd_retries)
    for attempt in range(retries):
        ok_bri, msg_bri = _set_govee_cmd_with_retry(
            device_id,
            model,
            "brightness",
            target_brightness,
            retries=cmd_retries,
        )
        if ok_bri:
            with _GOVEE_STATE_LOCK:
                _GOVEE_LAST_BRIGHTNESS[device_id] = target_brightness
            return True, f"ok (brightness {target_brightness}%)"
        last_msg = msg_bri
        if attempt + 1 < retries and retry_delay > 0:
            time.sleep(retry_delay)

    allow_scaled_fallback = env_flag("GOVEE_ALLOW_COLOR_SCALE_FALLBACK", False)
    if allow_scaled_fallback:
        scaled_rgb = apply_brightness(rgb, target_brightness)
        ok_scaled, msg_scaled = _set_govee_cmd(
            device_id,
            model,
            "color",
            {"r": scaled_rgb[0], "g": scaled_rgb[1], "b": scaled_rgb[2]},
        )
        if ok_scaled:
            return True, f"fallback color-scaled {target_brightness}% (brightness cmd failed: {last_msg})"
        return False, f"brightness failed: {last_msg}; fallback color failed: {msg_scaled}"

    return False, f"brightness command failed after {retries} tries: {last_msg}"


def extract_device_colors(device: Any) -> list[tuple[int, int, int]]:
    out: list[tuple[int, int, int]] = []
    for color in getattr(device, "colors", []) or []:
        try:
            out.append((int(color.red), int(color.green), int(color.blue)))
        except Exception:
            continue
    if out:
        return out

    for zone in getattr(device, "zones", []) or []:
        for led in getattr(zone, "leds", []) or []:
            color = getattr(led, "color", None)
            if color is None:
                continue
            try:
                out.append((int(color.red), int(color.green), int(color.blue)))
            except Exception:
                continue
    return out


def avg_rgb(colors: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    if not colors:
        return (0, 0, 0)
    return (
        clamp(sum(c[0] for c in colors) / len(colors)),
        clamp(sum(c[1] for c in colors) / len(colors)),
        clamp(sum(c[2] for c in colors) / len(colors)),
    )


class OpenRGBManager:
    _spawn_lock = threading.Lock()

    def __init__(self) -> None:
        self._client: OpenRGBClient | None = None
        self._last_error = ""
        self._spawned_process: subprocess.Popen | None = None

    def _start_openrgb_server(self, host: str, port: int, cfg: dict[str, Any]) -> bool:
        exe = os.getenv("OPENRGB_EXECUTABLE", "").strip() or cfg.get("openrgb_executable", "")
        if not exe:
            return False
        if not Path(exe).exists():
            self._last_error = f"OPENRGB executable not found: {exe}"
            return False
        try:
            self._spawned_process = subprocess.Popen(
                [
                    exe,
                    "--server",
                    "--server-host",
                    str(host),
                    "--server-port",
                    str(port),
                    "--startminimized",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return True
        except Exception as exc:
            self._last_error = f"Failed to start OpenRGB server: {exc}"
            return False

    def _connect(self) -> OpenRGBClient:
        if OpenRGBClient is None:
            raise RuntimeError("openrgb-python package is not installed")

        cfg = load_config()
        host = cfg.get("openrgb_host", "127.0.0.1")
        port = int(cfg.get("openrgb_port", 6742))
        autostart = env_flag("OPENRGB_AUTOSTART", bool(cfg.get("openrgb_autostart", False)))

        def connect_once() -> OpenRGBClient:
            client = OpenRGBClient(
                address=host,
                port=port,
                name="DifSyncDashboard",
                protocol_version=0,
            )
            self._client = client
            self._last_error = ""
            return client

        try:
            return connect_once()
        except Exception as first_exc:
            if not autostart:
                self._last_error = str(first_exc)
                raise

            # Multiple API requests can arrive while the helper is cold.
            # Serialize the re-check/start/wait sequence so only one OpenRGB
            # server can be launched for the machine.
            with self._spawn_lock:
                try:
                    return connect_once()
                except Exception:
                    pass

                started = self._start_openrgb_server(host, port, cfg)
                if not started:
                    raise

                deadline = time.time() + max(
                    8.0,
                    float(os.getenv("OPENRGB_STARTUP_TIMEOUT_SECONDS", "20")),
                )
                while time.time() < deadline:
                    try:
                        return connect_once()
                    except Exception:
                        time.sleep(0.6)

            self._last_error = "OpenRGB server autostart timed out"
            raise RuntimeError(self._last_error) from first_exc

    def _drop_client(self) -> None:
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
        self._client = None

    def _get_client(self) -> OpenRGBClient:
        if self._client is None:
            return self._connect()
        return self._client

    def _run(self, operation):
        last_exc: Exception | None = None
        for _ in range(2):
            try:
                client = self._get_client()
                return operation(client)
            except Exception as exc:
                last_exc = exc
                self._last_error = exc_text(exc)
                self._drop_client()
        raise RuntimeError(self._last_error or "OpenRGB operation failed") from last_exc

    def _run_fresh(self, operation):
        last_exc: Exception | None = None
        for _ in range(2):
            client: OpenRGBClient | None = None
            try:
                client = self._connect()
                return operation(client)
            except Exception as exc:
                last_exc = exc
                self._last_error = exc_text(exc)
            finally:
                if client is not None:
                    try:
                        client.disconnect()
                    except Exception:
                        pass
                self._client = None
        raise RuntimeError(self._last_error or "OpenRGB operation failed") from last_exc

    @staticmethod
    def _pick_writable_mode_index(device: Any) -> int | None:
        if orgb_utils is None:
            return None

        modes = getattr(device, "modes", []) or []
        preferred = {"direct", "static", "custom", "solid"}

        for i, mode in enumerate(modes):
            name = (getattr(mode, "name", "") or "").strip().lower()
            color_mode = getattr(mode, "color_mode", None)
            if name in preferred and color_mode in (orgb_utils.ModeColors.PER_LED, orgb_utils.ModeColors.MODE_SPECIFIC):
                return i

        for i, mode in enumerate(modes):
            color_mode = getattr(mode, "color_mode", None)
            if color_mode in (orgb_utils.ModeColors.PER_LED, orgb_utils.ModeColors.MODE_SPECIFIC):
                return i

        return None

    def status(self) -> dict[str, Any]:
        try:
            def op(client: OpenRGBClient) -> int:
                client.update()
                return len(client.devices)

            count = self._run_fresh(op)
            return {"connected": True, "error": "", "device_count": count}
        except Exception as exc:
            self._last_error = exc_text(exc)
            return {"connected": False, "error": self._last_error, "device_count": 0}

    def list_devices(self) -> list[dict[str, Any]]:
        def op(client: OpenRGBClient) -> list[dict[str, Any]]:
            client.update()
            rows = []
            for dev in client.devices:
                dev_type = getattr(dev, "type", None)
                try:
                    type_name = DeviceType(dev_type).name
                except Exception:
                    type_name = str(dev_type)
                colors = extract_device_colors(dev)
                rows.append(
                    {
                        "id": getattr(dev, "id", None),
                        "name": getattr(dev, "name", "Device"),
                        "type": type_name,
                        "led_count": len(getattr(dev, "colors", []) or []),
                        "active_mode": getattr(dev, "active_mode", None),
                        "avg_rgb": avg_rgb(colors),
                    }
                )
            return rows

        return self._run_fresh(op)

    def _apply_color_to_device_once(self, device_id: int, rgb: tuple[int, int, int], force_mode: bool) -> None:
        if RGBColor is None:
            raise RuntimeError("openrgb-python package is not installed")

        def op(client: OpenRGBClient) -> None:
            client.update()
            dev = next((d for d in client.devices if int(getattr(d, "id", -1)) == int(device_id)), None)
            if dev is None:
                raise RuntimeError(f"Device {device_id} not found")

            mode_index = self._pick_writable_mode_index(dev)
            if mode_index is None:
                raise RuntimeError("Device has no writable color mode")

            # These bridge devices are already kept in Direct mode. Re-sending
            # the mode packet to the MSI 3090 Ti can make OpenRGB reset the
            # client socket, so only change mode when it is genuinely different.
            if getattr(dev, "active_mode", None) != mode_index:
                dev.set_mode(mode_index, save=False)
                time.sleep(0.04)

            color = RGBColor(rgb[0], rgb[1], rgb[2])

            # Fast here means "send without immediately asking the server to
            # re-enumerate the device".  Re-enumeration after a SteelSeries HID
            # write resets the SDK socket on this machine even though the write
            # itself succeeds.
            dev.set_color(color, fast=True)
            time.sleep(0.03)

        self._run_fresh(op)

    def _read_device_avg_rgb(self, device_id: int) -> tuple[int, int, int] | None:
        def op(client: OpenRGBClient) -> tuple[int, int, int] | None:
            client.update()
            dev = next((d for d in client.devices if d.id == device_id), None)
            if dev is None:
                return None
            return avg_rgb(extract_device_colors(dev))

        return self._run_fresh(op)

    def _read_device_colors(self, device_id: int) -> list[tuple[int, int, int]]:
        def op(client: OpenRGBClient) -> list[tuple[int, int, int]]:
            client.update()
            dev = next((d for d in client.devices if int(getattr(d, "id", -1)) == int(device_id)), None)
            if dev is None:
                return []
            return [
                (int(c.red), int(c.green), int(c.blue))
                for c in (getattr(dev, "colors", []) or [])
            ]

        return self._run_fresh(op)

    def set_color(self, rgb: tuple[int, int, int], device_ids: list[int] | None = None) -> dict[str, Any]:
        def inventory(client: OpenRGBClient) -> list[dict[str, Any]]:
            client.update()
            rows: list[dict[str, Any]] = []
            for d in client.devices:
                dev_type = getattr(d, "type", None)
                try:
                    type_name = DeviceType(dev_type).name
                except Exception:
                    type_name = str(dev_type)
                rows.append({
                    "id": int(d.id),
                    "name": str(getattr(d, "name", "Device")),
                    "type": type_name,
                })
            return rows

        devices = self._run_fresh(inventory)
        target: set[int] | None = None
        if device_ids is not None:
            target = {int(x) for x in device_ids}
        force_mode = env_flag("OPENRGB_FORCE_COLOR_MODE", False)
        verify_write = env_flag("OPENRGB_VERIFY_WRITE", True)
        verify_tolerance = int(os.getenv("OPENRGB_VERIFY_TOLERANCE", "12"))

        changed = 0
        skipped: list[dict[str, Any]] = []
        for item in devices:
            dev_id = int(item["id"])
            if target is not None and dev_id not in target:
                continue

            name = str(item.get("name") or "")
            dev_type = str(item.get("type") or "").upper()
            try:
                self._apply_color_to_device_once(dev_id, rgb, force_mode)

                if verify_write:
                    # Aerox firmware does not expose current LED colors, so a
                    # fresh inventory always reports black even after a valid
                    # write.  Successful SDK/HID send is the verification there.
                    if "aerox 3 wireless" in name.lower():
                        pass
                    elif dev_type == "GPU" and "msi" in name.lower():
                        # MSI static mode physically uses RGB register 1. The
                        # other two exposed colors belong to effect modes and
                        # are not updated by a static/direct write.
                        colors = self._read_device_colors(dev_id)
                        if not colors:
                            raise RuntimeError("GPU color readback unavailable")
                        observed = colors[0]
                        delta = max(
                            abs(observed[0] - rgb[0]),
                            abs(observed[1] - rgb[1]),
                            abs(observed[2] - rgb[2]),
                        )
                        if delta > verify_tolerance:
                            raise RuntimeError(f"GPU write not reflected (observed {observed})")
                    else:
                        observed = self._read_device_avg_rgb(dev_id)
                        if observed is None:
                            raise RuntimeError("Device not found after write")
                        delta = max(
                            abs(observed[0] - rgb[0]),
                            abs(observed[1] - rgb[1]),
                            abs(observed[2] - rgb[2]),
                        )
                        if delta > verify_tolerance:
                            raise RuntimeError(f"Write not reflected by OpenRGB (observed {observed})")

                changed += 1
            except Exception as exc:
                skipped.append({"id": dev_id, "name": item["name"], "error": exc_text(exc)})

        return {"changed": changed, "skipped": skipped}


    @staticmethod
    def _build_layout_from_device(dev: Any) -> dict[str, Any]:
        segments: list[dict[str, Any]] = []
        cursor = 0
        zones = getattr(dev, "zones", []) or []
        for idx, zone in enumerate(zones):
            leds = len(getattr(zone, "leds", []) or [])
            if leds <= 0:
                continue
            label = str(getattr(zone, "name", "") or f"Zone {idx + 1}")
            segments.append({"id": idx, "label": label, "start": cursor, "count": leds})
            cursor += leds

        if cursor <= 0:
            leds = len(getattr(dev, "colors", []) or [])
            if leds <= 0:
                leds = 1
            segments = [{"id": 0, "label": "Full Device", "start": 0, "count": leds}]
            cursor = leds

        existing = extract_device_colors(dev)
        pixels = normalize_pixels(existing, cursor, (255, 255, 255))
        return {
            "device_id": int(getattr(dev, "id", 0)),
            "name": str(getattr(dev, "name", "Device")),
            "driver": "openrgb",
            "type": str(getattr(dev, "type", "")),
            "led_count": cursor,
            "segments": segments,
            "pixels": [list(x) for x in pixels],
            "backend": "openrgb",
        }

    def get_device_layout(self, device_id: int) -> dict[str, Any]:
        def op(client: OpenRGBClient) -> dict[str, Any]:
            client.update()
            dev = next((d for d in client.devices if int(getattr(d, "id", -1)) == int(device_id)), None)
            if dev is None:
                raise RuntimeError(f"Device {device_id} not found")
            return self._build_layout_from_device(dev)

        return self._run_fresh(op)

    def set_device_pixels(
        self, device_id: int, pixels: list[tuple[int, int, int]], fallback: tuple[int, int, int] = (255, 255, 255)
    ) -> dict[str, Any]:
        if RGBColor is None:
            raise RuntimeError("openrgb-python package is not installed")

        def op(client: OpenRGBClient) -> dict[str, Any]:
            client.update()
            dev = next((d for d in client.devices if int(getattr(d, "id", -1)) == int(device_id)), None)
            if dev is None:
                raise RuntimeError(f"Device {device_id} not found")

            layout = self._build_layout_from_device(dev)
            led_count = int(layout.get("led_count") or 1)
            normalized = normalize_pixels(pixels, led_count, fallback)
            rgb_colors = [RGBColor(c[0], c[1], c[2]) for c in normalized]

            mode_index = self._pick_writable_mode_index(dev)
            if mode_index is not None and getattr(dev, "active_mode", None) != mode_index:
                dev.set_mode(mode_index, save=False)
                time.sleep(0.04)

            try:
                if hasattr(dev, "set_colors"):
                    dev.set_colors(rgb_colors, fast=True)
                else:
                    cursor = 0
                    zones = getattr(dev, "zones", []) or []
                    for zone in zones:
                        zcount = len(getattr(zone, "leds", []) or [])
                        if zcount <= 0:
                            continue
                        zcolors = rgb_colors[cursor : cursor + zcount]
                        cursor += zcount
                        if not zcolors:
                            continue
                        if hasattr(zone, "set_colors"):
                            zone.set_colors(zcolors, fast=True)
                        elif hasattr(zone, "set_color"):
                            zone.set_color(zcolors[0], fast=True)
                    if hasattr(dev, "show"):
                        dev.show()
            except Exception:
                avg = avg_rgb(normalized)
                dev.set_color(RGBColor(avg[0], avg[1], avg[2]), fast=True)

            return {"changed": 1, "skipped": [], "device_id": int(device_id), "led_count": led_count, "backend": "openrgb"}

        return self._run_fresh(op)



class HybridPcRgbManager:
    """Native DifSync control with OpenRGB only for devices that need it."""

    OPENRGB_ID_BASE = 1_600_000_000
    BRIDGE_NATIVE_DRIVERS: set[str] = set()

    def __init__(self) -> None:
        self.native = NativePcRgbManager()
        self.bridge = OpenRGBManager()
        self._bridge_cache: tuple[float, list[dict[str, Any]]] = (0.0, [])
        self._bridge_scan_seconds = max(2.0, float(os.getenv("PC_RGB_GPU_SCAN_SECONDS", "30")))
        self._gpu_write_lock = threading.Lock()

    @property
    def backend_name(self) -> str:
        return "hybrid"

    def prime(self) -> None:
        self.native.prime()

    @classmethod
    def _public_bridge_id(cls, raw_id: int) -> int:
        return cls.OPENRGB_ID_BASE + int(raw_id)

    @classmethod
    def _raw_bridge_id(cls, public_id: int) -> int:
        return int(public_id) - cls.OPENRGB_ID_BASE

    @classmethod
    def _is_bridge_public_id(cls, device_id: int) -> bool:
        return int(device_id) >= cls.OPENRGB_ID_BASE

    @staticmethod
    def _bridge_candidate(row: dict[str, Any]) -> bool:
        dev_type = str(row.get("type") or "").strip().upper()
        name = str(row.get("name") or "").strip().lower()
        return dev_type == "GPU"

    def _native_devices(self) -> list[dict[str, Any]]:
        return [
            row
            for row in self.native.list_devices()
            if str(row.get("driver") or "") not in self.BRIDGE_NATIVE_DRIVERS
        ]

    def _bridge_devices(self, force: bool = False) -> list[dict[str, Any]]:
        now = time.time()
        cached_at, cached_rows = self._bridge_cache
        if not force and cached_rows and (now - cached_at) < self._bridge_scan_seconds:
            return [dict(x) for x in cached_rows]

        rows = self.bridge.list_devices()
        out: list[dict[str, Any]] = []
        for row in rows:
            if not self._bridge_candidate(row):
                continue
            item = dict(row)
            raw_id = int(item.get("id") or 0)
            item["openrgb_id"] = raw_id
            item["id"] = self._public_bridge_id(raw_id)
            dev_type = str(item.get("type") or "").strip().upper()
            item["driver"] = "openrgb_gpu_bridge" if dev_type == "GPU" else "openrgb_aerox_bridge"
            item["backend"] = self.backend_name
            item["write_supported"] = True
            item["per_led_supported"] = str(item.get("type") or "").strip().upper() != "GPU"
            item["note"] = "Headless OpenRGB transport"
            out.append(item)

        self._bridge_cache = (now, [dict(x) for x in out])
        return out

    def status(self) -> dict[str, Any]:
        native_status = self.native.status()
        native_rows: list[dict[str, Any]] = []
        try:
            native_rows = self._native_devices()
        except Exception:
            pass

        bridge_error = ""
        bridge_rows: list[dict[str, Any]] = []
        try:
            bridge_rows = self._bridge_devices(force=False)
        except Exception as exc:
            bridge_error = exc_text(exc)

        total = len(native_rows) + len(bridge_rows)
        return {
            "connected": bool(native_status.get("connected")) or bool(bridge_rows),
            "error": bridge_error if total == 0 and not native_status.get("connected") else "",
            "device_count": total,
            "backend": self.backend_name,
            "native": {**native_status, "device_count": len(native_rows)},
            "openrgb_bridge": {
                "connected": bool(bridge_rows),
                "device_count": len(bridge_rows),
                "error": bridge_error,
            },
        }

    def diagnostics(self) -> dict[str, Any]:
        native_diag = self.native.diagnostics() if hasattr(self.native, "diagnostics") else {}
        try:
            rows = self._bridge_devices(force=True)
            bridge_diag = {"connected": True, "devices": rows, "error": ""}
        except Exception as exc:
            bridge_diag = {"connected": False, "devices": [], "error": exc_text(exc)}
        return {"backend": self.backend_name, "native": native_diag, "openrgb_bridge": bridge_diag}

    def list_devices(self) -> list[dict[str, Any]]:
        native_rows = self._native_devices()
        try:
            bridge_rows = self._bridge_devices(force=False)
        except Exception:
            bridge_rows = []
        return native_rows + bridge_rows

    def _openrgb_cli_executable(self) -> str:
        raw = str(os.getenv("OPENRGB_EXECUTABLE", "") or "").strip()
        if not raw:
            raise RuntimeError("OPENRGB_EXECUTABLE is not configured")
        path = Path(raw)
        if not path.is_absolute():
            path = (ROOT / path).resolve()
        if not path.exists():
            raise RuntimeError(f"OpenRGB executable not found: {path}")
        return str(path)

    def _set_gpu_cli_color(self, name: str, rgb: tuple[int, int, int]) -> None:
        exe = self._openrgb_cli_executable()
        color_hex = f"{int(rgb[0]):02X}{int(rgb[1]):02X}{int(rgb[2]):02X}"
        attempts = max(2, min(5, int(os.getenv("DIFSYNC_SYNC_GPU_WRITE_RETRIES", "3"))))
        tolerance = int(os.getenv("OPENRGB_VERIFY_TOLERANCE", "12"))
        last_error = "GPU write failed"

        with self._gpu_write_lock:
            for attempt in range(attempts):
                completed = subprocess.run(
                    [exe, "--device", str(name), "--mode", "Direct", "--color", color_hex],
                    cwd=str(ROOT),
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=max(4.0, float(os.getenv("OPENRGB_CLI_TIMEOUT_SECONDS", "12"))),
                    check=False,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                if completed.returncode != 0:
                    last_error = (completed.stderr or "").strip() or f"OpenRGB CLI exited {completed.returncode}"
                else:
                    time.sleep(0.12 + (attempt * 0.05))
                    try:
                        rows = self._bridge_devices(force=True)
                        gpu = next((x for x in rows if str(x.get("name")) == str(name)), None)
                        if gpu is not None:
                            colors = self.bridge._read_device_colors(int(gpu["openrgb_id"]))
                            if colors:
                                observed = colors[0]
                                delta = max(abs(observed[0]-rgb[0]),abs(observed[1]-rgb[1]),abs(observed[2]-rgb[2]))
                                if delta <= tolerance:
                                    return
                                last_error = f"GPU verification mismatch: requested {rgb}, observed {observed}"
                            else:
                                return
                        else:
                            return
                    except Exception as exc:
                        last_error = exc_text(exc)
                time.sleep(0.12)
        raise RuntimeError(last_error)


    def set_color(self, rgb: tuple[int, int, int], device_ids: list[int] | None = None) -> dict[str, Any]:
        requested = None if device_ids is None else {int(x) for x in device_ids}

        native_rows = self._native_devices()
        native_available = {int(x["id"]) for x in native_rows}
        if requested is None:
            native_ids = sorted(native_available)
        else:
            native_ids = sorted(x for x in requested if x in native_available)

        native_result = (
            self.native.set_color(rgb, device_ids=native_ids)
            if native_ids
            else {"changed": 0, "skipped": []}
        )

        bridge_changed = 0
        bridge_skipped: list[dict[str, Any]] = []
        try:
            bridge_rows = self._bridge_devices(force=False)
            selected = [
                row
                for row in bridge_rows
                if requested is None or int(row["id"]) in requested
            ]

            # MSI GPU: use OpenRGB's native CLI command path.  The Python SDK
            # UPDATELEDS path is unreliable for this controller on Windows,
            # while the CLI path correctly commits all three MSI registers.
            for row in selected:
                if str(row.get("type") or "").strip().upper() != "GPU":
                    continue
                try:
                    self._set_gpu_cli_color(str(row.get("name") or "GPU"), rgb)
                    bridge_changed += 1
                except Exception as exc:
                    bridge_skipped.append({
                        "id": int(row["id"]),
                        "name": str(row.get("name") or "GPU"),
                        "error": exc_text(exc),
                    })

            # Aerox and any future non-GPU bridge devices use the persistent
            # SDK connection.  Their controllers do not expose reliable color
            # readback, so successful transmission is the success criterion.
            raw_targets = [
                int(row["openrgb_id"])
                for row in selected
                if str(row.get("type") or "").strip().upper() != "GPU"
            ]
            if raw_targets:
                result = self.bridge.set_color(rgb, device_ids=raw_targets)
                bridge_changed += int(result.get("changed", 0))
                public_by_raw = {int(x["openrgb_id"]): int(x["id"]) for x in bridge_rows}
                for item in result.get("skipped", []) or []:
                    row = dict(item)
                    raw_id = int(row.get("id") or 0)
                    row["id"] = public_by_raw.get(raw_id, self._public_bridge_id(raw_id))
                    bridge_skipped.append(row)

        except Exception as exc:
            if requested is None or any(self._is_bridge_public_id(x) for x in requested):
                bridge_skipped.append({"name": "OpenRGB bridge", "error": exc_text(exc)})

        return {
            "changed": int(native_result.get("changed", 0)) + bridge_changed,
            "skipped": list(native_result.get("skipped", []) or []) + bridge_skipped,
            "backend": self.backend_name,
        }


    def get_device_layout(self, device_id: int) -> dict[str, Any]:
        device_id = int(device_id)
        if not self._is_bridge_public_id(device_id):
            return self.native.get_device_layout(device_id)

        raw_id = self._raw_bridge_id(device_id)
        layout = dict(self.bridge.get_device_layout(raw_id))
        layout["openrgb_id"] = raw_id
        layout["device_id"] = device_id
        name = str(layout.get("name") or "").lower()
        layout["driver"] = "openrgb_aerox_bridge" if "aerox 3 wireless" in name else "openrgb_gpu_bridge"
        layout["backend"] = self.backend_name
        return layout

    def set_device_pixels(
        self,
        device_id: int,
        pixels: list[tuple[int, int, int]],
        fallback: tuple[int, int, int] = (255, 255, 255),
    ) -> dict[str, Any]:
        device_id = int(device_id)
        if not self._is_bridge_public_id(device_id):
            return self.native.set_device_pixels(device_id, pixels, fallback=fallback)

        raw_id = self._raw_bridge_id(device_id)
        result = dict(self.bridge.set_device_pixels(raw_id, pixels, fallback=fallback))
        result["device_id"] = device_id
        result["backend"] = self.backend_name
        return result

    def set_device_pixels_realtime(
        self,
        device_id: int,
        pixels: list[tuple[int, int, int]],
        fallback: tuple[int, int, int] = (255, 255, 255),
        led_count_hint: int | None = None,
    ) -> dict[str, Any]:
        device_id = int(device_id)
        if not self._is_bridge_public_id(device_id) and hasattr(self.native, "set_device_pixels_realtime"):
            return self.native.set_device_pixels_realtime(
                device_id, pixels, fallback=fallback, led_count_hint=led_count_hint
            )
        return self.set_device_pixels(device_id, pixels, fallback=fallback)


def build_pc_rgb_manager() -> tuple[Any, str]:
    mode = os.getenv("PC_RGB_BACKEND", "auto").strip().lower()
    if mode not in {"native", "openrgb", "hybrid", "auto"}:
        mode = "auto"

    def _prime_native(manager: Any) -> None:
        prime = os.getenv("PC_RGB_PRIME_ON_START", "true").strip().lower() in {"1", "true", "yes", "on"}
        if not prime:
            return
        try:
            manager.prime()
        except Exception:
            pass

    if mode == "native":
        manager = NativePcRgbManager()
        _prime_native(manager)
        return manager, "native"

    if mode == "openrgb":
        return OpenRGBManager(), "openrgb"

    if mode == "hybrid":
        manager = HybridPcRgbManager()
        _prime_native(manager)
        return manager, "hybrid"

    native = NativePcRgbManager()
    native_status = native.status()
    if native_status.get("connected") and int(native_status.get("device_count", 0)) > 0:
        helper = str(os.getenv("OPENRGB_EXECUTABLE", "") or "").strip()
        if helper and Path(helper).exists():
            manager = HybridPcRgbManager()
            _prime_native(manager)
            return manager, "hybrid"
        _prime_native(native)
        return native, "native"
    return OpenRGBManager(), "openrgb"


class PixelAnimator:
    """Phase-locked multi-device renderer.

    Every device samples one shared monotonic timeline. Fast devices render at
    the requested master interval, while slower protocols render at their own
    safe cadence without changing animation phase.
    """

    DRIVER_MIN_INTERVALS = {
        "asus_aura_mainboard": 0.190,
        "corsair_ram_smbus_custom": 0.190,
        "steelseries_aerox_wireless": 0.650,
        "steelseries_apex": 0.045,
        "nzxt_hue2": 0.045,
    }

    def __init__(self, manager: Any) -> None:
        self._manager = manager
        self._lock = threading.Lock()
        self._group: dict[str, Any] | None = None
        self._layout_cache: dict[int, dict[str, Any]] = {}

    @staticmethod
    def _mix(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
        q = max(0.0, min(1.0, float(t)))
        # Smoothstep removes visible hard corners between palette colors.
        q = q * q * (3.0 - (2.0 * q))
        return (
            clamp(a[0] + ((b[0] - a[0]) * q)),
            clamp(a[1] + ((b[1] - a[1]) * q)),
            clamp(a[2] + ((b[2] - a[2]) * q)),
        )

    @classmethod
    def _palette_at(cls, palette: list[tuple[int, int, int]], t: float) -> tuple[int, int, int]:
        p = palette or [(255, 255, 255)]
        if len(p) == 1:
            return p[0]
        v = (float(t) % 1.0) * len(p)
        idx = int(math.floor(v)) % len(p)
        frac = v - math.floor(v)
        return cls._mix(p[idx], p[(idx + 1) % len(p)], frac)

    @staticmethod
    def _scale(color: tuple[int, int, int], amount: float) -> tuple[int, int, int]:
        q = max(0.0, min(1.0, float(amount)))
        return (clamp(color[0] * q), clamp(color[1] * q), clamp(color[2] * q))

    @staticmethod
    def _triangle(t: float) -> float:
        q = float(t) % 2.0
        return q if q <= 1.0 else 2.0 - q

    @classmethod
    def _frame_at(
        cls,
        effect: str,
        positions: list[float],
        elapsed: float,
        palette: list[tuple[int, int, int]],
        fallback: tuple[int, int, int],
        speed: float,
        spread: float,
        direction: int,
    ) -> list[tuple[int, int, int]]:
        name = str(effect or "wave").strip().lower()
        p = palette or [fallback]
        motion = elapsed * max(0.03, float(speed)) * (1 if int(direction) >= 0 else -1)
        density = max(0.2, min(8.0, float(spread)))
        out: list[tuple[int, int, int]] = []

        for raw_x in positions:
            x = max(0.0, min(1.0, float(raw_x)))

            if name == "static":
                color = p[0]
            elif name == "gradient":
                color = cls._palette_at(p, x)
            elif name == "rainbow":
                hue = (x * density + motion * 0.16) % 1.0
                r, g, b = colorsys.hsv_to_rgb(hue, 1.0, 1.0)
                color = (clamp(r * 255), clamp(g * 255), clamp(b * 255))
            elif name == "pulse":
                amp = 0.12 + 0.88 * ((0.5 + 0.5 * math.sin((motion * math.tau) - math.pi / 2.0)) ** 1.45)
                base = cls._palette_at(p, motion * 0.10)
                color = cls._scale(base, amp)
            elif name == "scanner":
                head = cls._triangle(motion * 0.42)
                dist = abs(x - head)
                glow = math.exp(-((dist * (6.0 + density * 2.2)) ** 2))
                base = cls._palette_at(p, head + motion * 0.04)
                color = cls._scale(base, 0.025 + (0.975 * glow))
            elif name == "comet":
                # q grows behind the moving head, producing a long smooth tail.
                q = (x - (motion * 0.34)) % 1.0
                tail = math.exp(-q * (5.0 + density * 2.0))
                base = cls._palette_at(p, motion * 0.09)
                color = cls._scale(base, 0.02 + 0.98 * tail)
            elif name == "chase":
                q = ((x * density) - (motion * 0.48)) % 1.0
                head = math.exp(-((q / 0.18) ** 2))
                base = cls._palette_at(p, (x * 0.22) + motion * 0.11)
                color = cls._scale(base, 0.018 + 0.982 * head)
            elif name == "aurora":
                a = math.sin(math.tau * ((x * (0.85 + density * 0.16)) + motion * 0.11))
                b = math.sin(math.tau * ((x * (1.75 + density * 0.10)) - motion * 0.071))
                c = math.sin(math.tau * ((x * 0.43) + motion * 0.039))
                field = max(0.0, min(1.0, 0.5 + ((a + b + c) / 6.0)))
                base = cls._palette_at(p, field + (motion * 0.025))
                color = cls._scale(base, 0.38 + (0.62 * field))
            else:  # wave
                phase = (x * density) - (motion * 0.30)
                base = cls._palette_at(p, phase)
                shimmer = 0.76 + (0.24 * (0.5 + 0.5 * math.sin(math.tau * (phase + motion * 0.06))))
                color = cls._scale(base, shimmer)

            out.append(color)
        return out

    def _resolve_devices(self, device_ids: list[int]) -> list[dict[str, Any]]:
        inventory: dict[int, dict[str, Any]] = {}
        try:
            # Animation groups only contain per-LED native devices. Avoid a
            # full Hybrid inventory refresh here because that also probes the
            # slow OpenRGB GPU bridge and can delay effect startup by seconds.
            inventory_source = getattr(self._manager, "native", self._manager)
            for row in inventory_source.list_devices():
                if isinstance(row, dict) and row.get("id") is not None:
                    inventory[int(row["id"])] = row
        except Exception:
            pass

        rows: list[dict[str, Any]] = []
        count = max(1, len(device_ids))
        layout_source = getattr(self._manager, "native", self._manager)
        for device_index, dev_id in enumerate(device_ids):
            inv = inventory.get(int(dev_id), {})
            layout = dict(self._layout_cache.get(int(dev_id), {}))
            if not layout:
                try:
                    layout = dict(layout_source.get_device_layout(int(dev_id)))
                    self._layout_cache[int(dev_id)] = dict(layout)
                except Exception:
                    layout = {}

            led_count = max(1, int(layout.get("led_count") or inv.get("led_count") or 1))
            driver = str(layout.get("driver") or inv.get("driver") or "")
            name = str(layout.get("name") or inv.get("name") or f"Device {dev_id}")

            seg_start = device_index / count
            seg_width = 1.0 / count
            positions = [
                seg_start + (((idx + 0.5) / led_count) * seg_width)
                for idx in range(led_count)
            ]
            rows.append(
                {
                    "device_id": int(dev_id),
                    "name": name,
                    "driver": driver,
                    "led_count": led_count,
                    "positions": positions,
                }
            )
        return rows

    def prewarm(self) -> None:
        try:
            source = getattr(self._manager, "native", self._manager)
            rows = source.list_devices()
            ids = [
                int(row["id"])
                for row in rows
                if isinstance(row, dict)
                and row.get("id") is not None
                and str(row.get("driver") or "") != "openrgb_gpu_bridge"
            ]
            if ids:
                self._resolve_devices(ids)
        except Exception:
            pass

    def stop(self, device_id: int | None = None) -> dict[str, Any]:
        group: dict[str, Any] | None = None
        with self._lock:
            if self._group is not None:
                ids = [int(x) for x in self._group.get("device_ids", [])]
                if device_id is None or int(device_id) in ids:
                    group = self._group
                    self._group = None

        if group is None:
            return {"stopped": 0}

        group["stop"].set()
        # Joining prevents a final stale animation frame from racing a static
        # scene write immediately after Stop/Apply.
        for thread in list(group.get("threads") or []):
            if thread is threading.current_thread():
                continue
            try:
                thread.join(timeout=0.9)
            except Exception:
                pass
        return {"stopped": len(group.get("device_ids") or []), "group": True}

    def status(self) -> list[dict[str, Any]]:
        with self._lock:
            if self._group is None:
                return []
            group = self._group
            return [
                {
                    "type": "phase_locked_group",
                    "device_ids": list(group.get("device_ids") or []),
                    "devices": list(group.get("devices") or []),
                    "effect": group.get("effect"),
                    "interval_ms": group.get("interval_ms"),
                    "speed": group.get("speed"),
                    "spread": group.get("spread"),
                    "direction": group.get("direction"),
                    "started_at": group.get("started_at"),
                    "clock": "monotonic_shared",
                }
            ]

    def start_group(
        self,
        device_ids: list[int],
        effect: str,
        interval_ms: int,
        palette: list[tuple[int, int, int]],
        fallback: tuple[int, int, int],
        speed: float = 1.0,
        spread: float = 1.0,
        direction: int = 1,
    ) -> dict[str, Any]:
        ordered: list[int] = []
        seen: set[int] = set()
        for raw in device_ids:
            dev_id = int(raw)
            if dev_id not in seen:
                seen.add(dev_id)
                ordered.append(dev_id)
        if not ordered:
            raise ValueError("At least one device_id is required")
        if not hasattr(self._manager, "set_device_pixels"):
            raise RuntimeError("Active backend does not support per-LED animation")

        self.stop(device_id=None)
        devices = self._resolve_devices(ordered)
        stop_event = threading.Event()
        start_clock = time.monotonic() + 0.12
        requested_s = max(0.025, min(0.5, int(interval_ms) / 1000.0))
        writer = getattr(self._manager, "set_device_pixels_realtime", self._manager.set_device_pixels)
        threads: list[threading.Thread] = []
        public_devices: list[dict[str, Any]] = []

        def worker(row: dict[str, Any]) -> None:
            driver = str(row.get("driver") or "")
            safe_floor = float(self.DRIVER_MIN_INTERVALS.get(driver, 0.050))
            cadence = max(requested_s, safe_floor)
            tick = 0
            errors = 0

            delay = start_clock - time.monotonic()
            if delay > 0 and stop_event.wait(delay):
                return

            while not stop_event.is_set():
                elapsed = max(0.0, time.monotonic() - start_clock)
                try:
                    frame = self._frame_at(
                        effect=effect,
                        positions=list(row["positions"]),
                        elapsed=elapsed,
                        palette=palette,
                        fallback=fallback,
                        speed=speed,
                        spread=spread,
                        direction=direction,
                    )
                    try:
                        writer(
                            int(row["device_id"]),
                            frame,
                            fallback=fallback,
                            led_count_hint=int(row.get("led_count") or len(frame) or 1),
                        )
                    except TypeError:
                        writer(int(row["device_id"]), frame, fallback=fallback)
                    errors = 0
                except Exception:
                    errors += 1
                    if errors >= 5:
                        break

                tick += 1
                deadline = start_clock + (tick * cadence)
                wait_for = max(0.001, deadline - time.monotonic())
                stop_event.wait(wait_for)

        for row in devices:
            cadence = max(requested_s, float(self.DRIVER_MIN_INTERVALS.get(str(row.get("driver") or ""), 0.050)))
            public_devices.append(
                {
                    "device_id": int(row["device_id"]),
                    "name": str(row.get("name") or ""),
                    "driver": str(row.get("driver") or ""),
                    "led_count": int(row.get("led_count") or 1),
                    "cadence_ms": int(round(cadence * 1000)),
                }
            )
            thread = threading.Thread(
                target=worker,
                args=(row,),
                daemon=True,
                name=f"difsync-sync-{int(row['device_id'])}",
            )
            threads.append(thread)

        group = {
            "stop": stop_event,
            "threads": threads,
            "device_ids": ordered,
            "devices": public_devices,
            "effect": str(effect or "wave").strip().lower(),
            "interval_ms": int(round(requested_s * 1000)),
            "speed": float(speed),
            "spread": float(spread),
            "direction": 1 if int(direction) >= 0 else -1,
            "started_at": time.time(),
            "clock_start": start_clock,
        }
        with self._lock:
            self._group = group
        for thread in threads:
            thread.start()

        return {
            "started": True,
            "group": True,
            "device_ids": ordered,
            "devices": public_devices,
            "effect": group["effect"],
            "interval_ms": group["interval_ms"],
            "speed": group["speed"],
            "spread": group["spread"],
            "direction": group["direction"],
            "clock": "monotonic_shared",
        }

    def start(
        self,
        device_id: int,
        effect: str,
        interval_ms: int,
        palette: list[tuple[int, int, int]],
        fallback: tuple[int, int, int],
    ) -> dict[str, Any]:
        return self.start_group(
            [int(device_id)],
            effect=effect,
            interval_ms=interval_ms,
            palette=palette,
            fallback=fallback,
            speed=1.0,
            spread=1.0,
            direction=1,
        )


openrgb, PC_RGB_BACKEND_ACTIVE = build_pc_rgb_manager()
pixel_animator = PixelAnimator(openrgb)
threading.Thread(target=pixel_animator.prewarm, daemon=True, name="difsync-topology-prewarm").start()
app = Flask(__name__)
CORS_ALLOW_ORIGIN = os.getenv("DASHBOARD_CORS_ALLOW_ORIGIN", "*").strip() or "*"


def stop_pixel_animation_for_targets(device_ids: list[int] | None = None) -> None:
    try:
        if device_ids is None:
            pixel_animator.stop(device_id=None)
            return
        for dev_id in sorted({int(x) for x in device_ids}):
            pixel_animator.stop(device_id=dev_id)
    except Exception:
        pass


@app.before_request
def handle_preflight() -> Any:
    if request.method == "OPTIONS":
        response = jsonify({"ok": True})
        response.status_code = 204
        return response
    return None


@app.after_request
def add_cors_headers(response: Any) -> Any:
    allow_origin = CORS_ALLOW_ORIGIN
    if allow_origin == "*":
        origin = request.headers.get("Origin", "").strip()
        allow_origin = origin or "*"

    response.headers["Access-Control-Allow-Origin"] = allow_origin
    response.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Requested-With, X-Panel-Key"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Credentials"] = "false"
    response.headers["Vary"] = "Origin"
    return response


def require_auth() -> tuple[bool, tuple[Any, int] | None]:
    if not APP_TOKEN:
        return True, None
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False, (jsonify({"ok": False, "error": "missing bearer token"}), 401)
    provided = auth[7:].strip()
    if not hmac.compare_digest(provided, APP_TOKEN):
        return False, (jsonify({"ok": False, "error": "invalid bearer token"}), 401)
    return True, None


@app.route("/")
def index() -> Any:
    root = WEB_UI_ROOT if (WEB_UI_ROOT / "index.html").exists() else (ROOT / "dashboard")
    return send_from_directory(root, "index.html")


@app.route("/assets/<path:filename>")
def web_assets(filename: str) -> Any:
    root = WEB_UI_ROOT / "assets"
    return send_from_directory(root, filename)


@app.route("/api/health")
def api_health() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    return jsonify(
        {
            "ok": True,
            "openrgb": openrgb.status(),
            "pc_rgb_backend": PC_RGB_BACKEND_ACTIVE,
            "govee_key_set": bool(GOVEE_API_KEY),
            "token_required": bool(APP_TOKEN),
            "cloud_enabled": is_cloud_enabled(),
            "runtime_state": load_runtime_state(),
        }
    )


@app.route("/api/openrgb/devices")
def api_openrgb_devices() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    try:
        return jsonify({"ok": True, "devices": openrgb.list_devices()})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/pc/probe")
def api_pc_probe() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    if not hasattr(openrgb, "diagnostics"):
        return jsonify({"ok": False, "error": "Active backend does not expose diagnostics"}), 400
    try:
        return jsonify({"ok": True, "probe": openrgb.diagnostics(), "pc_rgb_backend": PC_RGB_BACKEND_ACTIVE})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/color", methods=["POST"])
def api_openrgb_color() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        rgb_raw = rgb_from_payload(payload)
        brightness = brightness_from_payload(payload, default=100)
        rgb = apply_brightness(rgb_raw, brightness)
        ids = payload.get("device_ids")
        device_ids = [int(x) for x in ids] if isinstance(ids, list) else None
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    try:
        stop_pixel_animation_for_targets(device_ids)
        result = openrgb.set_color(rgb, device_ids=device_ids)
        return jsonify({"ok": True, "rgb": rgb, "rgb_raw": rgb_raw, "brightness": brightness, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/device-layout")
def api_openrgb_device_layout() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    if not hasattr(openrgb, "get_device_layout"):
        return jsonify({"ok": False, "error": "Active backend does not support per-LED layout"}), 400

    device_id_raw = request.args.get("device_id", "").strip()
    if not device_id_raw:
        return jsonify({"ok": False, "error": "device_id query param is required"}), 400

    try:
        layout = openrgb.get_device_layout(int(device_id_raw))
        return jsonify({"ok": True, "layout": layout})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/pixels", methods=["POST"])
def api_openrgb_pixels() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    if not hasattr(openrgb, "set_device_pixels"):
        return jsonify({"ok": False, "error": "Active backend does not support per-LED write"}), 400

    payload = request.get_json(silent=True) or {}
    try:
        device_id = int(payload.get("device_id"))
        pixels = parse_pixels_payload(payload, key="pixels")
        fallback = rgb_from_payload(payload) if ("rgb" in payload or all(k in payload for k in ("r", "g", "b"))) else (255, 255, 255)
        brightness = brightness_from_payload(payload, default=100)
        scaled = [apply_brightness(px, brightness) for px in pixels]
        scaled_fallback = apply_brightness(fallback, brightness)
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    try:
        stop_pixel_animation_for_targets([device_id])
        result = openrgb.set_device_pixels(device_id, scaled, fallback=scaled_fallback)
        return jsonify({"ok": True, "device_id": device_id, "brightness": brightness, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/animation/status")
def api_openrgb_animation_status() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    return jsonify({"ok": True, "jobs": pixel_animator.status()})


@app.route("/api/openrgb/animation/start", methods=["POST"])
def api_openrgb_animation_start() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    if not hasattr(openrgb, "set_device_pixels") or not hasattr(openrgb, "get_device_layout"):
        return jsonify({"ok": False, "error": "Active backend does not support per-LED animation"}), 400

    payload = request.get_json(silent=True) or {}
    try:
        device_id = int(payload.get("device_id"))
        effect = str(payload.get("effect", "rainbow")).strip().lower()
        interval_ms = max(20, min(5000, int(payload.get("interval_ms", 65))))
        palette = parse_pixels_payload(payload, key="palette") if isinstance(payload.get("palette"), list) else []
        fallback = rgb_from_payload(payload) if ("rgb" in payload or all(k in payload for k in ("r", "g", "b"))) else (255, 255, 255)
        brightness = brightness_from_payload(payload, default=100)
        scaled_palette = [apply_brightness(px, brightness) for px in palette]
        scaled_fallback = apply_brightness(fallback, brightness)
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    try:
        result = pixel_animator.start(
            device_id=device_id,
            effect=effect,
            interval_ms=interval_ms,
            palette=scaled_palette,
            fallback=scaled_fallback,
        )
        return jsonify({"ok": True, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/animation/group/start", methods=["POST"])
def api_openrgb_animation_group_start() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    if not hasattr(openrgb, "set_device_pixels"):
        return jsonify({"ok": False, "error": "Active backend does not support per-LED animation"}), 400

    payload = request.get_json(silent=True) or {}
    try:
        raw_ids = payload.get("device_ids")
        if not isinstance(raw_ids, list) or not raw_ids:
            raise ValueError("device_ids must be a non-empty array")
        device_ids = [int(x) for x in raw_ids]
        effect = str(payload.get("effect", "wave")).strip().lower()
        allowed = {"static", "gradient", "wave", "pulse", "chase", "rainbow", "comet", "scanner", "aurora"}
        if effect not in allowed:
            raise ValueError("Unsupported animation effect")
        interval_ms = max(25, min(500, int(payload.get("interval_ms", 45))))
        speed = max(0.05, min(3.0, float(payload.get("speed", 0.65))))
        spread = max(0.2, min(8.0, float(payload.get("spread", 1.4))))
        direction = -1 if int(payload.get("direction", 1)) < 0 else 1
        palette = parse_pixels_payload(payload, key="palette") if isinstance(payload.get("palette"), list) else []
        fallback = rgb_from_payload(payload) if ("rgb" in payload or all(k in payload for k in ("r", "g", "b"))) else (255, 255, 255)
        brightness = brightness_from_payload(payload, default=100)
        scaled_palette = [apply_brightness(px, brightness) for px in palette]
        scaled_fallback = apply_brightness(fallback, brightness)
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    try:
        result = pixel_animator.start_group(
            device_ids=device_ids,
            effect=effect,
            interval_ms=interval_ms,
            palette=scaled_palette,
            fallback=scaled_fallback,
            speed=speed,
            spread=spread,
            direction=direction,
        )
        return jsonify({"ok": True, "brightness": brightness, **result})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/openrgb/animation/stop", methods=["POST"])
def api_openrgb_animation_stop() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    device_raw = payload.get("device_id")
    try:
        device_id = int(device_raw) if device_raw is not None else None
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    result = pixel_animator.stop(device_id=device_id)
    return jsonify({"ok": True, **result})


@app.route("/api/govee/devices")
def api_govee_devices() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    try:
        return jsonify({"ok": True, "devices": list_govee_devices()})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/govee/color", methods=["POST"])
def api_govee_color() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        rgb_raw = rgb_from_payload(payload)
        brightness = brightness_from_payload(payload, default=100)
        rgb = apply_brightness(rgb_raw, brightness)
        device_ids_raw = payload.get("device_ids")
        device_ids = [str(x) for x in device_ids_raw] if isinstance(device_ids_raw, list) else None
        report = apply_govee_color(rgb_raw, brightness=brightness, device_ids=device_ids)
        return jsonify({"ok": True, "rgb": rgb, "rgb_raw": rgb_raw, "brightness": brightness, "results": report})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400


@app.route("/api/scene/color", methods=["POST"])
def api_scene_color() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        rgb_raw = rgb_from_payload(payload)
        brightness = brightness_from_payload(payload, default=100)
        rgb = apply_brightness(rgb_raw, brightness)
        openrgb_ids_raw = payload.get("openrgb_device_ids")
        govee_ids_raw = payload.get("govee_device_ids")
        openrgb_ids = [int(x) for x in openrgb_ids_raw] if isinstance(openrgb_ids_raw, list) else None
        govee_ids = [str(x) for x in govee_ids_raw] if isinstance(govee_ids_raw, list) else None
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400

    try:
        stop_pixel_animation_for_targets(openrgb_ids)
        with ThreadPoolExecutor(max_workers=2) as executor:
            f_pc = executor.submit(openrgb.set_color, rgb, openrgb_ids)
            f_govee = executor.submit(apply_govee_color, rgb_raw, brightness, govee_ids)
            openrgb_result = f_pc.result()
            govee_report = f_govee.result()

        return jsonify(
            {"ok": True, "rgb": rgb, "rgb_raw": rgb_raw, "brightness": brightness, "openrgb": openrgb_result, "govee": govee_report}
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/system/state", methods=["GET", "POST"])
def api_system_state() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    try:
        if request.method == "POST":
            payload = request.get_json(silent=True) or {}
            state = save_runtime_state(payload)
        else:
            state = load_runtime_state()
        return jsonify({"ok": True, "state": state})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400


@app.route("/api/ai/status")
def api_ai_status() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    url = os.getenv("DIFSYNC_SYNC_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
    try:
        data = requests.get(f"{url}/api/tags", timeout=1.5).json()
        models = [str(x.get("name") or "") for x in data.get("models", []) if isinstance(x, dict)]
        return jsonify({"ok": True, "online": True, "models": models, "selected": load_runtime_state().get("ai_model","")})
    except Exception as exc:
        return jsonify({"ok": True, "online": False, "models": [], "error": exc_text(exc)})


@app.route("/api/ai/scene", methods=["POST"])
def api_ai_scene() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        scene = generate_ai_scene(str(payload.get("prompt") or ""))
        return jsonify({"ok": True, "scene": scene})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400


@app.route("/api/presets", methods=["GET"])
def api_presets_list() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    try:
        return jsonify({"ok": True, "presets": load_presets()})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


@app.route("/api/presets", methods=["POST"])
def api_presets_upsert() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    try:
        preset = normalize_preset(payload)
        presets = upsert_preset(preset)
        return jsonify({"ok": True, "preset": preset, "presets": presets})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400


@app.route("/api/presets/<string:name>", methods=["DELETE"])
def api_presets_delete(name: str) -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    try:
        presets, removed = delete_preset(name)
        if not removed:
            return jsonify({"ok": False, "error": "Preset not found"}), 404
        return jsonify({"ok": True, "presets": presets})
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 400


@app.route("/api/presets/apply", methods=["POST"])
def api_presets_apply() -> Any:
    ok, error = require_auth()
    if not ok:
        return error
    payload = request.get_json(silent=True) or {}
    preset_name = str(payload.get("name", "")).strip()
    if not preset_name:
        return jsonify({"ok": False, "error": "Preset name is required"}), 400

    try:
        preset = next((p for p in load_presets() if p["name"].lower() == preset_name.lower()), None)
        if preset is None:
            return jsonify({"ok": False, "error": "Preset not found"}), 404

        rgb_raw = tuple(preset["rgb"])
        brightness = clamp_brightness(preset.get("brightness", 100))
        rgb = apply_brightness(rgb_raw, brightness)
        target = preset["target"]
        openrgb_result = {"changed": 0, "skipped": []}
        govee_result: list[dict[str, Any]] = []

        if target == "scene":
            pc_ids = preset.get("openrgb_device_ids") or None
            govee_ids = preset.get("govee_device_ids") or None
            stop_pixel_animation_for_targets(pc_ids)
            with ThreadPoolExecutor(max_workers=2) as executor:
                f_pc = executor.submit(openrgb.set_color, rgb, pc_ids)
                f_govee = executor.submit(apply_govee_color, rgb_raw, brightness, govee_ids)
                openrgb_result = f_pc.result()
                govee_result = f_govee.result()
        else:
            if target == "openrgb":
                ids = preset.get("openrgb_device_ids") or None
                stop_pixel_animation_for_targets(ids)
                openrgb_result = openrgb.set_color(rgb, device_ids=ids)
            if target == "govee":
                ids = preset.get("govee_device_ids") or None
                govee_result = apply_govee_color(rgb_raw, brightness=brightness, device_ids=ids)

        return jsonify(
            {
                "ok": True,
                "preset": preset,
                "rgb": rgb,
                "rgb_raw": rgb_raw,
                "brightness": brightness,
                "openrgb": openrgb_result,
                "govee": govee_result,
            }
        )
    except Exception as exc:
        return jsonify({"ok": False, "error": exc_text(exc)}), 500


if __name__ == "__main__":
    print(f"[Dashboard] http://{APP_HOST}:{APP_PORT} (PC RGB backend: {PC_RGB_BACKEND_ACTIVE})")
    app.run(host=APP_HOST, port=APP_PORT, debug=False)













