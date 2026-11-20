import { Segmented } from "@/components/Segmented";

/** "Katalog" / "Madplan" at the top of the Madideer tab. */
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
        label="Madideer"
        items={[
          { href: "/madideer", label: "Katalog", active: active === "katalog" },
          {
            href: "/madideer/madplan",
            label: planCount > 0 ? `Madplan (${planCount})` : "Madplan",
            active: active === "madplan",
          },
        ]}
      />
    </div>
  );
}
