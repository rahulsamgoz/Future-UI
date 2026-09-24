#!/usr/bin/env node
/**
 * Retrieval evaluation corpus generator (spec section 19, retrieval row).
 *
 * Writes the FROZEN corpus.json used by test/eval.test.ts. The output is
 * deterministic — the entity observations and queries below are hand-authored,
 * not randomized — so regenerating reproduces the exact same corpus. To extend
 * the corpus, edit the tables and re-run; the generator self-checks overlap
 * sanity (every known-target query shares content vocabulary with its expected
 * entity; every no_match query shares none with any entity) and the corpus
 * sizes required by the release criterion (>= 100 known-target queries,
 * >= 30 ambiguous/out-of-corpus queries).
 *
 * Design notes (see README.md):
 * - 53 entities across realistic app areas, 2-3 observations each.
 * - Deliberate near-collisions ("Add to cart" vs "Add to cart item",
 *   "order #4821" in two entities, shared stopwords like "to"/"your") create
 *   genuine retrieval ambiguity instead of toy disjoint vocabularies.
 * - Known-target queries mix exact phrases, partial phrases, reordered words,
 *   and paraphrases built from corpus vocabulary.
 *
 * Usage: node fixtures/retrieval/generate-corpus.mjs [outputPath]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(process.argv[2] ?? path.join(scriptDir, "corpus.json"));

/** Hand-authored entities: entityKey -> visible-text observations (2-6 each). */
const ENTITIES = {
  "catalog.productChooser": ["Product chooser", "Featured products this week", "Browse the full catalog"],
  "catalog.sortControl": ["Sort products", "Sort by price, low to high", "Newest arrivals first"],
  "catalog.filterPanel": ["Filters", "Only in-stock items", "Refine results by brand"],
  "catalog.searchBar": ["Search products", "Search the catalog", "What are you looking for?"],
  "catalog.pagination": ["Next page", "Page 2 of 8", "Showing 24 of 187 products"],
  "catalog.productCard": ["Product details and price", "View full details", "Rated 4.5 by 231 customers"],
  "catalog.compareTray": ["Compare products", "Compare up to 4 products", "Clear comparison"],
  "catalog.wishlistButton": ["Save for later", "Add to wishlist", "Saved to your wishlist"],

  "cart.addButton": ["Add to cart", "Add this product to your cart", "Added to cart"],
  "cart.lineItemRow": ["Add to cart item", "Remove item", "Qty: 2"],
  "cart.miniCart": ["Your cart", "2 items in your cart", "View cart and checkout"],
  "cart.checkoutSummary": ["Order summary", "Checkout now", "Total due today"],
  "cart.promoCodeField": ["Promo code", "Enter a discount code", "Apply coupon"],
  "cart.shippingOptions": ["Shipping options", "Standard delivery, 3-5 days", "Express delivery, tomorrow"],

  "account.profileForm": ["Profile settings", "Display name", "Save profile changes"],
  "account.loginForm": ["Sign in", "Forgot your password?", "Keep me signed in"],
  "account.passwordForm": ["Change password", "Current password", "New password must differ from the old one"],
  "account.emailPrefs": ["Email preferences", "Weekly digest", "Unsubscribe from marketing emails"],
  "account.addressBook": ["Address book", "Add a new address", "Default shipping address"],
  "account.sessionsList": ["Active sessions", "Sign out of all devices", "Last signed in from Chrome"],

  "orders.orderList": ["Your orders", "Order #4821", "Placed on August 4"],
  "orders.orderDetail": ["Order details", "Items in this order", "Payment method: card ending 4242"],
  "orders.refundForm": ["Request a refund", "Refund reason", "Refunds process in 5 business days"],
  "orders.trackingPanel": ["Package tracking", "Shipped via Globex", "Arriving Thursday"],
  "orders.invoiceDownload": ["Download invoice", "Invoice PDF", "Tax invoice for order #4821"],

  "settings.themePicker": ["Appearance settings", "Dark mode", "Light or system theme"],
  "settings.languageMenu": ["Language", "Español", "Region and language"],
  "settings.notificationPanel": ["Notification settings", "Mute all alerts", "Push notifications"],
  "settings.privacyControls": ["Privacy controls", "Manage cookies", "Do not sell my data"],
  "settings.dataExport": ["Export your data", "Download a copy of your data", "Export format: JSON"],

  "nav.mainMenu": ["Main menu", "Home", "All departments"],
  "nav.breadcrumbTrail": ["Home / Catalog / Shoes", "Breadcrumb trail", "Back one level"],
  "nav.footerLinks": ["Footer", "Terms of service", "Privacy policy"],
  "nav.regionSwitcher": ["Choose your country", "Shipping country", "Region: EU"],

  "content.articleBody": ["Article body", "Published on September 2", "5 minute read"],
  "content.commentThread": ["Comments", "Share what you think", "12 replies"],
  "content.ratingStars": ["Rated 4.5 out of 5", "231 ratings", "Write a review"],
  "content.mediaGallery": ["Product photos", "Zoom the image", "12 photos"],
  "content.videoPlayer": ["Product video", "Play the demo", "Closed captions available"],

  "dashboard.statsPanel": ["Sales this week", "Revenue is up 12%", "Conversion rate 3.4%"],
  "dashboard.activityFeed": ["Recent activity", "You updated pricing 2 hours ago", "View all activity"],
  "dashboard.quickActions": ["Quick actions", "Create a new product", "Duplicate last week's campaign"],

  "support.helpCenter": ["Help center", "How can we help?", "Browse popular articles"],
  "support.contactForm": ["Contact support", "Start a chat", "We reply within one business day"],

  "admin.userTable": ["User management", "482 active users", "Invite a teammate"],
  "admin.roleEditor": ["Roles and permissions", "Grant admin access", "Editor role"],
  "admin.auditLog": ["Audit log", "Who changed what", "Export the log as CSV"],

  "app.region1": ["Announcement banner", "Free shipping on orders over 50", "Limited time offer"],
  "app.region2": ["Newsletter signup", "Subscribe to our newsletter", "Get 10% off your first order"],
  "app.region3": ["Store locator", "Find a store near you", "Open until 9 pm"],
  "app.region4": ["Gift cards", "Check your gift card balance", "Redeem a gift card"],
  "app.region5": ["Loyalty program", "Join the rewards club", "You have 240 points"],
  "app.region6": ["Sustainability", "Our climate pledge", "Carbon neutral since 2024"],
};

