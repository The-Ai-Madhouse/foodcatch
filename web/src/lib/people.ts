/**
 * How many people the user cooks for (docs/ui.md §25), chosen at the top of "Aftensmad" and kept
 * in a cookie. With fewer people than a recipe serves, a dish lasts several days; with more,
 * the recipe is made several times.
 */

export const PEOPLE_COOKIE = "fc_people";
export const PEOPLE_CHOICES = [1, 2, 3, 4, 5, 6] as const;

/** The stored number of people, or null when not chosen (1–12). */
export function parsePeople(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 12 ? n : null;
}

/** Leftovers should be eaten within this many days (Fødevarestyrelsen's general advice: 2–3). */
export const FRIDGE_DAYS = 3;

export interface Portions {
  /** Days the dish lasts for the people (whole days), when they are fewer than it serves. */
  days: number | null;
  /** How many times to make the recipe, when they are more than it serves (1 decimal). */
  times: number | null;
  /** The people's share of the dish price per day (kr.). */
  perDayKr: number;
  /** Part of it should be frozen: it lasts longer than leftovers keep in the fridge. */
  freeze: boolean;
}

/** What a dish means for `people`: days it lasts or times to make it, and the price per day. */
export function portions(servings: number, people: number, dishKr: number): Portions {
  const perDayKr = Math.round(((dishKr * people) / Math.max(1, servings)) * 100) / 100;
  if (people < servings) {
    const days = Math.floor(servings / people);
    return { days, times: null, perDayKr, freeze: days > FRIDGE_DAYS };
  }
  if (people > servings) {
    return {
      days: null,
      times: Math.round((people / servings) * 10) / 10,
      perDayKr,
      freeze: false,
    };
  }
  return { days: null, times: null, perDayKr, freeze: false };
}
