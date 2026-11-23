---------------------------- MODULE RunTerminal ----------------------------
EXTENDS Naturals, TLC
\* Models only the three compare-and-swap terminal writers in RunRepository.
VARIABLES status, winner, writes
vars == <<status, winner, writes>>
Init == /\ status = "running" /\ winner = "none" /\ writes = 0
Finish(s) == /\ status = "running" /\ s \in {"done", "failed", "cancelled"}
             /\ status' = s /\ winner' = s /\ writes' = writes + 1
Next == \E s \in {"done", "failed", "cancelled"}: Finish(s)
Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"running", "done", "failed", "cancelled"}
          /\ winner \in {"none", "done", "failed", "cancelled"} /\ writes \in Nat
OneTerminalWrite == writes <= 1
FirstWins == status = "running" \/ status = winner
=============================================================================
