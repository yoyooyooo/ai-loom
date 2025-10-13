import { useTheme } from '@/components/theme-provider';

export function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      
      <div className="max-w-md space-y-6">
        <div>
          <label className="block text-sm font-medium mb-2">
            Theme
          </label>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as any)}
            className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
        
        <div>
          <h3 className="text-lg font-medium mb-2">About</h3>
          <p className="text-muted-foreground">
            Vibe Starter - Built with Rust + React
          </p>
        </div>
      </div>
    </div>
  );
}
