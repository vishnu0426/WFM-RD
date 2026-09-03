/** §2.1's `AgentLiveState` hash fields, minus `last_updated_at` (stamped by `IntradayRedisService` on every write, never caller-supplied). */
export interface AgentLiveStateFields {
  currentActivity: string;
  activityStartedAt: string;
  scheduledActivity: string | null;
  adherenceStatus: string | null;
  siteId: string | null;
  queueId: string | null;
}

export type AgentLiveStateRecord = AgentLiveStateFields & { lastUpdatedAt: string };

/** §2.1's `QueueLiveState` hash fields, minus `last_updated_at`. */
export interface QueueLiveStateFields {
  currentVolume: number;
  agentsAvailable: number;
  agentsOnCall: number;
  forecastedVolume: number | null;
  serviceLevelCurrent: number | null;
  serviceLevelTarget: number | null;
}

export type QueueLiveStateRecord = QueueLiveStateFields & { lastUpdatedAt: string };
