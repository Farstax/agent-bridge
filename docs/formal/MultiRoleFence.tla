-------------------------- MODULE MultiRoleFence --------------------------
EXTENDS FiniteSets, TLC
\* Each role fence is installed separately. Cleanup can fail; unknown must not
\* be mistaken for an admitted or safely released rollout.
CONSTANT Roles, Other
VARIABLES held, phase, offline, foreignReleased
vars == <<held, phase, offline, foreignReleased>>
Init == /\ held = {} /\ phase = "acquiring" /\ offline = FALSE /\ foreignReleased = FALSE
Acquire(r) == /\ phase = "acquiring" /\ r \in Roles \ held /\ held' = held \cup {r}
              /\ UNCHANGED <<phase, offline, foreignReleased>>
Deny == /\ phase = "acquiring" /\ held # Roles /\ phase' = "unwinding"
        /\ UNCHANGED <<held, offline, foreignReleased>>
Admit == /\ phase = "acquiring" /\ held = Roles /\ phase' = "contained"
         /\ UNCHANGED <<held, offline, foreignReleased>>
Release(r, token) == /\ phase \in {"unwinding", "releasing"} /\ r \in held
                     /\ IF token = r THEN held' = held \ {r} ELSE held' = held
                     /\ foreignReleased' = (foreignReleased \/ (token # r /\ held' # held))
                     /\ UNCHANGED <<phase, offline>>
CleanupSuccess == /\ phase = "unwinding" /\ held = {} /\ phase' = "deferred"
                  /\ UNCHANGED <<held, offline, foreignReleased>>
CleanupFailure == /\ phase \in {"unwinding", "releasing"} /\ held # {} /\ phase' = "unknown"
                  /\ UNCHANGED <<held, offline, foreignReleased>>
Offline == /\ phase = "contained" /\ held = Roles /\ phase' = "offline" /\ offline' = TRUE
           /\ UNCHANGED <<held, foreignReleased>>
Healthy == /\ phase = "offline" /\ phase' = "releasing" /\ UNCHANGED <<held, offline, foreignReleased>>
ReleaseSuccess == /\ phase = "releasing" /\ held = {} /\ phase' = "done"
                  /\ UNCHANGED <<held, offline, foreignReleased>>
Next == (\E r \in Roles: Acquire(r) \/ (\E token \in Roles \cup {Other}: Release(r, token))) \/ Deny \/ Admit \/ CleanupSuccess \/ CleanupFailure \/ Offline \/ Healthy \/ ReleaseSuccess
Spec == Init /\ [][Next]_vars
TypeOK == /\ held \subseteq Roles /\ phase \in {"acquiring", "unwinding", "deferred", "contained", "offline", "releasing", "unknown", "done"} /\ offline \in BOOLEAN /\ foreignReleased \in BOOLEAN
FullFenceBeforeOffline == phase = "offline" => held = Roles
NoForeignRelease == ~foreignReleased
DeferredUnfenced == phase = "deferred" => held = {}
=============================================================================
