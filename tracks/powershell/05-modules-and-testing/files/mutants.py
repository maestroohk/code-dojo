#!/usr/bin/env python3
# Checks the learner's Pester tests the way a reviewer would: they must pass on the real LogTools module, and FAIL
# on each broken copy of it (a mutant). Every run uses a fresh copy of ~/src/LogTools in a temporary folder, so the
# tests must import the module relative to themselves ("$PSScriptRoot/../LogTools.psd1").
# Usage: mutants.py pass <min-tests> <file> | mutant <name> <file>
import os, shutil, subprocess, sys, tempfile

MUTANTS = {
    "inverted": ("Where-Object LastWriteTime -lt $cutoff", "Where-Object LastWriteTime -gt $cutoff",
                 "Get-OldLog returns the NEW files instead of the old ones"),
    "ignores-days": ("$cutoff = Get-Cutoff $Days\n    Get-ChildItem", "$cutoff = Get-Cutoff 30\n    Get-ChildItem",
                     "Get-OldLog ignores -Days and always uses 30"),
    "no-whatif": (" -and $PSCmdlet.ShouldProcess($File.FullName, 'Remove old log')", "",
                  "Remove-OldLog deletes even under -WhatIf"),
    "deletes-all": ("if ($File.LastWriteTime -lt $cutoff -and ", "if (",
                    "Remove-OldLog deletes every piped file, old or not"),
}

def run(mode, arg, test_file):
    src = os.path.expanduser("~/src/LogTools")
    tests = os.path.join(src, "tests", test_file)
    if not os.path.exists(tests):
        sys.exit(f"{tests} does not exist yet")
    tmp = tempfile.mkdtemp()
    dst = os.path.join(tmp, "LogTools")
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns(".git"))
    if mode == "mutant":
        old, new, what = MUTANTS[arg]
        psm1 = os.path.join(dst, "LogTools.psm1")
        code = open(psm1).read()
        if old not in code:
            sys.exit(f"could not build the mutant '{what}': LogTools.psm1 has changed (leave the module itself as it was)")
        open(psm1, "w").write(code.replace(old, new))
    ps = (f"$r = Invoke-Pester -Path '{os.path.join(dst, 'tests', test_file)}' -PassThru -Output None; "
          "\"$($r.Result) $($r.PassedCount) $($r.FailedCount) $($r.TotalCount)\"")
    out = subprocess.run(["pwsh", "-NoProfile", "-NonInteractive", "-c", ps], capture_output=True, text=True, timeout=25)
    shutil.rmtree(tmp, ignore_errors=True)
    lines = out.stdout.strip().splitlines()   # -WhatIf messages go to the host (stdout) too: the result is the last line
    parts = lines[-1].split() if lines else []
    if len(parts) != 4:
        sys.exit("Invoke-Pester did not run: " + (out.stdout + out.stderr).strip()[-400:])
    result, passed, failed, total = parts[0], int(parts[1]), int(parts[2]), int(parts[3])
    if mode == "pass":
        if failed or result != "Passed":
            sys.exit(f"on the real module your tests should pass, but {failed} of {total} failed (Invoke-Pester -Output Detailed shows why)")
        if total < int(arg):
            sys.exit(f"{total} tests; write at least {arg}")
        print(f"ok: {passed} tests pass on the real module")
    else:
        if failed == 0:
            sys.exit(f"your tests still pass when {MUTANTS[arg][2]}: add a test that catches it")
        print(f"ok: {failed} test(s) catch it when {MUTANTS[arg][2]}")

run(sys.argv[1], sys.argv[2], sys.argv[3])
