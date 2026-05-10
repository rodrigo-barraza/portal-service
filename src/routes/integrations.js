// ─── Integrations Route ─────────────────────────────────────

import { Router } from "express";

const router = Router();

// ── Provider Definitions ──────────────────────────────────────
// Each integration declares:
//   envKey     — process.env variable name
//   provider   — human-readable provider name
//   category   — grouping for the UI
//   docs       — link to the provider dashboard / docs
//   icon       — optional emoji or icon hint for the frontend

const INTEGRATIONS = [
  // ── AI / LLM ───────────────────────────────────────────────
  { envKey: "OPENAI_API_KEY",       provider: "OpenAI",       category: "AI / LLM",         docs: "https://platform.openai.com/api-keys" },
  { envKey: "ANTHROPIC_API_KEY",    provider: "Anthropic",    category: "AI / LLM",         docs: "https://console.anthropic.com/settings/keys" },
  { envKey: "GOOGLE_API_KEY",       provider: "Google AI",    category: "AI / LLM",         docs: "https://aistudio.google.com/apikey" },
  { envKey: "ELEVENLABS_API_KEY",   provider: "ElevenLabs",   category: "AI / LLM",         docs: "https://elevenlabs.io/app/settings/api-keys" },
  { envKey: "INWORLD_BASIC",        provider: "Inworld AI",   category: "AI / LLM",         docs: "https://studio.inworld.ai" },

  // ── Google (Service-Specific) ──────────────────────────────
  { envKey: "GOOGLE_PLACES_API_KEY",  provider: "Google Places",     category: "Google Cloud", docs: "https://console.cloud.google.com/apis/credentials" },
  { envKey: "GOOGLE_CSE_CX",          provider: "Google CSE",        category: "Google Cloud", docs: "https://programmablesearchengine.google.com" },
  { envKey: "GOOGLE_CLOUD_API_KEY",   provider: "Google Cloud",      category: "Google Cloud", docs: "https://console.cloud.google.com/apis/credentials" },
  { envKey: "GOOGLE_STICKERS_API_KEY",provider: "Google (Stickers)", category: "Google Cloud", docs: "https://console.cloud.google.com/apis/credentials" },

  // ── Events & Entertainment ─────────────────────────────────
  { envKey: "TICKETMASTER_API_KEY", provider: "Ticketmaster", category: "Events & Entertainment", docs: "https://developer.ticketmaster.com" },
  { envKey: "SEATGEEK_CLIENT_ID",   provider: "SeatGeek",    category: "Events & Entertainment", docs: "https://seatgeek.com/account/develop" },
  { envKey: "TMDB_API_KEY",         provider: "TMDB",        category: "Events & Entertainment", docs: "https://www.themoviedb.org/settings/api" },

  // ── Finance ────────────────────────────────────────────────
  { envKey: "FINNHUB_API_KEY",      provider: "Finnhub",     category: "Finance",          docs: "https://finnhub.io/dashboard" },
  { envKey: "FRED_API_KEY",         provider: "FRED",        category: "Finance",          docs: "https://fred.stlouisfed.org/docs/api/api_key.html" },

  // ── Product / eCommerce ────────────────────────────────────
  { envKey: "BESTBUY_API_KEY",       provider: "Best Buy",        category: "eCommerce",    docs: "https://developer.bestbuy.com" },
  { envKey: "PRODUCTHUNT_API_KEY",   provider: "Product Hunt",    category: "eCommerce",    docs: "https://www.producthunt.com/v2/oauth/applications" },
  { envKey: "EBAY_CLIENT_ID",        provider: "eBay",            category: "eCommerce",    docs: "https://developer.ebay.com/my/keys" },
  { envKey: "ETSY_API_KEY",          provider: "Etsy",            category: "eCommerce",    docs: "https://www.etsy.com/developers/your-apps" },

  // ── Social / Trends ────────────────────────────────────────
  { envKey: "REDDIT_CLIENT_ID",      provider: "Reddit",     category: "Social",           docs: "https://www.reddit.com/prefs/apps" },
  { envKey: "X_BEARER_TOKEN",        provider: "X (Twitter)", category: "Social",           docs: "https://developer.x.com/en/portal/dashboard" },

  // ── Weather / Space / Science ──────────────────────────────
  { envKey: "TOMORROWIO_API_KEY",    provider: "Tomorrow.io",  category: "Weather & Science", docs: "https://app.tomorrow.io/development/keys" },
  { envKey: "NASA_API_KEY",          provider: "NASA",         category: "Weather & Science", docs: "https://api.nasa.gov" },

  // ── Web Search ─────────────────────────────────────────────
  { envKey: "BRAVE_SEARCH_API_KEY",  provider: "Brave Search", category: "Search",          docs: "https://api.search.brave.com/app/keys" },

  // ── Transit ────────────────────────────────────────────────
  { envKey: "TRANSLINK_API_KEY",     provider: "TransLink",    category: "Transit",         docs: "https://developer.translink.ca" },

  // ── Utility ────────────────────────────────────────────────
  { envKey: "IPINFO_TOKEN",          provider: "IPinfo",       category: "Utility",         docs: "https://ipinfo.io/account/token" },

  // ── Maritime ───────────────────────────────────────────────
  { envKey: "AIS_STREAM_API_KEY",    provider: "AIS Stream",   category: "Maritime",        docs: "https://aisstream.io" },

  // ── Energy ─────────────────────────────────────────────────
  { envKey: "EIA_API_KEY",           provider: "EIA",          category: "Energy",          docs: "https://www.eia.gov/opendata/register.php" },

  // ── Communication ──────────────────────────────────────────
  { envKey: "TWILIO_ACCOUNT_SID",    provider: "Twilio",       category: "Communication",   docs: "https://console.twilio.com" },

  // ── Smart Home ─────────────────────────────────────────────
  { envKey: "LIFX_BEARER_TOKEN",     provider: "LIFX",         category: "Smart Home",      docs: "https://cloud.lifx.com/settings" },

  // ── Discord ────────────────────────────────────────────────
  { envKey: "LUPOS_TOKEN",           provider: "Discord (Lupos)",    category: "Discord",   docs: "https://discord.com/developers/applications" },
  { envKey: "STICKERS_DISCORD_TOKEN",provider: "Discord (Stickers)", category: "Discord",   docs: "https://discord.com/developers/applications" },

  // ── Proxy ──────────────────────────────────────────────────
  { envKey: "BRIGHTDATA_CUSTOMER_ID",provider: "Bright Data",  category: "Proxy",           docs: "https://brightdata.com" },
];

