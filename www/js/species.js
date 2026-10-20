// Field-guide entries. `unlock` = lifetime tasks completed before the
// species finds its way into the terrarium.

export const SPECIES = {
  scuttler: {
    name: 'Scuttler',
    latin: 'Crustula fossor',
    unlock: 0,
    cap: 7,
    kind: 'fauna',
    diet: 'Fallen fruit, husks, the dead',
    notes:
      'Dome-backed detritivores that keep the floor clean. They tunnel through the topsoil and leave it richer than they found it — wherever scuttlers feed, new sprouts follow. When well fed they simply split in two.',
  },
  petalmoth: {
    name: 'Petalmoth',
    latin: 'Lampyra velata',
    unlock: 0,
    cap: 9,
    kind: 'fauna',
    diet: 'Nectar of lantern lilies',
    notes:
      'Four- (occasionally six-) winged pollinators whose wing-eyes watch you back. Their visits ripen the bulbstalks. At night their thoraxes glow, and they have an odd habit of resting on the ring of the clock.',
  },
  bellwisp: {
    name: 'Bellwisp',
    latin: 'Vesica errans',
    unlock: 1,
    cap: 6,
    kind: 'fauna',
    diet: 'Light',
    notes:
      'Gas-filled bladders that drink sunlight through translucent skin, trailing tendrils that taste the air. At the end of their lives they rupture in a slow bloom of spores, which drift for a while before swelling into new wisps.',
  },
  ribbonfin: {
    name: 'Ribbonfin',
    latin: 'Taeniopteryx lucens',
    unlock: 2,
    cap: 4,
    kind: 'fauna',
    diet: 'Spores settling on the water',
    notes:
      'Eel-soft swimmers of the pond pocket. They gulp spores that settle on the surface, and sometimes leap clean out of the water for no reason anyone has established. A lit seam runs down their flank after dark.',
  },
  stiltstrider: {
    name: 'Stiltstrider',
    latin: 'Gracilopus calix',
    unlock: 4,
    cap: 3,
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
  // flora
  fanfern: { name: 'Fanfern', latin: 'Flabellifolia', unlock: 0, kind: 'flora', notes: 'Fleshy fan-fronds that sway with the air currents in the glass.' },
  bulbstalk: { name: 'Bulbstalk', latin: 'Bulbicaulis', unlock: 0, kind: 'flora', notes: 'Grows a single fruit-bulb that ripens green to coral. Pollinated by petalmoths; eaten by striders; rotted by scuttlers.' },
  lanternlily: { name: 'Lantern Lily', latin: 'Lucernaria nutans', unlock: 0, kind: 'flora', notes: 'Drooping bells full of nectar. Faintly luminous at night.' },
  puffcap: { name: 'Puffcap', latin: 'Sporocalyx', unlock: 0, kind: 'flora', notes: 'Spotted caps that exhale spore clouds. Some of those spores become bellwisps.' },
  tubebloom: { name: 'Tubebloom', latin: 'Siphonanthus', unlock: 6, kind: 'flora', notes: 'Clustered tubes that open at dusk and glow from within until morning.' },
  coilspire: { name: 'Coilspire', latin: 'Helicophyta', unlock: 10, kind: 'flora', notes: 'A slow spiral reaching for the ceiling of the glass. Taller every hour.' },
};

export const FAUNA_KINDS = ['scuttler', 'petalmoth', 'bellwisp', 'ribbonfin', 'stiltstrider', 'mindbloom'];

const A = ['ve', 'ka', 'mo', 'ri', 'su', 'ol', 'an', 'ze', 'lu', 'ny', 'ho', 'ae', 'is', 'to', 'ma', 'el', 'ur', 'qi', 'sa', 'do'];
const B = ['sk', 'n', 'l', 'r', 'th', 'v', 'm', 'z', 'sh', 'lt', 'nd', 'k'];
const C = ['a', 'i', 'o', 'e', 'u', 'ae', 'ia', 'en', 'is', 'um', 'ix', 'or'];

export function makeName(r = Math.random) {
  const p = (arr) => arr[Math.floor(r() * arr.length)];
  let n = p(A) + p(B) + p(C);
  if (r() < 0.35) n += p(B) + p(C);
  return n.charAt(0).toUpperCase() + n.slice(1);
}
