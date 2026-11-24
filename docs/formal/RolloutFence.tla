---------------------------- MODULE RolloutFence ----------------------------
EXTENDS FiniteSets, TLC
CONSTANT Roles
VARIABLES fences, writers, phase, offlineTouched, accepted
vars == <<fences, writers, phase, offlineTouched, accepted>>
Init == /\ fences = {} /\ writers = Roles /\ phase = "admitting"
        /\ offlineTouched = FALSE /\ accepted = FALSE
Fence(r) == /\ phase = "admitting" /\ r \in Roles \ fences /\ fences' = fences \cup {r}
            /\ UNCHANGED <<writers, phase, offlineTouched, accepted>>
AdmissionFails == /\ phase = "admitting" /\ fences # Roles /\ phase' = "aborted" /\ fences' = {}
                  /\ UNCHANGED <<writers, offlineTouched, accepted>>
Stop == /\ phase = "admitting" /\ fences = Roles /\ phase' = "containing"
        /\ UNCHANGED <<fences, writers, offlineTouched, accepted>>
WriterStarts(r) == /\ r \in Roles \ fences /\ r \notin writers /\ writers' = writers \cup {r}
                   /\ UNCHANGED <<fences, phase, offlineTouched, accepted>>
Contain(r) == /\ phase = "containing" /\ r \in writers /\ writers' = writers \ {r}
              /\ UNCHANGED <<fences, phase, offlineTouched, accepted>>
ContainmentFails == /\ phase = "containing" /\ writers # {} /\ phase' = "unsafe"
                    /\ UNCHANGED <<fences, writers, offlineTouched, accepted>>
Offline == /\ phase = "containing" /\ fences = Roles /\ writers = {} /\ phase' = "offline" /\ offlineTouched' = TRUE
           /\ UNCHANGED <<fences, writers, accepted>>
Activate == /\ phase = "offline" /\ phase' = "healthy" /\ accepted' = TRUE
            /\ UNCHANGED <<fences, writers, offlineTouched>>
Rollback == /\ phase = "offline" /\ phase' = "rollbackHealthy"
            /\ UNCHANGED <<fences, writers, offlineTouched, accepted>>
RollbackFails == /\ phase = "offline" /\ phase' = "unsafe"
                 /\ UNCHANGED <<fences, writers, offlineTouched, accepted>>
Release == /\ phase \in {"healthy", "rollbackHealthy"} /\ fences = Roles /\ fences' = {} /\ phase' = "released"
           /\ UNCHANGED <<writers, offlineTouched, accepted>>
Next == (\E r \in Roles: Fence(r) \/ WriterStarts(r) \/ Contain(r)) \/ AdmissionFails \/ Stop \/ ContainmentFails \/ Offline \/ Activate \/ Rollback \/ RollbackFails \/ Release \/ (phase \in {"aborted", "unsafe", "released"} /\ UNCHANGED vars)
Spec == Init /\ [][Next]_vars
TypeOK == /\ fences \subseteq Roles /\ writers \subseteq Roles
          /\ phase \in {"admitting", "aborted", "containing", "offline", "healthy", "rollbackHealthy", "unsafe", "released"}
          /\ offlineTouched \in BOOLEAN /\ accepted \in BOOLEAN
OfflineExclusive == phase = "offline" => fences = Roles /\ writers = {}
UnsafeRetainsFence == phase = "unsafe" => fences = Roles
AcceptedOnlyAfterOffline == accepted => offlineTouched
=============================================================================
