import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import {
  useGetRun,
  useRetryRun,
  useCancelRun,
  getGetRunQueryKey,
  getListRunsQueryKey,
  getGetMetricsQueryKey,
} from "@workspace/api-client-react";
import type {
  CanonicalTrace,
  NormalizedOutput,
  AgentRunRetryChainItem,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function extractEmoji(combo: string): string[] {
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(combo)];
  return segments.map(s => s.segment).filter(s => /\p{Emoji}/u.test(s));
}

function buildPhaseEmoji(combo: string, phases: string[]): Record<string, string> {
  const emojis = extractEmoji(combo);
  const map: Record<string, string> = {};
  phases.forEach((phase, i) => { if (emojis[i]) map[phase] = emojis[i]; });
  return map;
}

function CanonicalTraceCard({ trace }: { trace: CanonicalTrace }) {
  const combo = trace.canonical_combo || "";
  const phases = trace.canonical_phases || [];
  const phasesCompleted = trace.phases_completed || [];
  const phaseEmoji = buildPhaseEmoji(combo, phases);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          Canonical Execution Trace
          {trace.order_preserved ? (
            <Badge variant="default" className="text-xs">Order Preserved</Badge>
          ) : (
            <Badge variant="destructive" className="text-xs">Order Violation</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-1 text-2xl tracking-widest">
          {combo}
        </div>

        <div className="flex flex-wrap gap-2">
          {phases.map((phase) => {
            const completed = phasesCompleted.includes(phase);
            const isTerminal = phase === trace.terminal_phase;
            return (
              <Badge
                key={phase}
                variant={completed ? "default" : "outline"}
                className={`text-xs ${isTerminal ? "ring-2 ring-primary ring-offset-1" : ""}`}
              >
                {phaseEmoji[phase] || ""} {phase}
                {isTerminal && " (terminal)"}
              </Badge>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <span className="text-muted-foreground">Cycle version:</span>{" "}
            {trace.cycle_version}
          </div>
          <div>
            <span className="text-muted-foreground">MPS level:</span>{" "}
            {trace.mps_level} ({trace.mps_name})
          </div>
          <div>
            <span className="text-muted-foreground">Phases completed:</span>{" "}
            {phasesCompleted.length} / {phases.length}
          </div>
          <div>
            <span className="text-muted-foreground">Combo detected:</span>{" "}
            {trace.canonical_combo_detected ? "Yes" : "No"}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function NormalizedOutputCard({ output }: { output: NormalizedOutput }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Normalized Output</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Summary</p>
          <p className="text-sm">{output.summary}</p>
        </div>
        {output.qualityScore != null && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Quality:</span>
            <Badge variant={output.qualityScore >= 0.8 ? "default" : output.qualityScore >= 0.5 ? "secondary" : "destructive"}>
              {output.qualityScore.toFixed(3)}
            </Badge>
          </div>
        )}
        {output.warnings.length > 0 && (
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-1">Warnings</p>
            <div className="flex flex-wrap gap-1">
              {output.warnings.map((w, i) => <Badge key={i} variant="outline" className="text-xs">{w}</Badge>)}
            </div>
          </div>
        )}
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Structured Data</p>
          <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-40">{JSON.stringify(output.structured, null, 2)}</pre>
        </div>
      </CardContent>
    </Card>
  );
}

function RetryChainCard({ chain }: { chain: AgentRunRetryChainItem[] }) {
  if (chain.length === 0) return null;
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Retry Chain</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-2">
          {chain.map((entry) => {
            const ext = entry as Record<string, unknown>;
            return (
              <Link key={entry.id} href={`/runs/${entry.id}`}>
                <div className="flex items-center justify-between p-2 rounded hover:bg-muted cursor-pointer text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={entry.status === "completed" ? "default" : entry.status === "failed" ? "destructive" : "secondary"} className="text-xs">
                      {entry.status}
                    </Badge>
                    <code className="text-xs">{entry.id.slice(0, 12)}</code>
                    {ext.errorCode ? <span className="text-xs text-muted-foreground">{String(ext.errorCode)}</span> : null}
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {ext.durationMs != null && <span className="mr-2">{String(ext.durationMs)}ms</span>}
                    <span>{new Date(entry.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function ForensicsCard({ run }: { run: Record<string, unknown> }) {
  const forensics = run.forensics as Record<string, unknown> | undefined;
  if (!forensics) return null;
  return (
    <Card className="border-amber-500/50">
      <CardHeader><CardTitle className="text-base">Failure Forensics</CardTitle></CardHeader>
      <CardContent className="space-y-2 text-sm">
        {forensics.errorCode ? <div><span className="text-muted-foreground">Error Code:</span> <code>{String(forensics.errorCode)}</code></div> : null}
        {forensics.errorCategory ? <div><span className="text-muted-foreground">Category:</span> <Badge variant="outline" className="text-xs">{String(forensics.errorCategory)}</Badge></div> : null}
      </CardContent>
    </Card>
  );
}

function TimelineCard({ timeline }: { timeline: Record<string, unknown> }) {
  if (!timeline) return null;
  const entries = [
    { label: "Created", time: timeline.created },
    { label: "Admitted", time: timeline.admitted },
    { label: "Started", time: timeline.started },
    { label: "Completed", time: timeline.completed },
    { label: "Failed", time: timeline.failed },
    { label: "Cancelled", time: timeline.cancelled },
  ].filter((e) => e.time != null);

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
      <CardContent>
        <div className="space-y-1 text-sm">
          {entries.map((e) => (
            <div key={e.label} className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
              <span className="text-muted-foreground w-20">{e.label}</span>
              <span>{new Date(String(e.time)).toLocaleString()}</span>
            </div>
          ))}
          {timeline.durationMs != null && (
            <div className="pt-1 text-xs text-muted-foreground">Total: {String(timeline.durationMs)}ms</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [outputView, setOutputView] = useState<"normalized" | "raw">("normalized");

  const { data: run, isLoading, error } = useGetRun(id!, {
    query: { queryKey: getGetRunQueryKey(id!), enabled: !!id },
  });

  const retry = useRetryRun({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(id!) });
        queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMetricsQueryKey() });
      },
    },
  });

  const cancel = useCancelRun({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetRunQueryKey(id!) });
        queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMetricsQueryKey() });
      },
    },
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">Error: {String(error)}</p>;
  if (!run) return <p className="text-sm text-destructive">Run not found</p>;

  const prompt = (run.input as Record<string, string>)?.prompt || JSON.stringify(run.input);
  const isTerminal = ["completed", "failed", "cancelled"].includes(run.status);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/runs" className="text-sm text-muted-foreground hover:underline">Runs</Link>
        <span className="text-sm text-muted-foreground">/</span>
        <code className="text-sm font-medium">{run.id.slice(0, 12)}...</code>
      </div>

      <div className="flex items-center gap-3">
        <Badge variant={run.status === "completed" ? "default" : run.status === "failed" ? "destructive" : "secondary"} className="text-sm">
          {run.status}
        </Badge>
        {run.status === "failed" && (
          <Button size="sm" variant="outline" onClick={() => retry.mutate({ id: id!, data: {} })} disabled={retry.isPending}>
            {retry.isPending ? "Retrying..." : "Retry"}
          </Button>
        )}
        {!isTerminal && (
          <Button size="sm" variant="destructive" onClick={() => cancel.mutate({ id: id! })} disabled={cancel.isPending}>
            {cancel.isPending ? "Cancelling..." : "Cancel"}
          </Button>
        )}
        {(run.retryCount ?? 0) > 0 && (
          <Badge variant="outline" className="text-xs">Retry #{run.retryCount}</Badge>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">Metadata</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Run ID:</span> <code className="text-xs">{run.id}</code></div>
            <div><span className="text-muted-foreground">Agent:</span> <Link href={`/agents/${run.agentId}`} className="text-primary hover:underline">{run.agentId}</Link></div>
            <div><span className="text-muted-foreground">Version:</span> {run.agentVersion}</div>
            <div><span className="text-muted-foreground">Requested by:</span> {run.requestedBy || "unknown"}</div>
            {run.parentRunId && <div><span className="text-muted-foreground">Retry of:</span> <Link href={`/runs/${run.parentRunId}`} className="text-primary hover:underline"><code className="text-xs">{run.parentRunId.slice(0, 12)}</code></Link></div>}
            {run.originRunId && <div><span className="text-muted-foreground">Origin:</span> <code className="text-xs">{run.originRunId.slice(0, 12)}</code></div>}
            {run.retryReason && <div><span className="text-muted-foreground">Retry reason:</span> {run.retryReason}</div>}
            {run.runtimeRunId && <div><span className="text-muted-foreground">Core run:</span> <code className="text-xs">{run.runtimeRunId.slice(0, 12)}</code></div>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Timing</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div><span className="text-muted-foreground">Created:</span> {new Date(run.createdAt).toLocaleString()}</div>
            {run.queuedAt && <div><span className="text-muted-foreground">Queued:</span> {new Date(run.queuedAt).toLocaleString()}</div>}
            {run.startedAt && <div><span className="text-muted-foreground">Started:</span> {new Date(run.startedAt).toLocaleString()}</div>}
            {run.completedAt && <div><span className="text-muted-foreground">Completed:</span> {new Date(run.completedAt).toLocaleString()}</div>}
            {run.failedAt && <div><span className="text-muted-foreground">Failed:</span> {new Date(run.failedAt).toLocaleString()}</div>}
            {run.cancelledAt && <div><span className="text-muted-foreground">Cancelled:</span> {new Date(run.cancelledAt).toLocaleString()}</div>}
            {run.durationMs != null && <div><span className="text-muted-foreground">Duration:</span> {run.durationMs}ms</div>}
            {run.qualityScore != null && <div><span className="text-muted-foreground">Quality:</span> {run.qualityScore.toFixed(3)}</div>}
          </CardContent>
        </Card>
      </div>

      {run.canonicalTrace && <CanonicalTraceCard trace={run.canonicalTrace} />}

      <Card>
        <CardHeader><CardTitle className="text-base">Input</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm mb-2">{prompt}</p>
          <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-40">{JSON.stringify(run.input, null, 2)}</pre>
        </CardContent>
      </Card>

      {(run as unknown as Record<string, unknown>).timeline ? <TimelineCard timeline={(run as unknown as Record<string, unknown>).timeline as Record<string, unknown>} /> : null}

      {run.error && (
        <Card className="border-destructive/50">
          <CardHeader><CardTitle className="text-base text-destructive">Error</CardTitle></CardHeader>
          <CardContent>
            <pre className="text-sm text-destructive whitespace-pre-wrap">{run.error}</pre>
          </CardContent>
        </Card>
      )}

      {(run.status === "failed" || run.status === "cancelled") ? <ForensicsCard run={run as unknown as Record<string, unknown>} /> : null}

      {(run.normalizedOutput || run.output) && (
        <div>
          <Tabs value={outputView} onValueChange={(v) => setOutputView(v as "normalized" | "raw")}>
            <TabsList>
              <TabsTrigger value="normalized">Normalized Output</TabsTrigger>
              <TabsTrigger value="raw">Raw Output</TabsTrigger>
            </TabsList>

            <TabsContent value="normalized">
              {run.normalizedOutput ? (
                <NormalizedOutputCard output={run.normalizedOutput} />
              ) : run.output ? (
                <Card>
                  <CardHeader><CardTitle className="text-base">Output</CardTitle></CardHeader>
                  <CardContent>
                    <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-60">{JSON.stringify(run.output, null, 2)}</pre>
                  </CardContent>
                </Card>
              ) : (
                <Card><CardContent className="pt-4"><p className="text-sm text-muted-foreground">No normalized output available.</p></CardContent></Card>
              )}
            </TabsContent>

            <TabsContent value="raw">
              <Card>
                <CardHeader><CardTitle className="text-base">Raw Output</CardTitle></CardHeader>
                <CardContent>
                  <pre className="bg-muted p-3 rounded text-xs overflow-auto max-h-96">
                    {JSON.stringify(run.output, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      )}

      {run.retryChain && run.retryChain.length > 0 && <RetryChainCard chain={run.retryChain} />}

      {retry.data && (
        <Card className="border-primary/50">
          <CardHeader><CardTitle className="text-base">Retry Result</CardTitle></CardHeader>
          <CardContent>
            <pre className="bg-muted p-3 rounded text-xs overflow-auto">{JSON.stringify(retry.data, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
