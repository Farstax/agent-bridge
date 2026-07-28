#!/usr/bin/env python3
"""Stage and validate one immutable Agent Bridge release artifact.

This command does not stop services, touch databases, switch a pointer, or
change a Git checkout. Production invocation is root-only; the explicit test
environment escape is used only by fixture tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import tarfile
import tempfile
from pathlib import Path
from typing import BinaryIO


SHA = 40
SHA256 = 64


def production_mode() -> bool:
    return os.environ.get("AGENT_BRIDGE_RELEASE_STAGE_TEST") != "1"


def fail(message: str) -> None:
    raise RuntimeError(message)


def safe_relative(name: str) -> str:
    path = Path(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        fail(f"unsafe archive path: {name}")
    return "/".join(path.parts)


def safe_target(path: Path, target: str, root: Path) -> None:
    if os.path.isabs(target):
        fail(f"absolute symlink target is not allowed: {path} -> {target}")
    resolved = (path.parent / target).resolve()
    if resolved != root and root not in resolved.parents:
        fail(f"symlink escaped release root: {path} -> {target}")


def digest_stream(stream: BinaryIO) -> str:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        hasher.update(chunk)
    return hasher.hexdigest()


def snapshot_stream(source: BinaryIO, snapshot: BinaryIO) -> str:
    hasher = hashlib.sha256()
    for chunk in iter(lambda: source.read(1024 * 1024), b""):
        hasher.update(chunk)
        snapshot.write(chunk)
    snapshot.flush()
    return hasher.hexdigest()


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return digest_stream(stream)


def open_archive(path: Path) -> BinaryIO:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        fail(f"unable to open archive safely: {error}")
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        fail("archive must resolve to a regular file")
    return os.fdopen(descriptor, "rb", closefd=True)


def provenance_path(release_root: Path, expected_commit: str) -> Path:
    return release_root / f".{expected_commit}.staging-provenance.json"


def staging_helper_sha256() -> str:
    return hashlib.sha256(Path(__file__).resolve().read_bytes()).hexdigest()


def load_provenance(path: Path, expected_commit: str, expected_archive_sha256: str) -> dict:
    if path.is_symlink() or not path.is_file():
        fail("staging provenance is missing or is not a regular file")
    if path.stat().st_mode & 0o222:
        fail("staging provenance must be immutable")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid staging provenance: {error}")
    if value != {"archive_sha256": expected_archive_sha256, "commit": expected_commit, "release_stage_sha256": staging_helper_sha256(), "schema_version": 1}:
        fail("staging provenance identity does not match the expected commit or archive SHA-256")
    return value


def publish_provenance(release_root: Path, expected_commit: str, archive_sha256: str) -> None:
    target = provenance_path(release_root, expected_commit)
    if target.exists() or target.is_symlink():
        load_provenance(target, expected_commit, archive_sha256)
        return
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{expected_commit}.provenance-", dir=release_root)
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        temporary.write_text(json.dumps({
            "schema_version": 1,
            "commit": expected_commit,
            "archive_sha256": archive_sha256,
            "release_stage_sha256": staging_helper_sha256(),
        }, sort_keys=True) + "\n", encoding="utf-8")
        os.chmod(temporary, 0o444)
        if production_mode():
            os.chown(temporary, 0, 0)
        try:
            os.link(temporary, target)
        except FileExistsError:
            load_provenance(target, expected_commit, archive_sha256)
    finally:
        temporary.unlink(missing_ok=True)


def load_manifest(root: Path) -> dict:
    path = root / "manifest.json"
    if not path.is_file() or path.is_symlink():
        fail("release artifact is missing a regular manifest.json")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"invalid release manifest: {error}")
    if manifest.get("schema_version") != 1:
        fail("unsupported release manifest schema")
    commit = manifest.get("commit")
    tree = manifest.get("tree")
    if not isinstance(commit, str) or len(commit) != SHA or any(c not in "0123456789abcdef" for c in commit):
        fail("manifest commit is not a full lowercase SHA")
    if not isinstance(tree, str) or len(tree) != SHA or any(c not in "0123456789abcdef" for c in tree):
        fail("manifest tree is not a full lowercase SHA")
    if not isinstance(manifest.get("files"), list):
        fail("manifest files must be a list")
    return manifest


def verify_manifest(root: Path, manifest: dict) -> None:
    expected: dict[str, dict] = {}
    for entry in manifest["files"]:
        path = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(path, str):
            fail("manifest file path is invalid")
        path = safe_relative(path)
        if path == "manifest.json" or path in expected:
            fail(f"manifest contains duplicate or self-referential file: {path}")
        expected[path] = entry

    actual: set[str] = set()
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        directories[:] = sorted(directories)
        files = sorted(files)
        for name in files + directories:
            path = current_path / name
            relative = path.relative_to(root).as_posix()
            if relative == "manifest.json":
                continue
            if path.is_symlink():
                actual.add(relative)
                entry = expected.get(relative)
                if not entry or entry.get("type") != "symlink" or os.readlink(path) != entry.get("target"):
                    fail(f"release symlink does not match manifest: {relative}")
            elif path.is_file():
                actual.add(relative)
                entry = expected.get(relative)
                if not entry or entry.get("type", "file") != "file":
                    fail(f"release file is not in the manifest: {relative}")
                if digest(path) != entry.get("sha256") or path.stat().st_size != entry.get("size"):
                    fail(f"release file hash or size mismatch: {relative}")
            elif path.is_dir():
                continue
            else:
                fail(f"unsupported release entry: {relative}")
    if actual != set(expected):
        fail("release contents do not match the manifest")
    lock = expected.get("package-lock.json")
    if not lock or lock.get("sha256") != manifest.get("package_lock_sha256"):
        fail("package-lock hash binding is invalid")


def extract_archive(archive: BinaryIO, destination: Path) -> None:
    seen: set[str] = set()
    with tarfile.open(fileobj=archive, mode="r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            if member.name in (".", "./"):
                continue
            relative = safe_relative(member.name)
            if relative in seen:
                fail(f"duplicate archive member: {relative}")
            seen.add(relative)
            target = destination / relative
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.issym():
                safe_target(target, member.linkname, destination)
                os.symlink(member.linkname, target)
                continue
            if member.islnk():
                linkname = member.linkname
                while linkname.startswith("./"):
                    linkname = linkname[2:]
                link_relative = safe_relative(linkname)
                if link_relative not in seen:
                    fail(f"hardlink target must precede link: {relative} -> {linkname}")
                source = destination / link_relative
                if source.is_symlink() or not source.is_file():
                    fail(f"hardlink target is not a regular file: {relative} -> {linkname}")
                os.link(source, target)
                continue
            if not member.isfile():
                fail(f"unsupported archive member: {relative}")
            source = bundle.extractfile(member)
            if source is None:
                fail(f"unable to read archive member: {relative}")
            with target.open("xb") as output:
                shutil.copyfileobj(source, output)
            os.chmod(target, member.mode & 0o777)


def make_immutable(root: Path) -> None:
    for current, directories, files in os.walk(root, topdown=False, followlinks=False):
        for name in files:
            path = Path(current) / name
            if path.is_symlink():
                continue
            mode = path.stat().st_mode
            os.chmod(path, 0o555 if mode & stat.S_IXUSR else 0o444)
            if production_mode():
                os.chown(path, 0, 0)
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink():
                os.chmod(path, 0o555)
                if production_mode():
                    os.chown(path, 0, 0)
    os.chmod(root, 0o555)
    if production_mode():
        os.chown(root, 0, 0)


def validate_release_root(release_root: Path) -> Path:
    if release_root.exists() or release_root.is_symlink():
        metadata = release_root.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            fail("release root must be a regular directory, not a symlink")
    else:
        release_root.mkdir(parents=True)
    metadata = release_root.stat()
    if production_mode() and (metadata.st_uid != 0 or metadata.st_mode & 0o022):
        fail("production release root must be root-owned and not group/world writable")
    return release_root


def validate_existing(release: Path, release_root: Path, expected_commit: str, archive_sha256: str) -> str:
    if release.is_symlink() or not release.is_dir():
        fail(f"existing release path is not a directory: {release}")
    manifest = load_manifest(release)
    if manifest["commit"] != expected_commit:
        fail("existing release commit does not match expected commit")
    verify_manifest(release, manifest)
    for current, directories, files in os.walk(release, followlinks=False):
        for name in directories + files:
            path = Path(current) / name
            if not path.is_symlink() and path.stat().st_mode & 0o222:
                fail("existing release is writable")
    load_provenance(provenance_path(release_root, expected_commit), expected_commit, archive_sha256)
    return f"already staged {expected_commit}"


def stage(archive: Path, release_root: Path, expected_commit: str, expected_archive_sha256: str) -> str:
    if len(expected_commit) != SHA or any(c not in "0123456789abcdef" for c in expected_commit):
        fail("expected commit must be a full lowercase 40-character SHA")
    if len(expected_archive_sha256) != SHA256 or any(c not in "0123456789abcdef" for c in expected_archive_sha256):
        fail("expected archive SHA-256 must be a full lowercase SHA-256")
    release_root = validate_release_root(release_root)
    with open_archive(archive) as archive_stream:
        with tempfile.TemporaryFile(prefix="agent-bridge-archive-") as snapshot:
            archive_sha256 = snapshot_stream(archive_stream, snapshot)
            if archive_sha256 != expected_archive_sha256:
                fail("archive SHA-256 does not match the expected digest")
            replacement = os.environ.get("AGENT_BRIDGE_RELEASE_STAGE_TEST_REPLACE_ARCHIVE")
            if replacement and not production_mode():
                os.replace(replacement, archive)
            if os.environ.get("AGENT_BRIDGE_RELEASE_STAGE_TEST_MUTATE_ARCHIVE") and not production_mode():
                with archive.open("r+b") as mutated:
                    mutated.truncate(0)
                    mutated.write(b"mutated after hashing")

            release = release_root / expected_commit
            if release.exists() or release.is_symlink():
                return validate_existing(release, release_root, expected_commit, archive_sha256)

            temporary = Path(tempfile.mkdtemp(prefix=f".staging-{expected_commit}-", dir=release_root))
            try:
                snapshot.seek(0)
                extract_archive(snapshot, temporary)
                manifest = load_manifest(temporary)
                if manifest["commit"] != expected_commit:
                    fail("archive manifest commit does not match expected commit")
                verify_manifest(temporary, manifest)
                make_immutable(temporary)
                try:
                    os.rename(temporary, release)
                except FileExistsError:
                    shutil.rmtree(temporary)
                    return validate_existing(release, release_root, expected_commit, archive_sha256)
                publish_provenance(release_root, expected_commit, archive_sha256)
                return f"staged {expected_commit}"
            except Exception:
                if temporary.exists():
                    shutil.rmtree(temporary)
                raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--release-root", type=Path, required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--archive-sha256", required=True)
    args = parser.parse_args()
    if os.geteuid() != 0 and os.environ.get("AGENT_BRIDGE_RELEASE_STAGE_TEST") != "1":
        fail("release staging must run as root")
    print(stage(args.archive, args.release_root, args.expected_commit, args.archive_sha256))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"release-stage: {error}", file=sys.stderr)
        raise SystemExit(1)
