# Sequence: Pi live model catalog

**Last updated:** 2026-08-18
**Scope:** Planned discovery, fallback, presentation, selection, and existing launch flow for dispatch-time Pi models

## Diagram

```mermaid
sequenceDiagram
    actor Operator
    participant Browser as Dashboard catalog provider
    participant Route as GET /api/harnesses/models
    participant Service as HarnessModelCatalogService
    participant Registry as HARNESSES model capabilities
    participant Pi as Pi RPC subprocess
    participant Existing as Existing persistence and launch

    Operator->>Browser: Open a model picker
    Browser->>Route: Fetch every harness catalog once
    Route->>Service: Resolve all catalogs
    Service->>Registry: Read each harness model capability
    Registry-->>Service: Claude and Codex shipped choices
    Service->>Registry: Discover Pi choices
    Registry->>Pi: Start bounded no-session RPC probe
    Registry->>Pi: get_available_models with correlation id
    alt Matching valid response within bounds
        Pi-->>Registry: Allowlisted model fields
        Registry-->>Service: Provider-qualified choices
        Service->>Service: Cache last successful Pi result
    else Probe fails and a successful cache exists
        Pi--xRegistry: Timeout, invalid output, or child failure
        Registry-->>Service: Typed discovery failure
        Service->>Service: Retain stale successful cache
    else Probe fails before any successful cache
        Pi--xRegistry: Unsupported, unavailable, or failed
        Registry-->>Service: Typed discovery failure
        Service->>Service: Use shipped Pi fallback
    end
    Service-->>Route: Bounded catalogs, source, refresh time, problem state
    Route-->>Browser: Browser-safe catalog response
    Browser->>Browser: Group every Pi choice by provider
    Browser->>Browser: Preserve any selected off-catalog value
    Browser-->>Operator: Live choices or a usable fallback note
    Operator->>Browser: Select provider/model
    Browser->>Existing: Submit existing provider-qualified model id
    Existing-->>Operator: Persist and launch with --model provider/id
```

## Legend

- The dashboard makes one ordinary HTTP read when its shared catalog provider mounts. It does not add browser polling or another live channel.
- `HARNESSES` remains the exhaustive owner of agent-specific process behavior. The route and cache service do not branch on the Pi agent id.
- The Pi child receives no prompt and creates no session. Process time, output bytes, row count, strings, and derived ids are bounded before any value reaches the browser.
- A cache or shipped fallback changes only catalog quality. It never blocks the existing persistence or launch path.

## Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-08-18 | Initial planned sequence | Created during phased planning; this expands the request flow approved by the operator in `docs/plans/pi-live-model-catalog/plan.md` |