/**
 * Mask a secret value — shows first 4 + last 4 characters.
 * Returns null if the value is empty or not set.
 */
function maskValue(value) {
  if (!value || value.length === 0) return null;
  if (value.length <= 12) return `${"•".repeat(value.length)}`;
  return `${value.slice(0, 4)}${"•".repeat(Math.min(value.length - 8, 20))}${value.slice(-4)}`;
}

/**
 * GET /integrations
 * Returns all integration metadata grouped by category.
 */
router.get("/", (_req, res) => {
  const integrations = INTEGRATIONS.map((def) => {
    const rawValue = process.env[def.envKey] || "";
    const configured = rawValue.length > 0;

    return {
      envKey: def.envKey,
      provider: def.provider,
      category: def.category,
      docs: def.docs,
      configured,
      maskedKey: maskValue(rawValue),
    };
  });

  // Group by category
  const categories = {};
  for (const item of integrations) {
    if (!categories[item.category]) {
      categories[item.category] = {
        category: item.category,
        integrations: [],
        configuredCount: 0,
        totalCount: 0,
      };
    }
    categories[item.category].integrations.push(item);
    categories[item.category].totalCount++;
    if (item.configured) categories[item.category].configuredCount++;
  }

  const totalConfigured = integrations.filter((i) => i.configured).length;

  res.json({
    totalCount: integrations.length,
    configuredCount: totalConfigured,
    categories: Object.values(categories),
  });
});

export default router;
