// Couch Pilot demo catalog.
// Every title is fictional. Artwork and video clips are taken from Blender
// Foundation open movies released under Creative Commons Attribution
// (see CREDITS.md). No third-party brands, no copyrighted footage.

export const TITLES = [
  {
    id: 'harbor',
    name: 'Harbor Investigations',
    kind: 'series',
    genres: ['detective', 'crime', 'police', 'mystery', 'drama'],
    creator: 'M. Varga',
    year: 2024,
    art: 'img/harbor.jpg',
    still: 'img/harbor-2.jpg',
    video: 'media/harbor.mp4',
    rating: '12+',
    blurb: 'Two inspectors untangle the secrets of an old port city, one canal at a time.',
    seasons: [
      { number: 1, episodes: 8 },
      { number: 2, episodes: 8 },
    ],
    episodeMinutes: 44,
  },
  {
    id: 'brigade',
    name: 'Northern Brigade',
    kind: 'series',
    genres: ['detective', 'crime', 'police', 'thriller'],
    creator: 'L. Okafor',
    year: 2023,
    art: 'img/brigade.jpg',
    video: 'media/brigade.mp4',
    rating: '16+',
    blurb: 'A night-shift unit chases a sniper across a frozen city.',
    seasons: [{ number: 1, episodes: 6 }],
    episodeMinutes: 52,
  },
  {
    id: 'ember',
    name: 'The Ember Wing',
    kind: 'movie',
    genres: ['fantasy', 'adventure', 'film', 'movie'],
    creator: 'R. Aalders',
    year: 2025,
    art: 'img/ember.jpg',
    still: 'img/ember-2.jpg',
    video: 'media/ember.mp4',
    rating: '12+',
    minutes: 98,
    blurb: 'A young wanderer crosses a burning kingdom to find the dragon she raised.',
  },
  {
    id: 'pampas',
    name: 'Pampas Pals',
    kind: 'series',
    genres: ['kids', 'cartoon', 'animation', 'family', 'comedy'],
    creator: 'Studio Lomo',
    year: 2025,
    art: 'img/pampas.jpg',
    video: 'media/pampas.mp4',
    rating: 'All ages',
    kids: true,
    blurb: 'A clumsy llama and his friends try (and fail) to cross the big fence.',
    seasons: [{ number: 1, episodes: 12 }],
    episodeMinutes: 11,
  },
  {
    id: 'moon',
    name: 'Moon Meadow',
    kind: 'series',
    genres: ['kids', 'cartoon', 'animation', 'family'],
    creator: 'Peach Hill',
    year: 2024,
    art: 'img/moon.jpg',
    video: 'media/moon.mp4',
    rating: 'All ages',
    kids: true,
    blurb: 'A gentle giant rabbit and the meadow critters who share his garden.',
    seasons: [{ number: 1, episodes: 10 }],
    episodeMinutes: 9,
  },
  {
    id: 'cosmic',
    name: 'Cosmic Shores',
    kind: 'movie',
    genres: ['documentary', 'space', 'science', 'nature'],
    creator: 'Open Sky Films',
    year: 2026,
    art: 'img/cosmic.jpg',
    video: 'media/cosmic.mp4',
    rating: 'All ages',
    minutes: 52,
    audioDescription: true,
    blurb: 'A calm journey from our blue planet to the edge of the solar system.',
  },
  {
    id: 'dune',
    name: 'Dune Song',
    kind: 'movie',
    genres: ['drama', 'adventure', 'film', 'movie'],
    creator: 'R. Aalders',
    year: 2026,
    art: 'img/dune.jpg',
    video: 'media/dune.mp4',
    rating: '12+',
    minutes: 104,
    price: 3.99,
    blurb: 'New release. One traveller, one endless desert, one song to find the way home.',
  },
  {
    id: 'steel',
    name: 'Steel Canal',
    kind: 'movie',
    genres: ['science fiction', 'sci-fi', 'action', 'film', 'movie'],
    creator: 'I. de Wit',
    year: 2025,
    art: 'img/steel.jpg',
    still: 'img/lab.jpg',
    video: 'media/steel.mp4',
    rating: '12+',
    minutes: 92,
    blurb: 'Forty years after the machines rose, two old friends meet on a bridge.',
  },
  {
    id: 'snow',
    name: 'Snowbound',
    kind: 'movie',
    genres: ['adventure', 'drama', 'film', 'movie'],
    creator: 'H. Reijn',
    year: 2023,
    art: 'img/snow.jpg',
    video: 'media/ember.mp4',
    rating: '12+',
    minutes: 87,
    blurb: 'Lost in a whiteout, a lone climber follows a red bird home.',
  },
];

export const byId = Object.fromEntries(TITLES.map((t) => [t.id, t]));

// Household memory: what Couch Pilot remembers between sessions.
// Visible and erasable by the user (see "My List" > "What Couch Pilot remembers").
export function defaultMemory() {
  return {
    progress: {
      harbor: { season: 2, episode: 5, position: 23 * 60 + 12, watchedAt: 'yesterday' },
      ember: { position: 61 * 60 + 40, watchedAt: 'yesterday' },
      pampas: { season: 1, episode: 3, position: 4 * 60, watchedAt: '2 days ago' },
      moon: { season: 1, episode: 2, position: 0, watchedAt: 'last week' },
    },
    preferences: {
      volume: 30,
      subtitles: 'English',
      kidsMaxVolume: 15,
      kidsTimeLimit: 30,
    },
    lastSession: { titleId: 'harbor', volume: 30, subtitles: null },
  };
}

export const HERO_ORDER = ['harbor', 'ember', 'dune', 'cosmic', 'steel'];
export const CONTINUE_ORDER = ['harbor', 'ember', 'pampas'];

export function subtitleOf(t) {
  return `${t.creator} • ${t.year}`;
}

export function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  const rr = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
}

// Fuzzy title lookup used by the planner ("the lobster", "harbor", "pampas pals").
export function findTitles(text) {
  const q = text.toLowerCase();
  return TITLES.filter((t) => {
    const name = t.name.toLowerCase();
    if (q.includes(name)) return true;
    const words = name.replace(/^the /, '').split(/\s+/);
    return words.some((w) => w.length > 3 && q.includes(w));
  });
}
