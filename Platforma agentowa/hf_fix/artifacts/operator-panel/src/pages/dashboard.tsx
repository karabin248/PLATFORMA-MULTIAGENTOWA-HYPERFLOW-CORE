import { Link } from "wouter";
import {
  useGetMetrics,
  useListAgents,
  getGetMetricsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatScore(score: number | null | undefined): string {
  if (score == null) return "—";
  return score.toFixed(3);
}

export default function DashboardPage() {
  const { data: metrics } = useGetMetrics({
    query: { queryKey: getGetMetricsQueryKey(), refetchInterval: 10000 },
  });

  const { data: agentsData } = useListAgents();

  const activeAgents = agentsData?.agents.filter((a) => a.status === "active").length ?? 0;
  const totalAgents = agentsData?.total ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Hyperflow Agent Platform operator overview</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Total Runs" value={metrics?.total ?? "—"} sub={metrics ? `${metrics.completed} completed` : undefined} />
        <MetricCard
          label="Success Rate"
          value={metrics && metrics.total > 0 ? `${Math.round((metrics.completed / metrics.total) * 100)}%` : "—"}
          sub={metrics ? `${metrics.failed} failed, ${metrics.cancelled} cancelled` : undefined}
        />
        <MetricCard label="Avg Duration" value={formatMs(metrics?.avgDurationMs)} />
        <MetricCard label="Avg Quality" value={formatScore(metrics?.avgQualityScore)} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Active Agents" value={activeAgents} sub={`${totalAgents} total registered`} />
        <MetricCard label="Retried Runs" value={metrics?.retried ?? "—"} />
        <MetricCard label="Timed Out" value={(metrics as unknown as Record<string, unknown>)?.timedOut as number ?? "—"} />
        <MetricCard
          label="System Pressure"
          value={metrics ? `${(metrics as unknown as Record<string, unknown>).activeRuns ?? 0} / ${(metrics as unknown as Record<string, unknown>).maxConcurrentRuns ?? "?"}` : "—"}
          sub={metrics ? `Active runs / capacity` : undefined}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/agents">
          <div className="rounded-lg border p-6 cursor-pointer hover:bg-muted/50 transition-colors">
            <h2 className="font-medium mb-1">Agent Catalog</h2>
            <p className="text-sm text-muted-foreground">View, create, and manage registered agents</p>
          </div>
        </Link>
        <Link href="/runs">
          <div className="rounded-lg border p-6 cursor-pointer hover:bg-muted/50 transition-colors">
            <h2 className="font-medium mb-1">Run History</h2>
            <p className="text-sm text-muted-foreground">Browse, filter, and inspect agent execution records</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
