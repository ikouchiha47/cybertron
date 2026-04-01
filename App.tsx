import React, { useEffect, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { loadConfig } from './src/utils/storage';
import { registerBackgroundDetection } from './src/utils/backgroundDetection';
import SetupScreen from './src/screens/SetupScreen';
import MonitorScreen from './src/screens/MonitorScreen';
// Must import so TaskManager registers the task definition at startup
import './src/utils/backgroundDetection';

export default function App() {
  const [ip, setIp] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadConfig().then(config => {
      if (config?.ip) setIp(config.ip);
      else setShowSetup(true);
      setLoading(false);
    });
    registerBackgroundDetection();
  }, []);

  if (loading) return null;

  if (!ip || showSetup) {
    return (
      <SafeAreaProvider>
        <SetupScreen
          currentIp={ip ?? undefined}
          onSaved={newIp => { setIp(newIp); setShowSetup(false); }}
        />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <MonitorScreen
        ip={ip}
        onOpenSettings={() => setShowSetup(true)}
      />
    </SafeAreaProvider>
  );
}
