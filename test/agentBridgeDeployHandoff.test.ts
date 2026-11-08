import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function probe(program: string) {
  const root = mkdtempSync(join(tmpdir(), "deploy-handoff-"));
  roots.push(root);
  const script = [
    "import importlib.util, hashlib, json, os, pathlib, types, sys",
    "spec = importlib.util.spec_from_file_location('bridge_deploy', " + JSON.stringify(resolve("scripts/agent-bridge-deploy.py")) + ")",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "root = pathlib.Path(sys.argv[1])",
    "archive = root / 'source.tar.gz'",
    "archive.write_bytes(b'verified source artifact')",
    "sha256 = hashlib.sha256(archive.read_bytes()).hexdigest()",
    "commit = 'a' * 40",
    "os.environ['AGENT_BRIDGE_DEPLOY_TEST'] = '1'",
    "os.environ['AGENT_BRIDGE_DEPLOY_TEST_LOCK_FILE'] = str(root / 'deploy.lock')",
    "os.environ['AGENT_BRIDGE_DEPLOY_TEST_HANDOFF_ROOT'] = str(root / 'handoffs')",
    "os.environ['AGENT_BRIDGE_DEPLOY_TEST_RETIRED_HANDOFF_ROOT'] = str(root / 'retired')",
    "module.os.geteuid = lambda: 1000",
    "def fake_validate(path, *args):",
    "    module.VERIFIED_MANIFESTS[sha256] = {'commit': commit, '_staging_footprint': (4096, 2, path.stat().st_size)}",
    "    return (commit, sha256, None)",
    "module.validate_archive = fake_validate",
    "calls = []",
    "def fake_run(argv, **kwargs):",
    "    calls.append(argv)",
    "    return types.SimpleNamespace(returncode=0)",
    "module.subprocess.run = fake_run",
    program,
  ].join("\n");
  return spawnSync("python3", ["-c", script, root], { encoding: "utf8" });
}

