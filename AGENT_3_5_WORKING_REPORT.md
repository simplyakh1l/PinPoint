# Detailed Working Report: Agent 3 and Agent 5

Generated from the current Convex implementation in `convex/agents`, the orchestrator, dispatch policy, schema, and the Operations Command UI.

## Executive view

Agent 3 (Crowd Intelligence) converts zone telemetry and active incidents into bounded zone-risk assessments, resource recommendations, and volunteer/marshal coverage. Agent 5 (Dispatch) turns verified incidents into responder tasks, protects assignment integrity, monitors acceptance, escalates stalled tasks, and records every operational decision. They are connected in the pipeline as:

```text
evidence verification -> Agent 3 zone assessment -> routing -> Agent 5 response planning
```

Agent 5 is deliberately downstream of verification: a normal response task cannot be created unless the incident is `VERIFIED`. External emergency services are never contacted by this code; even an allowed safety decision only produces an operator-facing hold message.

## Agent 3 — Crowd Intelligence Agent

### Inputs

For each active event, Agent 3 reads up to 50 zones and up to 30 unresolved incidents. A zone supplies capacity, occupancy, inflow/outflow rates, exit-blocked state, narrow-passage state, map coordinates, and telemetry timestamp/source. Incident coordinates are used to estimate proximity.

### Risk calculation

The implementation computes a score from 0–100 for every zone:

```text
density       = min(1, occupancy / capacity)
netFlow       = inflow - outflow
projected     = max(0, occupancy + netFlow * 5)       # five-minute projection
pressure      = clamp((projectedDensity - density) / 0.5, 0, 1)
inflowTrend   = clamp(netFlow / (capacity * 0.05), 0, 1)
exitFactor    = 1.0 if exit blocked, else 0.6 if narrow passage, else 0
proximity     = 1.0 within 15 map units of an active incident,
                0.5 within 28 map units, otherwise 0

raw score = 35*density + 15*inflowTrend + 10*pressure
          + 25*exitFactor + 10*proximity
```

The result is rounded and clamped to 0–100. This is more specific than the original report's four-factor description: flow pressure is split into current surge and projected pressure, and exit risk is represented explicitly.

### Telemetry safety behavior

Telemetry is stale when it is missing or older than two minutes. Stale zones are labeled in `riskFactors` as an unknown/current-assessment limitation. They do not receive automatic volunteer demand, which prevents the system from presenting old data as a current staffing requirement.

### Outputs and side effects

For every zone, Agent 3 writes `riskScore`, `unmitigatedRiskScore`, `riskFactors`, `telemetryStale`, and, when changed, `updatedAt`. It logs a `predict_zone_risk` action with the top three zones and the count at or above the high-risk threshold of 60.

If risk changes, all active route recommendations for the event are deactivated. This forces routing to be recomputed against the new crowd state instead of leaving old guidance active.

For zones at or above 60 (using the unmitigated score), Agent 3 recommends volunteers. Demand is `max(1, ceil((risk - 50) / 10))`; scores below 60 need zero automatic posts. Scores above 80 produce a stronger diversion/perimeter-control recommendation; other high-risk zones receive a marshal/overflow-corridor recommendation.

### Automatic volunteer/marshal coverage

Agent 3 reconciles eligible `volunteer` and `general` responders. It releases assignments that are no longer needed, are overallocated, belong to an invalid/banned attendee membership, are already on a task, or are not an auto-assignable type. It fills high-risk zones in descending risk order, choosing the geographically nearest available responder by map distance.

Coverage reduces the displayed risk estimate by 10 points per assigned responder, capped at 20. The baseline is always recomputed from `unmitigatedRiskScore`, so repeated assessments do not compound the reduction. The coverage explanation is appended to `riskFactors`, and an `auto_assign_volunteers` action is logged when assignments change.

### Invocation and handoff

Agent 3 runs after verification in `orchestrator.runVerification`, through `assessAllZones`. It also runs when telemetry or responder availability changes and during simulation/reset flows. Its route invalidation hands fresh state to the Routing Agent; after routing, the orchestrator calls Agent 5 only for verified incidents.

