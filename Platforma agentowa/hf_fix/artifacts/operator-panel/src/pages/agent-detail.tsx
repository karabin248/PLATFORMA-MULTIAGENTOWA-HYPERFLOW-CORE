import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, Link } from "wouter";
import {
  useGetAgent,
  useRunAgent,
  useListRuns,
  useGetRevisions,
  useUpdateAgent,
  useDisableAgent,
  useEnableAgent,
  getGetAgentQueryKey,
  getListAgentsQueryKey,
  getGetRevisionsQueryKey,
  getListRunsQueryKey,
  getGetMetricsQueryKey,
} from "@workspace/api-client-react";
import type {
  Agent,
  AgentRevision,
  RunResponse,
  UpdateAgentPayload,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";

function RevisionList({ agentId }: { agentId: string }) {
  const { data } = useGetRevisions(agentId);

  if (!data || data.revisions.length === 0) {
    return <p className="text-sm text-muted-foreground">No revisions yet.</p>;
  }

  return (
    <div className="space-y-3">
      {data.revisions.map((rev: AgentRevision) => (
        <div key={rev.id} className="rounded-lg border p-3 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">Rev {rev.revisionNumber}</Badge>
              <span className="text-xs text-muted-foreground">by {rev.changedBy}</span>
            </div>
            <span className="text-xs text-muted-foreground">{new Date(rev.createdAt).toLocaleString()}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {rev.changedFields.map((f) => (
              <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
            ))}
          </div>
          <div className="text-xs text-muted-foreground">
            v{(rev.spec as Record<string, unknown>).version as string}
            {" — "}
            {(rev.spec as Record<string, unknown>).description as string}
          </div>
        </div>
      ))}
    </div>
  );
}

function EditDialog({ agent, onSuccess }: { agent: Agent; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    name: agent.name,
    version: agent.version,
    description: agent.description || "",
    role: agent.role,
    capabilities: agent.capabilities.join(", "),
  });

  const mutation = useUpdateAgent({
    mutation: {
      onSuccess: () => {
        onSuccess();
        setOpen(false);
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: UpdateAgentPayload = {};
    if (form.name !== agent.name) payload.name = form.name;
    if (form.version !== agent.version) payload.version = form.version;
    if (form.description !== (agent.description || "")) payload.description = form.description;
    if (form.role !== agent.role) payload.role = form.role;
    const caps = form.capabilities.split(",").map((s) => s.trim()).filter(Boolean);
    if (JSON.stringify(caps) !== JSON.stringify(agent.capabilities)) payload.capabilities = caps;
    if (Object.keys(payload).length === 0) { setOpen(false); return; }
    mutation.mutate({ id: agent.id, data: payload });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Edit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Agent</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="grid gap-4 grid-cols-2">
            <div className="space-y-2">
              <Label>Version</Label>
              <Input value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
          </div>
          <div className="space-y-2">
            <Label>Capabilities</Label>
            <Input value={form.capabilities} onChange={(e) => setForm({ ...form, capabilities: e.target.value })} placeholder="Comma-separated" />
          </div>
          {mutation.error && <p className="text-sm text-destructive">{String(mutation.error)}</p>}
          <Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? "Saving..." : "Save Changes"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState("");

  const { data: agent, isLoading, error } = useGetAgent(id!, {
    query: { queryKey: getGetAgentQueryKey(id!), enabled: !!id },
  });

  const { data: runsData } = useListRuns(
    { agentId: id },
    { query: { queryKey: getListRunsQueryKey({ agentId: id }), enabled: !!id } },
  );

  const runMutation = useRunAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListRunsQueryKey({ agentId: id }) });
        queryClient.invalidateQueries({ queryKey: getListRunsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetMetricsQueryKey() });
        setPrompt("");
      },
    },
  });

  const disableMutation = useDisableAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(id!) });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      },
    },
  });

  const enableMutation = useEnableAgent({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(id!) });
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
      },
    },
  });

  function invalidateAgent() {
    queryClient.invalidateQueries({ queryKey: getGetAgentQueryKey(id!) });
    queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRevisionsQueryKey(id!) });
  }

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading...</p>;
  if (error) return <p className="text-sm text-destructive">Error: {String(error)}</p>;
  if (!agent) return <p className="text-sm text-destructive">Agent not found</p>;

  const lastResult = runMutation.data as RunResponse | undefined;
  const togglePending = disableMutation.isPending || enableMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/agents" className="text-sm text-muted-foreground hover:underline">Agents</Link>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">{agent.name}</span>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">{agent.name}</CardTitle>
                <div className="flex items-center gap-2">
                  <EditDialog agent={agent} onSuccess={invalidateAgent} />
                  <Button
                    size="sm"
                    variant={agent.status === "active" ? "secondary" : "default"}
                    onClick={() =>
                      agent.status === "active"
                        ? disableMutation.mutate({ id: id! })
                        : enableMutation.mutate({ id: id! })
                    }
                    disabled={togglePending}
                  >
                    {agent.status === "active" ? "Disable" : "Enable"}
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div><span className="text-muted-foreground">ID:</span> <code className="text-xs">{agent.id}</code></div>
              <div><span className="text-muted-foreground">Version:</span> {agent.version}</div>
              <div><span className="text-muted-foreground">Status:</span> <Badge variant={agent.status === "active" ? "default" : "secondary"}>{agent.status}</Badge></div>
              <div><span className="text-muted-foreground">Role:</span> {agent.role}</div>
              <div><span className="text-muted-foreground">Runtime:</span> {agent.runtimeMode}</div>
              <div>
                <span className="text-muted-foreground">Capabilities:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {agent.capabilities.map((c) => <Badge key={c} variant="outline" className="text-xs">{c}</Badge>)}
                </div>
              </div>
              {agent.tags.length > 0 && (
                <div>
                  <span className="text-muted-foreground">Tags:</span>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {agent.tags.map((t) => <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>)}
                  </div>
                </div>
              )}
              {agent.description && (
                <div>
                  <span className="text-muted-foreground">Description:</span>
                  <p className="mt-1 text-sm">{agent.description}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Execute Agent</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                placeholder="Enter a prompt to run this agent..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={3}
                disabled={agent.status !== "active"}
              />
              <Button
                onClick={() =>
                  runMutation.mutate({
                    data: {
                      agentId: id!,
                      input: { prompt },
                      requestedBy: "operator",
                    },
                  })
                }
                disabled={!prompt.trim() || runMutation.isPending || agent.status !== "active"}
              >
                {runMutation.isPending ? "Running..." : "Run Agent"}
              </Button>
              {agent.status !== "active" && <p className="text-xs text-muted-foreground">Agent must be active to execute.</p>}
            </CardContent>
          </Card>

          {lastResult && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Last Result</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={lastResult.status === "completed" ? "default" : "destructive"}>{lastResult.status}</Badge>
                    {lastResult.durationMs != null && <span className="text-muted-foreground">{lastResult.durationMs}ms</span>}
                    {lastResult.qualityScore != null && <span className="text-muted-foreground">Q: {lastResult.qualityScore.toFixed(3)}</span>}
                  </div>
                  {lastResult.intent && <div><span className="text-muted-foreground">Intent:</span> {lastResult.intent} / {lastResult.mode}</div>}
                  {lastResult.normalizedOutput && (
                    <div className="space-y-1">
                      <p className="font-medium text-xs text-muted-foreground">Summary</p>
                      <p>{lastResult.normalizedOutput.summary}</p>
                      {lastResult.normalizedOutput.warnings.length > 0 && (
                        <div className="flex gap-1">{lastResult.normalizedOutput.warnings.map((w, i) => <Badge key={i} variant="outline" className="text-xs">{w}</Badge>)}</div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          <Tabs defaultValue="runs">
            <TabsList>
              <TabsTrigger value="runs">Recent Runs</TabsTrigger>
              <TabsTrigger value="revisions">Revisions</TabsTrigger>
            </TabsList>

            <TabsContent value="runs">
              <Card>
                <CardContent className="pt-4">
                  {runsData?.runs.length === 0 && <p className="text-sm text-muted-foreground">No runs yet</p>}
                  <div className="space-y-2">
                    {runsData?.runs.slice(0, 10).map((run) => (
                      <Link key={run.id} href={`/runs/${run.id}`}>
                        <div className="flex items-center justify-between p-2 rounded hover:bg-muted cursor-pointer text-sm">
                          <div className="flex items-center gap-2">
                            <Badge variant={run.status === "completed" ? "default" : run.status === "failed" ? "destructive" : "secondary"} className="text-xs">
                              {run.status}
                            </Badge>
                            <code className="text-xs text-muted-foreground">{run.id.slice(0, 8)}...</code>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {run.durationMs != null && <span>{run.durationMs}ms</span>}
                            <span>{new Date(run.createdAt).toLocaleString()}</span>
                          </div>
                        </div>
                      </Link>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="revisions">
              <Card>
                <CardContent className="pt-4">
                  <RevisionList agentId={agent.id} />
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
