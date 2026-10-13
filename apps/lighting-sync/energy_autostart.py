"""Install/read DifSync's background engine launch at Windows user sign-in.

The existing Studio UI startup is independent. No UAC, no service/process
termination, no console, no changes to CAMService or device-agent.
Windows HKCU Run activates after the user logs on, NOT before sign-in.
"""
from __future__ import annotations
from pathlib import Path
import os
import sys
import winreg

ROOT = Path(__file__).resolve().parent
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
ENTRY = "DifSync Energy Background"
PYTHONW = ROOT / ".venv" / "Scripts" / "pythonw.exe"
RUNTIME = ROOT / "desktop_runtime.py"

def command():
    if not PYTHONW.is_file() or not RUNTIME.is_file():
        raise FileNotFoundError("The windowless DifSync runtime is not installed.")
    return f'"{PYTHONW}" "{RUNTIME}"'

def status():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,RUN_KEY,0,winreg.KEY_QUERY_VALUE) as key:
            found,_ = winreg.QueryValueEx(key,ENTRY)
        return {"enabled":str(found).strip().casefold()==command().casefold(),
                "configured":str(found)}
    except (FileNotFoundError,OSError):
        return {"enabled":False,"configured":None}

def enable():
    cmd=command()
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,RUN_KEY,0,winreg.KEY_SET_VALUE) as key:
        winreg.SetValueEx(key,ENTRY,0,winreg.REG_SZ,cmd)
    return status()

def disable():
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,RUN_KEY,0,winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key,ENTRY)
    except FileNotFoundError:
        pass
    return status()

if __name__=="__main__":
    import json
    action=sys.argv[1] if len(sys.argv)>1 else "status"
    if action=="enable":
        print(json.dumps(enable()))
    elif action=="disable":
        print(json.dumps(disable()))
    elif action=="status":
        print(json.dumps(status()))
    else:
        raise SystemExit("Usage: energy_autostart.py [status|enable|disable]")