/**
 * Known-target query variants beyond the exact-phrase query every entity
 * gets. Partial phrases, reordered words, paraphrases — all built from the
 * entity's own observation vocabulary (plus corpus stopwords).
 */
const VARIANTS = {
  "catalog.productChooser": ["featured products", "chooser for the catalog"],
  "catalog.sortControl": ["price, low to high", "sort newest first"],
  "catalog.filterPanel": ["refine results", "in-stock only"],
  "catalog.searchBar": ["search the catalog", "what are you looking for"],
  "catalog.pagination": ["page 2 of 8", "showing 24 of 187"],
  "catalog.productCard": ["view full details", "4.5 by 231 customers"],
  "catalog.compareTray": ["clear comparison", "compare up to 4"],
  "catalog.wishlistButton": ["add to wishlist", "saved to your wishlist"],
  "cart.addButton": ["add this product to your cart", "added to cart"],
  "cart.lineItemRow": ["remove item", "qty 2"],
  "cart.miniCart": ["2 items in your cart", "view cart"],
  "cart.checkoutSummary": ["checkout now", "total due today"],
  "cart.promoCodeField": ["enter a discount code", "apply coupon"],
  "cart.shippingOptions": ["standard delivery 3-5 days", "express delivery tomorrow"],
  "account.profileForm": ["display name", "save profile changes"],
  "account.loginForm": ["forgot your password", "keep me signed in"],
  "account.passwordForm": ["current password", "new password must differ"],
  "account.emailPrefs": ["weekly digest", "unsubscribe from marketing emails"],
  "account.addressBook": ["add a new address", "default shipping address"],
  "account.sessionsList": ["sign out of all devices", "last signed in from chrome"],
  "orders.orderList": ["order 4821", "placed on august 4"],
  "orders.orderDetail": ["items in this order", "payment method card ending 4242"],
  "orders.refundForm": ["refund reason", "refunds process in 5 business days"],
  "orders.trackingPanel": ["shipped via globex", "arriving thursday"],
  "orders.invoiceDownload": ["invoice pdf", "tax invoice for order 4821"],
  "settings.themePicker": ["dark mode", "light or system theme"],
  "settings.languageMenu": ["region and language"],
  "settings.notificationPanel": ["mute all alerts", "push notifications"],
  "settings.privacyControls": ["manage cookies", "do not sell my data"],
  "settings.dataExport": ["download a copy of your data", "export format json"],
  "nav.mainMenu": ["all departments"],
  "nav.breadcrumbTrail": ["home catalog shoes", "back one level"],
  "nav.footerLinks": ["privacy policy"],
  "nav.regionSwitcher": ["shipping country", "region eu"],
  "content.articleBody": ["published on september 2", "5 minute read"],
  "content.commentThread": ["share what you think", "12 replies"],
  "content.ratingStars": ["231 ratings", "write a review"],
  "content.mediaGallery": ["zoom the image", "12 photos"],
  "content.videoPlayer": ["play the demo", "closed captions available"],
  "dashboard.statsPanel": ["revenue is up 12", "conversion rate 3.4"],
  "dashboard.activityFeed": ["you updated pricing 2 hours ago", "view all activity"],
  "dashboard.quickActions": ["create a new product", "duplicate last week's campaign"],
  "support.helpCenter": ["how can we help", "browse popular articles"],
  "support.contactForm": ["start a chat", "we reply within one business day"],
  "admin.userTable": ["482 active users", "invite a teammate"],
  "admin.roleEditor": ["grant admin access", "editor role"],
  "admin.auditLog": ["export the log as csv"],
  "app.region1": ["free shipping on orders over 50", "limited time offer"],
  "app.region2": ["subscribe to our newsletter", "get 10 off your first order"],
  "app.region3": ["find a store near you", "open until 9 pm"],
  "app.region4": ["check your gift card balance", "redeem a gift card"],
  "app.region5": ["join the rewards club", "you have 240 points"],
  "app.region6": ["our climate pledge", "carbon neutral since 2024"],
};

