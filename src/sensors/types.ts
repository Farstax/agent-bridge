export type SensorStatus = "green" | "amber" | "red";

export interface SensorCheck {
  name: string;
  status: SensorStatus;
  message: string;
  value?: string | number;
}

export interface SensorReport {
  sensorId: string;
  label: string;
  status: SensorStatus;
  checks: SensorCheck[];
  summary: string;
  timestamp: string;
}

export interface Sensor {
  readonly id: string;
  readonly label: string;
  check(): Promise<SensorReport>;
}
