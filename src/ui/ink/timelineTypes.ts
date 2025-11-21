export type UITimelineTaskStatus =
  | "started"
  | "updated"
  | "succeeded"
  | "failed";

export type UITimelineLogLevel = "info" | "note" | "warn" | "error";

interface UITimelineEventBase {
  id: string;
  timestamp: number;
}

export interface UITimelineTaskEvent extends UITimelineEventBase {
  type: "task";
  status: UITimelineTaskStatus;
  label: string;
  detail?: string;
}

export interface UITimelineLogEvent extends UITimelineEventBase {
  type: "log";
  level: UITimelineLogLevel;
  message: string;
}

export type UITimelineEvent = UITimelineTaskEvent | UITimelineLogEvent;
