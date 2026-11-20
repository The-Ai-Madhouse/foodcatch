import Link from "next/link";

export default function NotFound() {
  return (
    <>
      <h1 className="text-display shelf text-ink">Siden findes ikke</h1>
      <p className="mt-1 max-w-prose text-meta text-ink-2">
        Vi kunne ikke finde det, du ledte efter. Varen har måske ingen registrerede priser endnu.
      </p>
      <p className="mt-3">
        <Link href="/">Til forsiden</Link>
      </p>
    </>
  );
}
