/** Fictional mailbox story and sample-only candidate copy for the Jev recording. */
export const schoolTripFixture = {
  school: "Lincoln Middle School (fictional local sample)",
  sender: "Ms. Rivera (fictional local sample)",
  searchQuery: "aquarium",
  choices: [
    { id: "permission-slip", label: "Complete permission slip", details: [], sources: [] },
    { id: "trip-details", label: "Review trip details", details: [], sources: [] },
    { id: "explore-exhibits", label: "Explore exhibits", details: [], sources: [] },
  ],
} as const;

// Facts checked against the aquarium's public exhibit pages on 2026-09-23.
// These records make sample decisions repeatable; they do not represent a live Jev response.
export const aquariumFixture = {
  indexUrl: "https://www.montereybayaquarium.org/visit/exhibits",
  options: [
    {
      id: "kelp-forest",
      label: "Kelp Forest",
      details: ["See a 28-foot-tall kelp exhibit with sardines, leopard sharks, and other fish."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Kelp Forest",
          url: "https://www.montereybayaquarium.org/visit/exhibits/kelp-forest/",
        },
      ],
    },
    {
      id: "open-sea",
      label: "Open Sea",
      details: ["Watch turtles, sardines, and tuna through the aquarium's 90-foot viewing window."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Open Sea",
          url: "https://www.montereybayaquarium.org/visit/exhibits/open-sea/",
        },
      ],
    },
    {
      id: "rocky-shore",
      label: "Rocky Shore",
      details: ["Touch and interact with bat rays in the touch pool."],
      sources: [
        {
          title: "Monterey Bay Aquarium · Rocky Shore",
          url: "https://www.montereybayaquarium.org/visit/exhibits/rocky-shore",
        },
      ],
    },
  ],
} as const;
