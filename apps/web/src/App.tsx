import { NuqsAdapter } from "nuqs/adapters/react-router/v7";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/AppShell.tsx";
import { SettingsLayout } from "./components/settings/SettingsLayout.tsx";
import { EditorPage } from "./pages/EditorPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SharedByMePage } from "./pages/SharedByMePage.tsx";
import { SharedPage } from "./pages/SharedPage.tsx";
import { SharePage } from "./pages/SharePage.tsx";
import { EditorSettingsPage } from "./pages/settings/EditorSettingsPage.tsx";
import { KnowledgeLayersPage } from "./pages/settings/KnowledgeLayersPage.tsx";
import { KnowledgeParaPage } from "./pages/settings/KnowledgeParaPage.tsx";
import { KnowledgeSchemesPage } from "./pages/settings/KnowledgeSchemesPage.tsx";
import { McpSettingsPage } from "./pages/settings/McpSettingsPage.tsx";
import { ProfileSettingsPage } from "./pages/settings/ProfileSettingsPage.tsx";
import { SiteSettingsPage } from "./pages/settings/SiteSettingsPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <NuqsAdapter>
        <Routes>
          <Route element={<AppShell />}>
            <Route element={<HomePage />} path="/" />
            <Route element={<SharedPage />} path="/shared" />
            <Route element={<SharedByMePage />} path="/shared-by-me" />
            <Route element={<HomePage />} path="/f/:folderId" />
            <Route element={<EditorPage />} path="/n/:id" />
            <Route element={<SharePage />} path="/s/:id" />
            <Route element={<SettingsLayout />} path="/settings">
              <Route
                element={<Navigate replace={true} to="profile" />}
                index={true}
              />
              <Route element={<ProfileSettingsPage />} path="profile" />
              <Route element={<EditorSettingsPage />} path="editor" />
              <Route
                element={<Navigate replace={true} to="knowledge/para" />}
                path="knowledge"
              />
              <Route element={<KnowledgeParaPage />} path="knowledge/para" />
              <Route
                element={<KnowledgeSchemesPage />}
                path="knowledge/schemes"
              />
              <Route
                element={<KnowledgeLayersPage />}
                path="knowledge/layers"
              />
              <Route element={<McpSettingsPage />} path="mcp" />
              <Route element={<SiteSettingsPage />} path="site" />
            </Route>
            <Route element={<Navigate replace={true} to="/" />} path="*" />
          </Route>
        </Routes>
      </NuqsAdapter>
    </BrowserRouter>
  );
}
