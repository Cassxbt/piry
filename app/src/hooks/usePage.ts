import { useEffect } from "react";

const SUFFIX = "Piry";

// Sets the tab title and description for the route, so deep links share something meaningful.
export function usePage(title: string, description: string) {
  useEffect(() => {
    document.title = title === SUFFIX ? SUFFIX : `${title} | ${SUFFIX}`;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", description);
  }, [title, description]);
}
