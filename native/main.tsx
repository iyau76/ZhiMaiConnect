import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Workspace } from "../src/components/workspace";
import { initializeNativeRuntime } from "../src/lib/native-runtime";
import { startPwa } from "../src/lib/pwa-client";
import "../src/styles.css";
initializeNativeRuntime();
startPwa();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Workspace />
  </QueryClientProvider>,
);
