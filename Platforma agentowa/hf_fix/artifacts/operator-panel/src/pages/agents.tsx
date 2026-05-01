import { Link } from "wouter";
import { useListAgents } from "@workspace/api-client-react";
import type { Agent } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function statusColor(status: string) {
  switch (status) {
    case "active": return "default";
    case "disabled": return "secondary";
    case "deprecated": return "destructive";
    default: return "outline";
  }
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Link href={`/agents/${agent.id}`}>
      <Card className="cursor-pointer transition-shadow hover:shadow-md">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{agent.name}</CardTitle>
            <Badge variant={statusColor(agent.status)}>{agent.status}</Badge>
          </div>
          <CardDescription className="text-xs font-mono">{agent.id}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm text-muted-foreground line-clamp-2">{agent.description}</p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>v{agent.version}</span>
            <span>|</span>
            <span>{agent.role}</span>
            <span>|</span>
            <span>{agent.runtimeMode}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {agent.capabilities.map((cap) => (
              <Badge key={cap} variant="outline" className="text-xs">{cap}</Badge>
            ))}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

export default function AgentsPage() {
  const { data, isLoading, error } = useListAgents();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agent Catalog</h1>
          <p className="text-sm text-muted-foreground">Registered agents available for execution</p>
        </div>
        <Link href="/agents/new">
          <Button>Create Agent</Button>
        </Link>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading agents...</p>}
      {error && <p className="text-sm text-destructive">Failed to load agents: {String(error)}</p>}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {data?.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>

      {data && data.agents.length === 0 && (
        <p className="text-sm text-muted-foreground">No agents registered yet.</p>
      )}
    </div>
  );
}
