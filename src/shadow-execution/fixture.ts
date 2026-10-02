import { MarketPipeline } from '../app/pipeline.js';
import { TIMING_CONFIG } from '../config/timing.js';
import type { OpportunityEvent } from '../scanner/opportunity.js';
import { shadowFixture } from '../shadow/fixture.js';

// Synthetic accounts and real fresh-pair lifecycle; never an external account.
export function executionFixture(at = 1_700_000_000_000) {
  const input = shadowFixture(0.001, 103, at);
  const events: OpportunityEvent[] = [];
  const pipeline = new MarketPipeline({ timingConfig: { ...TIMING_CONFIG, minOffsetSamples: 1 },
    qualityConfig: { minActiveDurationMs: 0, minNetPnlUsdt: 0.001, minNetSpreadPercent: 0, maxSyncDiffMsForQualified: 100 },
    onEvent: event => { if (event.state === 'QUALIFIED') events.push(event); } });
  for (let i = 0; i < 2; i++) {
    pipeline.processOrderBook(structuredClone(input.books.bybit), at);
    pipeline.processOrderBook(structuredClone(input.books.okx), at);
  }
  const qualified = events[0];
  if (!qualified) throw new Error('Synthetic fixture must pass fresh-pair qualification.');
  return { input, event: { ...qualified, id: `fixture-${at}` } };
}
