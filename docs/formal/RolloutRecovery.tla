-------------------------- MODULE RolloutRecovery --------------------------
EXTENDS TLC
\* One role and one eligible accepted Workstream origin. Abstraction, not a
\* proof of SQLite transactions or provider-session authority.
VARIABLES fence, armed, origin, audit, stopped, claimed, process
vars == <<fence, armed, origin, audit, stopped, claimed, process>>
Init == /\ fence = FALSE /\ armed = FALSE /\ origin = "running"
        /\ audit = "none" /\ stopped = FALSE /\ claimed = FALSE /\ process = "live"
Admit == /\ ~fence /\ ~armed /\ origin = "running" /\ ~stopped
         /\ fence' = TRUE /\ armed' = TRUE
         /\ UNCHANGED <<origin, audit, stopped, claimed, process>>
Readmit == /\ ~fence /\ armed /\ origin = "running" /\ ~stopped
           /\ fence' = TRUE /\ UNCHANGED <<armed, origin, audit, stopped, claimed, process>>
AbortBeforeStop == /\ fence /\ origin = "running" /\ fence' = FALSE
                   /\ UNCHANGED <<armed, origin, audit, stopped, claimed, process>>
Interrupt == /\ fence /\ origin = "running" /\ origin' = "interrupted"
             /\ audit' = "proven" /\ UNCHANGED <<fence, armed, stopped, claimed, process>>
AmbiguousAudit == /\ fence /\ origin = "running" /\ origin' = "interrupted"
                  /\ audit' = "ambiguous" /\ UNCHANGED <<fence, armed, stopped, claimed, process>>
Release == /\ fence /\ origin = "interrupted" /\ fence' = FALSE
           /\ UNCHANGED <<armed, origin, audit, stopped, claimed, process>>
Stop == /\ ~fence /\ ~claimed /\ ~stopped /\ stopped' = TRUE
        /\ UNCHANGED <<fence, armed, origin, audit, claimed, process>>
Observe(p) == /\ ~claimed /\ p \in {"live", "absent", "ambiguous"} /\ process' = p
              /\ UNCHANGED <<fence, armed, origin, audit, stopped, claimed>>
Claim == /\ process = "absent" /\ armed /\ ~fence /\ origin = "interrupted" /\ audit = "proven"
         /\ ~stopped /\ ~claimed /\ claimed' = TRUE
         /\ UNCHANGED <<fence, armed, origin, audit, stopped, process>>
Next == (\E p \in {"live", "absent", "ambiguous"}: Observe(p)) \/ Admit \/ Readmit \/ AbortBeforeStop \/ Interrupt \/ AmbiguousAudit \/ Release \/ Stop \/ Claim
Spec == Init /\ [][Next]_vars
TypeOK == /\ fence \in BOOLEAN /\ armed \in BOOLEAN /\ stopped \in BOOLEAN /\ claimed \in BOOLEAN
          /\ process \in {"live", "absent", "ambiguous"} /\ origin \in {"running", "interrupted"} /\ audit \in {"none", "proven", "ambiguous"}
ClaimRequiresProof == claimed => (process = "absent" /\ armed /\ ~fence /\ origin = "interrupted" /\ audit = "proven" /\ ~stopped)
=============================================================================
