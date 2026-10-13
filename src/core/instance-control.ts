// Instance-wide control state: whether new invocations may start. Persisted, so a
// pause survives a restart of the instance.
export interface InstanceControl {
  isPaused(): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
}
