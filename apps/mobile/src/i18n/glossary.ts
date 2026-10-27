/** Proper nouns and format tokens. Sentences interpolate these; translations must not rewrite them. */
export const glossary = {
  openmuse: "OpenMuse",
  copilotkit: "CopilotKit",
  gmail: "Gmail",
  google: "Google",
  googleCalendar: "Google Calendar",
  openbot: "OpenBot",
  chromium: "Chromium",
  pdf: "PDF",
  json: "JSON",
  url: "URL",
  csv: "CSV",
} as const;

export const names = {
  brand: glossary.openmuse,
  google: glossary.google,
  gmail: glossary.gmail,
  googleCalendar: glossary.googleCalendar,
  openbot: glossary.openbot,
  chromium: glossary.chromium,
  copilotkit: glossary.copilotkit,
  pdf: glossary.pdf,
  json: glossary.json,
  url: glossary.url,
  csv: glossary.csv,
} as const;
