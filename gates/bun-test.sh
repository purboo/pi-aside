#!/usr/bin/env bash
# Runs `bun test` with the given arguments, unchanged, then prints owed's counts line (owed SPEC RC2) from bun's summary:
# `owed-counts {"pass":P,"fail":F,"skip":S,"failed":[...]}`. Without a summary (a crash) it prints none, so min_tests fails.
log=$(mktemp)
trap 'rm -f "$log"' EXIT
bun test "$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
python3 - "$log" <<'EOF'
import json, re, sys
t = open(sys.argv[1], encoding="utf-8", errors="replace").read()
def last(word):
    m = re.findall(r"^ *(\d+) " + word + r"$", t, re.M)
    return int(m[-1]) if m else None
p, f, s = last("pass"), last("fail"), last("skip")
if p is not None:
    failed = [re.sub(r" \[[0-9.]+m?s\]$", "", x) for x in re.findall(r"^\(fail\) (.+)$", t, re.M)][:50]
    d = {"pass": p, "fail": f or 0, "skip": s or 0}
    if failed:
        d["failed"] = failed
    print("owed-counts " + json.dumps(d))
EOF
exit "$rc"
