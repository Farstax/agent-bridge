---------------------------- MODULE QueueStop ----------------------------
EXTENDS Naturals, TLC
\* One accepted queued item and two distinct lane acquisitions. Atomic actions
\* abstract SQLite transactions; external provider termination is not modeled.
CONSTANT Owners, None
VARIABLES queue, lane, claim, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission
vars == <<queue, lane, claim, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission>>
Init == /\ queue = "queued" /\ lane = None /\ claim = None /\ stop = FALSE
        /\ run = "none" /\ starts = 0 /\ startsAfterStop = FALSE /\ cancelRequested = FALSE /\ staleAdmission = FALSE
Acquire(o) == /\ lane = None /\ o \in Owners /\ lane' = o
              /\ UNCHANGED <<queue, claim, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission>>
Claim(o) == /\ lane = o /\ queue = "queued" /\ ~stop
            /\ queue' = "claimed" /\ claim' = o
            /\ UNCHANGED <<lane, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission>>
LoseLane == /\ lane # None /\ lane' = None
            /\ UNCHANGED <<queue, claim, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission>>
Recover(o) == /\ lane = o /\ queue = "claimed" /\ claim # o /\ ~stop
              /\ queue' = "queued" /\ claim' = None
              /\ UNCHANGED <<lane, stop, run, starts, startsAfterStop, cancelRequested, staleAdmission>>
Admit(o) == /\ lane = o /\ queue = "claimed" /\ claim = o /\ ~stop /\ run = "none"
            /\ run' = "running" /\ starts' = starts + 1 /\ startsAfterStop' = (startsAfterStop \/ stop) /\ staleAdmission' = (lane # claim)
            /\ UNCHANGED <<queue, lane, claim, stop, cancelRequested>>
Stop == /\ ~stop /\ stop' = TRUE /\ queue' = "discarded" /\ claim' = None
        /\ cancelRequested' = (run = "running")
        /\ UNCHANGED <<lane, run, starts, startsAfterStop, staleAdmission>>
Finish == /\ run = "running" /\ run' = "done" /\ UNCHANGED <<queue, lane, claim, stop, starts, startsAfterStop, cancelRequested, staleAdmission>>
Next == (\E o \in Owners: Acquire(o) \/ Claim(o) \/ Recover(o) \/ Admit(o)) \/ LoseLane \/ Stop \/ Finish
Spec == Init /\ [][Next]_vars
TypeOK == /\ queue \in {"queued", "claimed", "discarded"} /\ lane \in Owners \cup {None} /\ claim \in Owners \cup {None}
          /\ stop \in BOOLEAN /\ run \in {"none", "running", "done"} /\ starts \in Nat /\ startsAfterStop \in BOOLEAN /\ cancelRequested \in BOOLEAN /\ staleAdmission \in BOOLEAN
NoStaleAdmission == ~staleAdmission
AtMostOneRun == starts <= 1
NoAdmissionAfterStop == ~startsAfterStop
StopSignalsActive == stop /\ run = "running" => cancelRequested
=============================================================================
