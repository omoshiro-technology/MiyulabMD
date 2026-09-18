import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useOutletContext } from "react-router";
import { HistoryPanel } from "../../../src/components/editor/HistoryPanel.tsx";
import { AppShell } from "../../../src/components/layout/AppShell.tsx";
import type { AppShellContext } from "../../../src/components/layout/AppShellContext.ts";
import { ThemeProvider } from "../../../src/hooks/use-theme.ts";

function HistoryProbe() {
  const context = useOutletContext<AppShellContext>();
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    if (!(context.viewing && context.viewer.user)) {
      return;
    }
    const scope = context.viewing.beginView(context.viewer);
    scope.publish({ source: "network", viewer: context.viewer });
    return () => scope.dispose();
  }, [context.viewer, context.viewing]);
  if (!context.user || closed) {
    return <p>{closed ? "History closed" : "Waiting for verified viewer"}</p>;
  }
  return (
    <HistoryPanel
      canEdit={true}
      noteId="history-note"
      onClose={() => setClosed(true)}
      user={context.user}
    />
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(
  <ThemeProvider>
    <MemoryRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route element={<HistoryProbe />} path="/" />
        </Route>
      </Routes>
    </MemoryRouter>
  </ThemeProvider>,
);
