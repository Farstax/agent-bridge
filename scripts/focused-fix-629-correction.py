from pathlib import Path
p = Path('src/scheduledRunCorrelation.ts')
text = p.read_text()
old = '    if (runId !== null && !/^[0-9a-f-]{16,120}$/i.test(runId)) return null;'
new = '    if (runId !== null && !/^[A-Za-z0-9_.:-]{1,120}$/.test(runId)) return null;'
if old not in text:
    raise SystemExit('expected scheduled Run-id validation not found')
p.write_text(text.replace(old, new, 1))
