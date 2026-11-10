"""Turn compiler errors and test failures in a cargo log into GitHub annotations.

Annotations are readable through the public API, so failures can be triaged without log access.
GitHub keeps at most 10 error annotations per step, so blocks are packed into ≤ 10 messages.
"""
import re
import sys

MAX_ANNOTATIONS = 10
MAX_CHARS = 20_000

log = open(sys.argv[1], encoding="utf-8", errors="replace").read()
log = re.sub(r"\x1b\[[0-9;]*m", "", log)
lines = log.splitlines()

blocks = []
i = 0
while i < len(lines):
    line = lines[i]
    starts_error = re.match(r"^error(\[E\d+\])?:", line)
    starts_test = re.match(r"^---- .* stdout ----$", line)
    if starts_error or starts_test:
        j = i + 1
        while j < len(lines) and lines[j].strip() != "" and not re.match(r"^(error|warning|---- )", lines[j]):
            j += 1
        if starts_test:  # test output blocks run until the next block header
            while j < len(lines) and not re.match(r"^(---- |failures:|test result:)", lines[j]):
                j += 1
        blocks.append("\n".join(lines[i:j]).strip())
        i = j
    else:
        i += 1

summary = [l for l in lines if l.startswith("test result:") or re.match(r"^test .* \.\.\. FAILED$", l)]
if summary:
    blocks.append("\n".join(summary))
if not blocks:
    blocks = ["\n".join(lines[-60:])]

per = max(1, -(-len(blocks) // MAX_ANNOTATIONS))
for k in range(0, len(blocks), per):
    msg = "\n\n".join(blocks[k : k + per])[:MAX_CHARS]
    msg = msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
    print(f"::error title=cargo ({k // per + 1})::{msg}")
