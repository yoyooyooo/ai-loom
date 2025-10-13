import React, { createContext, useContext, useState } from 'react';

interface Config {
  apiBaseUrl: string;
  appName: string;
}

const ConfigContext = createContext<Config | undefined>(undefined);

export function ConfigProvider({ children }: { children: React.ReactNode }) {
  const [config] = useState<Config>({
    apiBaseUrl: '/api',
    appName: 'Vibe Starter',
  });

  return (
    <ConfigContext.Provider value={config}>
      {children}
    </ConfigContext.Provider>
  );
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (context === undefined) {
    throw new Error('useConfig must be used within a ConfigProvider');
  }
  return context;
}