## Agent 5 — Dispatch Agent

### Inputs and eligibility

Agent 5 receives a verified, unresolved incident and reads available responders in the same event. Membership integrity is checked server-side: event match, user match, not banned, and not an attendee-only membership. Responders with an active task are excluded.

Capability matching is deterministic:

| Incident | Required capability |
|---|---|
| Medical | medical responder or first-aid capability |
| Fire | fire responder or fire-training capability |
| Security | security responder |
| Stampede/other | qualified general response rules |

### Ranking and search

The shared dispatch policy first filters to available, capability-qualified responders. It prefers responders within the initial 100-meter search radius; if none are nearby, it expands to the eligible pool. Within the selected pool it sorts by incident-specific skill strength, prior workload (fewer tasks first), and map distance.

Distance is a simulated map estimate derived from responder and incident coordinates. ETA is `max(30 seconds, distance / 3)`, and the task stores both distance and ETA. The ETA text explicitly identifies the value as an estimate and asks staff to confirm a passable route.

### Task creation and safety checks

`dispatchResponders` exits for missing/resolved/unverified incidents, reuses an existing active response task, and avoids silently creating a duplicate after a completed response. Otherwise it selects the top-ranked responder and creates a pending `dispatchTasks` record with instruction, purpose, ETA, distance, assignment time, and escalation count.

Assignment atomically marks the responder unavailable, attaches the task ID, logs `assign_and_notify_responder`, and schedules an acceptance check for three minutes later. A response assignment cannot bypass verification or capability checks.

### Task lifecycle and escalation

Allowed task transitions are explicitly constrained: pending → accepted/rejected/escalated/canceled; accepted → en-route/on-scene/canceled; en-route → on-scene/canceled; on-scene → completed/canceled. A pending or rejected task that remains unresolved at the acceptance review is escalated.

Escalation releases the original responder, marks the old task escalated, and ranks another eligible responder. It permits up to two escalation rounds. If no replacement is available, Agent 5 logs `escalation_requires_operator` and leaves the issue for event control. Arrival checks log an overdue warning when an accepted/en-route responder has not marked on-scene.

### Emergency-service boundary

The emergency-service function maps fire/security/medical incidents to fire brigade/police/ambulance, but it never performs an external API call. It evaluates the verification safety gate and logs `external_dispatch_held`; the returned result tells the operator to use the venue procedure. The normal orchestrator passes `allowEmergencyServices: false`, so routine response planning only assigns in-event responders.

## End-to-end example

1. A report is verified by the preceding agent.
2. Agent 3 recalculates all zone risks from current telemetry and active-incident proximity.
3. If a zone crosses 60, Agent 3 recommends and may assign available volunteer/general marshals; changed risk invalidates active routes.
4. Routing publishes fresh recommendations subject to its own approval controls.
5. Agent 5 checks that the incident is verified, finds same-event responders with the required capability, ranks them, and creates one pending task.
6. The responder accepts and progresses through the task lifecycle, or the three-minute review escalates to another eligible responder.
7. Completion is handled by the responder/control-room workflow; external emergency contact remains an operator action.

## Operational strengths and limitations

**Strengths:** bounded reads (`take` limits), server-side authorization checks, explicit safety states, stale-telemetry labeling, idempotent active-task reuse, deterministic audit logging, route invalidation after risk changes, and human control at verification/route/emergency boundaries.

**Limitations:** risk and distance are rule-based simulations using zone/map coordinates; ETA is not a live indoor navigation result; no external emergency-service integration exists; and escalation cannot resolve a shortage of qualified responders without operator intervention.

## Source map

- Agent 3: `convex/agents/crowdIntel.ts`
- Agent 5: `convex/agents/dispatch.ts`
- Ranking and task policy: `convex/lib/dispatchPolicy.ts`
- Pipeline handoff: `convex/orchestrator.ts`
- Persisted models: `convex/schema.ts` (`zones`, `responders`, `dispatchTasks`, `routeRecommendations`)
- UI visibility: `src/AgentCommandCenter.tsx`, `src/AgentPipelineVisualizer.tsx`
