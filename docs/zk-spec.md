# ZK Circuit Specification

## 1. Overview
Circuit for proving score > threshold without revealing exact score. Groth16 on BLS12-381, verified on-chain via Soroban.

## 2. Public Inputs
| Name | Type | Description |
|------|------|-------------|
| threshold | u32 | Minimum score to prove |
| subject | Address | Stellar account bound to proof |
| credit_oracle_id | Address | Source contract |
| score_commitment | BytesN<32> | Pedersen commitment to ScoreRecord |
| snapshot_ledger | u32 | Ledger sequence at computation |
| domain_separator | BytesN<32> | Protocol version binding |


## 3. Private Witness
| Name | Type | Description |
|------|------|-------------|
| score | u32 | Actual credit score (300-850) |
| vc_count | u32 | Active VC count |

| repayment_rate | u32 | Basis points (0-10000) |
| last_updated | u64 | Ledger timestamp |
| vc_weight | u32 | Active VC weight |
| tx_weight | u32 | Active TX weight |
| repay_weight | u32 | Active repayment weight |

score > threshold
score >= 300 AND score <= 850
vc_score = min(vc_count * 20, 100)
tx_score = min(tx_volume_30d / 100_000_000, 100)
repay_score = repayment_rate / 100


## 6. Soroban Verifier
env.crypto().groth16_verify(&VERIFICATION_KEY, &public_inputs, &proof) with public inputs: threshold, subject, credit_oracle_id, score_commitment, snapshot_ledger, domain_separator.

## 7. Proof System
Groth16 on BLS12-381 via CAP-0059. WASM prover via arkworks-rs or snarkjs. Proof size ~192 bytes.

## 8. Prover Flow
Subject calls compute_score() -> reads ScoreRecord + Weights from chain -> generates witness with random blinding -> runs Groth16 prover in browser WASM -> submits proof to verifier contract.

## 9. Versioning
Version 1.0.0 domain separator: hash(stellar-did-credit-zk-v1)

## 10. References

