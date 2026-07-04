"""Tests for the vendored-asset downloader: which assets count as missing, that
downloads land atomically, and that a failed fetch keeps its CDN fallback. None
touch the network; ``_fetch`` is monkeypatched.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from htmlit_core import config, vendoring


@pytest.fixture
def vendor_dir(tmp_path: Path, monkeypatch) -> Path:
    monkeypatch.setattr(config, "VENDOR_DIR", tmp_path)
    return tmp_path


def _fake_fetch(monkeypatch, body: bytes = b"/* asset */") -> None:
    monkeypatch.setattr(vendoring, "_fetch", lambda url: body)


def test_missing_lists_every_asset_when_none_cached(vendor_dir: Path) -> None:
    assert vendoring.missing() == dict(config.VENDOR_CDN)


def test_missing_skips_a_cached_asset(vendor_dir: Path) -> None:
    name = next(iter(config.VENDOR_CDN))
    (vendor_dir / name).write_bytes(b"cached")
    assert name not in vendoring.missing()


def test_missing_treats_empty_file_as_absent(vendor_dir: Path) -> None:
    name = next(iter(config.VENDOR_CDN))
    (vendor_dir / name).write_bytes(b"")
    assert name in vendoring.missing()


def test_download_writes_all_assets_and_leaves_no_temp(vendor_dir: Path, monkeypatch) -> None:
    _fake_fetch(monkeypatch, b"data")
    saved, failed = vendoring.download(vendoring.missing())
    assert failed == {}
    assert sorted(saved) == sorted(config.VENDOR_CDN)
    for name in config.VENDOR_CDN:
        assert (vendor_dir / name).read_bytes() == b"data"
    assert list(vendor_dir.glob("*.part")) == []


def test_download_reports_failure_and_writes_nothing(vendor_dir: Path, monkeypatch) -> None:
    def boom(url: str) -> bytes:
        raise OSError("network down")

    monkeypatch.setattr(vendoring, "_fetch", boom)
    saved, failed = vendoring.download(vendoring.missing())
    assert saved == []
    assert set(failed) == set(config.VENDOR_CDN)
    assert "network down" in next(iter(failed.values()))
    assert list(vendor_dir.iterdir()) == []


def test_empty_response_is_a_failure(vendor_dir: Path, monkeypatch) -> None:
    _fake_fetch(monkeypatch, b"")
    saved, failed = vendoring.download({next(iter(config.VENDOR_CDN)): "http://x"})
    assert saved == []
    assert failed


def test_vendor_without_force_skips_cached(vendor_dir: Path, monkeypatch) -> None:
    cached = next(iter(config.VENDOR_CDN))
    (vendor_dir / cached).write_bytes(b"old")
    _fake_fetch(monkeypatch, b"new")
    saved, failed = vendoring.vendor(force=False)
    assert failed == {}
    assert cached not in saved
    assert (vendor_dir / cached).read_bytes() == b"old"


def test_vendor_force_redownloads_everything(vendor_dir: Path, monkeypatch) -> None:
    cached = next(iter(config.VENDOR_CDN))
    (vendor_dir / cached).write_bytes(b"old")
    _fake_fetch(monkeypatch, b"new")
    saved, failed = vendoring.vendor(force=True)
    assert failed == {}
    assert sorted(saved) == sorted(config.VENDOR_CDN)
    assert (vendor_dir / cached).read_bytes() == b"new"


def test_auto_vendor_defaults_on() -> None:
    assert config.AUTO_VENDOR is True
