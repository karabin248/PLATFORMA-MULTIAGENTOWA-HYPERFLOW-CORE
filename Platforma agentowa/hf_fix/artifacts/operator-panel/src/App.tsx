import { Switch, Route, Router as WouterRouter, Link, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import DashboardPage from "@/pages/dashboard";
import AgentsPage from "@/pages/agents";
import AgentDetailPage from "@/pages/agent-detail";
import AgentCreatePage from "@/pages/agent-create";
import RunsPage from "@/pages/runs";
import RunDetailPage from "@/pages/run-detail";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [location] = useLocation();
  const isActive = location === href || (href !== "/" && location.startsWith(href));
  return (
    <Link
      href={href}
      className={`text-sm font-medium transition-colors hover:text-foreground ${
        isActive ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="font-semibold tracking-tight">Hyperflow Operator</span>
          </Link>
          <nav className="flex items-center gap-4">
            <NavLink href="/">Dashboard</NavLink>
            <NavLink href="/agents">Agents</NavLink>
            <NavLink href="/runs">Runs</NavLink>
          </nav>
        </div>
      </header>
      <main className="container px-6 py-6">
        {children}
      </main>
    </div>
  );
}

function AppRouter() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={DashboardPage} />
        <Route path="/agents" component={AgentsPage} />
        <Route path="/agents/new" component={AgentCreatePage} />
        <Route path="/agents/:id" component={AgentDetailPage} />
        <Route path="/runs" component={RunsPage} />
        <Route path="/runs/:id" component={RunDetailPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AppRouter />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
