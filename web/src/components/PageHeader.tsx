/** The page title with an optional lead paragraph. */
export function PageHeader({ title, lead }: { title: string; lead?: React.ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">{title}</h1>
      {lead ? <p className="mt-2 max-w-prose text-ink-2">{lead}</p> : null}
    </header>
  );
}
