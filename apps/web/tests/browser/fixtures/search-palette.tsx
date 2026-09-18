import { NuqsAdapter } from "nuqs/adapters/react-router/v7";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShell } from "../../../src/components/layout/AppShell.tsx";
import { ThemeProvider } from "../../../src/hooks/use-theme.ts";
import { EditorPage } from "../../../src/pages/EditorPage.tsx";

function HomeStub() {
  return <p>検索フィクスチャのホーム</p>;
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing fixture root");
}
createRoot(root).render(
  <ThemeProvider>
    <MemoryRouter>
      <NuqsAdapter>
        <Routes>
          <Route element={<AppShell />}>
            <Route element={<HomeStub />} path="/" />
            <Route element={<EditorPage />} path="/n/:id" />
          </Route>
        </Routes>
      </NuqsAdapter>
    </MemoryRouter>
  </ThemeProvider>,
);
