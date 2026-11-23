---------------------- MODULE OrdinaryContinuation ----------------------
EXTENDS Naturals, TLC
\* Abstraction of one ordinary outward continuation, not capacity waits.
CONSTANT Tokens, NoToken
VARIABLES state, token, successor, fenced, stopped, outcome, used, retired
vars == <<state, token, successor, fenced, stopped, outcome, used, retired>>

Init == /\ state = "pending" /\ token = NoToken /\ successor = FALSE
        /\ fenced = FALSE /\ stopped = FALSE /\ outcome = "none" /\ used = {} /\ retired = {}
Fence == /\ ~fenced /\ fenced' = TRUE
         /\ UNCHANGED <<state, token, successor, stopped, outcome, used, retired>>
Unfence == /\ fenced /\ fenced' = FALSE
           /\ UNCHANGED <<state, token, successor, stopped, outcome, used, retired>>
Claim(t) == /\ state = "pending" /\ ~fenced /\ ~stopped /\ t \in Tokens \ used
            /\ state' = "claimed" /\ token' = t /\ used' = used \cup {t}
            /\ UNCHANGED <<successor, fenced, stopped, outcome, retired>>
Admit(t) == /\ state = "claimed" /\ token = t /\ ~successor /\ ~fenced /\ ~stopped
            /\ successor' = TRUE
            /\ UNCHANGED <<state, token, fenced, stopped, outcome, used, retired>>
Reclaim == /\ state = "claimed" /\ ~successor /\ ~fenced
           /\ state' = "pending" /\ token' = NoToken /\ retired' = retired \cup {token}
           /\ UNCHANGED <<successor, fenced, stopped, outcome, used>>
Stop == /\ state \in {"pending", "claimed"} /\ ~fenced
        /\ state' = "cancelled" /\ stopped' = TRUE
        /\ UNCHANGED <<token, successor, fenced, outcome, used, retired>>
Expire == /\ state = "pending" /\ ~fenced
          /\ state' = "expired"
          /\ UNCHANGED <<token, successor, fenced, stopped, outcome, used, retired>>
Settle(t, result) == /\ state = "claimed" /\ token = t /\ successor /\ ~fenced
                     /\ result \in {"complete", "blocked", "unresolved"}
                     /\ state' = IF result = "unresolved" THEN "failed" ELSE "completed"
                     /\ outcome' = result
                     /\ UNCHANGED <<token, successor, fenced, stopped, used, retired>>
Next == Fence \/ Unfence \/ (\E t \in Tokens: Claim(t) \/ Admit(t) \/ (\E r \in {"complete", "blocked", "unresolved"}: Settle(t, r))) \/ Reclaim \/ Stop \/ Expire
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in {"pending", "claimed", "completed", "failed", "expired", "cancelled"}
          /\ token \in Tokens \cup {NoToken} /\ successor \in BOOLEAN
          /\ fenced \in BOOLEAN /\ stopped \in BOOLEAN
          /\ outcome \in {"none", "complete", "blocked", "unresolved"}
          /\ used \subseteq Tokens /\ retired \subseteq used
NoFalseCompletion == state = "completed" => outcome \in {"complete", "blocked"}
NoRequeueAfterAdmission == successor => state # "pending"
NoRetiredClaim == state = "claimed" => token \notin retired
StopIsTerminal == stopped => state = "cancelled"
=============================================================================
