import type { PaperRiskSummary, SessionRiskState } from '../risk/paper-risk-manager.js';
import type { ClockHealthStatus } from '../timing/clock-health.js';
import type { SyncStatus } from '../timing/sync-model.js';
import { MAX_FEED_SILENCE_MS } from '../config/runtime.js';

export type OperationalState =
  | 'STARTING'
  | 'RECOVERING'
  | 'WARMING_UP'
  | 'RUNNING'
  | 'DEGRADED'
  | 'SHUTTING_DOWN';

export interface ServiceHealth {
  version?: string;
  uptimeSec?: number;
  readinessReasons?: ReadinessReason[];
  market: { bybitConnected: boolean; okxConnected: boolean };
  timing: {
    syncStatus: SyncStatus | null;
    clockHealth: ClockHealthStatus;
  };
  persistence: {
    checkpointHealthy: boolean;
    journalHealthy: boolean;
    lastCheckpointAt: number | null;
  };
  paper: {
    operationalState: OperationalState;
    riskState: SessionRiskState;
    openTrades: number;
    residualExposure: number;
  };
}
export type ReadinessReason = 'MARKET_DISCONNECTED' | 'FEED_SILENT' | 'TIMING_UNHEALTHY' | 'PERSISTENCE_UNHEALTHY' | 'RECOVERING' | 'SHUTTING_DOWN';

export class OperationalStateManager {
  private state: OperationalState = 'STARTING';
  private bybitConnected = false;
  private okxConnected = false;
  private syncStatus: SyncStatus | null = null;
  private clockHealth: ClockHealthStatus = 'WARMING_UP';
  private checkpointHealthy = true;
  private journalHealthy = true;
  private lastCheckpointAt: number | null = null;
  private recoveryFailed = false;
  readonly heartbeat: Record<'lastBybitBookAt' | 'lastOkxBookAt' | 'lastComparisonAt' | 'lastExecutionEventAt', number | null> = {
    lastBybitBookAt: null, lastOkxBookAt: null, lastComparisonAt: null, lastExecutionEventAt: null,
  };
  constructor(private readonly now: () => number = Date.now, private readonly maxSilence = MAX_FEED_SILENCE_MS) {}
  observeBook(exchange: 'bybit' | 'okx', at = this.now()): void {
    this.heartbeat[exchange === 'bybit' ? 'lastBybitBookAt' : 'lastOkxBookAt'] = at;
    this.refreshState();
  }
  feedSilent(): boolean {
    return [this.heartbeat.lastBybitBookAt, this.heartbeat.lastOkxBookAt]
      .some(at => at === null || this.now() - at > this.maxSilence || this.now() < at);
  }
  reasons(): ReadinessReason[] {
    const reasons: ReadinessReason[] = [];
    if (this.state === 'STARTING' || this.state === 'RECOVERING' || this.recoveryFailed) reasons.push('RECOVERING');
    if (this.state === 'SHUTTING_DOWN') reasons.push('SHUTTING_DOWN');
    if (!this.bybitConnected || !this.okxConnected) reasons.push('MARKET_DISCONNECTED');
    if (this.feedSilent()) reasons.push('FEED_SILENT');
    if (this.syncStatus !== 'SYNC_HEALTHY' || this.clockHealth !== 'HEALTHY') reasons.push('TIMING_UNHEALTHY');
    if (!this.checkpointHealthy || !this.journalHealthy) reasons.push('PERSISTENCE_UNHEALTHY');
    return reasons;
  }

  beginRecovery(): void {
    this.state = 'RECOVERING';
  }

  completeRecovery(): void {
    if (this.state !== 'DEGRADED') {
      this.state = 'WARMING_UP';
      this.refreshState();
    }
  }

  failRecovery(): void {
    this.recoveryFailed = true;
    this.state = 'DEGRADED';
  }

  beginShutdown(): void {
    this.state = 'SHUTTING_DOWN';
  }

  setFeedConnected(exchange: 'bybit' | 'okx', connected: boolean): void {
    if (!connected) this.heartbeat[exchange === 'bybit' ? 'lastBybitBookAt' : 'lastOkxBookAt'] = null;
    if (exchange === 'bybit') {
      this.bybitConnected = connected;
    } else {
      this.okxConnected = connected;
    }
    this.refreshState();
  }

  observeTiming(syncStatus: SyncStatus, clockHealth: ClockHealthStatus): void {
    this.syncStatus = syncStatus;
    this.clockHealth = clockHealth;
    this.refreshState();
  }

  setPersistenceHealth(input: {
    checkpointHealthy: boolean;
    journalHealthy: boolean;
    lastCheckpointAt: number | null;
  }): void {
    this.checkpointHealthy = input.checkpointHealthy;
    this.journalHealthy = input.journalHealthy;
    this.lastCheckpointAt = input.lastCheckpointAt;
    this.refreshState();
  }

  canAcceptPaperEntry(): boolean {
    this.refreshState();
    return this.state === 'RUNNING';
  }

  getState(): OperationalState {
    this.refreshState();
    return this.state;
  }

  getHealth(risk: PaperRiskSummary): ServiceHealth {
    this.refreshState();
    return {
      version: '0.4.2', uptimeSec: process.uptime(), readinessReasons: this.reasons(),
      market: {
        bybitConnected: this.bybitConnected,
        okxConnected: this.okxConnected,
      },
      timing: {
        syncStatus: this.syncStatus,
        clockHealth: this.clockHealth,
      },
      persistence: {
        checkpointHealthy: this.checkpointHealthy,
        journalHealthy: this.journalHealthy,
        lastCheckpointAt: this.lastCheckpointAt,
      },
      paper: {
        operationalState: this.state,
        riskState: risk.state,
        openTrades: risk.openTrades,
        residualExposure: risk.globalResidualBtc,
      },
    };
  }

  private refreshState(): void {
    if (
      this.state === 'STARTING' ||
      this.state === 'RECOVERING' ||
      this.state === 'SHUTTING_DOWN'
    ) {
      return;
    }
    if (this.recoveryFailed || !this.checkpointHealthy || !this.journalHealthy) {
      this.state = 'DEGRADED';
      return;
    }
    this.state =
      this.bybitConnected &&
      this.okxConnected &&
      !this.feedSilent() &&
      this.syncStatus === 'SYNC_HEALTHY' &&
      this.clockHealth === 'HEALTHY'
        ? 'RUNNING'
        : 'WARMING_UP';
  }
}
