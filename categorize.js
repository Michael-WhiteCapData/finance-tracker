'use strict';

// Keyword-based spending categorizer. Rules are checked in order, first match
// wins, so put specific buckets (subscriptions, gaming) before generic ones.
// Each rule: [regex tested against the raw description, category].

let RULES = [
  // Fees — the costly stuff, caught first
  [/paid item fee|overdraft|nsf|return item|insufficient/i, 'Fees & Charges'],
  [/service charge|maintenance fee|monthly fee|interest charge|finance charge/i, 'Fees & Charges'],

  // Subscriptions (match known recurring services before generic shopping)
  [/anthropic|claude|openai|chatgpt|x ?corp|twitter|\bx dev/i, 'Subscriptions'],
  [/spotify|netflix|hulu|disney|youtube ?premium|soundcloud|pandora|audible/i, 'Subscriptions'],
  [/discord|github|proton|adobe|notion|dropbox|microsoft ?365|office ?365/i, 'Subscriptions'],
  [/norton|mcafee|bitdefender|realdefense|godaddy|\bwix\b|cloudflare/i, 'Subscriptions'],
  [/higgsfield|midjourney|elevenlabs|runway/i, 'Subscriptions'],
  [/apple\.?com\/?bill|apple bill|apple services|itunes/i, 'Subscriptions'],
  [/dynalist|mailreach|\bzoho\b|zendesk|calendly|typeform|airtable/i, 'Subscriptions'],

  // Education
  [/cengage|pearson|chegg|coursera|udemy|university|\bcollege\b|textbook|vitalsource|mcgraw/i, 'Education'],

  // Adult
  [/aylo|segpay|pornhub|onlyfans|brazzers|mindgeek/i, 'Adult'],

  // Gaming (à-la-carte purchases + storefronts)
  [/steam|valve|xbox|playstation|nintendo|riot|epic ?games|ubisoft|rockstar/i, 'Gaming'],
  [/\bg2a\b|eneba|cdkeys|gamer2gamer|kinguin|tebex|xsolla|battlemetrics|iracing/i, 'Gaming'],
  [/playerauctions|electronic ?arts|\bea ?\*|microsoft\*store|origin|blizzard|twitch/i, 'Gaming'],
  [/razer ?gold|openfront|roblox|garena|supercell|mihoyo|hoyoverse/i, 'Gaming'],

  // Entertainment / recreation
  [/\bski\b|mountain|cinema|movie|\bamc\b|regal cinem|golf|bowling|concert|ticketmaster|stubhub|arcade/i, 'Entertainment'],

  // Food & dining
  [/doordash|uber ?eats|grubhub|postmates|seamless/i, 'Food & Dining'],
  [/pizza|pizzeria|mcdonald|burger|taco|chipotle|wendy|subway|dunkin|starbucks|coffee|cafe|caf\b/i, 'Food & Dining'],
  [/restaurant|grill|diner|bar ?& ?grill|kitchen|bbq|deli|bagel|donut|wings|sushi|chinese|thai/i, 'Food & Dining'],
  [/\btst\*|arby|sandwich|five ?guys|panera|chick-?fil|popeyes|kfc/i, 'Food & Dining'],
  [/tavern|\bpub\b|tap ?house|brewing|brewery|eatery|bistro|cantina|saloon/i, 'Food & Dining'],
  [/liquor|wine ?& ?spirits|\bspirits\b|beverage|smoke ?shop|smokes?\b/i, 'Food & Dining'],

  // Groceries
  [/wal-?\s?mart|walmart|aldi|save ?a ?lot|grocery|supermarket|trader ?joe|kroger|costco|sam.?s club|dollar ?gen|dollar ?tree/i, 'Groceries'],

  // Gas & auto / convenience
  [/\bgas\b|fuel|shell|sunoco|exxon|mobil|speedway|citgo|valero|bp ?#|chevron|marathon|circle ?k/i, 'Gas & Auto'],
  [/\bmini ?mart|convenien|\bcitgo\b|\bsheetz\b|\bwawa\b/i, 'Gas & Auto'],
  [/autozone|advance ?auto|o.?reilly|jiffy ?lube|car ?wash|mechanic|tire/i, 'Gas & Auto'],

  // Health
  [/cvs|walgreens|rite ?aid|pharmacy|\brx\b|doctor|dental|medical|hospital|clinic|urgent ?care/i, 'Health'],

  // Shopping
  [/amazon|amzn|\bebay\b|\btarget\b|best ?buy|aliexpress|temu|shein|etsy/i, 'Shopping'],
  [/tractor ?supply|home ?depot|\blowe.?s\b|menards|hardware/i, 'Shopping'],

  // Crypto / investment
  [/bitcoin|coinbase|crypto|\bbtc\b|kraken|binance|robinhood|kalshi/i, 'Crypto / Investment'],

  // Gambling / DFS
  [/draftking|fanduel|prizepicks|underdog|betmgm|caesars|sportsbook|casino/i, 'Gambling'],

  // Bills & utilities
  [/insurance|geico|progressive|state ?farm|allstate/i, 'Bills & Utilities'],
  [/verizon|at&t|t-?mobile|spectrum|comcast|xfinity|electric|national ?grid|water|utility|rent/i, 'Bills & Utilities'],

  // Cash / ATM
  [/\batm\b|cash ?withdrawal|withdrawal/i, 'Cash & ATM'],

  // P2P / people (peer payments). `\bzel\b` catches Zelle abbreviated as "ZEL"
  // with a space or asterisk after it (e.g. "ZEL JANE", "ZEL*SAM") — the old
  // `\bzel\*` only matched the asterisk form, leaking the spaced form into Other.
  [/\bzel\b|zelle|quickpay|popmoney|apple ?cash|sent ?money|venmo|cash ?app|cashapp|\bp2p\b/i, 'P2P / People'],
];

// Optional local override: drop a git-ignored `categorize.local.js` exporting
// `{ rules: [[regex, 'Category'], ...] }` to teach the categorizer your own
// regional/local merchants without committing them to a public repo. Local
// rules are checked FIRST (they're the most specific to you).
try {
  const local = require('./categorize.local');
  if (local && Array.isArray(local.rules)) RULES = [...local.rules, ...RULES];
} catch { /* no local overrides present — that's fine */ }

// Normalize a raw bank/platform description into a short merchant label.
const NOISE = new Set([
  'DBT', 'CRD', 'POS', 'DEB', 'PURCHASE', 'RECURRING', 'IAT', 'PAYMENT', 'PMT',
  'WEB', 'COM', 'WWW', 'INC', 'LLC', 'THE', 'CO', 'USA', 'US', 'CA', 'NY',
]);

function merchant(raw) {
  let s = String(raw || '').toUpperCase().replace(/[^A-Z0-9* ]+/g, ' ');
  s = s.replace(/\b\d+\b/g, ' ');
  const tokens = s.split(/\s+/).filter((t) => t && t.length > 1 && !NOISE.has(t));
  return tokens.slice(0, 3).join(' ') || 'Unknown';
}

function categorize(description, hint) {
  const text = `${description || ''} ${hint || ''}`;
  for (const [re, cat] of RULES) {
    if (re.test(text)) return cat;
  }
  return 'Other';
}

module.exports = { categorize, merchant };
