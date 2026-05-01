export interface LatencyBucket {
  count: number;
  sum: number;
  values: number[];
}

class MetricsCollector {
  private requestCount = 0;
  private requestsByMethod: Record<string, number> = {};
  private requestsByStatus: Record<string, number> = {};
  private runTotal = 0;
  private runSuccess = 0;
  private runFailed = 0;
  private runTimeout = 0;
  private runCancelled = 0;
  private concurrencyDenied = 0;
  private idempotencyHits = 0;
  private validationDenied = 0;
  private runLatencies: number[] = [];
  private requestLatencies: number[] = [];
  private startedAt = Date.now();
  private _activeRuns = 0;

  recordRequest(method: string, statusCode: number, durationMs: number): void {
    this.requestCount++;
    this.requestsByMethod[method] = (this.requestsByMethod[method] || 0) + 1;
    const bucket = `${Math.floor(statusCode / 100)}xx`;
    this.requestsByStatus[bucket] = (this.requestsByStatus[bucket] || 0) + 1;
    this.requestLatencies.push(durationMs);
    if (this.requestLatencies.length > 10_000) {
      this.requestLatencies = this.requestLatencies.slice(-5_000);
    }
  }

  recordRun(success: boolean, durationMs: number): void {
    this.runTotal++;
    if (success) this.runSuccess++;
    else this.runFailed++;
    this.runLatencies.push(durationMs);
    if (this.runLatencies.length > 10_000) {
      this.runLatencies = this.runLatencies.slice(-5_000);
    }
  }

  recordTimeout(): void {
    this.runTimeout++;
  }

  recordCancel(): void {
    this.runCancelled++;
  }

  recordConcurrencyDenied(): void {
    this.concurrencyDenied++;
  }

  recordIdempotencyHit(): void {
    this.idempotencyHits++;
  }

  recordValidationDenied(): void {
    this.validationDenied++;
  }

  set activeRuns(count: number) {
    this._activeRuns = count;
  }

