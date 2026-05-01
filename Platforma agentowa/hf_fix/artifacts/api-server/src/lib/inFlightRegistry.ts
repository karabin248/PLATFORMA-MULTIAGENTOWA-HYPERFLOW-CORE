interface InFlightEntry {
  runId: string;
  agentId: string;
  correlationId: string;
  abortController: AbortController;
  startedAt: Date;
}

class InFlightRegistry {
  private readonly registry = new Map<string, InFlightEntry>();

  get activeCount(): number {
    return this.registry.size;
  }

  register(entry: InFlightEntry): void {
    this.registry.set(entry.runId, entry);
  }

  remove(runId: string): void {
    this.registry.delete(runId);
  }

  /**
   * Abort an in-flight run.
   * Returns true if the run was found and aborted, false if it was already gone.
   */
  abort(runId: string): boolean {
    const entry = this.registry.get(runId);
    if (!entry) return false;
    entry.abortController.abort();
    return true;
  }

  getActiveRuns(): Array<Omit<InFlightEntry, "abortController">> {
    return Array.from(this.registry.values()).map(
      ({ runId, agentId, correlationId, startedAt }) => ({
        runId,
        agentId,
        correlationId,
        startedAt,
      }),
    );
  }
}

export const inFlightRegistry = new InFlightRegistry();
