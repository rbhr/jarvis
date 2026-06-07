"""
JARVIS Home integration — Apple Home (HomeKit) control via the Shortcuts CLI.

Apple's Home.app is NOT AppleScript-scriptable, so the only reliable way to
control HomeKit accessories/scenes from the command line is the macOS
`shortcuts` tool. The user creates Shortcuts (each one containing a HomeKit
"Control Home" / "Set Scene" action — or a Home Assistant / Homebridge call)
and JARVIS triggers them by name with `shortcuts run "<name>"`.

Setup (one-time, per scene the user wants JARVIS to control):
  1. Open the Shortcuts app on the Mac.
  2. New Shortcut → add a "Control <accessory>" or "Set <scene>" Home action.
  3. Name it something JARVIS-friendly, e.g. "Lights On", "Goodnight", "Movie Time".
  Those names then appear in `shortcuts list` and JARVIS can run them.

Each function returns {"success": bool, "confirmation": str}.
"""

import asyncio
import logging
import time

log = logging.getLogger("jarvis.home")

# Cache the shortcut list — listing spawns a subprocess and the set of
# shortcuts changes rarely. Refreshed on a TTL.
_shortcuts_cache: list[str] = []
_shortcuts_fetched_at: float = 0.0
_SHORTCUTS_TTL = 300.0  # 5 minutes


async def list_shortcuts(force: bool = False) -> list[str]:
    """Return the names of all available Shortcuts (cached for 5 minutes)."""
    global _shortcuts_cache, _shortcuts_fetched_at
    now = time.monotonic()
    if not force and _shortcuts_cache and (now - _shortcuts_fetched_at) < _SHORTCUTS_TTL:
        return _shortcuts_cache
    try:
        proc = await asyncio.create_subprocess_exec(
            "shortcuts", "list",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=10)
        if proc.returncode == 0:
            names = [line.strip() for line in stdout.decode().splitlines() if line.strip()]
            _shortcuts_cache = names
            _shortcuts_fetched_at = now
            return names
        log.warning(f"shortcuts list failed: {stderr.decode()[:200]}")
    except FileNotFoundError:
        log.warning("`shortcuts` CLI not found — Home control unavailable (needs macOS Monterey+)")
    except asyncio.TimeoutError:
        log.warning("shortcuts list timed out")
    except Exception as e:
        log.warning(f"shortcuts list error: {e}")
    return _shortcuts_cache  # may be stale/empty, but never raises


def _resolve_shortcut_name(requested: str, available: list[str]) -> str | None:
    """Match a requested name to an actual shortcut, case-insensitively.

    Falls back to a substring match so "lights" can find "Lights On".
    Returns the canonical shortcut name, or None if nothing matches.
    """
    if not requested:
        return None
    req = requested.strip().lower()
    # Exact (case-insensitive) match first
    for name in available:
        if name.lower() == req:
            return name
    # Substring match — requested contained in a shortcut, or vice-versa
    for name in available:
        n = name.lower()
        if req in n or n in req:
            return name
    return None


async def run_shortcut(name: str) -> dict:
    """Run a named Shortcut (e.g. a HomeKit scene). Returns success + confirmation."""
    available = await list_shortcuts()
    resolved = _resolve_shortcut_name(name, available) if available else name
    if available and resolved is None:
        log.info(f"Home: no shortcut matching '{name}'")
        return {
            "success": False,
            "confirmation": f"I couldn't find a Home shortcut called {name}, sir.",
        }
    target = resolved or name

    try:
        proc = await asyncio.create_subprocess_exec(
            "shortcuts", "run", target,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        success = proc.returncode == 0
        if not success:
            log.error(f"shortcuts run '{target}' failed: {stderr.decode()[:200]}")
        else:
            log.info(f"Home: ran shortcut '{target}'")
        return {
            "success": success,
            "confirmation": f"Done, sir." if success else f"The {target} shortcut ran into a problem, sir.",
        }
    except FileNotFoundError:
        return {"success": False, "confirmation": "I'm afraid Home control isn't available on this machine, sir."}
    except asyncio.TimeoutError:
        log.error(f"shortcuts run '{target}' timed out")
        return {"success": False, "confirmation": f"The {target} shortcut took too long, sir."}
    except Exception as e:
        log.error(f"run_shortcut error: {e}")
        return {"success": False, "confirmation": "Something went wrong reaching Home, sir."}
