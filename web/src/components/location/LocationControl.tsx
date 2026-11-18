"use client";

import { useRouter } from "next/navigation";
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import {
  resetLocation,
  restoreLocation,
  saveCoordinates,
  saveLocation,
  type LocationActionState,
} from "@/app/actions";
import { CloseIcon, PinIcon } from "@/components/Icons";
import {
  RADIUS_OPTIONS_KM,
  toStoredLocation,
  type StoredLocation,
  type UserLocation,
} from "@/lib/location";
import { readStoredLocation, removeStoredLocation, writeStoredLocation } from "./storage";

/** Dispatched on `window` to open the location sheet from anywhere ("Skift afstand"). */
export const OPEN_LOCATION_EVENT = "foodcatch:open-location";

const INITIAL: LocationActionState = { status: "idle", message: "", address: "", seq: 0 };

const GEO_ERROR = "Vi fik ikke adgang til din position. Skriv en adresse i stedet.";

// Once per page load: the restore from localStorage runs at most once and never after "Glem".
let restoreAttempted = false;
let forgotten = false;

const noopSubscribe = () => () => {};

function openDialog(dialog: HTMLDialogElement | null) {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>("input[name=address]")?.focus();
}
const canGeolocate = () => window.isSecureContext && "geolocation" in navigator;

/**
 * The location button in the top bar and its sheet (docs/ui.md §5.1): address, "Brug min
 * position", radius and "Gem". The location lives in a cookie (server rendering), is backed up
 * in localStorage and restored from there when the cookie is gone. The address field always
 * shows the saved address (or the text that failed), never an emptied field.
 */
