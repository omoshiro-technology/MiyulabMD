import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useOutletContext } from "react-router";
import { AppShell } from "../../../src/components/layout/AppShell.tsx";
import type { AppShellContext } from "../../../src/components/layout/AppShellContext.ts";
import { ThemeProvider } from "../../../src/hooks/use-theme.ts";

function ViewerProbe() {
  const context = useOutletContext<AppShellContext>();
  const [buffer, setBuffer] = useState("");
  useEffect(() => {
    setBuffer("");
  }, [context.viewer]);
  const scope = useRef<{ dispose: () => void } | null>(null);
  useEffect(() => () => scope.current?.dispose(), []);
  const showSource = (source: "cache" | "network") => {
    if (!context.viewing) {
      return;
    }
    const previous = scope.current;
    const next = context.viewing.beginView(context.viewer);
    next.publish({ source, viewer: context.viewer });
    scope.current = next;
    previous?.dispose();
  };
  return (
    <>
      <input
        aria-label="Unsent viewer buffer"
        onChange={(event) => setBuffer(event.target.value)}
        value={buffer}
      />
      <output aria-label="Viewer context">
        {JSON.stringify({
          hasViewing: Boolean(context.viewing),
          user: context.user,
          userLoading: context.userLoading,
          viewer: context.viewer ?? null,
        })}
      </output>
      <button
        disabled={!context.viewing || context.userLoading}
        onClick={() => showSource("cache")}
        type="button"
      >
        Use cached viewing
      </button>
      <button
        disabled={!context.viewing || context.userLoading}
        onClick={() => showSource("network")}
        type="button"
      >
        Use network viewing
      </button>
      <button
        onClick={() =>
          context.setUser({
            displayName: "Bob",
            email: "bob@example.test",
            id: "bob",
          })
        }
        type="button"
      >
        Set Bob viewer
      </button>
    </>
  );
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <MemoryRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route element={<ViewerProbe />} path="/" />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>
  </StrictMode>,
);