/** Ambiguous queries: multiple equally-valid corpus targets. */
const AMBIGUOUS_QUERIES = [
  { text: "add to cart", expectedEntityKeys: ["cart.addButton", "cart.lineItemRow"] },
  { text: "cart", expectedEntityKeys: ["cart.addButton", "cart.miniCart", "cart.lineItemRow"] },
  { text: "items in your cart", expectedEntityKeys: ["cart.miniCart", "cart.lineItemRow"] },
  { text: "checkout", expectedEntityKeys: ["cart.checkoutSummary", "cart.miniCart"] },
  { text: "password", expectedEntityKeys: ["account.loginForm", "account.passwordForm"] },
  { text: "sign", expectedEntityKeys: ["account.loginForm", "account.sessionsList"] },
  { text: "settings", expectedEntityKeys: ["account.profileForm", "settings.themePicker", "settings.notificationPanel"] },
  { text: "order", expectedEntityKeys: ["orders.orderList", "orders.orderDetail", "orders.invoiceDownload"] },
  { text: "order 4821", expectedEntityKeys: ["orders.orderList", "orders.invoiceDownload", "admin.userTable"] },
  { text: "card", expectedEntityKeys: ["app.region4", "orders.orderDetail"] },
  { text: "shipping", expectedEntityKeys: ["cart.shippingOptions", "account.addressBook", "nav.regionSwitcher"] },
  { text: "product", expectedEntityKeys: ["catalog.productChooser", "catalog.productCard", "content.mediaGallery", "content.videoPlayer"] },
  { text: "price", expectedEntityKeys: ["catalog.sortControl", "catalog.productCard"] },
  { text: "view", expectedEntityKeys: ["catalog.productCard", "cart.miniCart", "dashboard.activityFeed"] },
  { text: "export", expectedEntityKeys: ["settings.dataExport", "admin.auditLog"] },
  { text: "your data", expectedEntityKeys: ["settings.dataExport", "settings.privacyControls"] },
  { text: "home", expectedEntityKeys: ["nav.mainMenu", "nav.breadcrumbTrail"] },
  { text: "region", expectedEntityKeys: ["nav.regionSwitcher", "settings.languageMenu"] },
  { text: "active", expectedEntityKeys: ["admin.userTable", "account.sessionsList"] },
  { text: "12", expectedEntityKeys: ["content.mediaGallery", "content.commentThread"] },
];

/** Out-of-corpus queries: text about nothing in the corpus. */
const NO_MATCH_QUERIES = [
  "quarterly budget spreadsheet",
  "weather forecast for berlin",
  "banana bread recipe",
  "flight arrival status",
  "schedule a dentist appointment",
  "mortgage interest calculator",
  "adopt a rescue dog",
  "translate spanish to french",
  "live sports scores",
  "movie showtimes tonight",
  "recover deleted files",
  "parking permit renewal",
];

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
  "i", "in", "is", "it", "its", "me", "my", "not", "of", "on", "or", "our",
  "s", "t", "that", "the", "this", "to", "was", "we", "were", "will", "with",
  "you", "your",
]);