  private percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  toPrometheus(poolStats?: Record<string, number>): string {
    const lines: string[] = [];
    const uptime = (Date.now() - this.startedAt) / 1000;

    lines.push("# HELP hyperflow_uptime_seconds Server uptime in seconds");
    lines.push("# TYPE hyperflow_uptime_seconds gauge");
    lines.push(`hyperflow_uptime_seconds ${uptime.toFixed(1)}`);
    lines.push("");

    lines.push("# HELP hyperflow_http_requests_total Total HTTP requests");
    lines.push("# TYPE hyperflow_http_requests_total counter");
    lines.push(`hyperflow_http_requests_total ${this.requestCount}`);
    lines.push("");

    lines.push("# HELP hyperflow_http_requests_by_method HTTP requests by method");
    lines.push("# TYPE hyperflow_http_requests_by_method counter");
    for (const [method, count] of Object.entries(this.requestsByMethod)) {
      lines.push(`hyperflow_http_requests_by_method{method="${method}"} ${count}`);
    }
    lines.push("");

    lines.push("# HELP hyperflow_http_requests_by_status HTTP requests by status bucket");
    lines.push("# TYPE hyperflow_http_requests_by_status counter");
    for (const [bucket, count] of Object.entries(this.requestsByStatus)) {
      lines.push(`hyperflow_http_requests_by_status{status="${bucket}"} ${count}`);
    }
    lines.push("");

    lines.push("# HELP hyperflow_http_request_duration_ms HTTP request latency percentiles");
    lines.push("# TYPE hyperflow_http_request_duration_ms gauge");
    lines.push(`hyperflow_http_request_duration_ms{quantile="0.5"} ${this.percentile(this.requestLatencies, 50)}`);
    lines.push(`hyperflow_http_request_duration_ms{quantile="0.95"} ${this.percentile(this.requestLatencies, 95)}`);
    lines.push("");

    lines.push("# HELP hyperflow_runs_total Total agent runs");
    lines.push("# TYPE hyperflow_runs_total counter");
    lines.push(`hyperflow_runs_total ${this.runTotal}`);
    lines.push("");

    lines.push("# HELP hyperflow_runs_success Successful agent runs");
    lines.push("# TYPE hyperflow_runs_success counter");
    lines.push(`hyperflow_runs_success ${this.runSuccess}`);
    lines.push("");

    lines.push("# HELP hyperflow_runs_failed Failed agent runs");
    lines.push("# TYPE hyperflow_runs_failed counter");
    lines.push(`hyperflow_runs_failed ${this.runFailed}`);
    lines.push("");

    lines.push("# HELP hyperflow_run_duration_ms Agent run latency percentiles");
    lines.push("# TYPE hyperflow_run_duration_ms gauge");
    lines.push(`hyperflow_run_duration_ms{quantile="0.5"} ${this.percentile(this.runLatencies, 50)}`);
    lines.push(`hyperflow_run_duration_ms{quantile="0.95"} ${this.percentile(this.runLatencies, 95)}`);
    lines.push("");

    lines.push("# HELP hyperflow_runs_timeout Timed out agent runs");
    lines.push("# TYPE hyperflow_runs_timeout counter");
    lines.push(`hyperflow_runs_timeout ${this.runTimeout}`);
    lines.push("");

    lines.push("# HELP hyperflow_runs_cancelled Cancelled agent runs");
    lines.push("# TYPE hyperflow_runs_cancelled counter");
    lines.push(`hyperflow_runs_cancelled ${this.runCancelled}`);
    lines.push("");

    lines.push("# HELP hyperflow_concurrency_denied Requests denied due to concurrency limit");
    lines.push("# TYPE hyperflow_concurrency_denied counter");
    lines.push(`hyperflow_concurrency_denied ${this.concurrencyDenied}`);
    lines.push("");

    lines.push("# HELP hyperflow_idempotency_hits Deduplicated requests via idempotency key");
    lines.push("# TYPE hyperflow_idempotency_hits counter");
    lines.push(`hyperflow_idempotency_hits ${this.idempotencyHits}`);
    lines.push("");

    lines.push("# HELP hyperflow_active_runs Currently in-flight runs");
    lines.push("# TYPE hyperflow_active_runs gauge");
    lines.push(`hyperflow_active_runs ${this._activeRuns}`);
    lines.push("");

    if (poolStats) {
      lines.push("# HELP hyperflow_db_pool_total Total pool connections");
      lines.push("# TYPE hyperflow_db_pool_total gauge");
      lines.push(`hyperflow_db_pool_total ${poolStats.totalCount ?? 0}`);
      lines.push("");

      lines.push("# HELP hyperflow_db_pool_active Active pool connections");
      lines.push("# TYPE hyperflow_db_pool_active gauge");
      lines.push(`hyperflow_db_pool_active ${poolStats.activeCount ?? 0}`);
      lines.push("");

      lines.push("# HELP hyperflow_db_pool_idle Idle pool connections");
      lines.push("# TYPE hyperflow_db_pool_idle gauge");
      lines.push(`hyperflow_db_pool_idle ${poolStats.idleCount ?? 0}`);
      lines.push("");

      lines.push("# HELP hyperflow_db_pool_waiting Waiting pool requests");
      lines.push("# TYPE hyperflow_db_pool_waiting gauge");
      lines.push(`hyperflow_db_pool_waiting ${poolStats.waitingCount ?? 0}`);
      lines.push("");

      lines.push("# HELP hyperflow_db_pool_errors_total Total pool errors");
      lines.push("# TYPE hyperflow_db_pool_errors_total counter");
      lines.push(`hyperflow_db_pool_errors_total ${poolStats.totalErrors ?? 0}`);
    }

    return lines.join("\n") + "\n";
  }
}

export const metrics = new MetricsCollector();
