---------------------- MODULE OrdinaryContinuation ----------------------
EXTENDS Naturals, TLC
\* Abstraction of one ordinary outward continuation, not capacity waits.
CONSTANT Tokens, NoToken, Providers, NoProvider
VARIABLES state, token, successor, fenced, stopped, outcome, used, retired,
          origin, selected, switched, authorised, lock, executionProvider
lifecycle == <<state, token, successor, fenced, stopped, outcome, used, retired>>
policy == <<origin, selected, switched, authorised, lock>>
vars == <<lifecycle, policy, executionProvider>>

Dispositions == {"complete", "continue", "blocked", "unresolved"}
DesiredProvider == IF switched THEN selected ELSE origin
Allowed(p) == p \in authorised /\ (lock = NoProvider \/ p = lock)
Eligible(t) == state = "claimed" /\ token = t /\ ~successor /\ ~fenced /\ ~stopped

Init == /\ state = "pending" /\ token = NoToken /\ successor = FALSE
        /\ fenced = FALSE /\ stopped = FALSE /\ outcome = "none" /\ used = {} /\ retired = {}
        \* A fallback may have scheduled this wake with a different stored preference.
        /\ origin \in Providers /\ selected \in Providers /\ switched = FALSE
        /\ authorised \in SUBSET Providers /\ lock \in Providers \cup {NoProvider}
        /\ executionProvider = NoProvider
Fence == /\ ~fenced /\ fenced' = TRUE
         /\ UNCHANGED <<state, token, successor, stopped, outcome, used, retired, policy, executionProvider>>
Unfence == /\ fenced /\ fenced' = FALSE
           /\ UNCHANGED <<state, token, successor, stopped, outcome, used, retired, policy, executionProvider>>
\* Deliberate selection is evidence distinct from a differing stored preference.
\* A second switch back does not erase that evidence.
Select(p) == /\ state \in {"pending", "claimed"} /\ ~successor /\ ~fenced /\ ~stopped
             /\ p \in Providers /\ Allowed(p) /\ p # selected
             /\ selected' = p /\ switched' = TRUE
             /\ UNCHANGED <<lifecycle, origin, authorised, lock, executionProvider>>
\* Effective configuration may differ at admission. Freeze the policy after
\* admission in this abstraction; it represents the admission-time decision.
Configure(a, l) == /\ state \in {"pending", "claimed"} /\ ~successor /\ ~fenced /\ ~stopped
                   /\ a \in SUBSET Providers /\ l \in Providers \cup {NoProvider}
                   /\ authorised' = a /\ lock' = l
                   /\ UNCHANGED <<lifecycle, origin, selected, switched, executionProvider>>
Claim(t) == /\ state = "pending" /\ ~fenced /\ ~stopped /\ t \in Tokens \ used
            /\ state' = "claimed" /\ token' = t /\ used' = used \cup {t}
            /\ UNCHANGED <<successor, fenced, stopped, outcome, retired, policy, executionProvider>>
Admit(t, p) == /\ Eligible(t)
               /\ p = DesiredProvider
               /\ Allowed(p)
               /\ successor' = TRUE /\ executionProvider' = p
               /\ UNCHANGED <<state, token, fenced, stopped, outcome, used, retired, policy>>
\* A missing or locked-out provider is an unresolved blocker, not completion.
ConfigurationBlocked(t) == /\ Eligible(t) /\ ~Allowed(DesiredProvider)
                           /\ state' = "failed" /\ outcome' = "unresolved"
                           /\ UNCHANGED <<token, successor, fenced, stopped, used, retired, policy, executionProvider>>
Reclaim == /\ state = "claimed" /\ ~successor /\ ~fenced
           /\ state' = "pending" /\ token' = NoToken /\ retired' = retired \cup {token}
           /\ UNCHANGED <<successor, fenced, stopped, outcome, used, policy, executionProvider>>
Stop == /\ state \in {"pending", "claimed"} /\ ~fenced
        /\ state' = "cancelled" /\ stopped' = TRUE
        /\ UNCHANGED <<token, successor, fenced, outcome, used, retired, policy, executionProvider>>
Expire == /\ state = "pending" /\ ~fenced
          /\ state' = "expired"
          /\ UNCHANGED <<token, successor, fenced, stopped, outcome, used, retired, policy, executionProvider>>
Settle(t, result) == /\ state = "claimed" /\ token = t /\ successor /\ ~fenced
                     /\ result \in Dispositions
                     /\ state' = IF result = "unresolved" THEN "failed" ELSE "completed"
                     /\ outcome' = result
                     /\ UNCHANGED <<token, successor, fenced, stopped, used, retired, policy, executionProvider>>
Next == Fence \/ Unfence \/ Reclaim \/ Stop \/ Expire
        \/ (\E p \in Providers: Select(p))
        \/ (\E a \in SUBSET Providers, l \in Providers \cup {NoProvider}: Configure(a, l))
        \/ (\E t \in Tokens: Claim(t) \/ ConfigurationBlocked(t)
             \/ (\E p \in Providers: Admit(t, p))
             \/ (\E r \in Dispositions: Settle(t, r)))
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in {"pending", "claimed", "completed", "failed", "expired", "cancelled"}
          /\ token \in Tokens \cup {NoToken} /\ successor \in BOOLEAN
          /\ fenced \in BOOLEAN /\ stopped \in BOOLEAN
          /\ outcome \in Dispositions \cup {"none"}
          /\ used \subseteq Tokens /\ retired \subseteq used
          /\ origin \in Providers /\ selected \in Providers /\ switched \in BOOLEAN
          /\ authorised \subseteq Providers /\ lock \in Providers \cup {NoProvider}
          /\ executionProvider \in Providers \cup {NoProvider}
NoFalseCompletion == state = "completed" => successor /\ outcome \in {"complete", "continue", "blocked"}
NoRequeueAfterAdmission == successor => state # "pending"
NoRetiredClaim == state = "claimed" => token \notin retired
StopIsTerminal == stopped => state = "cancelled"
NoUnauthorisedAdmission == successor => executionProvider \in Providers /\ Allowed(executionProvider)
ProviderSelectionRespected == successor => executionProvider = DesiredProvider
\* Enabledness, not eventual execution: a valid claimed wake must have an
\* admission transition even after a deliberate switch away from its origin.
ValidAdmissionEnabled == (token \in Tokens /\ Eligible(token) /\ Allowed(DesiredProvider))
                         => ENABLED Admit(token, DesiredProvider)
=============================================================================
