import { savePeople } from "@/app/actions";
import { PEOPLE_CHOICES } from "@/lib/people";

/**
 * "Hvor mange er I?" at the very top (docs/ui.md §25): one button per number, saved in a cookie
 * by a server action (works without JS). Every dish then says how many days it lasts and the
 * price per day.
 */
export function PeoplePicker({ people }: { people: number | null }) {
  return (
    <form action={savePeople} className="mt-3 rounded-xl border border-line bg-surface p-3">
      <fieldset>
        <legend className="text-meta font-medium text-ink">Hvor mange er I?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {PEOPLE_CHOICES.map((n) => (
            <button
              key={n}
              type="submit"
              name="personer"
              value={n}
              aria-pressed={people === n}
              className="h-11 min-w-11 rounded-[10px] border border-line-strong bg-surface px-3 font-semibold text-ink tabular hover:bg-surface-2 aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:text-page"
            >
              {n}
              <span className="sr-only">{n === 1 ? " person" : " personer"}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <p className="mt-2 text-micro text-ink-3">
        {people == null
          ? "Vælg, så viser hver ret, hvor mange dage den rækker, og prisen pr. dag."
          : `Hver ret viser, hvor mange dage den rækker for ${people === 1 ? "1 person" : `${people} personer`}, og prisen pr. dag.`}
      </p>
    </form>
  );
}
