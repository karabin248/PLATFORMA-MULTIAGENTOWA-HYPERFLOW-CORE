import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Link } from "wouter";
import {
  useCreateAgent,
  getListAgentsQueryKey,
} from "@workspace/api-client-react";
import type { CreateAgentPayload } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function AgentCreatePage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    id: "",
    name: "",
    version: "1.0.0",
    description: "",
    role: "assistant",
    capabilities: "",
    promptTemplate: "{{input.prompt}}",
    tags: "",
    runtimeMode: "standard",
  });

  const mutation = useCreateAgent({
    mutation: {
      onSuccess: (agent) => {
        queryClient.invalidateQueries({ queryKey: getListAgentsQueryKey() });
        navigate(`/agents/${agent.id}`);
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const payload: CreateAgentPayload = {
      id: form.id.trim(),
      name: form.name.trim(),
      version: form.version.trim(),
      description: form.description.trim() || undefined,
      role: form.role || undefined,
      capabilities: form.capabilities.trim() ? form.capabilities.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      promptTemplate: form.promptTemplate.trim() || undefined,
      tags: form.tags.trim() ? form.tags.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      runtimeMode: form.runtimeMode as CreateAgentPayload["runtimeMode"],
    };
    mutation.mutate({ data: payload });
  }

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2">
        <Link href="/agents" className="text-sm text-muted-foreground hover:underline">Agents</Link>
        <span className="text-sm text-muted-foreground">/</span>
        <span className="text-sm font-medium">Create</span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create New Agent</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="id">Agent ID</Label>
                <Input id="id" placeholder="agent-my-agent" value={form.id} onChange={(e) => update("id", e.target.value)} required />
                <p className="text-xs text-muted-foreground">Lowercase alphanumeric with hyphens, 3-64 chars</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="My Agent" value={form.name} onChange={(e) => update("name", e.target.value)} required />
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="version">Version</Label>
                <Input id="version" placeholder="1.0.0" value={form.version} onChange={(e) => update("version", e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="role">Role</Label>
                <Input id="role" placeholder="assistant" value={form.role} onChange={(e) => update("role", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="runtimeMode">Runtime Mode</Label>
                <Select value={form.runtimeMode} onValueChange={(v) => update("runtimeMode", v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="fast">Fast</SelectItem>
                    <SelectItem value="careful">Careful</SelectItem>
                    <SelectItem value="creative">Creative</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" placeholder="What does this agent do?" value={form.description} onChange={(e) => update("description", e.target.value)} rows={2} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="capabilities">Capabilities</Label>
              <Input id="capabilities" placeholder="analysis, generation, summarization" value={form.capabilities} onChange={(e) => update("capabilities", e.target.value)} />
              <p className="text-xs text-muted-foreground">Comma-separated list</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tags">Tags</Label>
              <Input id="tags" placeholder="nlp, production" value={form.tags} onChange={(e) => update("tags", e.target.value)} />
              <p className="text-xs text-muted-foreground">Comma-separated list</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="promptTemplate">Prompt Template</Label>
              <Textarea id="promptTemplate" placeholder="{{input.prompt}}" value={form.promptTemplate} onChange={(e) => update("promptTemplate", e.target.value)} rows={2} className="font-mono text-sm" />
            </div>

            {mutation.error && (
              <p className="text-sm text-destructive">{String(mutation.error)}</p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Creating..." : "Create Agent"}
              </Button>
              <Link href="/agents">
                <Button type="button" variant="outline">Cancel</Button>
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
