import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

export default function NotFound() {
  return (
    <>
      <PageHeader
        title="Siden findes ikke"
        lead="Vi kunne ikke finde det, du ledte efter. Varen har måske ingen registrerede priser endnu."
      />
      <Link href="/">Til ugens bedste køb</Link>
    </>
  );
}
