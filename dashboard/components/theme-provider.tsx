"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark" | "system";
type Density = "default" | "compact";

interface ThemeContextValue {
  theme: Theme;
  density: Density;
  setTheme: (t: Theme) => void;
  setDensity: (d: Density) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  density: "default",
  setTheme: () => {},
  setDensity: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");
  const [density, setDensityState] = useState<Density>("default");

  // On mount, read persisted prefs and apply them
  useEffect(() => {
    const t = (localStorage.getItem("lumi-theme") as Theme) || "light";
    const d = (localStorage.getItem("lumi-density") as Density) || "default";
    setThemeState(t);
    setDensityState(d);
    applyTheme(t);
    applyDensity(d);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    localStorage.setItem("lumi-theme", t);
    applyTheme(t);
  }, []);

  const setDensity = useCallback((d: Density) => {
    setDensityState(d);
    localStorage.setItem("lumi-density", d);
    applyDensity(d);
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, density, setTheme, setDensity }}>
      {children}
    </ThemeContext.Provider>
  );
}

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", t);
  }
}

function applyDensity(d: Density) {
  const root = document.documentElement;
  if (d === "compact") {
    root.setAttribute("data-density", "compact");
  } else {
    root.removeAttribute("data-density");
  }
}
