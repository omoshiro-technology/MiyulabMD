import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppShell } from "./components/layout/AppShell.tsx";
import { SettingsLayout } from "./components/settings/SettingsLayout.tsx";
import { EditorPage } from "./pages/EditorPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { SharedByMePage } from "./pages/SharedByMePage.tsx";
import { SharedPage } from "./pages/SharedPage.tsx";
import { SharePage } from "./pages/SharePage.tsx";
import { McpSettingsPage } from "./pages/settings/McpSettingsPage.tsx";
import { ProfileSettingsPage } from "./pages/settings/ProfileSettingsPage.tsx";
import { SiteSettingsPage } from "./pages/settings/SiteSettingsPage.tsx";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/shared" element={<SharedPage />} />
          <Route path="/shared-by-me" element={<SharedByMePage />} />
          <Route path="/f/:folderId" element={<HomePage />} />
          <Route path="/n/:id" element={<EditorPage />} />
          <Route path="/s/:id" element={<SharePage />} />
          <Route path="/settings" element={<SettingsLayout />}>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<ProfileSettingsPage />} />
            <Route path="mcp" element={<McpSettingsPage />} />
            <Route path="site" element={<SiteSettingsPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
