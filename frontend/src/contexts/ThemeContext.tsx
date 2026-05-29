import React, { createContext, useContext, useEffect, useState } from 'react';
import { useConfigStore } from '../stores/configStore';
import { API } from '../utils/api';

type Theme = 'paper' | 'dark' | 'light';

// Order used by toggleTheme to cycle. `paper` is the default (Protoflow).
const THEMES: readonly Theme[] = ['paper', 'dark', 'light'] as const;
const isTheme = (v: unknown): v is Theme =>
  v === 'paper' || v === 'dark' || v === 'light';

interface ThemeContextType {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { config } = useConfigStore();
  const [theme, setTheme] = useState<Theme>(() => {
    // Check localStorage for saved preference (for immediate access)
    const saved = localStorage.getItem('theme');
    if (isTheme(saved)) {
      return saved;
    }
    // Default to the paper theme (Protoflow)
    return 'paper';
  });
  const [configLoaded, setConfigLoaded] = useState(false);

  // Sync theme from config when it loads
  useEffect(() => {
    if (isTheme(config?.theme)) {
      setTheme(config.theme);
      localStorage.setItem('theme', config.theme);
      setConfigLoaded(true);
    }
  }, [config?.theme]);

  useEffect(() => {
    // Update document root and body classes (3-way: paper | dark | light)
    const root = document.documentElement;
    const body = document.body;

    root.classList.remove(...THEMES);
    body.classList.remove(...THEMES);
    root.classList.add(theme);
    body.classList.add(theme);

    // Save preference to localStorage for immediate access
    localStorage.setItem('theme', theme);

    // Only save to config after initial config has loaded
    // This prevents overwriting the config with the initial state
    if (configLoaded) {
      API.config.update({ theme }).catch(err => {
        console.error('Failed to save theme to config:', err);
      });
    }
  }, [theme, configLoaded]);

  // Cycle paper → dark → light → paper
  const toggleTheme = () => {
    setTheme(prev => THEMES[(THEMES.indexOf(prev) + 1) % THEMES.length]);
  };

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return context;
};