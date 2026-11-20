"use client";

import { useRouter } from "next/navigation";

/**
 * A GET form that applies itself on every change (still works with its submit button without
 * JavaScript). Empty values are left out of the URL.
 */
export function AutoSubmitForm({
  action,
  className,
  children,
}: {
  action: string;
  className?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const go = (form: HTMLFormElement) => {
    const params = new URLSearchParams();
    for (const [key, value] of new FormData(form)) {
      if (typeof value === "string" && value) params.set(key, value);
    }
    const qs = params.toString();
    router.replace((qs ? `${action}?${qs}` : action) as never, { scroll: false });
  };
  return (
    <form
      action={action}
      method="get"
      className={className}
      onChange={(e) => go(e.currentTarget)}
      onSubmit={(e) => {
        e.preventDefault();
        go(e.currentTarget);
      }}
    >
      {children}
    </form>
  );
}
