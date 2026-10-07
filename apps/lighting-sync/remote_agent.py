import os
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests
from dotenv import load_dotenv
from requests.adapters import HTTPAdapter
from urllib.parse import urlparse, urlunparse
from urllib3.util.retry import Retry

from dashboard_server import apply_govee_color, list_govee_devices, openrgb

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "difsync_state.json")


def cloud_control_enabled() -> bool:
    try:
        with open(STATE_PATH, "r", encoding="utf-8-sig") as handle:
            data = __import__("json").load(handle)
        return bool(data.get("cloud_enabled", True))
    except Exception:
        return True

load_dotenv()


def env_optional(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name, "").strip()
        if value:
            return value
    return default


def env_required_any(*names: str) -> str:
    value = env_optional(*names, default="")
    if not value:
        joined = ", ".join(names)
        raise RuntimeError(f"Missing required environment variable. Set one of: {joined}")
    return value


def clamp(value: Any) -> int:
    return max(0, min(255, int(round(float(value)))))


def rgb_from_payload(payload: dict[str, Any]) -> tuple[int, int, int]:
    if "rgb" in payload and isinstance(payload["rgb"], (list, tuple)) and len(payload["rgb"]) >= 3:
        return (clamp(payload["rgb"][0]), clamp(payload["rgb"][1]), clamp(payload["rgb"][2]))
    if all(k in payload for k in ("r", "g", "b")):
        return (clamp(payload["r"]), clamp(payload["g"]), clamp(payload["b"]))
    raise ValueError("Payload must include rgb array or r/g/b values")


def brightness_from_payload(payload: dict[str, Any], default: int = 100) -> int:
    raw = payload.get("brightness", payload.get("bri", default))
    try:
        return max(0, min(100, int(round(float(raw)))))
    except Exception:
        return default


def apply_brightness(rgb: tuple[int, int, int], brightness: int) -> tuple[int, int, int]:
    scale = max(0, min(100, int(brightness))) / 100.0
    return (
        clamp(rgb[0] * scale),
        clamp(rgb[1] * scale),
        clamp(rgb[2] * scale),
    )


