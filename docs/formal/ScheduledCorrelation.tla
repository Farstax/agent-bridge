----------------------- MODULE ScheduledCorrelation -----------------------
EXTENDS Naturals
CONSTANT Runs
VARIABLES linked, runStatus, evidence, completedRun
vars == <<linked, runStatus, evidence, completedRun>>
Statuses == {"missing", "running", "done", "failed", "cancelled"}
Init == /\ linked = "none" /\ runStatus \in [Runs -> Statuses]
        /\ evidence = "claimed" /\ completedRun = "none"
Link(r) == /\ IF linked = "none" THEN TRUE ELSE (linked = r \/ runStatus[linked] \in {"missing", "failed", "cancelled"})
           /\ linked' = r
           /\ evidence' = CASE runStatus[r] = "done" -> "completed"
                           [] runStatus[r] = "failed" -> "failed"
                           [] runStatus[r] = "cancelled" -> "fenced"
                           [] OTHER -> "running"
           /\ completedRun' = IF runStatus[r] = "done" THEN r ELSE completedRun
           /\ UNCHANGED runStatus
FailEvidence == /\ IF linked = "none" THEN TRUE ELSE runStatus[linked] # "done"
                /\ evidence' = "failed" /\ UNCHANGED <<linked, runStatus, completedRun>>
Advance(r, status) == /\ runStatus[r] = "running" /\ status \in {"done", "failed", "cancelled"}
                      /\ runStatus' = [runStatus EXCEPT ![r] = status]
                      /\ UNCHANGED <<linked, evidence, completedRun>>
Next == (\E r \in Runs: Link(r)) \/ FailEvidence \/ (\E r \in Runs, status \in Statuses: Advance(r, status))
Spec == Init /\ [][Next]_vars
NoReplaceDone == completedRun # "none" => linked = completedRun /\ evidence = "completed"
TypeOK == /\ linked \in Runs \cup {"none"} /\ runStatus \in [Runs -> Statuses]
          /\ evidence \in {"claimed", "running", "completed", "failed", "fenced"}
          /\ completedRun \in Runs \cup {"none"}
=============================================================================
