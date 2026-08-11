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
            original_inode = caddyfile.stat().st_ino

            backup = MODULE.install(caddyfile=caddyfile, site_file=site)
            self.assertIsNotNone(backup)
            self.assertEqual(backup.read_text(encoding="utf-8"), original)
            self.assertIn(MODULE.START, caddyfile.read_text(encoding="utf-8"))
            self.assertEqual(caddyfile.stat().st_ino, original_inode)
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

    def test_updates_only_an_explicitly_managed_block_and_preserves_inode(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            caddyfile = root / "Caddyfile"
            site = root / "site"
            original = (
                "example.com { respond 200 }\n\n"
                f"{MODULE.START}\n"
                "reme.maniforld.com { respond 404 }\n"
                f"{MODULE.END}\n"
            )
            caddyfile.write_text(original, encoding="utf-8")
            site.write_text("reme.maniforld.com { respond 200 }\n", encoding="utf-8")
            original_inode = caddyfile.stat().st_ino

            with self.assertRaisesRegex(ValueError, "differs"):
                MODULE.install(caddyfile=caddyfile, site_file=site)

            backup = MODULE.install(
                caddyfile=caddyfile,
                site_file=site,
                update_managed=True,
            )
            self.assertIsNotNone(backup)
            self.assertEqual(backup.read_text(encoding="utf-8"), original)
            self.assertIn("respond 200", caddyfile.read_text(encoding="utf-8"))
            self.assertNotIn("respond 404", caddyfile.read_text(encoding="utf-8"))
            self.assertEqual(caddyfile.stat().st_ino, original_inode)


if __name__ == "__main__":
    unittest.main()
