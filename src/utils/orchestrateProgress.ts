export interface OrchestrateProgress {
  state: 'queued' | 'running' | 'retrying' | 'success' | 'partial' | 'failed' | 'unknown';
  message: string;
  generatedAt?: string;
  completed?: string[];
  deferred?: string[];
  failed?: string[];
}
