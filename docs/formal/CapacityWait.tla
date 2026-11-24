---------------------------- MODULE CapacityWait ----------------------------
EXTENDS TLC
\* Abstract capacity wait with a retained queue receipt. No time or owner lease.
VARIABLES state, receipt, successor, retryProof, stopped
vars == <<state, receipt, successor, retryProof, stopped>>
Init == /\ state = "pending" /\ receipt = "queued" /\ successor = "none"
        /\ retryProof = FALSE /\ stopped = FALSE
Claim == /\ state = "pending" /\ ~stopped /\ state' = "claimed"
         /\ UNCHANGED <<receipt, successor, retryProof, stopped>>
Admit == /\ state = "claimed" /\ successor = "none" /\ receipt = "queued" /\ ~stopped
         /\ successor' = "running" /\ receipt' = "claimed"
         /\ UNCHANGED <<state, retryProof, stopped>>
Finish(s) == /\ state = "claimed" /\ successor = "running" /\ s \in {"done", "failed", "capacityRejected"}
             /\ successor' = s /\ receipt' = "missing" /\ retryProof' = (s = "capacityRejected")
             /\ UNCHANGED <<state, stopped>>
ReceiptLost == /\ state = "claimed" /\ receipt # "missing" /\ receipt' = "missing"
               /\ UNCHANGED <<state, successor, retryProof, stopped>>
Complete == /\ state = "claimed" /\ successor = "done" /\ receipt = "missing"
            /\ state' = "completed" /\ UNCHANGED <<receipt, successor, retryProof, stopped>>
Fail == /\ state = "claimed" /\ successor = "failed" /\ state' = "failed"
        /\ UNCHANGED <<receipt, successor, retryProof, stopped>>
Retry == /\ state = "claimed" /\ successor = "capacityRejected" /\ retryProof /\ ~stopped
         /\ state' = "pending" /\ receipt' = "queued" /\ successor' = "none" /\ retryProof' = FALSE
         /\ UNCHANGED stopped
Stop == /\ state \in {"pending", "claimed"} /\ ~stopped /\ state' = "cancelled" /\ stopped' = TRUE
        /\ UNCHANGED <<receipt, successor, retryProof>>
Expire == /\ state = "pending" /\ state' = "expired" /\ UNCHANGED <<receipt, successor, retryProof, stopped>>
Next == Claim \/ Admit \/ (\E s \in {"done", "failed", "capacityRejected"}: Finish(s)) \/ ReceiptLost \/ Complete \/ Fail \/ Retry \/ Stop \/ Expire
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in {"pending", "claimed", "completed", "failed", "cancelled", "expired"}
          /\ receipt \in {"queued", "claimed", "missing"}
          /\ successor \in {"none", "running", "done", "failed", "capacityRejected"}
          /\ retryProof \in BOOLEAN /\ stopped \in BOOLEAN
NoFalseCompletion == state = "completed" => successor = "done"
StopTerminal == stopped => state = "cancelled"
=============================================================================
