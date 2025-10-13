import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ConfigProvider } from '@/contexts/config-context';
import { ThemeProvider } from '@/components/theme-provider';
import { HomePage } from '@/pages/home-page';
import { SettingsPage } from '@/pages/settings-page';

function App() {
  return (
    <BrowserRouter>
      <ConfigProvider>
        <ThemeProvider defaultTheme="light" storageKey="vibe-starter-theme">
          <div className="h-screen flex flex-col bg-background">
            {/* Navigation header */}
            <header className="border-b">
              <div className="container mx-auto px-4 py-3">
                <div className="flex items-center justify-between">
                  <h1 className="text-xl font-semibold">Vibe Starter</h1>
                  <nav className="flex items-center space-x-4">
                    <a 
                      href="/" 
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      Home
                    </a>
                    <a 
                      href="/settings" 
                      className="text-sm text-muted-foreground hover:text-foreground"
                    >
                      Settings
                    </a>
                  </nav>
                </div>
              </div>
            </header>
            
            {/* Main content area */}
            <main className="flex-1 overflow-auto">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </main>
          </div>
        </ThemeProvider>
      </ConfigProvider>
    </BrowserRouter>
  );
}

export default App;
