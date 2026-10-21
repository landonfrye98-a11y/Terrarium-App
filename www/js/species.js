// Field-guide entries. `unlock` = lifetime tasks completed before the
// species finds its way into the terrarium.

export const SPECIES = {
  scuttler: {
    name: 'Scuttler',
    latin: 'Crustula fossor',
    unlock: 0,
    cap: 10,
    kind: 'fauna',
    diet: 'Fallen fruit, husks, the dead',
    notes:
      'Dome-backed detritivores that keep the floor clean. They tunnel through the topsoil and return what they eat to it — wherever scuttlers feed, new sprouts follow. When well fed they simply split in two. Burrowing is their only defence against the hookjaw.',
  },
  petalmoth: {
    name: 'Petalmoth',
    latin: 'Lampyra velata',
    unlock: 0,
    cap: 12,
    kind: 'fauna',
    diet: 'Nectar of lantern lilies',
    notes:
      'Four- (occasionally six-) winged pollinators whose wing-eyes watch you back. Their visits ripen the bulbstalks. At night their thoraxes glow, and they have an odd habit of resting on the ring of the clock.',
  },
  bellwisp: {
    name: 'Bellwisp',
    latin: 'Vesica errans',
    unlock: 1,
    cap: 8,
    kind: 'fauna',
    diet: 'Light',
    notes:
      'Gas-filled bladders that drink sunlight through translucent skin, trailing tendrils that taste the air. At the end of their lives they rupture in a slow bloom of spores, which drift for a while before swelling into new wisps.',
  },
  ribbonfin: {
    name: 'Ribbonfin',
    latin: 'Taeniopteryx lucens',
    unlock: 2,
    cap: 6,
    kind: 'fauna',
    diet: 'Spores settling on the water',
    notes:
      'Eel-soft swimmers of the pond pocket. They gulp spores that settle on the surface, and sometimes leap clean out of the water for no reason anyone has established. A lit seam runs down their flank after dark.',
  },
  stiltstrider: {
    name: 'Stiltstrider',
    latin: 'Gracilopus calix',
    unlock: 4,
    cap: 4,
    kind: 'fauna',
    diet: 'Ripe bulbstalk fruit',
    notes:
      'Patient grazers on improbable legs. The head is a fleshy cup ringed with small eyes; it opens like a flower when feeding. They fold down to sleep at night and lay speckled eggs when the fruit is plentiful.',
  },
  mindbloom: {
    name: 'Mindbloom',
    latin: 'Noocephala suspensa',
    unlock: 8,
    cap: 1,
    kind: 'fauna',
    diet: 'Attention',
    notes:
      'Hangs from the glass by a single tendril and pulses. Creatures nearby stop what they are doing and stare. It seems to grow brighter whenever you are focused on a task. Probably harmless. Probably.',
  },
  gloamwhale: {
    name: 'Gloamwhale',
    latin: 'Caelocetus immensus',
    unlock: 12,
    cap: 0,
    kind: 'visitor',
    diet: 'Unknown',
    notes:
      'Not a resident. Every so often a vast shape drifts across the far sky, its ribs lit from inside, fronds trailing a kilometre below. Nobody has seen one land.',
  },
  hookjaw: {
    name: 'Hookjaw',
    latin: 'Uncognathus insidians',
    unlock: 20,
    cap: 3,
    kind: 'fauna',
    diet: 'Scuttlers, strider eggs, carrion',
    notes:
      'A low, patient stalker with a hinged hook of a jaw. It follows the scuttlers along the soil line and always picks out the weakest — the young, the old, the infected. Burrowed scuttlers are safe from it. After a kill it lies still for hours to digest.',
  },
  lancewing: {
    name: 'Lancewing',
    latin: 'Hastaptera praeceps',
    unlock: 25,
    cap: 2,
    kind: 'fauna',
    diet: 'Petalmoths',
    notes:
      'A needle of a body slung between long glass wings. It circles high in the glass, then folds and drops on a petalmoth. Moths that glow brightly at night are easier to find; the plainer ones tend to survive it.',
  },
  mireeel: {
    name: 'Mire-eel',
    latin: 'Limnophis illex',
    unlock: 25,
    cap: 2,
    kind: 'fauna',
    diet: 'Ribbonfin roe and fry',
    notes:
      'Lies on the pond floor dangling a glowing lure from its jaw. It only takes eggs and the very young, which keeps the ribbonfins from crowding the water.',
  },
  // flora
  fanfern: { name: 'Fanfern', latin: 'Flabellifolia', unlock: 0, kind: 'flora', notes: 'Fleshy fan-fronds that sway with the air currents in the glass.' },
  bulbstalk: { name: 'Bulbstalk', latin: 'Bulbicaulis', unlock: 0, kind: 'flora', notes: 'Grows a single fruit-bulb that ripens green to coral. Pollinated by petalmoths; eaten by striders; rotted by scuttlers.' },
  lanternlily: { name: 'Lantern Lily', latin: 'Lucernaria nutans', unlock: 0, kind: 'flora', notes: 'Drooping bells full of nectar. Faintly luminous at night.' },
  puffcap: { name: 'Puffcap', latin: 'Sporocalyx', unlock: 0, kind: 'flora', notes: 'Spotted caps that exhale spore clouds. Some of those spores become bellwisps.' },
  tubebloom: { name: 'Tubebloom', latin: 'Siphonanthus', unlock: 6, kind: 'flora', notes: 'Clustered tubes that open at dusk and glow from within until morning.' },
  snaplure: { name: 'Snaplure', latin: 'Muscipula fallax', unlock: 15, kind: 'flora', notes: 'A hinged trap that glows like a lantern lily. Petalmoths that mistake it for nectar do not leave. It feeds on nothing else, and withers if the moths grow scarce.' },
  dewveil: { name: 'Dewveil', latin: 'Velum roridum', unlock: 15, kind: 'flora', notes: 'A sticky curtain that hangs from the glass ceiling. Bellwisps drifting too high are caught and slowly drunk.' },
  gloomcap: { name: 'Gloomcap', latin: 'Lugubria mycetes', unlock: 0, kind: 'flora', notes: 'The fruiting body of a fungus that spreads when creatures crowd together. It erupts from the bodies it kills, sheds spores for a few hours, and rots back into the soil.' },
  coilspire: { name: 'Coilspire', latin: 'Helicophyta', unlock: 10, kind: 'flora', notes: 'A slow spiral reaching for the ceiling of the glass. Taller every hour.' },
};

