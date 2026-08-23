---
name: Storage trust model
description: Product decision for how the storage UI represents disconnected and backend-dependent states.
---

The initial storage experience must prefer an explicit empty or unavailable state over plausible-looking local examples. File rows, transfer rows, percentages, speeds, ETAs, and completion states only become visible when they come from a real provider or transfer-engine event source.

**Why:** The product owner explicitly rejected fake backend data and simulated progress because transfer visibility is a trust-critical part of the application.

**How to apply:** Keep the UI event-driven and provider-agnostic. When a capability is not connected, label it unavailable or under development instead of adding optimistic fallback records.