class DifSyncRemoteAgent:
    def __init__(self) -> None:
        self.base_url = env_required_any("DIFSYNC_SYNC_CLOUD_URL").rstrip("/")
        self.base_urls = self._build_base_urls(self.base_url)
        self.base_idx = 0
        self.agent_id = env_required_any("DIFSYNC_SYNC_AGENT_ID")
        self.agent_token = env_required_any("DIFSYNC_SYNC_AGENT_TOKEN")
        self.poll_seconds = float(env_optional("DIFSYNC_SYNC_POLL_SECONDS", default="2.0"))
        self.poll_error_streak = 0
        self.session = requests.Session()
        self.session.headers.update({"X-Agent-Token": self.agent_token, "Content-Type": "application/json"})
        self._configure_http_retries()

    def _configure_http_retries(self) -> None:
        try:
            retry = Retry(
                total=2,
                connect=2,
                read=2,
                backoff_factor=0.25,
                status_forcelist=[429, 500, 502, 503, 504],
                allowed_methods=None,
            )
        except TypeError:
            retry = Retry(  # pragma: no cover
                total=2,
                connect=2,
                read=2,
                backoff_factor=0.25,
                status_forcelist=[429, 500, 502, 503, 504],
                method_whitelist=None,
            )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=4, pool_maxsize=8)
        self.session.mount("https://", adapter)
        self.session.mount("http://", adapter)

    def _build_base_urls(self, primary: str) -> list[str]:
        urls: list[str] = []

        def add(url: str) -> None:
            u = str(url or "").strip().rstrip("/")
            if u and u not in urls:
                urls.append(u)

        add(primary)

        parsed = urlparse(primary)
        host = parsed.netloc
        if host.startswith("www."):
            alt = urlunparse((parsed.scheme, host[4:], parsed.path, parsed.params, parsed.query, parsed.fragment))
            add(alt)
        elif host and "." in host:
            alt = urlunparse((parsed.scheme, f"www.{host}", parsed.path, parsed.params, parsed.query, parsed.fragment))
            add(alt)

        extra = env_optional("DIFSYNC_SYNC_CLOUD_URL_FALLBACK", default="")
        if extra:
            for item in extra.split(","):
                add(item)

        return urls or [primary]

    def current_base_url(self) -> str:
        return self.base_urls[self.base_idx]

    def rotate_base_url(self) -> bool:
        if len(self.base_urls) <= 1:
            return False
        old = self.base_urls[self.base_idx]
        self.base_idx = (self.base_idx + 1) % len(self.base_urls)
        new = self.base_urls[self.base_idx]
        print(f"[DifSyncAgent] Switching cloud endpoint: {old} -> {new}")
        return True

    def api_url(self, action: str, base_url: str | None = None) -> str:
        base = (base_url or self.current_base_url()).rstrip("/")
        return f"{base}/api.php?action={action}"

    def pull_commands(self) -> list[dict[str, Any]]:
        payload = {
            "agent_id": self.agent_id,
            "agent_name": env_optional("DIFSYNC_SYNC_AGENT_NAME", default=self.agent_id),
        }
        response = self.session.post(self.api_url("agent_pull"), json=payload, timeout=20)
        response.raise_for_status()
        data = response.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("error", "agent_pull failed"))
        return data.get("commands", [])

    def ack_command(self, command_id: int, success: bool, message: str, details: dict[str, Any] | None = None) -> None:
        payload = {
            "agent_id": self.agent_id,
            "command_id": int(command_id),
            "success": bool(success),
            "message": str(message)[:500],
            "details": details or {},
        }
        last_error: Exception | None = None
        for offset in range(len(self.base_urls)):
            idx = (self.base_idx + offset) % len(self.base_urls)
            base = self.base_urls[idx]
            try:
                response = self.session.post(self.api_url("agent_ack", base_url=base), json=payload, timeout=20)
                response.raise_for_status()
                data = response.json()
                if not data.get("ok"):
                    raise RuntimeError(data.get("error", "agent_ack failed"))
                if idx != self.base_idx:
                    self.base_idx = idx
                return
            except Exception as exc:
                last_error = exc
                continue
        raise RuntimeError(f"agent_ack failed on all endpoints: {last_error}")

    def _normalize_openrgb_ids(self, ids_raw: Any) -> list[int] | None:
        if not isinstance(ids_raw, list):
            return None
        requested: list[int] = []
        for item in ids_raw:
            try:
                requested.append(int(item))
            except Exception:
                continue
        if not requested:
            return None
        try:
            devices = openrgb.list_devices()
            available = {int(d.get("id")) for d in devices if isinstance(d, dict) and d.get("id") is not None}
            valid = [x for x in requested if x in available]
            return valid if valid else None
        except Exception:
            # If inventory call fails, keep requested ids as-is.
            return requested

    def _normalize_govee_ids(self, ids_raw: Any) -> list[str] | None:
        if not isinstance(ids_raw, list):
            return None
        requested = [str(x).strip() for x in ids_raw if str(x).strip()]
        if not requested:
            return None
        try:
            devices = list_govee_devices()
            available = {str(d.get("device", "")).strip() for d in devices if isinstance(d, dict)}
            valid = [x for x in requested if x in available]
            return valid if valid else None
        except Exception:
            # If inventory call fails, keep requested ids as-is.
            return requested

    def run_command(self, command: dict[str, Any]) -> tuple[bool, str, dict[str, Any]]:
        target = str(command.get("target", "")).strip().lower()
        payload = command.get("payload", {}) or {}

        if target == "scene":
            rgb_raw = rgb_from_payload(payload)
            openrgb_ids = self._normalize_openrgb_ids(payload.get("openrgb_device_ids"))
            govee_ids = self._normalize_govee_ids(payload.get("govee_device_ids"))
            brightness = brightness_from_payload(payload, default=100)
            rgb = apply_brightness(rgb_raw, brightness)

            with ThreadPoolExecutor(max_workers=2) as executor:
                f_pc = executor.submit(openrgb.set_color, rgb, openrgb_ids)
                f_govee = executor.submit(
                    apply_govee_color,
                    rgb_raw,
                    brightness=brightness,
                    device_ids=govee_ids,
                )
                openrgb_result = f_pc.result()
                govee_result = f_govee.result()

            changed = int(openrgb_result.get("changed", 0))
            skipped_rows = openrgb_result.get("skipped", [])
            skipped = len(skipped_rows)
            ok_g = len([x for x in govee_result if x.get("ok")])
            msg = f"scene rgb_raw={rgb_raw} bri={brightness}% pc_rgb={rgb} pc_changed={changed} pc_skipped={skipped} govee_ok={ok_g}/{len(govee_result)}"
            # Treat scene as failed if the PC RGB backend could not apply any device updates.
            if changed == 0 and skipped > 0:
                return False, msg, {"pc_rgb": openrgb_result, "openrgb": openrgb_result, "govee": govee_result}
            return True, msg, {"pc_rgb": openrgb_result, "openrgb": openrgb_result, "govee": govee_result}

        if target == "openrgb":
            rgb_raw = rgb_from_payload(payload)
            ids = self._normalize_openrgb_ids(payload.get("device_ids"))
            brightness = brightness_from_payload(payload, default=100)
            rgb = apply_brightness(rgb_raw, brightness)
            result = openrgb.set_color(rgb, device_ids=ids)
            changed = int(result.get("changed", 0))
            skipped = len(result.get("skipped", []))
            msg = f"pc_rgb rgb_raw={rgb_raw} bri={brightness}% rgb={rgb} changed={changed} skipped={skipped}"
            success = not (changed == 0 and skipped > 0)
            return success, msg, {"pc_rgb": result, "openrgb": result}

        if target == "govee":
            rgb = rgb_from_payload(payload)
            ids = self._normalize_govee_ids(payload.get("device_ids"))
            brightness = brightness_from_payload(payload, default=100)
            result = apply_govee_color(rgb, brightness=brightness, device_ids=ids)
            ok_count = len([x for x in result if x.get("ok")])
            failed = [x for x in result if not x.get("ok")]
            fail_msg = ""
            if failed:
                parts = []
                for row in failed[:2]:
                    parts.append(f"{row.get('device','?')}: {row.get('message','error')}")
                fail_msg = " failures=" + " | ".join(parts)
            msg = f"govee rgb={rgb} bri={brightness}% ok={ok_count}/{len(result)}{fail_msg}"
            success = ok_count > 0 if result else False
            return success, msg, {"govee": result}

        if target == "inventory":
            pc_devices = openrgb.list_devices()
            probe = openrgb.diagnostics() if hasattr(openrgb, "diagnostics") else None
            try:
                govee_devices = list_govee_devices()
            except Exception:
                govee_devices = []
            msg = f"inventory pc={len(pc_devices)} govee={len(govee_devices)}"
            return True, msg, {"inventory": {"pc_devices": pc_devices, "govee_devices": govee_devices, "probe": probe}}

        return False, f"Unknown command target: {target}", {}

    def loop(self) -> None:
        endpoints = ", ".join(self.base_urls)
        print(f"[DifSyncAgent] Connected as {self.agent_id} (cloud endpoints: {endpoints})")
        cloud_was_enabled: bool | None = None
        while True:
            enabled = cloud_control_enabled()
            if enabled != cloud_was_enabled:
                print(f"[DifSyncAgent] Cloud control {'ENABLED' if enabled else 'DISABLED'}")
                cloud_was_enabled = enabled
            if not enabled:
                time.sleep(1.0)
                continue
            try:
                commands = self.pull_commands()
                self.poll_error_streak = 0
                if commands:
                    print(f"[DifSyncAgent] Pulled {len(commands)} command(s)")
                for command in commands:
                    command_id = int(command.get("id", 0))
                    if not command_id:
                        continue
                    try:
                        if not cloud_control_enabled():
                            self.ack_command(command_id, False, "Cloud control disabled locally", {"cloud_enabled": False})
                            continue
                        success, message, details = self.run_command(command)
                        self.ack_command(command_id, success, message, details)
                        print(f"[DifSyncAgent] #{command_id} {message}")
                    except Exception as exc:
                        err = f"{type(exc).__name__}: {str(exc)}"
                        try:
                            self.ack_command(command_id, False, err, {"error": err})
                        except Exception as ack_exc:
                            print(f"[DifSyncAgent] ACK failed for #{command_id}: {type(ack_exc).__name__}: {ack_exc}")
                        print(f"[DifSyncAgent] #{command_id} FAILED {err}")
            except Exception as exc:
                self.poll_error_streak += 1
                err_text = str(exc).lower()
                dns_or_socket = any(
                    token in err_text
                    for token in (
                        "failed to resolve",
                        "getaddrinfo failed",
                        "name resolution",
                        "remotedisconnected",
                        "connection reset",
                        "read timed out",
                        "max retries exceeded",
                        "forcibly closed",
                    )
                )
                if dns_or_socket and (self.poll_error_streak == 1 or self.poll_error_streak % 3 == 0):
                    self.rotate_base_url()
                print(f"[DifSyncAgent] Poll error: {type(exc).__name__}: {exc}")
            # Keep polling responsive for realtime slider updates, with gentle backoff on cloud failures.
            backoff = min(6.0, (self.poll_error_streak * 0.35))
            time.sleep(max(0.15, self.poll_seconds) + backoff)

if __name__ == "__main__":
    DifSyncRemoteAgent().loop()






