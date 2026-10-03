import { reportEvidence } from './shadow-evidence/report.js';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--dir' || !args[1]) throw new Error('Usage: shadow:report -- --dir <run-or-parent>');
const report = await reportEvidence(args[1]);
console.log(`Observed shadow survival report: ${report.runCount} run(s).`);
for (const warning of [...report.warnings, ...report.caveats]) console.log(`NOTE: ${warning}`);
for (const c of report.configurations) {
  console.log(JSON.stringify({ fingerprint: c.configFingerprint, contexts: c.contexts, runs: c.runCount, observationDurationMs: c.observationDurationMs,
    records: c.records, completeGroups: c.completeGroups, incompleteGroups: c.incompleteGroups,
    evidenceComplete: c.evidenceComplete, warnings: c.dataQualityWarnings, losses: c.losses }));
  console.table(c.scenarioTable.map(p => ({ profile: p.id, latencyMs: p.latencyMs, label: p.label, attempts: p.attempts,
    cleanFillRate: p.cleanFillRate, positiveFinalRate: p.positiveFinalRate, noFillRate: p.noFillRate, oneLegRate: p.oneLegRate,
    medianNetPnl: p.medianNetPnl, P95NetPnl: p.P95NetPnl })));
  console.table(Object.entries(c.splits).filter(([key]) => key !== 'aggregate' && !key.includes('profile:')).map(([split, v]) =>
    ({ split, attempts: v.attempts, positive: v.positiveFinal, negative: v.negativeFinal, clean: v.cleanFills, noFill: v.noFill,
      medianPnl: v.medianNetPnl, P95Pnl: v.P95NetPnl, medianFillRatio: v.fillRatio.median, medianDurationMs: v.timing.median })));
  console.table(c.latencyDecay);
}
