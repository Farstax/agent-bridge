export type HealthStatus = "green" | "amber" | "red";

export interface CheckResult {
  name: string;
  status: HealthStatus;
  message: string;
  value?: string | number;
}

export interface HealthReport {
  pluginName: string;
  status: HealthStatus;
  checks: CheckResult[];
  summary: string;
  timestamp: string;
}

export interface HealthAggregate {
  status: HealthStatus | null;
  reports: HealthReport[];
  nonGreenReports: HealthReport[];
  evidence: {
    missingPluginNames: string[];
    stalePluginNames: string[];
  };
}


export interface HealthPlugin {
  name: string;
  check(): Promise<HealthReport>;
}

export interface HealthConfig {
  enabled: boolean;
  cadenceSeconds: number;
  silenceOnGreen?: boolean;
}
