--------------------------- MODULE EventReceipt ---------------------------
EXTENDS Naturals, TLC
\* Telegram/Slack receipt abstraction for one idempotency key. Retention and
\* underlying transaction semantics are assumed; external effects are separate.
VARIABLES status, linked, dispatches, ambiguousEver
vars == <<status, linked, dispatches, ambiguousEver>>
Init == /\ status = "absent" /\ linked = FALSE /\ dispatches = 0 /\ ambiguousEver = FALSE
Receive == /\ status = "absent" /\ status' = "received" /\ UNCHANGED <<linked, dispatches, ambiguousEver>>
Duplicate == /\ status # "absent" /\ UNCHANGED vars
Claim == /\ status = "received" /\ status' = "dispatching" /\ dispatches' = dispatches + 1 /\ UNCHANGED <<linked, ambiguousEver>>
Link == /\ ~linked /\ status \in {"received", "dispatching", "completed"}
        /\ linked' = TRUE /\ status' = IF status = "completed" THEN status ELSE "run_created"
        /\ UNCHANGED <<dispatches, ambiguousEver>>
Finish(s) == /\ status \in {"dispatching", "run_created"} /\ s \in {"completed", "failed", "cancelled", "ambiguous"}
             /\ status' = s /\ ambiguousEver' = (ambiguousEver \/ (s = "ambiguous"))
             /\ UNCHANGED <<linked, dispatches>>
Next == Receive \/ Duplicate \/ Claim \/ Link \/ (\E s \in {"completed", "failed", "cancelled", "ambiguous"}: Finish(s))
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"absent", "received", "dispatching", "run_created", "completed", "failed", "cancelled", "ambiguous"}
          /\ linked \in BOOLEAN /\ ambiguousEver \in BOOLEAN /\ dispatches \in Nat
OneDispatch == dispatches <= 1
AmbiguityTerminal == ambiguousEver => status = "ambiguous"
=============================================================================
