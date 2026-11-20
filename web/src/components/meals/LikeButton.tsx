"use client";

import { useOptimistic, useTransition } from "react";
import { toggleLikedRecipe } from "@/app/actions";

/** A heart that saves a dish under "Gemte" (cookie, server action). */
export function LikeButton({
  recipeId,
  name,
  liked,
}: {
  recipeId: string;
  name: string;
  liked: boolean;
}) {
  const [optimistic, setOptimistic] = useOptimistic(liked);
  const [, startTransition] = useTransition();
  return (
    <button
      type="button"
      aria-pressed={optimistic}
      aria-label={optimistic ? `Fjern ${name} fra gemte` : `Gem ${name}`}
      title={optimistic ? "Gemt – klik for at fjerne" : "Gem retten"}
      onClick={() =>
        startTransition(async () => {
          setOptimistic(!optimistic);
          await toggleLikedRecipe(recipeId);
        })
      }
      className={`flex size-11 shrink-0 items-center justify-center rounded-full text-[22px] leading-none hover:bg-surface-2 ${optimistic ? "text-bad-fg" : "text-ink-3"}`}
    >
      <span aria-hidden="true">{optimistic ? "♥" : "♡"}</span>
    </button>
  );
}
