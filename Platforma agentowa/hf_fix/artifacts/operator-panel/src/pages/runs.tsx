import { useState } from "react";
import { Link } from "wouter";
import {
  useListRuns,
  useListAgents,
  getListRunsQueryKey,
} from "@workspace/api-client-react";
import type {
  AgentRun,
  ListRunsParams,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function statusVariant(status: string) {
  switch (status) {
    case "completed": return "default" as const;
    case "failed": return "destructive" as const;
    case "running": return "secondary" as const;
    case "cancelled": return "outline" as const;
    default: return "outline" as const;
  }
}

function statusLabel(run: AgentRun): string {
  if (run.status === "failed" && (run as unknown as Record<string, unknown>).errorCode === "CORE_TIMEOUT") return "timed out";
  return run.status;
}

function RunRow({ run }: { run: AgentRun }) {
  const prompt = (run.input as Record<string, string>)?.prompt || JSON.stringify(run.input).slice(0, 80);

  return (
    <Link href={`/runs/${run.id}`}>
      <div className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          <Badge variant={statusVariant(run.status)} className="text-xs shrink-0">{statusLabel(run)}</Badge>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{prompt}</p>
            <p className="text-xs text-muted-foreground">
              <code>{run.id.slice(0, 8)}</code> | {run.agentId} v{run.agentVersion}
              {(run.retryCount ?? 0) > 0 && <span className="ml-1">(retry #{run.retryCount})</span>}
            </p>
          </div>
        </div>
        <div className="text-right shrink-0 text-xs text-muted-foreground space-y-0.5">
          {run.durationMs != null && <p>{run.durationMs}ms</p>}
          {run.qualityScore != null && <p>Q: {run.qualityScore.toFixed(3)}</p>}
          <p>{new Date(run.createdAt).toLocaleString()}</p>
        </div>
      </div>
    </Link>
  );
}

export default function RunsPage() {
  const [filters, setFilters] = useState<ListRunsParams>({});
  const [search, setSearch] = useState("");

  const { data: agentsData } = useListAgents();

  const activeFilters: ListRunsParams = {
    ...filters,
    q: search || undefined,
  };

  const { data, isLoading, error } = useListRuns(activeFilters, {
    query: { queryKey: getListRunsQueryKey(activeFilters), refetchInterval: 5000 },
  });

  function updateFilter(key: keyof ListRunsParams, value: string | undefined) {
    setFilters((prev) => {
      const next = { ...prev };
      if (value) {
        (next as Record<string, unknown>)[key] = value;
      } else {
        delete (next as Record<string, unknown>)[key];
      }
      return next;
    });
  }

  const hasFilters = Object.keys(filters).length > 0 || search;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Run History</h1>
        <p className="text-sm text-muted-foreground">All agent execution records</p>
      </div>

      <Card>
        <CardContent className="pt-4">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Status</label>
              <Select value={(filters.status as string) || "_all"} onValueChange={(v) => updateFilter("status", v === "_all" ? undefined : v)}>
                <SelectTrigger className="w-[130px]">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="running">Running</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                  <SelectItem value="queued">Queued</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Agent</label>
              <Select value={filters.agentId || "_all"} onValueChange={(v) => updateFilter("agentId", v === "_all" ? undefined : v)}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="All agents" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="_all">All agents</SelectItem>
                  {agentsData?.agents.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1 flex-1 min-w-[200px]">
              <label className="text-xs text-muted-foreground">Search</label>
              <Input
                placeholder="Search prompts, errors, IDs..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={() => { setFilters({}); setSearch(""); }}>
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading && <p className="text-sm text-muted-foreground">Loading runs...</p>}
      {error && <p className="text-sm text-destructive">Failed to load runs: {String(error)}</p>}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {data ? `${data.total} run${data.total !== 1 ? "s" : ""}` : "Runs"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data?.runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
          {data && data.runs.length === 0 && (
            <p className="text-sm text-muted-foreground">No runs match the current filters.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
