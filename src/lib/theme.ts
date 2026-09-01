import { useEffect, useState } from "react";

export const THEMES = [
  { id: "rosa", zh: "玫红", en: "Rosa", dark: false, swatch: ["#F72C50", "#C6F7DE"] },
  { id: "magenta", zh: "洋红", en: "Magenta", dark: false, swatch: ["#F51CE0", "#E6F7C4"] },
  { id: "citrus", zh: "橙蓝", en: "Citrus", dark: false, swatch: ["#F9A03A", "#8AE7FB"] },
  { id: "violet", zh: "紫粉", en: "Violet", dark: false, swatch: ["#7A26D9", "#FBC0D6"] },
  { id: "noir", zh: "夜色玫红", en: "Noir", dark: true, swatch: ["#2A1E27", "#F7527A"] },
  { id: "midnight", zh: "午夜蓝", en: "Midnight", dark: true, swatch: ["#111A2E", "#5B8CFF"] },
  { id: "forest", zh: "深林绿", en: "Forest", dark: true, swatch: ["#10201A", "#3FD9A0"] },
  { id: "ink", zh: "墨黑金", en: "Ink & Gold", dark: true, swatch: ["#121212", "#E5B94E"] },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** 无障碍配色 / 对比度增强 */
export const A11Y_MODES = [
  {
    id: "none",
    zh: "关闭",
    en: "Off",
    desc: { zh: "使用主题原本的配色", en: "Theme default colours" },
  },
  {
    id: "deuter",
    zh: "红绿色弱（红绿色盲）",
    en: "Red-green (deuter/protan)",
    desc: {
      zh: "改用蓝 / 橙区分，红绿不再承担信息",
      en: "Blue / orange coding instead of red-green",
    },
  },
  {
    id: "tritan",
    zh: "蓝黄色弱",
    en: "Blue-yellow (tritan)",
    desc: { zh: "改用洋红 / 青绿区分", en: "Magenta / teal coding" },
  },
  {
    id: "contrast",
    zh: "高对比",
    en: "High contrast",
    desc: { zh: "加深文字与描边，弱视更易读", en: "Darker text and stronger borders" },
  },
] as const;

export type A11yMode = (typeof A11Y_MODES)[number]["id"];

const THEME_KEY = "openglass.theme";
const A11Y_KEY = "openglass.a11y";
const A11Y_TEXT_KEY = "openglass.a11y.bigtext";

const CLASSES: Record<ThemeId, string[]> = {
  rosa: [],
  magenta: ["theme-magenta"],
  citrus: ["theme-citrus"],
  violet: ["theme-violet"],
  noir: ["dark"],
  midnight: ["dark", "theme-midnight"],
  forest: ["dark", "theme-forest"],
  ink: ["dark", "theme-ink"],
};

const A11Y_CLASSES: Record<A11yMode, string[]> = {
  none: [],
  deuter: ["a11y-deuter"],
  tritan: ["a11y-tritan"],
  contrast: ["a11y-contrast"],
};

const DARK_THEMES = new Set<ThemeId>(["noir", "midnight", "forest", "ink"]);

/**
 * Runs in <head> before the stylesheet and React hydration. The app previously
 * painted the light defaults once and only applied the saved theme in an
 * effect, which produced a visible flash on cold loads and recordings.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  const root = document.documentElement;
  const themeClasses = ${JSON.stringify(CLASSES)};
  const a11yClasses = ${JSON.stringify(A11Y_CLASSES)};
  const darkThemes = ${JSON.stringify([...DARK_THEMES])};
  const theme = localStorage.getItem("${THEME_KEY}") || "violet";
  const a11y = localStorage.getItem("${A11Y_KEY}") || "none";
  root.classList.add(...(themeClasses[theme] || themeClasses.violet));
  root.classList.add(...(a11yClasses[a11y] || a11yClasses.none));
  if (localStorage.getItem("${A11Y_TEXT_KEY}") === "1") root.classList.add("a11y-bigtext");
  const dark = darkThemes.includes(theme);
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.backgroundColor = dark ? "#07101f" : "#f8f7fa";
})();`;

const ALL_CLASSES = [
  ...new Set([...Object.values(CLASSES).flat(), ...Object.values(A11Y_CLASSES).flat()]),
];

function apply(theme: ThemeId, a11y: A11yMode, bigText: boolean) {
  const root = document.documentElement;
  ALL_CLASSES.forEach((cls) => root.classList.remove(cls));
  [...CLASSES[theme], ...A11Y_CLASSES[a11y]].forEach((cls) => root.classList.add(cls));
  root.classList.toggle("a11y-bigtext", bigText);
  root.style.colorScheme = DARK_THEMES.has(theme) ? "dark" : "light";
  root.style.removeProperty("background-color");
}

export function applyTheme(id: ThemeId) {
  apply(id, "none", false);
}

/** 应用启动时读取本机偏好并套用（默认紫粉） */
export function initTheme() {
  let theme: ThemeId = "violet";
  let a11y: A11yMode = "none";
  let bigText = false;
  try {
    const storedTheme = localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (storedTheme && storedTheme in CLASSES) theme = storedTheme;
    const storedA11y = localStorage.getItem(A11Y_KEY) as A11yMode | null;
    if (storedA11y && storedA11y in A11Y_CLASSES) a11y = storedA11y;
    bigText = localStorage.getItem(A11Y_TEXT_KEY) === "1";
  } catch {
    /* ignore */
  }
  apply(theme, a11y, bigText);
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>("violet");
  const [a11y, setA11yState] = useState<A11yMode>("none");
  const [bigText, setBigTextState] = useState(false);

  useEffect(() => {
    let nextTheme: ThemeId = "violet";
    let nextA11y: A11yMode = "none";
    let nextBig = false;
    try {
      const storedTheme = localStorage.getItem(THEME_KEY) as ThemeId | null;
      if (storedTheme && storedTheme in CLASSES) nextTheme = storedTheme;
      const storedA11y = localStorage.getItem(A11Y_KEY) as A11yMode | null;
      if (storedA11y && storedA11y in A11Y_CLASSES) nextA11y = storedA11y;
      nextBig = localStorage.getItem(A11Y_TEXT_KEY) === "1";
    } catch {
      /* ignore */
    }
    setThemeState(nextTheme);
    setA11yState(nextA11y);
    setBigTextState(nextBig);
    apply(nextTheme, nextA11y, nextBig);
  }, []);

  const persist = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  };

  const setTheme = (id: ThemeId) => {
    setThemeState(id);
    apply(id, a11y, bigText);
    persist(THEME_KEY, id);
  };

  const setA11y = (mode: A11yMode) => {
    setA11yState(mode);
    apply(theme, mode, bigText);
    persist(A11Y_KEY, mode);
  };

  const setBigText = (on: boolean) => {
    setBigTextState(on);
    apply(theme, a11y, on);
    persist(A11Y_TEXT_KEY, on ? "1" : "0");
  };

  return { theme, setTheme, a11y, setA11y, bigText, setBigText };
}
