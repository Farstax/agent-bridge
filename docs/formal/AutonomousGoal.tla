-------------------------- MODULE AutonomousGoal --------------------------
EXTENDS Naturals, TLC
\* Bounded goal-cycle abstraction; one wake and at most one in-flight Run.
CONSTANT MaxCycles
VARIABLES status, cycle, wake, run, starts, cancelled
vars == <<status, cycle, wake, run, starts, cancelled>>
Init == /\ status = "active" /\ cycle = 0 /\ wake = "pending" /\ run = "none" /\ starts = 0 /\ cancelled = FALSE
Claim == /\ status = "active" /\ cycle < MaxCycles /\ wake = "pending" /\ run = "none"
         /\ wake' = "claimed" /\ run' = "running" /\ starts' = starts + 1
         /\ UNCHANGED <<status, cycle, cancelled>>
Continue == /\ status = "active" /\ wake = "claimed" /\ run = "running"
            /\ cycle' = cycle + 1 /\ status' = (IF cycle' >= MaxCycles THEN "budget_exhausted" ELSE "active")
            /\ wake' = (IF status' = "active" THEN "pending" ELSE "none") /\ run' = "none"
            /\ UNCHANGED <<starts, cancelled>>
Terminal(s) == /\ status = "active" /\ wake = "claimed" /\ run = "running" /\ s \in {"complete", "blocked"}
               /\ status' = s /\ cycle' = cycle + 1 /\ wake' = "none" /\ run' = "none"
               /\ UNCHANGED <<starts, cancelled>>
Cancel == /\ status = "active" /\ status' = "cancelled" /\ cancelled' = TRUE
          /\ wake' = "none" /\ UNCHANGED <<cycle, run, starts>>
Next == Claim \/ Continue \/ (\E s \in {"complete", "blocked"}: Terminal(s)) \/ Cancel
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"active", "complete", "blocked", "cancelled", "budget_exhausted"}
          /\ cycle \in 0..MaxCycles /\ starts \in 0..MaxCycles
          /\ wake \in {"pending", "claimed", "none"} /\ run \in {"none", "running"} /\ cancelled \in BOOLEAN
BudgetBound == starts <= MaxCycles
CancelledTerminal == cancelled => status = "cancelled" /\ wake = "none"
=============================================================================
