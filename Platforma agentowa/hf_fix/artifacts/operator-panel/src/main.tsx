import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { initPWA } from "./pwa";
import { initApiClient } from "./lib/api-init";

// Configure the generated API client (base URL + bearer token) before any
// query hook fires. Without this every request is unauthenticated and the
// server's audit log fills with "auth.failed" noise (O-1).
initApiClient();

const root = document.getElementById("root");
if (!root) throw new Error("#root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register service worker and wire update/offline toasts.
// Must be called after React root is mounted so sonner toast is available.
initPWA();
