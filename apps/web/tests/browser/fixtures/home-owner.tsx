import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useOutletContext } from "react-router";
import { AppShell } from "../../../src/components/layout/AppShell.tsx";
import type { AppShellContext } from "../../../src/components/layout/AppShellContext.ts";
import { ThemeProvider } from "../../../src/hooks/use-theme.ts";
import { HomePage } from "../../../src/pages/HomePage.tsx";

function HomeWithOwnerControl() {
  const { setUser } = useOutletContext<AppShellContext>();
  return (
    <>
      <button
        onClick={() =>
          setUser({
            displayName: "Bob",
            email: "bob@example.test",
            id: "bob",
          })
        }
        type="button"
      >
        Switch to Bob
      </button>
      <HomePage />
    </>
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
          <Route element={<HomeWithOwnerControl />} path="/" />
        </Route>
      </Routes>
    </MemoryRouter>
  </ThemeProvider>,
);
