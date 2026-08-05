"""Preset check-in voice assets for the danger link.

The fall check-in must *speak* the moment it reaches the elder device — a
runtime TTS hop would put network latency inside the one path the danger link
optimises. So the spoken lines are pre-generated offline by this CLI, served
as static files by B (``GET /voice/<file>``), and advertised per decision via
``CareDecision.voice_asset`` only when the decision's ``elder_message`` is
exactly the recorded wording (policy enforces the match, and
:func:`load_voice_assets` re-checks it at startup so stale recordings are
dropped rather than mismatched).

Generation uses macOS ``say``/``afconvert`` (the platform TTS endpoint was
probed 404 on 2026-08-01; local synthesis keeps the demo key-independent).
Playback side is plain ``<audio>``-compatible AAC/m4a.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path

from reme.runtime.decision.mimo.prompts import PersonaConfig
from reme.runtime.decision.state_machine import TemplateId

VOICE_PRESET_SCHEMA_VERSION = "reme-voice-preset/v0-experiment"
DEFAULT_VOICE = "Tingting"
DEFAULT_OUT_DIR = Path("examples/decision/voice_presets")

# The fall episode's spoken lines. CONCERN/consent wording is MiMo-composed at
# runtime and therefore never preset (the recording could not match).
PRESET_TEMPLATES = (
    TemplateId.FALL_CHECK_IN,
    TemplateId.CLARIFY,
    TemplateId.FALL_HELP_ALERT,
    TemplateId.DANGER_CONFIRMED_ALERT,
)


class VoicePresetError(RuntimeError):
    """Raised when generation prerequisites or the manifest are broken."""


def _template_lines(persona: PersonaConfig) -> dict[TemplateId, str]:
    # Imported lazily to keep module import cheap and cycle-free.
    from reme.decision.policy import _TEMPLATES, _fill

    lines: dict[TemplateId, str] = {}
    for template in PRESET_TEMPLATES:
        text = _fill(_TEMPLATES[template].elder_message, persona)
        if text is None:  # pragma: no cover - preset templates all speak
            continue
        lines[template] = text
    return lines


def _synthesize(text: str, target: Path, *, voice: str) -> None:
    with tempfile.TemporaryDirectory() as workdir:
        aiff = Path(workdir) / "clip.aiff"
        try:
            subprocess.run(
                ["say", "-v", voice, "-o", str(aiff), text],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["afconvert", "-f", "m4af", "-d", "aac", str(aiff), str(target)],
                check=True,
                capture_output=True,
            )
        except FileNotFoundError as exc:
            raise VoicePresetError(
                f"{exc.filename} is unavailable — preset generation needs macOS say/afconvert"
            ) from exc
        except subprocess.CalledProcessError as exc:
            detail = exc.stderr.decode("utf-8", "replace").strip()
            raise VoicePresetError(f"{exc.cmd[0]} failed: {detail}") from exc
        if not target.is_file() or target.stat().st_size == 0:
            raise VoicePresetError(f"synthesis produced no audio for {target.name}")


def generate_presets(
    out_dir: Path, *, persona: PersonaConfig, voice: str = DEFAULT_VOICE
) -> dict[str, str]:
    """Generate all preset clips plus the manifest; returns file-per-template."""

    out_dir.mkdir(parents=True, exist_ok=True)
    entries: dict[str, dict[str, str]] = {}
    for template, text in _template_lines(persona).items():
        filename = f"{template.value}.m4a"
        _synthesize(text, out_dir / filename, voice=voice)
        entries[template.value] = {"file": filename, "text": text}
    manifest = {
        "schema_version": VOICE_PRESET_SCHEMA_VERSION,
        "voice": voice,
        "elder_name": persona.elder_name,
        "family_relation": persona.family_relation,
        "entries": entries,
    }
    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return {template: entry["file"] for template, entry in entries.items()}


def load_voice_assets(
    voice_dir: Path, *, persona: PersonaConfig, url_prefix: str = "/voice"
) -> Mapping[TemplateId, str]:
    """Map templates to served URLs for every preset that still matches.

    A preset is advertised only when the manifest persona equals the running
    persona *and* the recorded text equals the template's current wording —
    a renamed elder or an edited template silently drops the stale clip
    (C falls back to speaking ``elder_message`` itself).
    """

    manifest_path = voice_dir / "manifest.json"
    if not manifest_path.is_file():
        return {}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warning: unreadable voice manifest {manifest_path}: {exc}", file=sys.stderr)
        return {}
    if not isinstance(manifest, dict) or manifest.get("schema_version") != (
        VOICE_PRESET_SCHEMA_VERSION
    ):
        print(f"warning: unsupported voice manifest {manifest_path}", file=sys.stderr)
        return {}
    if (
        manifest.get("elder_name") != persona.elder_name
        or manifest.get("family_relation") != persona.family_relation
    ):
        print(
            "warning: voice presets were recorded for another persona; re-run reme-voice-preset",
            file=sys.stderr,
        )
        return {}
    entries = manifest.get("entries")
    if not isinstance(entries, dict):
        return {}
    lines = _template_lines(persona)
    assets: dict[TemplateId, str] = {}
    for template, expected in lines.items():
        entry = entries.get(template.value)
        if not isinstance(entry, dict):
            continue
        filename, text = entry.get("file"), entry.get("text")
        if not isinstance(filename, str) or text != expected:
            continue
        if not (voice_dir / filename).is_file():
            continue
        assets[template] = f"{url_prefix}/{filename}"
    return assets


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="reme-voice-preset",
        description="Generate the danger link's preset check-in voice clips.",
    )
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--voice", default=DEFAULT_VOICE)
    parser.add_argument("--elder-name", default=PersonaConfig().elder_name)
    parser.add_argument("--family-relation", default=PersonaConfig().family_relation)
    args = parser.parse_args(argv)
    persona = PersonaConfig(elder_name=args.elder_name, family_relation=args.family_relation)
    try:
        files = generate_presets(args.out, persona=persona, voice=args.voice)
    except VoicePresetError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    for template, filename in sorted(files.items()):
        print(f"{template}: {args.out / filename}")
    print(f"manifest: {args.out / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
