import type { PaperRiskSummary, SessionRiskState } from '../risk/paper-risk-manager.js';
import type { ClockHealthStatus } from '../timing/clock-health.js';
import type { SyncStatus } from '../timing/sync-model.js';

export type OperationalState =
  | 'STARTING'
  | 'RECOVERING'
  | 'WARMING_UP'
  | 'RUNNING'
  | 'DEGRADED'
  | 'SHUTTING_DOWN';

export interface ServiceHealth {
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

export class OperationalStateManager {
  private state: OperationalState = 'STARTING';
  private bybitConnected = false;
  private okxConnected = false;
  private syncStatus: SyncStatus | null = null;
  private clockHealth: ClockHealthStatus = 'WARMING_UP';
  private checkpointHealthy = true;
  private journalHealthy = true;
  private lastCheckpointAt: number | null = null;

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
    this.state = 'DEGRADED';
  }

  beginShutdown(): void {
    this.state = 'SHUTTING_DOWN';
  }

  setFeedConnected(exchange: 'bybit' | 'okx', connected: boolean): void {
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
    return this.state === 'RUNNING';
  }

  getState(): OperationalState {
    return this.state;
  }

  getHealth(risk: PaperRiskSummary): ServiceHealth {
    return {
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
    if (!this.checkpointHealthy || !this.journalHealthy) {
      this.state = 'DEGRADED';
      return;
    }
    this.state =
      this.bybitConnected &&
      this.okxConnected &&
      this.syncStatus === 'SYNC_HEALTHY' &&
      this.clockHealth === 'HEALTHY'
        ? 'RUNNING'
        : 'WARMING_UP';
  }
}
