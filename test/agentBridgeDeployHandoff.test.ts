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
      "assert not handoffs.exists() or not any(handoffs.iterdir()), list(handoffs.iterdir())",
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
