export const DEPLOY_TO_RENDER_URL =
  "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fojusave%2Fopenmuse";

export const GITHUB_REPOSITORY_URL = "https://github.com/ojusave/openmuse";

/** Returns the single Render signup URL with attribution for its header placement. */
export function renderSignupUrlWithUtms(content = "navbar_button"): string {
  const params = new URLSearchParams({
    utm_source: "github",
    utm_medium: "referral",
    utm_campaign: "ojus_demos",
    utm_content: content,
  });

  return `https://dashboard.render.com/register?${params.toString()}`;
}
