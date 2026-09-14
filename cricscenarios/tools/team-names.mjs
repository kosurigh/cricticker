/**
 * Recover display names from the normalised keys in divisions.json.
 *
 * Build-time only — never shipped to the browser. Live data from CricHeroes
 * carries proper team names, so this exists purely so the placeholder seasons
 * read like a real league table instead of "Carysirjis".
 *
 * The division map stores names lowercased with punctuation stripped
 * ("hollyspringsheat"), which throws away the word boundaries. Two sources put
 * them back:
 *
 *   1. assets/team-logos/manifest.json — its filenames kept the original
 *      casing ("HollySpringsHeat.png"), so 35 of the 125 names come back exactly.
 *   2. A greedy longest-match split over the vocabulary below for the rest.
 *
 * Anything the vocabulary cannot split is title-cased and reported by
 * `unresolved()`, so a bad name is visible rather than silently shipped.
 */

/** Tokens that should render in a fixed form rather than title case. */
const LITERALS = {
  ht: 'HT', xi: 'XI', x1: 'X1', cc: 'CC', nc: 'NC', rtp: 'RTP', ct: 'CT',
  mib: 'MIB', r3: 'R3', usa: 'USA', '11': '11', '12th': '12th', '40': '40',
};

/**
 * Vocabulary for the splitter, longest first at match time.
 *
 * Drawn from the actual team names in this tournament — team names are not
 * ordinary English, so a dictionary would not help: "bhaukal", "sirjis",
 * "dothraki" and "markhors" are all real entries here.
 */
const WORDS = `
all star stars starz xi x1 ht cc nc rtp ct mib usa
alphas astras army avengers bachchan bengal blasters blazing blue bol bouys boys
boyz brave bravehearts bulls carolina cary chapel chargers cheetahs chennai
cholans citius club conquerors courageous cricket cricketers crisco dominatorzz
dragons eaters edition emperors fast finishers force fresh friends fuquay
gangsters garner garudas giants glory green greensboro greenville guts gully
hawks hearts heat hickory hill himalayan hunters hyderabad invincible islanders
jaguars jordans kings knights knockout kryptonians lemurians limited lions
mammoths man markhors mavericks mighty man mustangs nationals naughty oak only
origin original panthers predators raising rangers rare red revengers rhinos
roaring rockers royal sandstorm sirjis springs stallions stormers sundarban
super supergillies gillies tech the titans triangle tridents troopers united
vikings walkers warriors waves whales white wildcats wilson wings xmen zen
zorians bhaukal death dothraki mutants unicorns thunderbolts tigers
12th 11 40 3
`.trim().split(/\s+/);

const BY_LENGTH = [...new Set(WORDS)].sort((a, b) => b.length - a.length);

/** Names the splitter gets wrong or cannot reach — corrected by hand. */
const OVERRIDES = {
  naughty40: 'Naughty40',
  r3: 'R3',
  the11starsht: 'The 11 Stars HT',
  mib: 'MIB',
  bolbachchan: 'Bol Bachchan',
  dominatorzz: 'DominatorZZ',
  supergillies: 'Super Gillies',
  garneroriginalgangsters: 'Garner Original Gangsters',
  greensborocricketclubht: 'Greensboro Cricket Club HT',
  fastrangers: 'FAST Rangers',
  allstarsxi: 'All Stars XI',
  '12thmanht': '12th Man HT',
  ncjordans: 'NC Jordans',
  ncnationalsht: 'NC Nationals HT',
  ncrockers: 'NC Rockers',
  cttitansht: 'CT Titans HT',
  citiustechxi: 'Citius Tech XI',
  invinciblex1: 'Invincible X1',
  sandstormx1: 'Sandstorm X1',
  blazingxi: 'Blazing XI',
  criscoxi: 'Crisco XI',
  dragonsxi: 'Dragons XI',
  mustangsxi: 'Mustangs XI',
  xmenht: 'X-Men HT',
  theboysht: 'The Boys HT',
  thebouys: 'The Bouys',
  theforceht: 'The Force HT',
  thefreshstarz: 'The Fresh Starz',
  gullyboyz: 'Gully Boyz',
  bhaukalarmy: 'Bhaukal Army',
  rareht: 'RARE HT',
};

const titleCase = (w) => (LITERALS[w] || w.charAt(0).toUpperCase() + w.slice(1));

/** Greedy longest-match split; returns null if the whole string is not covered. */
function split(key) {
  const out = [];
  let i = 0;
  while (i < key.length) {
    const w = BY_LENGTH.find((word) => key.startsWith(word, i));
    if (!w) return null;
    out.push(w);
    i += w.length;
  }
  return out;
}

/** Turn a logo filename back into the name it was made from. */
export function fromLogoFile(file) {
  return file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, ' ')
    .replace(/(?<=[A-Z])(?=[A-Z][a-z])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const missed = new Set();

/**
 * Best display name for a normalised division-map key.
 * `manifest` is the team-logo manifest (normalised name -> filename).
 */
export function displayName(key, manifest = {}) {
  if (OVERRIDES[key]) return OVERRIDES[key];
  if (manifest[key]) return fromLogoFile(manifest[key]);
  const parts = split(key);
  if (parts) return parts.map(titleCase).join(' ');
  missed.add(key);
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Keys that fell through to bare title case, for reporting. */
export function unresolved() {
  return [...missed];
}

/** Short code for a team, used where the logo is missing. */
export function shortCode(name) {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.map((w) => w[0]).join('').toUpperCase().slice(0, 4);
}
