-------------------------- MODULE SlackReadiness --------------------------
EXTENDS Naturals
CONSTANT Generations
VARIABLES generation, phase, degraded, diskGen, diskPhase, diskDegraded, age
vars == <<generation, phase, degraded, diskGen, diskPhase, diskDegraded, age>>
Phases == {"connecting", "connected", "reconnecting", "disconnected", "failed", "reconnect_required"}
Init == /\ generation \in Generations /\ phase = "connecting" /\ degraded = FALSE
        /\ diskGen = "none" /\ diskPhase = "connecting" /\ diskDegraded = FALSE /\ age = 2
Transition(p, d) == /\ phase' = p /\ degraded' = d
                    /\ UNCHANGED <<generation, diskGen, diskPhase, diskDegraded, age>>
Flush == /\ diskGen' = generation /\ diskPhase' = phase /\ diskDegraded' = degraded /\ age' = 0
         /\ UNCHANGED <<generation, phase, degraded>>
Restart(g) == /\ g # generation /\ generation' = g /\ phase' = "connecting" /\ degraded' = FALSE
              /\ UNCHANGED <<diskGen, diskPhase, diskDegraded, age>>
Tick == /\ age < 2 /\ age' = age + 1 /\ UNCHANGED <<generation, phase, degraded, diskGen, diskPhase, diskDegraded>>
Next == (\E p \in Phases, d \in BOOLEAN: Transition(p,d)) \/ Flush \/ (\E g \in Generations: Restart(g)) \/ Tick
Spec == Init /\ [][Next]_vars
Current == diskGen = generation /\ diskPhase = "connected" /\ ~diskDegraded /\ age < 2
FreshGeneration == Current => diskGen = generation
HealthyObservation == Current => diskPhase = "connected" /\ ~diskDegraded /\ age < 2
TypeOK == /\ generation \in Generations /\ phase \in Phases /\ degraded \in BOOLEAN
          /\ diskGen \in Generations \cup {"none"} /\ diskPhase \in Phases /\ diskDegraded \in BOOLEAN /\ age \in 0..2
=============================================================================
