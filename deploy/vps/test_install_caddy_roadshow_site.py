import importlib.util
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("install-caddy-roadshow-site.py")
SPEC = importlib.util.spec_from_file_location("install_caddy_roadshow_site", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("unable to load install-caddy-roadshow-site.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class InstallCaddyRoadshowSiteTests(unittest.TestCase):
    def test_appends_once_and_keeps_a_backup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caddyfile = root / "Caddyfile"
            site = root / "site"
            original = "example.com {\n    respond 200\n}\n"
            caddyfile.write_text(original, encoding="utf-8")
            site.write_text("reme.maniforld.com {\n    respond 200\n}\n", encoding="utf-8")

            backup = MODULE.install(caddyfile=caddyfile, site_file=site)
            self.assertIsNotNone(backup)
            self.assertEqual(backup.read_text(encoding="utf-8"), original)
            self.assertIn(MODULE.START, caddyfile.read_text(encoding="utf-8"))
            self.assertIsNone(MODULE.install(caddyfile=caddyfile, site_file=site))

    def test_check_does_not_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caddyfile = root / "Caddyfile"
            site = root / "site"
            original = "example.com { respond 200 }\n"
            caddyfile.write_text(original, encoding="utf-8")
            site.write_text("reme.maniforld.com { respond 200 }\n", encoding="utf-8")
            self.assertIsNone(MODULE.install(caddyfile=caddyfile, site_file=site, check=True))
            self.assertEqual(caddyfile.read_text(encoding="utf-8"), original)

    def test_refuses_unmanaged_or_different_existing_site(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caddyfile = root / "Caddyfile"
            site = root / "site"
            site.write_text("reme.maniforld.com { respond 200 }\n", encoding="utf-8")
            caddyfile.write_text("reme.maniforld.com { respond 404 }\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unmanaged"):
                MODULE.install(caddyfile=caddyfile, site_file=site)


if __name__ == "__main__":
    unittest.main()
