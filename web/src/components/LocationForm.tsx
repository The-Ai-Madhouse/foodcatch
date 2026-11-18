"use client";

import { useActionState } from "react";
import { resetLocation, saveLocation, type LocationFormState } from "@/app/actions";
import { RADIUS_OPTIONS_KM } from "@/lib/location";

const INITIAL: LocationFormState = { status: "idle", message: "" };

/**
 * Address and radius chooser. Works without JavaScript (server action); with JavaScript it shows
 * progress and errors inline.
 */
export function LocationForm({
  label,
  radiusKm,
  isDefault,
}: {
  label: string;
  radiusKm: number;
  isDefault: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveLocation, INITIAL);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm text-ink-2">
        Viser butikker inden for <strong className="text-ink">{radiusKm} km</strong> af{" "}
        {isDefault ? "standardplaceringen" : <strong className="text-ink">{label}</strong>}.
      </p>
      <form action={formAction} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="address" className="block text-sm font-medium text-ink">
            Adresse
          </label>
          <input
            id="address"
            name="address"
            type="text"
            autoComplete="street-address"
            maxLength={200}
            placeholder="fx Nørrebrogade 10, 2200 København N"
            aria-describedby="address-hint"
            className="mt-1 w-full rounded-md border border-line-strong bg-page px-3 py-2 text-ink placeholder:text-ink-3"
          />
          <p id="address-hint" className="mt-1 text-xs text-ink-3">
            Lad feltet stå tomt for kun at ændre radius. Adressen slås op hos OpenStreetMap.
          </p>
        </div>
        <div>
          <label htmlFor="radius" className="block text-sm font-medium text-ink">
            Radius
          </label>
          <select
            id="radius"
            name="radius"
            defaultValue={String(radiusKm)}
            className="mt-1 w-full rounded-md border border-line-strong bg-page px-3 py-2 text-ink sm:w-auto"
          >
            {RADIUS_OPTIONS_KM.map((km) => (
              <option key={km} value={km}>
                {km} km
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand px-4 py-2 font-semibold text-page hover:opacity-90 disabled:opacity-60"
        >
          {pending ? "Opdaterer…" : "Opdater"}
        </button>
      </form>
      <div aria-live="polite" className="mt-2 min-h-5 text-sm">
        {state.status === "error" ? (
          <p className="text-bad-fg">{state.message}</p>
        ) : state.status === "saved" ? (
          <p className="text-good-fg">{state.message}</p>
        ) : null}
      </div>
      {!isDefault ? (
        <form action={resetLocation}>
          <button type="submit" className="text-sm text-link underline">
            Brug standardplacering
          </button>
        </form>
      ) : null}
    </div>
  );
}