describe("durable independent OSS deployer handoff (#1347)", () => {
  it("copies exact archive before returning and starts an independent non-waiting worker", () => {
    const result = probe([
      "receipt = module.accept_handoff(archive, None, None)",
      "assert receipt.startswith('accepted ' + commit + ' ' + sha256 + ' unit=')",
      "archive.unlink()",
      "copied = root / 'handoffs' / (commit + '-' + sha256) / 'release.tar.gz'",
      "assert copied.read_bytes() == b'verified source artifact'",
      "assert len(calls) == 1",
      "assert '--wait' not in calls[0]",
      "assert '--internal-worker' in calls[0]",
      "assert '--handoff-id=' + commit + '-' + sha256 in calls[0]",
      "progress = json.loads((copied.parent / 'result.json').read_text())",
      "assert progress['status'] == 'accepted' and progress['archiveSha256'] == sha256",
      "assert progress['approvalReference'] == 'control-plane-pinned-release'",
      "print(receipt)",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("accepted ");
  });

  it("resumes the same exact immutable pending request without selecting a newer release", () => {
    const result = probe([
      "assert module.resume_pending_handoff() == 'none'",
      "module.accept_handoff(archive, None, None)",
      "archive.unlink()",
      "module.validate_archive = lambda *args: (_ for _ in ()).throw(RuntimeError('original approval expired'))",
      "result = module.resume_pending_handoff()",
      "assert result.startswith('accepted ' + commit + ' ' + sha256)",
      "assert len(calls) == 2",
      "print('same-identity')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("same-identity");
  });

  it("refuses a different release while another accepted request is unresolved", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'second release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "module.validate_archive = lambda *args: ('b' * 40, other_sha, None)",
      "try:",
      "    module.accept_handoff(other, None, None)",
      "    raise AssertionError('second pending request was accepted')",
      "except RuntimeError as e:",
      "    assert 'unresolved' in str(e)",
      "assert not (root / 'handoffs' / ('b' * 40 + '-' + other_sha)).exists() or not (root / 'handoffs' / ('b' * 40 + '-' + other_sha) / 'release.tar.gz').exists()",
      "print('refused')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("refused");
  });

  it("does not classify loose session wording as a retryable refusal", () => {
    const source = readFileSync(resolve("scripts/agent-bridge-deploy.py"), "utf8");
    expect(source).not.toContain("provider.*active");
    expect(source).toContain("\\bprovider_sessions_active\\b");
  });

  it("rejects changed durable bytes", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "path = root / 'handoffs' / (commit + '-' + sha256) / 'release.tar.gz'",
      "path.write_bytes(b'tampered')",
      "try:",
      "    module.accept_handoff(archive, None, None)",
      "    raise AssertionError('tampered archive was accepted')",
      "except RuntimeError as e:",
      "    assert 'checksum mismatch' in str(e)",
      "print('rejected')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("rejected");
  });

  it("writes verified only after completion and preserves a deferred receipt on failure", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "identity = commit + '-' + sha256",
      "directory = root / 'handoffs' / identity",
      "durable = directory / 'release.tar.gz'",
      "module.run_deployment = lambda *args: 'deployed'",
      "assert module.finish_handoff_worker(identity, durable, None, None) == 'deployed'",
      "assert json.loads((directory / 'result.json').read_text())['status'] == 'verified'",
      "assert not durable.exists()",
      "try:",
      "    module.finish_handoff_worker(identity, durable, None, None)",
      "    raise AssertionError('verified handoff was run again')",
      "except (RuntimeError, SystemExit):",
      "    pass",
      "assert json.loads((directory / 'result.json').read_text())['status'] == 'verified'",
      "# A fresh request for the same identity is a new accepted receipt with a new private archive.",
      "durable.write_bytes(b'verified source artifact')",
      "durable.chmod(0o600)",
      "module.update_handoff_result(directory, 'accepted', commit, sha256)",
      "def fail_worker(*args):",
      "    raise RuntimeError('disk_headroom_insufficient')",
      "module.run_deployment = fail_worker",
      "try:",
      "    module.finish_handoff_worker(identity, durable, None, None)",
      "except RuntimeError:",
      "    pass",
      "assert json.loads((directory / 'result.json').read_text())['status'] == 'deferred'",
      "def hard_failure(*args):",
      "    raise RuntimeError('rollback_ambiguous')",
      "module.run_deployment = hard_failure",
      "try:",
      "    module.finish_handoff_worker(identity, durable, None, None)",
      "except RuntimeError:",
      "    pass",
      "assert json.loads((directory / 'result.json').read_text())['status'] == 'failed'",
      "try:",
      "    module.resume_pending_handoff()",
      "    raise AssertionError('hard failure was silently skipped')",
      "except RuntimeError:",
      "    pass",
      "print('checked')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("checked");
  });
});

describe("terminally failed handoff retirement", () => {
  it("refuses a replacement while a failed receipt remains unless explicitly superseded", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "module.update_handoff_result(directory, 'failed', commit, sha256, 'action_required')",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'second release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "module.validate_archive = lambda *args: ('b' * 40, other_sha, None)",
      "try:",
      "    module.accept_handoff(other, None, None)",
      "    raise AssertionError('failed receipt was silently replaced')",
      "except RuntimeError as error:",
      "    assert 'unresolved' in str(error)",
      "assert directory.exists()",
      "print('blocked')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("blocked");
  });

  it("retires a terminally failed handoff with an audit record and then accepts the replacement", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "module.update_handoff_result(directory, 'failed', commit, sha256, 'action_required')",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'second release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "other_commit = 'b' * 40",
      "def fake_other_validate(path, *args):",
      "    module.VERIFIED_MANIFESTS[other_sha] = {'commit': other_commit, '_staging_footprint': (4096, 2, path.stat().st_size)}",
      "    return (other_commit, other_sha, None)",
      "module.validate_archive = fake_other_validate",
      "receipt = module.accept_handoff(other, None, None, supersede_failed=True)",
      "assert receipt.startswith('accepted ' + other_commit)",
      "assert not directory.exists()",
      "retired = list((root / 'retired').iterdir())",
      "assert len(retired) == 1",
      "audit = json.loads((retired[0] / 'retirement.json').read_text())",
      "assert audit['originalIdentity'] == commit + '-' + sha256",
      "assert audit['originalStatus'] == 'failed'",
      "assert audit['originalDetail'] == 'action_required'",
      "assert audit['supersededBy'] == other_commit + '-' + other_sha",
      "assert audit['reason'] == 'terminally_failed_handoff_superseded'",
      "assert (retired[0] / 'result.json').exists()",
      "print('superseded')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("superseded");
  });

  it("keeps the failed receipt when supersede admission fails so a later accept stays closed", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "module.update_handoff_result(directory, 'failed', commit, sha256, 'action_required')",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'second release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "other_commit = 'b' * 40",
      "def fake_other_validate(path, *args):",
      "    module.VERIFIED_MANIFESTS[other_sha] = {'commit': other_commit, '_staging_footprint': (4096, 2, path.stat().st_size)}",
      "    return (other_commit, other_sha, None)",
      "module.validate_archive = fake_other_validate",
      "module.admit_staging = lambda *args: (_ for _ in ()).throw(RuntimeError('disk_headroom_insufficient'))",
      "try:",
      "    module.accept_handoff(other, None, None, supersede_failed=True)",
      "    raise AssertionError('failed admission still superseded')",
      "except RuntimeError as error:",
      "    assert 'disk_headroom_insufficient' in str(error)",
      "assert directory.exists()",
      "assert json.loads((directory / 'result.json').read_text())['status'] == 'failed'",
      "assert not (root / 'retired').exists() or list((root / 'retired').iterdir()) == []",
      "module.admit_staging = lambda *args: None",
      "try:",
      "    module.accept_handoff(other, None, None)",
      "    raise AssertionError('failed receipt was silently replaced after a partial supersede')",
      "except RuntimeError as error:",
      "    assert 'unresolved' in str(error)",
      "print('interlock-held')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("interlock-held");
  });

  it("refuses to supersede an accepted, deferred, or active failed handoff", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'second release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "module.validate_archive = lambda *args: ('b' * 40, other_sha, None)",
      "try:",
      "    module.accept_handoff(other, None, None, supersede_failed=True)",
      "    raise AssertionError('accepted receipt was superseded')",
      "except RuntimeError as error:",
      "    assert 'unresolved' in str(error)",
      "module.update_handoff_result(directory, 'deferred', commit, sha256, 'disk_headroom_insufficient')",
      "try:",
      "    module.accept_handoff(other, None, None, supersede_failed=True)",
      "    raise AssertionError('deferred receipt was superseded')",
      "except RuntimeError as error:",
      "    assert 'unresolved' in str(error)",
      "module.update_handoff_result(directory, 'failed', commit, sha256, 'action_required')",
      "os.environ['AGENT_BRIDGE_DEPLOY_TEST_HANDOFF_UNIT_ACTIVE'] = module.handoff_unit(commit, sha256)",
      "try:",
      "    module.accept_handoff(other, None, None, supersede_failed=True)",
      "    raise AssertionError('active failed worker was superseded')",
      "except RuntimeError as error:",
      "    assert 'still active' in str(error)",
      "assert directory.exists()",
      "print('protected')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("protected");
  });

  it("refuses to supersede when more than one failed receipt is present", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "first = root / 'handoffs' / (commit + '-' + sha256)",
      "module.update_handoff_result(first, 'failed', commit, sha256, 'action_required')",
      "second_commit = 'c' * 40",
      "second_sha = 'd' * 64",
      "second = root / 'handoffs' / (second_commit + '-' + second_sha)",
      "second.mkdir(mode=0o700)",
      "(second / 'result.json').write_text(json.dumps({'status':'failed','targetCommit':second_commit,'archiveSha256':second_sha,'detail':'action_required'}) + '\\n')",
      "(second / 'result.json').chmod(0o600)",
      "other = root / 'other.tar.gz'",
      "other.write_bytes(b'third release')",
      "other_sha = hashlib.sha256(other.read_bytes()).hexdigest()",
      "def fake_other_validate(path, *args):",
      "    module.VERIFIED_MANIFESTS[other_sha] = {'commit': 'b' * 40, '_staging_footprint': (4096, 2, path.stat().st_size)}",
      "    return ('b' * 40, other_sha, None)",
      "module.validate_archive = fake_other_validate",
      "try:",
      "    module.accept_handoff(other, None, None, supersede_failed=True)",
      "    raise AssertionError('two failed receipts were superseded')",
      "except RuntimeError as error:",
      "    assert 'bounded recovery audit' in str(error)",
      "assert first.exists() and second.exists()",
      "print('audit')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("audit");
  });

  it("retires a failed handoff through --retire-failed without accepting a replacement", () => {
    const result = probe([
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "module.update_handoff_result(directory, 'failed', commit, sha256, 'action_required')",
      "outcome = module.retire_failed_handoff()",
      "assert outcome.startswith('retired ' + commit + '-' + sha256)",
      "assert not directory.exists()",
      "retired = list((root / 'retired').iterdir())",
      "assert len(retired) == 1",
      "audit = json.loads((retired[0] / 'retirement.json').read_text())",
      "assert audit['supersededBy'] is None",
      "assert audit['reason'] == 'terminally_failed_handoff_retired'",
      "print(outcome)",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("retired ");
  });

  it("refuses to retire an ambiguous or live handoff through --retire-failed", () => {
    const result = probe([
      "try:",
      "    module.retire_failed_handoff()",
      "    raise AssertionError('empty spool was retired')",
      "except RuntimeError as error:",
      "    assert 'no terminally failed' in str(error)",
      "module.accept_handoff(archive, None, None)",
      "directory = root / 'handoffs' / (commit + '-' + sha256)",
      "try:",
      "    module.retire_failed_handoff()",
      "    raise AssertionError('accepted receipt was retired')",
      "except RuntimeError as error:",
      "    assert 'unresolved' in str(error)",
      "(directory / 'result.json').write_text('{')",
      "try:",
      "    module.retire_failed_handoff()",
      "    raise AssertionError('ambiguous receipt was retired')",
      "except RuntimeError as error:",
      "    assert 'cannot be safely inventoried' in str(error) or 'invalid' in str(error).lower()",
      "print('refused')",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("refused");
  });
});

describe("handoff staging disk admission (#1100)", () => {
  it("refuses before writing the durable archive copy when staging would not fit", () => {
    const result = probe([
      "os.environ['AGENT_BRIDGE_DEPLOY_TEST_AVAILABLE_BYTES'] = str(268435456)",
      "os.environ['AGENT_BRIDGE_DEPLOY_TEST_RELEASE_ROOT'] = str(root / 'releases')",
      "try:",
      "    module.accept_handoff(archive, None, None)",
      "except RuntimeError as error:",
      "    print(error)",
      "else:",
      "    raise SystemExit('handoff unexpectedly accepted')",
      "handoffs = root / 'handoffs'",
      "assert not handoffs.exists(), list(handoffs.iterdir()) if handoffs.exists() else []",
      "assert calls == []",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/staging disk admission refused/);
  });

  it("refuses an archive whose size changed after verification", () => {
    const result = probe([
      "module.validate_archive(archive)",
      "archive.write_bytes(b'replaced after verification with more bytes')",
      "try:",
      "    module.admit_staging(archive, commit, sha256, root / 'releases', False)",
      "except RuntimeError as error:",
      "    print(error)",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("release archive changed after verification");
  });
});

describe("bounded archive copies (#1100)", () => {
  it("refuses a source that grew after admission without copying the excess", () => {
    const result = probe([
      "real_admit = module.admit_staging",
      "def admit_then_grow(*args, **kwargs):",
      "    real_admit(*args, **kwargs)",
      "    with archive.open('ab') as grow:",
      "        grow.write(b'x' * (4 * 1024 * 1024))",
      "module.admit_staging = admit_then_grow",
      "try:",
      "    module.accept_handoff(archive, None, None)",
      "except RuntimeError as error:",
      "    print(error)",
      "copied = root / 'handoffs' / (commit + '-' + sha256) / 'release.tar.gz'",
      "assert not copied.exists()",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("release archive changed during handoff");
  });

  it("fails closed when an old stage helper cannot bound a caller-writable archive in production", () => {
    const result = probe([
      "module.validate_archive(archive)",
      "helper = root / 'old-release-stage.py'",
      "helper.write_text('def stage(*args):\\n    pass\\n')",
      "try:",
      "    module.snapshot_limit_args(helper, archive, sha256, True)",
      "except RuntimeError as error:",
      "    print(error)",
      "print('limit', module.snapshot_limit_args(pathlib.Path(" + JSON.stringify(resolve("scripts/release-stage.py")) + "), archive, sha256, True))",
    ].join("\n"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("installed release-stage cannot bound its archive snapshot");
    expect(result.stdout).toMatch(/limit \['--max-archive-bytes', '\d+'\]/);
  });
});