export function LocationControl({ location }: { location: UserLocation }) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleId = useId();
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [toast, setToast] = useState(false);
  const [geoPending, setGeoPending] = useState(false);
  const [restoring, startRestore] = useTransition();
  const [busy, startBusy] = useTransition();
  const geolocation = useSyncExternalStore(noopSubscribe, canGeolocate, () => false);

  const savedLabel = location.isDefault ? "" : location.label;

  function onSaved(stored: StoredLocation | undefined) {
    if (stored) writeStoredLocation(stored);
    forgotten = false;
    setNote(null);
    dialogRef.current?.close();
    setToast(true);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(false), 3000);
    router.refresh();
  }

  const [state, formAction, pending] = useActionState(
    async (previous: LocationActionState, formData: FormData) => {
      const next = await saveLocation(previous, formData);
      if (next.status === "saved") onSaved(next.location);
      else setNote(null);
      return next;
    },
    INITIAL,
  );

  // Keep the backup in step with the server (the server wins), or restore from it when the
  // cookie is gone.
  useEffect(() => {
    if (!location.isDefault) {
      writeStoredLocation(toStoredLocation(location, new Date()));
      return;
    }
    if (restoreAttempted || forgotten) return;
    restoreAttempted = true;
    const entry = readStoredLocation();
    if (!entry) return;
    startRestore(async () => {
      const { restored } = await restoreLocation(entry);
      if (restored) router.refresh();
    });
  }, [location, router]);

  useEffect(() => {
    const open = () => openDialog(dialogRef.current);
    window.addEventListener(OPEN_LOCATION_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_LOCATION_EVENT, open);
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function selectedRadius(): number {
    const value = formRef.current ? new FormData(formRef.current).get("radius") : null;
    return Number(value ?? location.radiusKm);
  }

  function locateMe() {
    setNote(null);
    setGeoPending(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        startBusy(async () => {
          const result = await saveCoordinates({
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            accuracyM: position.coords.accuracy,
            radiusKm: selectedRadius(),
          });
          setGeoPending(false);
          if (result.status === "saved") onSaved(result.location);
          else setNote({ text: result.message, error: true });
        });
      },
      () => {
        setGeoPending(false);
        setNote({ text: GEO_ERROR, error: true });
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  function forget() {
    startBusy(async () => {
      await resetLocation();
      removeStoredLocation();
      forgotten = true;
      setNote({ text: "Adressen er glemt.", error: false });
      router.refresh();
    });
  }

  const buttonLabel = restoring
    ? "Henter din gemte adresse…"
    : location.isDefault
      ? "Vælg adresse"
      : location.label;
  const accessibleName = restoring
    ? "Henter din gemte adresse…"
    : `Placering: ${location.isDefault ? "ingen adresse valgt" : location.label}, radius ${location.radiusKm} km. Skift`;
  const message = note ?? (state.status === "error" ? { text: state.message, error: true } : null);
  // Remount the fields after every result and every new location, so they show the saved values.
  const formKey = `${state.seq}|${location.label}|${location.radiusKm}|${location.isDefault}`;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => openDialog(dialogRef.current)}
        aria-haspopup="dialog"
        aria-label={accessibleName}
        title={location.isDefault ? undefined : location.label}
        className={`flex h-11 min-w-0 items-center gap-1.5 rounded-[10px] px-2 text-meta font-medium hover:bg-surface-2 ${
          location.isDefault && !restoring ? "text-link" : "text-ink"
        }`}
      >
        <PinIcon size={18} />
        <span className="max-w-[22ch] truncate md:max-w-[40ch]">{buttonLabel}</span>
        <span className="shrink-0 text-ink-3" aria-hidden="true">
          · {location.radiusKm} km
        </span>
      </button>

      <div
        role="status"
        className="pointer-events-none fixed inset-x-0 top-14 z-40 flex justify-center"
      >
        {toast ? (
          <p className="rounded-full border border-good-line bg-good-bg px-3 py-1 text-meta font-semibold text-good-fg">
            Gemt ✓
          </p>
        ) : restoring ? (
          <p className="sr-only">Henter din gemte adresse…</p>
        ) : null}
      </div>

      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-modal="true"
        onClose={() => buttonRef.current?.focus()}
        onClick={(event) => {
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="fixed inset-x-0 top-auto bottom-0 m-0 max-h-[90dvh] w-full max-w-none overflow-y-auto rounded-t-2xl border border-line bg-surface p-0 text-ink backdrop:bg-overlay md:top-14 md:right-[max(24px,calc((100vw-1200px)/2+24px))] md:bottom-auto md:left-auto md:w-[400px] md:rounded-xl"
      >
        <div className="p-4 pb-[calc(16px+env(safe-area-inset-bottom))] md:p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id={titleId} className="text-heading font-semibold">
              Din placering
            </h2>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="-mr-2 flex size-11 items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2"
            >
              <CloseIcon />
              <span className="sr-only">Luk</span>
            </button>
          </div>

          {!location.isDefault ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-[10px] bg-surface-2 px-3 py-2">
              <p className="min-w-0 text-body">
                Gemt: <strong className="break-words">{location.label}</strong>
              </p>
              <button
                type="button"
                onClick={forget}
                disabled={busy}
                className="h-11 shrink-0 px-2 text-meta font-medium text-link underline disabled:opacity-60"
              >
                Glem
              </button>
            </div>
          ) : null}

          <form ref={formRef} key={formKey} action={formAction} className="mt-4 space-y-4">
            <div>
              <label htmlFor={`${titleId}-address`} className="block text-meta font-medium">
                Adresse
              </label>
              <input
                id={`${titleId}-address`}
                name="address"
                type="text"
                defaultValue={state.status === "error" ? state.address : savedLabel}
                placeholder="Vej og nummer, postnummer"
                autoComplete="street-address"
                enterKeyHint="search"
                maxLength={200}
                className="mt-1 h-11 w-full rounded-[10px] border border-line-strong bg-page px-3 text-body text-ink placeholder:text-ink-3"
              />
            </div>

            {geolocation ? (
              <button
                type="button"
                onClick={locateMe}
                disabled={geoPending || busy}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-[10px] border border-line-strong bg-surface px-4 font-medium text-ink hover:bg-surface-2 disabled:opacity-60 md:w-auto"
              >
                <PinIcon size={18} />
                {geoPending ? "Finder din position…" : "Brug min position"}
              </button>
            ) : null}

            <fieldset>
              <legend className="text-meta font-medium">Afstand</legend>
              <div className="mt-1 grid grid-cols-5 rounded-[10px] border border-line-strong bg-page p-1">
                {RADIUS_OPTIONS_KM.map((km) => (
                  <label key={km} className="relative">
                    <input
                      type="radio"
                      name="radius"
                      value={km}
                      defaultChecked={km === location.radiusKm}
                      className="peer sr-only"
                    />
                    <span className="flex h-10 cursor-pointer items-center justify-center rounded-[8px] text-meta font-medium whitespace-nowrap text-ink-2 peer-checked:bg-brand peer-checked:text-page peer-focus-visible:outline-2 peer-focus-visible:outline-focus">
                      {km} km
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <button
              type="submit"
              disabled={pending}
              className="h-11 w-full rounded-[10px] bg-brand px-4 font-semibold text-page hover:opacity-90 disabled:opacity-60"
            >
              {pending ? "Gemmer…" : "Gem"}
            </button>
          </form>

          <div aria-live="polite" className="mt-3 min-h-5 text-meta">
            {message ? (
              <p className={message.error ? "text-bad-fg" : "text-ink-2"}>{message.text}</p>
            ) : null}
          </div>
        </div>
      </dialog>
    </>
  );
}

/** A button that opens the location sheet ("Skift afstand"). */
export function OpenLocationButton({ children }: { children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_LOCATION_EVENT))}
      className="mt-2 inline-flex h-11 items-center rounded-[10px] border border-line-strong bg-surface px-4 font-medium text-ink hover:bg-surface-2"
    >
      {children}
    </button>
  );
}
