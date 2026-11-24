------------------------- MODULE AutonomyReconcile -------------------------
EXTENDS TLC
\* One cycle's disposition/reconciliation boundary. Atomic transitions abstract
\* the database transaction and do not represent process containment.
VARIABLES goal, run, receipt, wake, disposition, reconciled, wasCancelled
vars == <<goal, run, receipt, wake, disposition, reconciled, wasCancelled>>
Init == /\ goal = "active" /\ run = "running" /\ receipt = "claimed"
        /\ wake = FALSE /\ disposition = "missing" /\ reconciled = FALSE /\ wasCancelled = FALSE
ProviderDone == /\ run = "running" /\ run' = "done"
                /\ UNCHANGED <<goal, receipt, wake, disposition, reconciled, wasCancelled>>
CancelRun == /\ run = "running" /\ run' = "cancelled" /\ wasCancelled' = TRUE
             /\ UNCHANGED <<goal, receipt, wake, disposition, reconciled>>
ReconcileMissing == /\ ~reconciled /\ run \in {"running", "done"} /\ disposition = "missing" /\ goal = "active"
                    /\ run' = "failed" /\ receipt' = "failed" /\ wake' = TRUE /\ reconciled' = TRUE
                    /\ UNCHANGED <<goal, disposition, wasCancelled>>
ReconcileCancelled == /\ ~reconciled /\ run = "cancelled"
                      /\ goal' = "cancelled" /\ receipt' = "cancelled" /\ wake' = FALSE /\ reconciled' = TRUE
                      /\ UNCHANGED <<run, disposition, wasCancelled>>
Next == ProviderDone \/ CancelRun \/ ReconcileMissing \/ ReconcileCancelled
Spec == Init /\ [][Next]_vars
TypeOK == /\ goal \in {"active", "cancelled"} /\ run \in {"running", "done", "failed", "cancelled"}
          /\ receipt \in {"claimed", "failed", "cancelled"} /\ wake \in BOOLEAN /\ reconciled \in BOOLEAN /\ disposition = "missing" /\ wasCancelled \in BOOLEAN
CancelledRunNotOverwritten == wasCancelled => run = "cancelled"
CancelWins == goal = "cancelled" => run = "cancelled" /\ receipt = "cancelled" /\ ~wake
NoFalseWake == wake => run = "failed" /\ receipt = "failed" /\ reconciled
=============================================================================
