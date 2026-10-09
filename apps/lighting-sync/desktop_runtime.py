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
            sys.argv=[str(ROOT/"dashboard_server.py")]
            runpy.run_path(str(ROOT/"dashboard_server.py"),run_name="__main__")
        except Exception:
            traceback.print_exc(file=log)
            raise

if __name__ == "__main__":
    main()
