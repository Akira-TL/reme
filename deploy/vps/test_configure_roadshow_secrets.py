import importlib.util
import stat
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("configure-roadshow-secrets.py")
SPEC = importlib.util.spec_from_file_location("configure_roadshow_secrets", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load configure-roadshow-secrets.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigureRoadshowSecretsTests(unittest.TestCase):
    def test_builds_matching_private_bindings_without_leaking_to_public_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mimo = root / "mimo.env"
            coturn = root / "turnserver.conf"
            relay = root / "relay.dev.vars"
            mimo.write_text("MIMO_API_KEY=test-mimo-key\n", encoding="utf-8")
            coturn.write_text(
                "use-auth-secret\nstatic-auth-secret=test-turn-secret\n",
                encoding="utf-8",
            )

            backend_content, relay_content = MODULE.build_configs(
                mimo_env=mimo,
                coturn_config=coturn,
                existing_relay_env=relay,
                origin="https://reme.example",
                public_ip="192.0.2.8",
            )

            self.assertIn('MIMO_API_KEY="test-mimo-key"', backend_content)
            self.assertNotIn("test-turn-secret", backend_content)
            self.assertIn('REME_TURN_SHARED_SECRET="test-turn-secret"', relay_content)
            self.assertIn('ALLOWED_ORIGINS="https://reme.example"', relay_content)
            backend = root / "backend.env"
            backend.write_text(backend_content, encoding="utf-8")
            relay.write_text(relay_content, encoding="utf-8")
            backend_values = MODULE.parse_assignment_file(backend)
            relay_values = MODULE.parse_assignment_file(relay)
            self.assertEqual(
                backend_values["REME_FAMILY_RELAY_TOKEN"],
                relay_values["RUNTIME_INGEST_TOKEN"],
            )

    def test_reuses_existing_runtime_token_and_writes_mode_600(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mimo = root / "mimo.env"
            coturn = root / "turnserver.conf"
            relay = root / "relay.dev.vars"
            backend = root / "backend.env"
            token = "A" * 48
            mimo.write_text("MIMO_API_KEY=test-mimo-key\n", encoding="utf-8")
            coturn.write_text("static-auth-secret test-turn-secret\n", encoding="utf-8")
            relay.write_text(f"RUNTIME_INGEST_TOKEN={token}\n", encoding="utf-8")
            backend_content, relay_content = MODULE.build_configs(
                mimo_env=mimo,
                coturn_config=coturn,
                existing_relay_env=relay,
                origin="https://reme.example",
                public_ip="192.0.2.8",
            )
            self.assertIn(token, backend_content)
            self.assertIn(token, relay_content)
            MODULE.atomic_private_write(backend, backend_content)
            self.assertEqual(stat.S_IMODE(backend.stat().st_mode), 0o600)

    def test_rejects_missing_turn_secret(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mimo = root / "mimo.env"
            coturn = root / "turnserver.conf"
            relay = root / "relay.dev.vars"
            mimo.write_text("MIMO_API_KEY=test-mimo-key\n", encoding="utf-8")
            coturn.write_text("realm=reme.example\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "static-auth-secret"):
                MODULE.build_configs(
                    mimo_env=mimo,
                    coturn_config=coturn,
                    existing_relay_env=relay,
                    origin="http://reme.example",
                    public_ip="192.0.2.8",
                )

    def test_rejects_plaintext_origin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mimo = root / "mimo.env"
            coturn = root / "turnserver.conf"
            relay = root / "relay.dev.vars"
            mimo.write_text("MIMO_API_KEY=test-mimo-key\n", encoding="utf-8")
            coturn.write_text("static-auth-secret=test-turn-secret\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "HTTPS origin"):
                MODULE.build_configs(
                    mimo_env=mimo,
                    coturn_config=coturn,
                    existing_relay_env=relay,
                    origin="http://reme.example",
                    public_ip="192.0.2.8",
                )


if __name__ == "__main__":
    unittest.main()
