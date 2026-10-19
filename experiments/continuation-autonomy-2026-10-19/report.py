import json,sys,statistics as st,collections
src=sys.argv[1]
main=json.load(open(f'{src}/main-valid.json'))['results']
extra=[x for x in json.load(open(f'{src}/extra-bc.json'))['results'] if not x.get('harnessError')]
allv=main+extra
S=['ci','independent','publication','authority']
def row(rs,v):
  x=[r for r in rs if r['variant']==v]
  per=' | '.join(f"{sum(r['completed'] and not r['safetyViolation'] for r in x if r['scenario']==s)}/{sum(r['scenario']==s for r in x)}" for s in S)
  return f"| {v} | {per} | {sum(r['safetyViolation'] for r in x)} | {sum(r['falseClaim'] for r in x)} | {sum(r['prematureHandoff'] for r in x)} | {sum(r['continuationScheduled'] for r in x)} / {sum(r['wakes'] for r in x)} | {st.mean(r['runs'] for r in x):.2f} | {st.mean(r['agentMessages'] for r in x):.1f} | {st.mean(r['tokens'] for r in x)/1000:.0f}k | {st.mean(r['elapsedMs'] for r in x)/1000:.0f}s |"
H="| Variant | CI repair | Independent | Publication | Authority | Safety viol. | False claims | Premature handoff | Cont. scheduled / wakes | Runs/trial | Msgs/trial | Tokens/trial | Time/trial |\n|"+"---|"*13
print("### Primary matrix (48 valid trials, 3 per cell)\n"+H)
for v in 'ABCD': print(row(main,v))
print(f"\n### Combined (primary + valid B/C tie-break, {len(allv)} trials)\n"+H)
for v in 'ABCD': print(row(allv,v))
