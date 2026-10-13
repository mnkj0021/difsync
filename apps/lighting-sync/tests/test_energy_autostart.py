"""Windows-only non-mutating startup verification for DifSync Energy."""
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
if sys.platform=="win32":
    import energy_autostart as energy
    cmd=energy.command()
    assert "pythonw.exe" in cmd.lower() and "desktop_runtime.py" in cmd.lower()
    assert cmd.startswith('"') and '" "' in cmd
    status=energy.status()
    assert isinstance(status["enabled"],bool)
    assert status["enabled"] == (status["configured"] is not None and
                                status["configured"].casefold()==cmd.casefold())
    print("STARTUP_SOURCE_PASS windows user-login registry entry and silent runner validated")
else:
    print("STARTUP_CHECK_SKIPPED non-Windows platform")
