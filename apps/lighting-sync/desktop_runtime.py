"""DifSync windowless lighting runtime.

Launched only by DifSync's desktop app, using pythonw.exe.
No terminal, no console watchdog, no external Python files.
This does not start or stop the DifSync remote access agent or CAMService.
"""
from __future__ import annotations
import logging
import os
import pathlib
import runpy
import sys
import time
import traceback

ROOT = pathlib.Path(__file__).resolve().parent
LOG = ROOT / "desktop_runtime.log"
_ACTIVE_MUTEX_HANDLE = None

def _only_one_instance():
    """Cross-process guard for simultaneous Windows-login and GUI launches."""
    global _ACTIVE_MUTEX_HANDLE
    if sys.platform != "win32":
        return True
    import ctypes
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32",use_last_error=True)
    create = kernel.CreateMutexW
    create.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    create.restype = wintypes.HANDLE
    handle = create(None, False, r"Local\DifSync-Windowless-Runtime-v1")
    if not handle:
        raise OSError(ctypes.get_last_error(),"Could not create DifSync instance guard")
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.CloseHandle(handle)
        return False
    _ACTIVE_MUTEX_HANDLE = handle
    return True

def _rotate_log():
    if LOG.exists() and LOG.stat().st_size > 2_000_000:
        backup=ROOT/"desktop_runtime.previous.log"
        try:
            if backup.exists():backup.unlink()
            LOG.replace(backup)
        except OSError:pass

def _hide_console_subprocesses():
    # In a pythonw-hosted session, invoking sc.exe or PowerShell without the
    # CREATE_NO_WINDOW flag makes Windows Terminal open a separate visible
    # window for EACH hardware service check. This exhausted the desktop.
    # Restrict this setting to the windowless lighting service process.
    import subprocess
    native_popen = subprocess.Popen
    flag=getattr(subprocess,"CREATE_NO_WINDOW",0x08000000)
    def no_window_popen(*args,**kwargs):
        kwargs["creationflags"]=int(kwargs.get("creationflags") or 0)|flag
        kwargs["windowsHide"]=True if "windowsHide" in kwargs else kwargs.get("windowsHide",False)
        # windowsHide is a Node option, not a Python Popen option.
        kwargs.pop("windowsHide",None)
        return native_popen(*args,**kwargs)
    subprocess.Popen=no_window_popen

def main():
    os.chdir(str(ROOT))
    _hide_console_subprocesses()
    _rotate_log()
    with LOG.open("a", encoding="utf-8", buffering=1) as log:
        sys.stdout = log
        sys.stderr = log
        print("[DifSync] Windowless local lighting engine starting at",time.strftime("%Y-%m-%d %H:%M:%S"),flush=True)
        print("[DifSync] Python:",sys.executable,"port:",os.environ.get("DASHBOARD_PORT","8080"),flush=True)
        # Preserve actual server warnings and errors, but avoid logging every
        # 4-second UI health/telemetry request indefinitely.
        logging.getLogger("werkzeug").setLevel(logging.WARNING)
        try:
            if "--probe" in sys.argv:
                import ctypes
                import json
                console_present=bool(ctypes.windll.kernel32.GetConsoleWindow())
                (ROOT/"tests"/"silent-runtime-probe.json").write_text(
                    json.dumps({"ok":True,"has_console":console_present,
                                "pid":os.getpid(),"executable":sys.executable}),
                    encoding="utf-8")
                return
            if not _only_one_instance():
                print("[DifSync] Background engine already active; skipping duplicate launch.",flush=True)
                return
            sys.argv=[str(ROOT/"dashboard_server.py")]
            runpy.run_path(str(ROOT/"dashboard_server.py"),run_name="__main__")
        except Exception:
            traceback.print_exc(file=log)
            raise

if __name__ == "__main__":
    main()
