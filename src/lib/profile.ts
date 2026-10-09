// Username rules from the extension's components/profile.js: how long a name may be and what to
// show before the user picks one. The picture helpers are left out — the app resizes with
// expo-image-picker instead of a canvas.

export const NAME_MIN = 2;
export const NAME_MAX = 24;

/** Whatever is wrong with `name`, in a sentence, or null when it is fine. */
export function nameError(name: string | null | undefined): string | null {
  const trimmed = String(name ?? '').trim();
  if (trimmed.length < NAME_MIN) return `Your username needs at least ${NAME_MIN} characters.`;
  if (trimmed.length > NAME_MAX) return `Your username can be at most ${NAME_MAX} characters.`;
  return null;
}

/** A name to show before the user has picked one (the part of their email before the @). */
export const suggestedName = (user?: { displayName?: string; email?: string } | null) =>
  (user?.displayName || user?.email || '')
    .split('@')[0]
    .slice(0, NAME_MAX);

/** Both consent checks, in one sentence, or null when they can proceed. */
export function consentError(age: boolean, terms: boolean, minimumAge = 18): string | null {
  if (!age) return `Confirm you are ${minimumAge} or older.`;
  if (!terms) return 'Accept the terms and privacy policy to continue.';
  return null;
}
