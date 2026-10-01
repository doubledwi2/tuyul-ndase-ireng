# Phase 5.2.1 — fresh-pair qualification integrity

This is a local observation freshness guard, not a claim that exchange clocks or networks are synchronized. Both local book generations must advance; all existing timing/source-clock guards still apply.

## Generation identity

MarketPipeline owns Bybit/OKX integer counters starting at zero. Each valid normalized order-book input increments its venue counter, including updates with identical receipt timestamps. Invalid input returns before incrementing. The pipeline passes a typed BookGenerationPair alongside each directional depth comparison to OpportunityTracker. Generation metadata is internal: no persisted OpportunityEvent/schema changes. Replay derives the same generations from the same valid input order, never host time.

## Acceptance and safety

The first quality-valid complete pair creates DETECTED with validObservations=1, a logical validation start timestamp, and a copied generation baseline. Baselines are separate per direction/event. Further positive observations are accepted only when Bybit generation AND OKX generation are strictly greater than that baseline. Only acceptance increments observations and evaluates elapsed validation duration. Example: accepted B10/O20; B11/O20 and B12/O20 cannot progress; B12/O21 can.

Comparison and timing metrics continue on every valid complete-pair input. Latest event metrics also update on one-sided input. An already QUALIFIED event does not emit a duplicate transition just because books remain positive. Failing economics, depth, quality or synchronization is evaluated BEFORE the freshness guard, so one-sided failures still immediately emit DISAPPEARED or INVALID_SYNC according to the existing economic-versus-sync priority.

INVALID_SYNC clears the positive window and resets the generation baseline to the failing observation. Every subsequent unhealthy observation updates that baseline too, without duplicate INVALID_SYNC emission. Recovery requires both generations to advance after the latest failure; positive one-sided observations do not move that baseline. Accepted recovery emits DETECTED with one observation and a new validation start. No pre-invalid elapsed time counts. Existing everQualified/first-qualified historical fields retain their prior semantics. DISAPPEARED deletes the entire tracked state.

Legacy quote-only processing retains its compatibility behavior without generation metadata. A tracked depth event with an established generation baseline cannot progress through a metadata-less call.

## Integration and changed sequences

Normal alternating updates still qualify. An example previously producing DETECTED -> VALIDATING (one side only) -> QUALIFIED now produces DETECTED -> QUALIFIED at the first fresh pair if the duration has already elapsed. Recovery can occur later, and qualification may disappear entirely from a dataset that never provides another fresh pair.

Paper coordinators already enter only on QUALIFIED, so entries naturally inherit this stricter lifecycle. No extra engine guard or execution change. Seven Phase 3.1 synthetic replay fixtures now include an additional OKX observation at logical time 1000, paired with their existing second Bybit observation. This preserves the intended qualification time and latency scenario without weakening freshness. Expected clean-fill, single-leg, partial, timeout and unwind outcomes remain tested.

Shadow remains a separate current-book diagnostic evaluated every depth snapshot, not a QUALIFIED-only consumer. Its fee/funding policies, private polling, security boundary, depth simulator, source-offset estimator and durable state are unchanged. No exchange endpoint or capability was added. Paper-only and observation-only; no real execution.

## Validation

369 offline tests pass, including 23 new fresh-pair tests. Typecheck/build pass, secret scan reports zero findings, and state check validates the prior temporary paper checkpoint. Dedicated tests cover both one-sided feeds, same timestamps, invalid input, independent directional baselines, immediate economic/depth/quality/sync failure at each lifecycle stage, repeated invalidation and recovery timer reset. Direct versus twice-replayed lifecycle/metrics match excluding event UUID.

All seven corrected latency replay fixtures retain their intended outcomes. Built paper replay processes the six-record clean-fill dataset with no trades at default source warmup settings (execution outcomes are tested separately with explicit test settings). Shadow fixture runs twice identically. Soak runs three iterations of 13776 records with digest `c5bd853aa329c09e6b3fe7d75581ef24c08f086f6bb39130fba76aa7ec827492`, zero default-threshold trades; this finite check is not long-run proof or evidence of live execution. No live private requests are needed for this patch.