const tokenize = (text) =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0 && !STOPWORDS.has(t));

const entityTokens = new Map();
for (const [key, observations] of Object.entries(ENTITIES)) {
  entityTokens.set(key, new Set(observations.flatMap((o) => tokenize(o))));
}

// --- Self-checks ------------------------------------------------------------

const errors = [];
for (const [key, observations] of Object.entries(ENTITIES)) {
  if (observations.length < 2 || observations.length > 6) errors.push(`${key}: expected 2-6 observations`);
}

const knownTargetQueries = [];
// Every entity gets its exact-phrase query (first observation, verbatim).
for (const key of Object.keys(ENTITIES)) {
  knownTargetQueries.push({ text: ENTITIES[key][0], expectedEntityKey: key });
}
// Then variants round-robin over entities until the corpus reaches 100.
const variantsByEntity = Object.entries(VARIANTS).map(([key, texts]) => ({ key, texts, next: 0 }));
const TARGET_KNOWN = 100;
while (knownTargetQueries.length < TARGET_KNOWN) {
  let progressed = false;
  for (const entry of variantsByEntity) {
    if (knownTargetQueries.length >= TARGET_KNOWN) break;
    if (entry.next < entry.texts.length) {
      knownTargetQueries.push({ text: entry.texts[entry.next], expectedEntityKey: entry.key });
      entry.next += 1;
      progressed = true;
    }
  }
  if (!progressed) break;
}

for (const q of knownTargetQueries) {
  if (!entityTokens.has(q.expectedEntityKey)) errors.push(`query "${q.text}": unknown expected entity ${q.expectedEntityKey}`);
  const qt = tokenize(q.text);
  if (qt.length === 0) errors.push(`query "${q.text}": no content tokens after stopword removal`);
  const expected = entityTokens.get(q.expectedEntityKey);
  if (!qt.some((t) => expected.has(t))) {
    errors.push(`query "${q.text}" shares no content vocabulary with ${q.expectedEntityKey}`);
  }
}

const allTokens = new Set([...entityTokens.values()].flatMap((s) => [...s]));
for (const q of NO_MATCH_QUERIES) {
  const qt = tokenize(q);
  if (qt.length === 0) errors.push(`no_match query "${q.text}": only stopwords`);
  for (const t of qt) {
    if (allTokens.has(t)) errors.push(`no_match query "${q.text}" shares token "${t}" with the corpus`);
  }
}

const entityKeys = new Set(Object.keys(ENTITIES));
for (const q of AMBIGUOUS_QUERIES) {
  if (q.expectedEntityKeys.length < 2) errors.push(`ambiguous query "${q.text}": needs >= 2 expected keys`);
  for (const key of q.expectedEntityKeys) {
    if (!entityKeys.has(key)) errors.push(`ambiguous query "${q.text}": unknown expected entity ${key}`);
  }
  const qt = tokenize(q.text);
  const matching = [...entityTokens.entries()].filter(([, tokens]) => qt.some((t) => tokens.has(t)));
  if (matching.length < 2) errors.push(`ambiguous query "${q.text}": only ${matching.length} entities share vocabulary`);
}

if (knownTargetQueries.length < 100) errors.push(`known-target queries: ${knownTargetQueries.length} < 100`);
if (AMBIGUOUS_QUERIES.length + NO_MATCH_QUERIES.length < 30) errors.push("ambiguous + no_match < 30");

if (errors.length > 0) {
  console.error("corpus self-check failed:");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const corpus = {
  version: 1,
  frozenAt: "2026-09-24",
  description:
    "Frozen retrieval evaluation corpus (spec section 19). Regenerate with: node fixtures/retrieval/generate-corpus.mjs",
  entities: Object.entries(ENTITIES).map(([entityKey, observations]) => ({
    entityKey,
    anchors: [entityKey],
    observations,
  })),
  knownTargetQueries,
  ambiguousQueries: AMBIGUOUS_QUERIES,
  noMatchQueries: NO_MATCH_QUERIES.map((text) => ({ text })),
};

mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(corpus, null, 2)}\n`);
console.log(
  `corpus written to ${outPath}: ${corpus.entities.length} entities, ` +
    `${knownTargetQueries.length} known-target, ${AMBIGUOUS_QUERIES.length} ambiguous, ` +
    `${NO_MATCH_QUERIES.length} no-match queries`
);
