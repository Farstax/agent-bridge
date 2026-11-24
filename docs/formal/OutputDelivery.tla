------------------------ MODULE OutputDelivery ------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Files
VARIABLES allowed, pending, inflight, delivered, state
vars == <<allowed, pending, inflight, delivered, state>>
Init == /\ allowed = TRUE /\ pending = Files /\ inflight = {} /\ delivered = {} /\ state = "active"
Start(f) == /\ state = "active" /\ allowed /\ inflight = {} /\ f \in pending
            /\ pending' = pending \ {f} /\ inflight' = {f}
            /\ UNCHANGED <<allowed, delivered, state>>
Stop == /\ state = "active" /\ allowed /\ allowed' = FALSE
        /\ UNCHANGED <<pending, inflight, delivered, state>>
Finish == /\ state = "active" /\ inflight # {}
          /\ delivered' = delivered \cup inflight /\ inflight' = {}
          /\ UNCHANGED <<allowed, pending, state>>
Settle == /\ state = "active" /\ inflight = {} /\ (~allowed \/ pending = {})
          /\ state' = IF allowed THEN "complete" ELSE "cancelled"
          /\ UNCHANGED <<allowed, pending, inflight, delivered>>
Next == (\E f \in Files: Start(f)) \/ Stop \/ Finish \/ Settle
Spec == Init /\ [][Next]_vars
TypeOK == /\ allowed \in BOOLEAN /\ pending \subseteq Files /\ inflight \subseteq Files
          /\ delivered \subseteq Files /\ state \in {"active", "complete", "cancelled"}
Disjoint == /\ pending \cap inflight = {} /\ pending \cap delivered = {} /\ inflight \cap delivered = {}
CompleteAll == state = "complete" => delivered = Files
NoStartAfterStop == [][allowed \/ pending' = pending]_vars
=============================================================================
