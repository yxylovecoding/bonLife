export interface OrchestrateProgress {
  state: 'queued' | 'running' | 'success' | 'failed' | 'unknown';
  message: string;
}
