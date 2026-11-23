------------------------ MODULE LateProviderResult ------------------------
EXTENDS TLC
\* One outward Run's result settlement. This says nothing about effects already
\* performed by the provider or messages sent before Stop was requested.
VARIABLES cancelRequested, providerReturned, run, published
vars == <<cancelRequested, providerReturned, run, published>>
Init == /\ cancelRequested = FALSE /\ providerReturned = FALSE /\ run = "running" /\ published = FALSE
Stop == /\ run = "running" /\ ~cancelRequested /\ cancelRequested' = TRUE
        /\ UNCHANGED <<providerReturned, run, published>>
Return == /\ run = "running" /\ ~providerReturned /\ providerReturned' = TRUE
          /\ UNCHANGED <<cancelRequested, run, published>>
Settle == /\ run = "running" /\ providerReturned
          /\ run' = (IF cancelRequested THEN "cancelled" ELSE "done")
          /\ published' = ~cancelRequested
          /\ UNCHANGED <<cancelRequested, providerReturned>>
Next == Stop \/ Return \/ Settle
Spec == Init /\ [][Next]_vars
TypeOK == /\ cancelRequested \in BOOLEAN /\ providerReturned \in BOOLEAN
          /\ run \in {"running", "done", "cancelled"} /\ published \in BOOLEAN
NoCancelledPublication == run = "cancelled" => ~published
StopBeforeSettlement == cancelRequested /\ run # "running" => run = "cancelled" /\ ~published
=============================================================================
