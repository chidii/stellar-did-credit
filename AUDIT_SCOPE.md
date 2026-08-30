# Security Audit Scope

## 1. Contracts in Scope

| Contract | Path | Description |
|----------|------|-------------|
| `identity-oracle` | `contracts/identity-oracle/` | Anchors DIDs and verifiable credentials (VCs), registers/deregisters issuers, checks verification status |
| `credit-oracle` | `contracts/credit-oracle/` | Computes credit scores from weighted transaction stats, manages feeders, applies governance-approved weight updates |
| `revocation-registry` | `contracts/revocation-registry/` | Tracks revoked VC hashes, supports batch revocation by registered issuers |
| `governance` | `contracts/governance/` | Proposal creation, voting, and execution for protocol changes |

**Note:** `score-range-verifier` is intentionally **out of scope** until Phase 4 is completed. It will be added in a future revision.

## 2. Out of Scope

| Component | Path | Reason |
|-----------|------|--------|
| TypeScript SDK | `packages/sdk/` | Client library, not on-chain logic |
| Feeder | `packages/feeder/` | Off-chain process |
| CLI / Scripts | `scripts/` | Deployment tooling |
| Issuer Example | `packages/issuer-example/` | Reference implementation only |

## 3. Known Issues Already Tracked

Auditors should **not** spend time rediscovering issues already tracked. Search for `security` and `bug` labels in the [issue tracker](https://github.com/cybermax4200/stellar-did-credit/issues) before flagging a new finding.

| Issue | Description | Status |
|-------|-------------|--------|
| All open issues labeled `security` | See issue tracker | Refer to GitHub Issues |

## 4. Attack Scenarios to Focus On

### Identity Oracle
- Unauthorized issuer registration and VC anchoring
- DID overwrite by a non-owner
- Verification bypass for revoked or non-anchored VCs
- Two-step admin transfer race conditions
- Malformed IPFS CID injection

### Credit Oracle
- Non-admin weight proposal or application
- Score inflation via repeated counterparty transactions
- Compute cooldown bypass
- Deregistered feeder still submitting stats
- Score bounds violation (<300 or >850)

### Revocation Registry
- Unauthorized VC hash revocation
- Batch size limit bypass
- Cross-contract inconsistency after revocation

### Governance
- Non-member proposal creation or voting
- Timelock bypass
- Reentrancy in proposal execution

## 5. Protocol Invariants to Verify

1. **Score bounds**: Scores always within [300, 850].
2. **Weight sum**: Proposed weight updates must sum to exactly 100.
3. **Single anchor**: DID can only be overwritten by owner or authorized admin.
4. **Revocation propagation**: Revoked VC hash returns `false` from `is_verified`.
5. **Issuer authority**: Only registered issuers can anchor VCs and revoke hashes.
6. **Admin transfer**: Two-step transfer requires both propose and accept with correct auth.
7. **Feeder authority**: Only registered feeders can submit transaction statistics.

## 6. Testing Methodology Requirements

1. Unit tests for every public function (happy + failure paths).
2. Property-based tests for score computation and weight application.
3. Cross-contract integration tests covering full protocol flow.
4. Fuzz testing for XDR decoding and event parsing.
5. Reentrancy tests for cross-contract calls.
6. Authorization matrix tests: Every function × caller role × expected outcome.
7. Upgrade safety tests: State preservation across WASM upgrades.

## Sign-off

This document must be reviewed and approved by core maintainers before being shared with auditors.

**Approved by:** ______________________  
**Date:** ______________________