export const FAUNA_KINDS = ['scuttler', 'petalmoth', 'bellwisp', 'ribbonfin', 'stiltstrider', 'mindbloom', 'hookjaw', 'lancewing', 'mireeel'];
export const PREDATORS = ['hookjaw', 'lancewing', 'mireeel'];

// Ecological constants in one place, so the headless harness can tune them.
// n* values are nutrient units (one soil cell holds about 0.5 when healthy).
export const ECO = {
  nBody: { scuttler: 0.08, petalmoth: 0.05, bellwisp: 0.06, ribbonfin: 0.1, stiltstrider: 0.16, mindbloom: 0.3, hookjaw: 0.1, lancewing: 0.08, mireeel: 0.1 },
  nPlant: { grass: 0.04, fanfern: 0.14, bulbstalk: 0.22, lanternlily: 0.18, puffcap: 0.1, tubebloom: 0.18, coilspire: 0.4, snaplure: 0.16, dewveil: 0.16, gloomcap: 0.02 },
  nFruit: 0.1,       // nutrient packed into one ripe bulb
  nNectar: 0.05,     // nutrient in a full lily of nectar
  assim: 0.7,        // share of eaten nutrient kept; the rest is excreted on the spot
  bankFloor: 1,      // a species at or below this many lives can be rescued by its seed bank
  bankHalfLife: 3 * 86400,
  immigrateAfter: 2 * 86400,
  // predators: a = capture rate per second when hunting, digest = seconds of rest after a kill
  hunt: {
    hookjaw: { a: 1 / 2400, digest: 3 * 3600, refuge: 3 },
    lancewing: { a: 1 / 3600, digest: 3 * 3600, refuge: 3 },
    mireeel: { a: 1 / 1800, digest: 1.5 * 3600, refuge: 2 },
    snaplure: { a: 1 / 6000, digest: 2 * 3600, refuge: 3 },
    dewveil: { a: 1 / 6000, digest: 2 * 3600, refuge: 2 },
  },
  // fungus: spreads only where creatures crowd together
  fungus: { beta: 1 / 20000, crowd: 5, spont: 1 / 300000, lifeMin: 2 * 3600, lifeMax: 5 * 3600 },
};

const A = ['ve', 'ka', 'mo', 'ri', 'su', 'ol', 'an', 'ze', 'lu', 'ny', 'ho', 'ae', 'is', 'to', 'ma', 'el', 'ur', 'qi', 'sa', 'do'];
const B = ['sk', 'n', 'l', 'r', 'th', 'v', 'm', 'z', 'sh', 'lt', 'nd', 'k'];
const C = ['a', 'i', 'o', 'e', 'u', 'ae', 'ia', 'en', 'is', 'um', 'ix', 'or'];

export function makeName(r = Math.random) {
  const p = (arr) => arr[Math.floor(r() * arr.length)];
  let n = p(A) + p(B) + p(C);
  if (r() < 0.35) n += p(B) + p(C);
  return n.charAt(0).toUpperCase() + n.slice(1);
}
