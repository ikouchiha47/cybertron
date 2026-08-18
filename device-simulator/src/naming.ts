// Docker-style name generator: adjective_noun, with a numeric suffix on collision.

const ADJECTIVES = [
  "quiet", "amber", "brisk", "cozy", "dizzy", "eager", "faded", "gentle",
  "hollow", "icy", "jolly", "keen", "lively", "misty", "noble", "olive",
  "plucky", "quirky", "rusty", "sunny", "tidy", "usual", "vivid", "witty",
];

const NOUNS = [
  "falcon", "otter", "cedar", "harbor", "meadow", "canyon", "ember", "lagoon",
  "willow", "boulder", "comet", "drift", "fjord", "grove", "haven", "isle",
  "juniper", "kestrel", "lantern", "marsh", "nimbus", "orchard", "prairie", "reef",
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateName(taken: Set<string>): string {
  let name = `${randomFrom(ADJECTIVES)}_${randomFrom(NOUNS)}`;
  let suffix = 2;
  while (taken.has(name)) {
    name = `${randomFrom(ADJECTIVES)}_${randomFrom(NOUNS)}_${suffix}`;
    suffix++;
  }
  taken.add(name);
  return name;
}

export function generateId(category: string, index: number): string {
  return `${category}-${String(index).padStart(3, "0")}-${Math.random().toString(16).slice(2, 8)}`;
}
