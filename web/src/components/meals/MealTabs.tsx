import { Segmented } from "@/components/Segmented";

/** "Retter" / "Madplan" at the top of the Aftensmad tab. */
export function MealTabs({
  active,
  planCount,
}: {
  active: "katalog" | "madplan";
  planCount: number;
}) {
  return (
    <div className="mt-3">
      <Segmented
        label="Aftensmad"
        items={[
          { href: "/", label: "Retter", active: active === "katalog" },
          {
            href: "/madplan",
            label: planCount > 0 ? `Madplan (${planCount})` : "Madplan",
            active: active === "madplan",
          },
        ]}
      />
    </div>
  );
}
