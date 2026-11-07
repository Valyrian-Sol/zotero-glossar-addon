#!/usr/bin/env python3
"""Erstellt das installierbare Zotero Add-on Paket `zotero-pdf-definitions.xpi`."""

from pathlib import Path
import shutil
import zipfile

ROOT = Path(__file__).resolve().parent
OUTPUT_XPI = ROOT / "zotero-pdf-definitions.xpi"


def build_xpi() -> Path:
    # main.js auch im Hauptverzeichnis bereitstellen (wie bei ZotLit / Zotero 10 Standard-XPIs)
    src_main = ROOT / "chrome" / "content" / "main.js"
    root_main = ROOT / "main.js"
    shutil.copyfile(src_main, root_main)

    if OUTPUT_XPI.exists():
        OUTPUT_XPI.unlink()

    files_to_package = [
        "manifest.json",
        "bootstrap.js",
        "main.js",
        "chrome/content/main.js",
        "icons/icon.svg",
    ]

    with zipfile.ZipFile(OUTPUT_XPI, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # Explizite Ordner-Einträge für den Mozilla AddonManager
        for dir_entry in ["icons/", "chrome/", "chrome/content/"]:
            zinfo = zipfile.ZipInfo(dir_entry)
            zinfo.external_attr = 0o40755 << 16
            zf.writestr(zinfo, "")

        for rel_path in files_to_package:
            src = ROOT / rel_path
            if not src.is_file():
                raise FileNotFoundError(f"Pflichtdatei fehlt: {src}")
            zf.write(src, arcname=rel_path)

    print(f"XPI erfolgreich erstellt: {OUTPUT_XPI} ({OUTPUT_XPI.stat().st_size} Bytes)")
    return OUTPUT_XPI


if __name__ == "__main__":
    build_xpi()
